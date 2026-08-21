import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import { assertLocalAgentProviderAvailable } from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  formatAvailableLocalAgentTargets,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStore,
} from "./local-agent-store.js";
import { terminateProcessTree } from "./process-platform.js";

export interface StartLocalAgentInput {
  workspaceId?: string;
  workspaceRoot: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
}

export async function startLocalAgentSession(
  config: ServerConfig,
  store: LocalAgentStore,
  input: StartLocalAgentInput,
): Promise<LocalAgentRecord> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const existing = store.get(input.target);
  if (existing) {
    assertLocalAgentInWorkspace(existing, input.workspaceId, workspaceRoot);
    if (!isLocalAgentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    if (existing.status === "starting" || existing.status === "running") {
      throw new Error(`Subagent ${existing.id} is already running.`);
    }
    assertLocalAgentProviderAvailable(existing.provider);
    const prompt = await prepareExistingAgentPrompt(config, existing, input.prompt);

    const prepared = store.update(existing.id, {
      status: "starting",
      model: input.model ?? existing.model,
      thinking: input.thinking ?? existing.thinking,
      latestResponse: undefined,
      error: undefined,
      workerPid: undefined,
    });
    return spawnStoredLocalAgent(config.stateDir, store, prepared, prompt);
  }

  const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
  const target = resolveLocalAgentTarget(input.target, profiles, input.model, input.thinking);
  if (!target) {
    throw new Error(
      `Unknown subagent profile, provider, or id: ${input.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
    );
  }
  assertLocalAgentProviderAvailable(target.provider);

  const record = store.create({
    workspaceId: input.workspaceId,
    workspaceRoot,
    profileName: target.name,
    provider: target.provider,
    model: target.model,
    thinking: target.thinking,
  });
  const prompt = target.kind === "profile"
    ? applyProfilePrompt(target.profile, input.prompt)
    : input.prompt;
  return spawnStoredLocalAgent(config.stateDir, store, record, prompt);
}

export function getLocalAgentSession(
  store: LocalAgentStore,
  workspaceId: string | undefined,
  workspaceRoot: string,
  id: string,
): LocalAgentRecord {
  const record = store.get(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);
  assertLocalAgentInWorkspace(record, workspaceId, workspaceRoot);
  return record;
}

export function listLocalAgentSessions(
  store: LocalAgentStore,
  workspaceId: string | undefined,
  workspaceRoot: string,
): LocalAgentRecord[] {
  if (!workspaceId) return store.list({ workspaceRoot });

  const sessions = new Map<string, LocalAgentRecord>();
  for (const record of store.list({ workspaceId })) sessions.set(record.id, record);
  for (const record of store.list({ workspaceRoot })) {
    if (!record.workspaceId) sessions.set(record.id, record);
  }
  return Array.from(sessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function cancelLocalAgentSession(
  store: LocalAgentStore,
  workspaceId: string | undefined,
  workspaceRoot: string,
  id: string,
): LocalAgentRecord {
  const record = getLocalAgentSession(store, workspaceId, workspaceRoot, id);
  if (record.status !== "starting" && record.status !== "running") return record;
  if (!record.workerPid) {
    throw new Error(`Subagent ${record.id} is running but has no worker process id; it cannot be terminated safely.`);
  }

  terminateProcessTree(
    {
      pid: record.workerPid,
      kill: (signal = "SIGTERM") => {
        try {
          process.kill(record.workerPid!, signal);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      },
    },
    "SIGTERM",
    true,
  );

  return store.update(record.id, {
    status: "stopped",
    workerPid: undefined,
    error: undefined,
  });
}

export async function executeLocalAgentWorker(
  store: LocalAgentStore,
  agentId: string,
  promptFile: string,
): Promise<void> {
  const record = store.get(agentId);
  if (!record) throw new Error(`Unknown subagent id: ${agentId}`);
  if (record.status === "stopped") {
    await rm(dirname(promptFile), { recursive: true, force: true }).catch(() => undefined);
    return;
  }

  try {
    if (!isLocalAgentProvider(record.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${record.provider}`);
    }
    const prompt = await readFile(promptFile, "utf8");
    const result = await runLocalAgentProvider(record.provider, {
      prompt,
      workspace: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: "allowed",
      model: record.model,
      thinking: record.thinking,
    });
    store.updateUnlessStopped(record.id, {
      providerSessionId: result.providerSessionId ?? undefined,
      status: "idle",
      latestResponse: result.finalResponse,
      workerPid: undefined,
      error: undefined,
    });
  } catch (error) {
    store.updateUnlessStopped(record.id, {
      status: "error",
      workerPid: undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(dirname(promptFile), { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnStoredLocalAgent(
  stateDir: string,
  store: LocalAgentStore,
  record: LocalAgentRecord,
  prompt: string,
): LocalAgentRecord {
  const promptFile = writeAgentPromptFile(prompt);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [
      ...process.execArgv,
      localAgentWorkerPath(),
      record.id,
      "--state-dir",
      stateDir,
      "--prompt-file",
      promptFile,
    ], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
  } catch (error) {
    void rm(dirname(promptFile), { recursive: true, force: true });
    store.update(record.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!child.pid) {
    child.kill();
    void rm(dirname(promptFile), { recursive: true, force: true });
    const error = new Error("Subagent worker did not start with a process id.");
    store.update(record.id, { status: "error", error: error.message });
    throw error;
  }

  child.unref();
  return store.update(record.id, {
    status: "running",
    workerPid: child.pid,
    error: undefined,
  });
}

async function prepareExistingAgentPrompt(
  config: ServerConfig,
  record: LocalAgentRecord,
  prompt: string,
): Promise<string> {
  if (record.profileName === record.provider) return prompt;

  const profiles = await loadLocalAgentProfiles(config, record.workspaceRoot);
  const profile = profiles.find((candidate) => candidate.name === record.profileName);
  if (!profile) throw new Error(`Subagent profile not found: ${record.profileName}`);
  return applyProfilePrompt(profile, prompt);
}

function applyProfilePrompt(profile: LocalAgentProfile, prompt: string): string {
  const body = profile.body.trim();
  return body ? `${body}\n\nTask:\n${prompt}` : prompt;
}

function assertLocalAgentInWorkspace(
  record: LocalAgentRecord,
  workspaceId: string | undefined,
  workspaceRoot: string,
): void {
  if (record.workspaceId) {
    if (workspaceId === record.workspaceId) return;
    throw new Error(`Subagent ${record.id} belongs to another workspace.`);
  }
  if (resolve(record.workspaceRoot) !== resolve(workspaceRoot)) {
    throw new Error(`Subagent ${record.id} belongs to another workspace.`);
  }
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function localAgentWorkerPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath);
  const workerFile = extension === ".ts" ? "local-agent-worker.ts" : "local-agent-worker.js";
  return fileURLToPath(new URL(`./${workerFile}`, import.meta.url));
}

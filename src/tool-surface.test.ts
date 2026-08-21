import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { consoleEventStoreFor } from "./console-events.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("full tool mode exposes safe search, managed processes, moves, and native subagents", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-tool-surface-test-"));
  const project = join(root, "project");
  const agentDir = join(root, ".agent");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const localAgentStore = new LocalAgentStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const server = createMcpServer(
    config,
    workspaces,
    new ProcessSessionManager(),
    [],
    [],
    localAgentStore,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-surface-test", version: "1.0.0" });

  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "open_workspace",
      "checkpoint",
      "history_search",
      "read",
      "write",
      "edit",
      "move_file",
      "grep",
      "glob",
      "ls",
      "bash",
      "exec_command",
      "write_stdin",
      "list_processes",
      "get_process",
      "kill_process",
      "run_agent",
      "get_agent",
      "list_agents",
      "cancel_agent",
    ]) {
      assert.equal(names.has(name), true, `missing MCP tool ${name}`);
    }

    for (const tool of tools.tools) {
      const meta = tool._meta as {
        ui?: { resourceUri?: unknown };
        "ui/resourceUri"?: unknown;
        "openai/outputTemplate"?: unknown;
      } | undefined;
      assert.equal(meta?.ui?.resourceUri, undefined, `${tool.name} should not create a tool-card iframe`);
      assert.equal(meta?.["ui/resourceUri"], undefined, `${tool.name} should not expose legacy widget metadata`);
      assert.equal(meta?.["openai/outputTemplate"], undefined, `${tool.name} should not expose an output template`);
    }

    for (const name of ["bash", "exec_command"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      const description = tool?.description ?? "";
      assert.match(description, /git init/);
      assert.match(description, /git add/);
      assert.match(description, /git commit/);
      assert.match(description, /git push/);
    }

    const bashTool = tools.tools.find((candidate) => candidate.name === "bash");
    const bashInputSchema = bashTool?.inputSchema as {
      properties?: { command?: { description?: string } };
    } | undefined;
    assert.match(bashInputSchema?.properties?.command?.description ?? "", /git init/);
    assert.match(bashInputSchema?.properties?.command?.description ?? "", /git add/);
    assert.match(bashInputSchema?.properties?.command?.description ?? "", /git commit/);

    const execTool = tools.tools.find((candidate) => candidate.name === "exec_command");
    const execInputSchema = execTool?.inputSchema as {
      properties?: { cmd?: { description?: string } };
    } | undefined;
    assert.match(execInputSchema?.properties?.cmd?.description ?? "", /git init/);
    assert.match(execInputSchema?.properties?.cmd?.description ?? "", /git add/);
    assert.match(execInputSchema?.properties?.cmd?.description ?? "", /git commit/);

    const opened = await client.callTool({
      name: "open_workspace",
      arguments: { path: project },
    });
    const workspaceId = (opened.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId;
    assert.equal(typeof workspaceId, "string");
    const openEvent = consoleEventStoreFor(config).recent(10).find((event) => event.tool === "open_workspace");
    assert.equal(openEvent?.consoleUi?.resource, "tool/open_workspace");
    assert.equal(openEvent?.consoleUi?.card.workspaceId, workspaceId);

    const legacyCheckpointPrepare = await client.callTool({
      name: "bash",
      arguments: { workspaceId, command: "checkpoint" },
    });
    const legacyPrepareResult = (legacyCheckpointPrepare.structuredContent as { result?: unknown } | undefined)?.result;
    assert.equal(typeof legacyPrepareResult, "string");
    assert.match(String(legacyPrepareResult), /DEVSPACE_CHECKPOINT_STATE_REQUIRED/);

    const legacyCheckpointState = {
      goal: "Keep legacy conversations resumable",
      currentTask: "Verify the bash checkpoint compatibility bridge",
      completed: ["Added Resume State persistence"],
      decisions: ["Legacy conversations reuse the existing bash tool"],
      files: ["src/server.ts"],
      verification: ["tool-surface test"],
      blockers: [],
      next: ["Open a new conversation and verify continuation"],
    };
    const legacyCheckpointSaved = await client.callTool({
      name: "bash",
      arguments: {
        workspaceId,
        command: `checkpoint ${JSON.stringify(legacyCheckpointState)}`,
      },
    });
    const legacySaveResult = (legacyCheckpointSaved.structuredContent as { result?: unknown } | undefined)?.result;
    assert.equal(typeof legacySaveResult, "string");
    assert.match(String(legacySaveResult), /Saved legacy conversation checkpoint/);
    const legacyCheckpointEvent = consoleEventStoreFor(config).recent(20).find(
      (event) => event.tool === "checkpoint" && event.consoleUi?.card.source === "legacy-bash",
    );
    const legacyCheckpointId = legacyCheckpointEvent?.consoleUi?.card.checkpointId;
    assert.equal(typeof legacyCheckpointId, "string");
    const legacyResume = await workspaces.getResumeState(workspaces.getWorkspace(String(workspaceId)));
    assert.equal(legacyResume?.checkpointId, legacyCheckpointId);
    assert.equal(legacyResume?.state.goal, legacyCheckpointState.goal);
    assert.equal(legacyResume?.state.currentTask, legacyCheckpointState.currentTask);

    const emptyProcesses = await client.callTool({
      name: "list_processes",
      arguments: { workspaceId },
    });
    assert.deepEqual(
      (emptyProcesses.structuredContent as { processes?: unknown[] } | undefined)?.processes,
      [],
    );

    const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
    const startedProcess = await client.callTool({
      name: "exec_command",
      arguments: {
        workspaceId,
        cmd: `${node} -e "setInterval(() => {}, 1000)"`,
        yieldTimeMs: 10,
      },
    });
    const processSessionId = (startedProcess.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
    assert.equal(typeof processSessionId, "number");

    const listedProcesses = await client.callTool({
      name: "list_processes",
      arguments: { workspaceId, includeCompleted: false },
    });
    const processes = (listedProcesses.structuredContent as { processes?: Array<Record<string, unknown>> } | undefined)?.processes;
    assert.equal(processes?.some((process) => process.sessionId === processSessionId && process.running === true), true);

    const fetchedProcess = await client.callTool({
      name: "get_process",
      arguments: { workspaceId, sessionId: processSessionId },
    });
    const processInfo = (fetchedProcess.structuredContent as { process?: Record<string, unknown> } | undefined)?.process;
    assert.equal(processInfo?.sessionId, processSessionId);
    assert.equal(processInfo?.running, true);

    const killedProcess = await client.callTool({
      name: "kill_process",
      arguments: { workspaceId, sessionId: processSessionId, gracePeriodMs: 100 },
    });
    assert.equal((killedProcess.structuredContent as { running?: unknown } | undefined)?.running, false);

    const empty = await client.callTool({
      name: "list_agents",
      arguments: { workspaceId },
    });
    assert.deepEqual(
      (empty.structuredContent as { agents?: unknown[] } | undefined)?.agents,
      [],
    );

    const created = localAgentStore.create({
      workspaceId: workspaceId as string,
      workspaceRoot: project,
      profileName: "reviewer",
      provider: "codex",
    });
    const fetched = await client.callTool({
      name: "get_agent",
      arguments: { workspaceId, agentId: created.id },
    });
    assert.equal(
      ((fetched.structuredContent as { agent?: { id?: unknown } } | undefined)?.agent?.id),
      created.id,
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    localAgentStore.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

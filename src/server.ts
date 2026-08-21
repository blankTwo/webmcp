import { randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { moveWorkspacePath } from "./move-file.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createHealthStatus, createRuntimeStatus } from "./runtime-status.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  buildWorkspaceContinuation,
  captureWorkspaceFacts,
  normalizeResumeState,
  type WorkspaceResumeStateInput,
} from "./workspace-memory.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  cancelLocalAgentSession,
  getLocalAgentSession,
  listLocalAgentSessions,
  startLocalAgentSession,
} from "./local-agent-service.js";
import { createLocalAgentStore, type LocalAgentRecord, type LocalAgentStore } from "./local-agent-store.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import { DEVSPACE_VERSION } from "./version.js";
import {
  bindConsoleEventStore,
  closeConsoleEventStore,
  consoleEventStoreFor,
  ConsoleEventStore,
  MAX_CONSOLE_RETENTION_DAYS,
  MIN_CONSOLE_RETENTION_DAYS,
  type ConsoleToolUi,
} from "./console-events.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const LEGACY_CHECKPOINT_PREFIX = "checkpoint";
const legacyCheckpointStateSchema = z.object({
  goal: z.string().min(1),
  currentTask: z.string().min(1),
  completed: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  verification: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
});

function parseLegacyCheckpointCommand(command: string):
  | { kind: "prepare" }
  | { kind: "save"; state: WorkspaceResumeStateInput }
  | undefined {
  const trimmed = command.trim();
  if (trimmed.toLowerCase() === LEGACY_CHECKPOINT_PREFIX) {
    return { kind: "prepare" };
  }

  if (!trimmed.toLowerCase().startsWith(`${LEGACY_CHECKPOINT_PREFIX} `)) {
    return undefined;
  }

  const payload = trimmed.slice(LEGACY_CHECKPOINT_PREFIX.length).trim();
  if (!payload.startsWith("{")) return undefined;

  const parsed = legacyCheckpointStateSchema.parse(JSON.parse(payload));
  return { kind: "save", state: parsed };
}
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const SHELL_GIT_WRITE_ALLOWANCE =
  "Git metadata writes are an explicit exception: git init, git add, and git commit are allowed when the user asks to initialize, stage, or commit. Do not run git push unless the user explicitly requests it.";
const MOVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const PROCESS_KILL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const AGENT_RUN_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const AGENT_CANCEL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface DiffStats {
  additions: number;
  removals: number;
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspaceId.";

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
  sessionId?: number;
  running?: boolean;
  exitCode?: number;
  outputPreview?: string;
  consoleUi?: ConsoleToolUi;
}

function serverInstructions(config: ServerConfig): string {
  const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const subagentInstruction = config.subagents
    ? " When the user explicitly asks for delegation or a second opinion, use run_agent, get_agent, list_agents, and cancel_agent directly instead of invoking the devspace agents CLI through shell."
    : "";
  const memoryInstruction =
    " Use checkpoint only at meaningful milestones, before switching tasks, or when the user pauses work; do not checkpoint after every tool call. Use history_search only when a previous checkpoint is needed to recover an older decision or detail that is not in the current continuation. Compatibility: if the user says exactly `checkpoint` but this conversation does not expose the checkpoint tool, use the existing bash tool with command `checkpoint` and immediately follow the returned machine instruction without asking the user for more input.";

  if (config.toolMode === "codex") {
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use ${toolNames.read} for direct file reads, apply_patch for file content changes, move_file for explicit moves or renames, exec_command for inspection, tests, builds, and other commands. ${SHELL_GIT_WRITE_ALLOWANCE} Use write_stdin to poll or interact with running processes, list_processes/get_process to inspect managed process state without consuming output, and kill_process to terminate a managed process session. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${memoryInstruction}${subagentInstruction}${artifactInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  const managedProcessInstruction = config.toolMode === "full"
    ? " Use exec_command for long-running or interactive commands, write_stdin to poll or interact with them, list_processes/get_process to inspect managed process state without consuming output, and kill_process to terminate a managed process session."
    : "";

  return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, move_file for moves or renames, and ${toolNames.shell} for one-shot tests, builds, git inspection, package scripts, and commands that are better executed by the shell. ${SHELL_GIT_WRITE_ALLOWANCE} Except for that Git metadata exception, do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${managedProcessInstruction}${memoryInstruction}${subagentInstruction}${artifactInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceResumeStateOutputSchema = z.object({
  goal: z.string(),
  currentTask: z.string(),
  completed: z.array(z.string()),
  decisions: z.array(z.string()),
  files: z.array(z.string()),
  verification: z.array(z.string()),
  blockers: z.array(z.string()),
  next: z.array(z.string()),
});

const workspaceMemoryFactsOutputSchema = z.object({
  capturedAt: z.string(),
  gitBranch: z.string().optional(),
  gitHead: z.string().optional(),
  changedFiles: z.array(z.string()),
});

const workspaceContinuationOutputSchema = z.object({
  checkpointId: z.string(),
  updatedAt: z.string(),
  stale: z.boolean(),
  staleReason: z.string().optional(),
  state: workspaceResumeStateOutputSchema,
  facts: workspaceMemoryFactsOutputSchema,
  text: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const localAgentSessionOutputSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  profileName: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerSessionId: z.string().optional(),
  status: z.enum(["starting", "running", "idle", "error", "stopped"]),
  latestResponse: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const localAgentSessionSummaryOutputSchema = z.object({
  id: z.string(),
  profileName: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  status: z.enum(["starting", "running", "idle", "error", "stopped"]),
  error: z.string().optional(),
  updatedAt: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function ownerTokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function consoleToolUi(tool: string, card: Record<string, unknown>): ConsoleToolUi {
  return { resource: `tool/${tool}`, card };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  const { command, consoleUi, ...safeFields } = fields;
  const safeCommandPreview = command ? commandPreview(command) : undefined;
  const clientUi = consoleUi ?? {
    resource: `tool/${fields.tool}`,
    card: {
      workspaceId: fields.workspaceId,
      path: fields.path,
      workingDirectory: fields.workingDirectory,
      command: safeCommandPreview,
      sessionId: fields.sessionId,
      running: fields.running,
      exitCode: fields.exitCode,
      error: fields.error,
    },
  } satisfies ConsoleToolUi;

  consoleEventStoreFor(config).publish({
    ...safeFields,
    commandPreview: safeCommandPreview,
    consoleUi: clientUi,
  });

  if (!config.logging.toolCalls) return;

  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands ? safeCommandPreview : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function consoleOutputPreview(text: string): string | undefined {
  if (!text) return undefined;
  const maxCharacters = 4_000;
  if (text.length <= maxCharacters) return text;
  return `…${text.slice(-(maxCharacters - 1))}`;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processInfoSchema() {
  return z.object({
    sessionId: z.number().int().positive(),
    pid: z.number().int().positive().optional(),
    command: z.string(),
    cwd: z.string(),
    tty: z.boolean(),
    startedAt: z.number().nonnegative(),
    wallTimeMs: z.number().nonnegative(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerManagedProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        `Run a command in a workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, long-running processes, and approved Git metadata writes. ${SHELL_GIT_WRITE_ALLOWANCE}`,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe(`Shell command to execute. ${SHELL_GIT_WRITE_ALLOWANCE}`),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        sessionId: snapshot.sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        outputPreview: consoleOutputPreview(snapshot.output),
        consoleUi: consoleToolUi("exec_command", {
          workspaceId,
          summary: {
            command: cmd,
            workingDirectory: workingDirectory ?? ".",
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          },
          payload: { content: snapshot.output },
        }),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        outputPreview: consoleOutputPreview(snapshot.output),
        consoleUi: consoleToolUi("write_stdin", {
          workspaceId,
          summary: {
            sessionId,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          },
          payload: { content: snapshot.output },
        }),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  server.registerTool(
    "list_processes",
    {
      title: "List processes",
      description:
        "List managed process sessions for a workspace. Includes recently completed sessions by default so the agent can inspect what just finished.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier whose managed processes should be listed."),
        includeCompleted: z
          .boolean()
          .optional()
          .describe("Include recently completed sessions retained by DevSpace. Defaults to true."),
      },
      outputSchema: resultOutputSchema({
        processes: z.array(processInfoSchema()),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, includeCompleted }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const processes = processSessions.list(workspaceId, includeCompleted ?? true);
      const result = processes.length === 0
        ? "No managed process sessions found."
        : `${processes.length} managed process session${processes.length === 1 ? "" : "s"}.`;
      logToolCall(config, {
        tool: "list_processes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, processes },
      };
    },
  );

  server.registerTool(
    "get_process",
    {
      title: "Get process",
      description:
        "Get metadata for one managed process session without consuming its buffered output.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().int().positive().describe("Managed process session identifier."),
      },
      outputSchema: resultOutputSchema({
        process: processInfoSchema(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, sessionId }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const processInfo = processSessions.get(workspaceId, sessionId);
      const result = processInfo.running
        ? `Process session ${sessionId} is running.`
        : `Process session ${sessionId} has completed.`;
      logToolCall(config, {
        tool: "get_process",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, process: processInfo },
      };
    },
  );

  server.registerTool(
    "kill_process",
    {
      title: "Terminate process",
      description:
        "Terminate a managed process session. DevSpace first requests graceful termination, waits briefly, then force-kills the process tree if it is still running.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().int().positive().describe("Process session identifier returned by exec_command."),
        gracePeriodMs: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Milliseconds to wait after graceful termination before force-killing. Defaults to 1500."),
      },
      outputSchema: resultOutputSchema({
        sessionId: z.number().int().positive(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
      }),
      _meta: {},
      annotations: PROCESS_KILL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, gracePeriodMs }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const processInfo = await processSessions.terminate(workspaceId, sessionId, gracePeriodMs);
      const result = processInfo.running
        ? `Force termination was sent to process session ${sessionId}, but it still reports as running.`
        : `Process session ${sessionId} terminated.`;
      logToolCall(config, {
        tool: "kill_process",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          sessionId,
          running: processInfo.running,
          exitCode: processInfo.exitCode,
          signal: processInfo.signal,
        },
      };
    },
  );
}

function localAgentSessionOutput(record: LocalAgentRecord) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    profileName: record.profileName,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    providerSessionId: record.providerSessionId,
    status: record.status,
    latestResponse: record.latestResponse,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function localAgentSessionSummary(record: LocalAgentRecord) {
  return {
    id: record.id,
    profileName: record.profileName,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    status: record.status,
    error: record.error,
    updatedAt: record.updatedAt,
  };
}

function registerLocalAgentTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  store: LocalAgentStore,
): void {
  server.registerTool(
    "run_agent",
    {
      title: "Run subagent",
      description:
        "Start a configured subagent profile or built-in provider in a workspace, or send a follow-up to an existing agent id. Returns immediately with a persistent agent session; use get_agent to read the final response.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        target: z.string().min(1).describe("Subagent profile name, built-in provider name, or existing agent id."),
        prompt: z.string().min(1).describe("Self-contained task for the subagent."),
        model: z.string().min(1).optional().describe("Optional provider-specific model override."),
        thinking: z.string().min(1).optional().describe("Optional provider-specific thinking/effort override."),
      },
      outputSchema: resultOutputSchema({ agent: localAgentSessionOutputSchema }),
      _meta: {},
      annotations: AGENT_RUN_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, target, prompt, model, thinking }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const agent = await startLocalAgentSession(config, store, {
        workspaceId,
        workspaceRoot: workspace.root,
        target,
        prompt,
        model,
        thinking,
      });
      const output = localAgentSessionOutput(agent);
      const result = `Started subagent ${agent.id} (${agent.profileName}, ${agent.provider}).`;
      logToolCall(config, {
        tool: "run_agent",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: output },
      };
    },
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get subagent",
      description: "Read the latest state and response of one subagent session in the selected workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1).describe("Agent id returned by run_agent."),
      },
      outputSchema: resultOutputSchema({ agent: localAgentSessionOutputSchema }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, agentId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const agent = getLocalAgentSession(store, workspaceId, workspace.root, agentId);
      const output = localAgentSessionOutput(agent);
      const result = agent.latestResponse
        ? `${agent.id} is ${agent.status}.\n${agent.latestResponse}`
        : agent.error
          ? `${agent.id} is ${agent.status}: ${agent.error}`
          : `${agent.id} is ${agent.status}.`;
      logToolCall(config, {
        tool: "get_agent",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: output },
      };
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List subagents",
      description: "List persistent subagent sessions belonging to the selected workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({ agents: z.array(localAgentSessionSummaryOutputSchema) }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const agents = listLocalAgentSessions(store, workspaceId, workspace.root).map(localAgentSessionSummary);
      const result = agents.length === 0
        ? "No subagent sessions found for this workspace."
        : `Found ${agents.length} subagent session${agents.length === 1 ? "" : "s"}.`;
      logToolCall(config, {
        tool: "list_agents",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, agents },
      };
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel subagent",
      description: "Terminate a running subagent worker and its child process tree in the selected workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1).describe("Agent id returned by run_agent."),
      },
      outputSchema: resultOutputSchema({ agent: localAgentSessionOutputSchema }),
      _meta: {},
      annotations: AGENT_CANCEL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, agentId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const agent = cancelLocalAgentSession(store, workspaceId, workspace.root, agentId);
      const output = localAgentSessionOutput(agent);
      const result = agent.status === "stopped"
        ? `Stopped subagent ${agent.id}.`
        : `Subagent ${agent.id} is already ${agent.status}.`;
      logToolCall(config, {
        tool: "cancel_agent",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: output },
      };
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  localAgentStore?: LocalAgentStore,
): McpServer {
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: DEVSPACE_VERSION,
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  const saveWorkspaceCheckpoint = async (
    workspaceId: string,
    input: WorkspaceResumeStateInput,
    sourceConversationId: string | undefined,
    startedAt: number,
    source: "tool" | "legacy-bash",
  ) => {
    const workspace = workspaces.getWorkspace(workspaceId);
    const state = normalizeResumeState(input);
    const facts = await captureWorkspaceFacts(workspace.root);
    const checkpoint = await workspaces.saveCheckpoint(workspace, {
      id: randomUUID(),
      state,
      facts,
      sourceConversationId,
    });
    logToolCall(config, {
      tool: "checkpoint",
      workspaceId,
      path: workspace.root,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
      consoleUi: consoleToolUi("checkpoint", {
        workspaceId,
        path: workspace.root,
        checkpointId: checkpoint.id,
        state,
        facts,
        source,
        summary: {
          goal: state.goal,
          currentTask: state.currentTask,
          next: state.next,
        },
      }),
    });
    return { workspace, state, facts, checkpoint };
  };

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        continuation: workspaceContinuationOutputSchema.optional(),
        instruction: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const conversationScopeId = openAiConversationScopeId(_meta);
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId },
      );
      const savedResumeState = includeBootstrapContext && conversationScopeId
        ? await workspaces.getResumeState(workspace)
        : undefined;
      const continuation = savedResumeState && savedResumeState.sourceConversationId !== conversationScopeId
        ? buildWorkspaceContinuation(
            savedResumeState,
            await captureWorkspaceFacts(workspace.root),
          )
        : undefined;
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const cardAgentProviders = config.subagents ? localAgentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            continuation?.text,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("open_workspace", {
          workspaceId: workspace.id,
          root: workspace.root,
          path: workspace.root,
          mode: workspace.mode,
          workspaceReused,
          includeBootstrapContext,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: cardAgentsFiles,
          availableAgentsFiles: cardAvailableAgentsFiles,
          skills: cardSkills,
          agentProviders: cardAgentProviders,
          agents: cardAgents,
          instruction: cardInstruction,
          continuation: continuation
            ? {
                checkpointId: continuation.checkpointId,
                updatedAt: continuation.updatedAt,
                stale: continuation.stale,
              }
            : undefined,
          summary: {
            mode: workspace.mode,
            agentsFiles: cardAgentsFiles.length,
            availableAgentsFiles: cardAvailableAgentsFiles.length,
            skills: cardSkills.length,
            agentProviders: cardAgentProviders.length,
            agents: cardAgents.length,
          },
        }),
      });

      return {
        content: resultContent,
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          ...(continuation ? { continuation } : {}),
          instruction,
        },
      };
    },
  );

  server.registerTool(
    "checkpoint",
    {
      title: "Save workspace checkpoint",
      description:
        "Save a compact continuation checkpoint for this workspace after a meaningful milestone, before switching tasks, or when the user pauses work. Store project state and decisions, not the full conversation or secrets. A checkpoint updates the workspace resume state used by future ChatGPT conversations.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        goal: z.string().min(1).describe("Overall project goal that should survive into the next conversation."),
        currentTask: z.string().min(1).describe("The task or phase currently in progress."),
        completed: z.array(z.string()).optional().describe("Important work already completed."),
        decisions: z.array(z.string()).optional().describe("Important implementation or product decisions and their concise rationale."),
        files: z.array(z.string()).optional().describe("Important workspace-relative files involved in the current work."),
        verification: z.array(z.string()).optional().describe("Tests, builds, checks, or other verification already completed."),
        blockers: z.array(z.string()).optional().describe("Current blockers, unresolved problems, or risks."),
        next: z.array(z.string()).optional().describe("Concrete next steps for continuing the work."),
      },
      outputSchema: resultOutputSchema({
        checkpointId: z.string(),
        updatedAt: z.string(),
        state: workspaceResumeStateOutputSchema,
        facts: workspaceMemoryFactsOutputSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...input }, { _meta }) => {
      const startedAt = performance.now();
      const { workspace, state, facts, checkpoint } = await saveWorkspaceCheckpoint(
        workspaceId,
        input,
        openAiConversationScopeId(_meta),
        startedAt,
        "tool",
      );
      const result = `Saved workspace checkpoint ${checkpoint.id} for ${workspace.root} at ${checkpoint.createdAt}.`;
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          checkpointId: checkpoint.id,
          updatedAt: checkpoint.createdAt,
          state,
          facts,
        },
      };
    },
  );

  server.registerTool(
    "history_search",
    {
      title: "Search workspace checkpoints",
      description:
        "Search compact historical checkpoints for the current workspace when the resume state lacks a needed prior decision or the user asks what happened in earlier work. This searches saved project state, not full ChatGPT transcripts.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        query: z.string().default("").describe("Keyword or phrase to find in saved goals, tasks, decisions, files, blockers, or next steps. Leave empty to list recent checkpoints."),
        limit: z.number().int().min(1).max(10).optional().describe("Maximum checkpoint summaries to return. Defaults to 5."),
      },
      outputSchema: resultOutputSchema({
        matches: z.array(z.object({
          checkpointId: z.string(),
          createdAt: z.string(),
          goal: z.string(),
          currentTask: z.string(),
          decisions: z.array(z.string()),
          files: z.array(z.string()),
          blockers: z.array(z.string()),
          next: z.array(z.string()),
          gitHead: z.string().optional(),
          stale: z.boolean(),
        })),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, query, limit }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const checkpoints = await workspaces.searchCheckpoints(workspace, query, limit ?? 5);
      const currentFacts = await captureWorkspaceFacts(workspace.root);
      const matches = checkpoints.map((checkpoint) => ({
        checkpointId: checkpoint.id,
        createdAt: checkpoint.createdAt,
        goal: checkpoint.state.goal,
        currentTask: checkpoint.state.currentTask,
        decisions: checkpoint.state.decisions,
        files: checkpoint.state.files,
        blockers: checkpoint.state.blockers,
        next: checkpoint.state.next,
        gitHead: checkpoint.facts.gitHead,
        stale: Boolean(
          checkpoint.facts.gitHead
            && currentFacts.gitHead
            && checkpoint.facts.gitHead !== currentFacts.gitHead,
        ),
      }));
      const result = matches.length === 0
        ? `No saved checkpoints matched ${query.trim() ? JSON.stringify(query.trim()) : "this workspace"}.`
        : matches.map((match) => [
            `${match.checkpointId} (${match.createdAt})${match.stale ? " [stale]" : ""}`,
            `Goal: ${match.goal}`,
            `Task: ${match.currentTask}`,
            match.next.length > 0 ? `Next: ${match.next.join("; ")}` : undefined,
          ].filter(Boolean).join("\n")).join("\n\n");
      logToolCall(config, {
        tool: "history_search",
        workspaceId,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("history_search", {
          workspaceId,
          path: workspace.root,
          query,
          matches,
          summary: { count: matches.length },
        }),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, matches },
      };
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.read, {
          workspaceId,
          path: input.path,
          summary,
          payload: { content: response.content },
        }),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  server.registerTool(
    "move_file",
    {
      title: "Move file or directory",
      description:
        "Move or rename one file or directory inside a workspace. The destination parent must already exist and the destination must not already exist.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        source: z.string().min(1).describe("Existing source path relative to the workspace root."),
        destination: z.string().min(1).describe("Unused destination path relative to the workspace root."),
      },
      outputSchema: resultOutputSchema({
        source: z.string(),
        destination: z.string(),
      }),
      _meta: {},
      annotations: MOVE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, source, destination }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const moved = await moveWorkspacePath(workspace.root, source, destination);
      const result = `Moved ${moved.source} to ${moved.destination}.`;
      logToolCall(config, {
        tool: "move_file",
        workspaceId,
        path: moved.source,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("move_file", {
          workspaceId,
          path: moved.source,
          summary: {
            source: moved.source,
            destination: moved.destination,
          },
          files: [
            { path: moved.destination, previousPath: moved.source, operation: "move" },
          ],
        }),
      });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          source: moved.source,
          destination: moved.destination,
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.write, {
          workspaceId,
          path: input.path,
          summary,
          payload: {
            content: response.content,
            patch,
          },
        }),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.edit, {
          workspaceId,
          path: input.path,
          summary,
          payload: {
            diff: response.details?.diff,
            patch: response.details?.patch,
          },
        }),
      });

      return {
        content: editContent,
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    server.registerTool(
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi("apply_patch", {
            workspaceId,
            path: displayPath,
            summary: {
              files: applied.files.length,
              additions: applied.additions,
              removals: applied.removals,
            },
            files: applied.files,
            payload: { patch: applied.patch },
          }),
        });

        return {
          content,
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    server.registerTool(
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.grep, {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        return {
          ...response,
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    server.registerTool(
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.glob, {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        return {
          ...response,
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    server.registerTool(
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory in a workspace. Use this for directory inspection before reading files.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.ls, {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        return {
          ...response,
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command in a workspace. Use only for tests, builds, git inspection, approved Git metadata writes, package scripts, search, file discovery, and directory inspection. ${SHELL_GIT_WRITE_ALLOWANCE} In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Except for the approved Git metadata writes, do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Legacy checkpoint compatibility: command exactly \`checkpoint\` is intercepted by DevSpace and is never executed by the shell; follow the returned instruction immediately. This is powerful execution and should only be exposed behind strong authentication.`
        : `Run a shell command in a workspace. Use only for tests, builds, git inspection, approved Git metadata writes, package scripts, and commands that are better executed by the shell. ${SHELL_GIT_WRITE_ALLOWANCE} Except for the approved Git metadata writes, do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Legacy checkpoint compatibility: command exactly \`checkpoint\` is intercepted by DevSpace and is never executed by the shell; follow the returned instruction immediately. This is powerful execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        command: z
          .string()
          .describe(
            `Shell command to run. ${SHELL_GIT_WRITE_ALLOWANCE} Except for those Git metadata writes, do not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const legacyCheckpoint = parseLegacyCheckpointCommand(input.command);

      if (legacyCheckpoint?.kind === "prepare") {
        const result = [
          "DEVSPACE_CHECKPOINT_STATE_REQUIRED",
          "The user asked to save this legacy conversation as a workspace checkpoint.",
          "Do not ask the user any follow-up question. Immediately call this same bash tool again for the same workspaceId.",
          "The command must start with `checkpoint ` followed by one JSON object containing the semantic state you can infer from the current conversation.",
          "Required JSON fields: goal, currentTask. Optional array fields: completed, decisions, files, verification, blockers, next.",
          "Example: checkpoint {\"goal\":\"Continue the project\",\"currentTask\":\"Finish the current phase\",\"completed\":[],\"decisions\":[],\"files\":[],\"verification\":[],\"blockers\":[],\"next\":[]}",
          "DevSpace will intercept the second command too; neither command is executed by the operating system.",
        ].join("\n");
        return {
          content: [textBlock(result)],
          structuredContent: { result },
        };
      }

      if (legacyCheckpoint?.kind === "save") {
        const { checkpoint } = await saveWorkspaceCheckpoint(
          workspaceId,
          legacyCheckpoint.state,
          openAiConversationScopeId(_meta),
          startedAt,
          "legacy-bash",
        );
        const result = `Saved legacy conversation checkpoint ${checkpoint.id} for ${workspace.root} at ${checkpoint.createdAt}.`;
        return {
          content: [textBlock(result)],
          structuredContent: { result },
        };
      }

      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        outputPreview: consoleOutputPreview(contentText(response.content)),
        consoleUi: consoleToolUi(toolNames.shell, {
          workspaceId,
          path: workingDirectory,
          summary,
          payload: { content: response.content },
        }),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode !== "minimal") {
    registerManagedProcessTools(server, config, workspaces, processSessions);
  }

  if (config.subagents) {
    if (!localAgentStore) {
      throw new Error("Subagent tools require a LocalAgentStore.");
    }
    registerLocalAgentTools(server, config, workspaces, localAgentStore);
  }

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const processSessions = new ProcessSessionManager();
  const consoleEvents = new ConsoleEventStore(2_000, config.stateDir);
  bindConsoleEventStore(config, consoleEvents);
  const localAgentStore = config.subagents ? createLocalAgentStore(config) : undefined;
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json(createHealthStatus());
  });

  app.get("/statusz", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(createRuntimeStatus(config));
  });

  app.get("/console/snapshot", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const workspaceSessions = workspaceStore.listSessions(200);
    const runningWorkspaceIds = workspaceSessions
      .filter((session) => processSessions.list(session.id, false).length > 0)
      .map((session) => session.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      server: createHealthStatus(),
      streamSubscribers: consoleEvents.subscriberCount(),
      settings: consoleEvents.settings(),
      workspaceEventCounts: consoleEvents.countsByWorkspaceRoot(),
      runningWorkspaceIds,
      workspaces: workspaceSessions,
      events: consoleEvents.recent(limit),
    });
  });

  app.post("/console/workspaces", express.json(), async (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const requestedPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ ok: false, error: "path is required." });
      return;
    }

    try {
      const canonicalPath = await realpath(requestedPath);
      const existing = workspaceStore.listSessions(500).find((session) =>
        session.mode === "checkout"
        && (process.platform === "win32"
          ? session.root.toLowerCase() === canonicalPath.toLowerCase()
          : session.root === canonicalPath));

      if (existing) {
        workspaces.getWorkspace(existing.id);
        workspaceStore.touchSession(existing.id);
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, workspace: workspaceStore.getSession(existing.id), reused: true });
        return;
      }

      const context = await workspaces.openWorkspace({ path: canonicalPath, mode: "checkout" });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({
        ok: true,
        workspace: workspaceStore.getSession(context.workspace.id),
        reused: false,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/console/processes", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceRoot = typeof req.query.workspaceRoot === "string"
      ? req.query.workspaceRoot.trim()
      : "";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required." });
      return;
    }

    const matchingSessions = workspaceStore.listSessions(500).filter((session) =>
      process.platform === "win32"
        ? session.root.toLowerCase() === workspaceRoot.toLowerCase()
        : session.root === workspaceRoot);
    const processes = matchingSessions
      .flatMap((session) => processSessions.list(session.id, true).map((processInfo) => ({
        workspaceId: session.id,
        ...processInfo,
      })))
      .sort((a, b) => b.startedAt - a.startedAt);

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, processes });
  });

  app.get("/console/processes/:sessionId/output", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    const sessionId = Number(req.params.sessionId);
    if (!workspaceId || !Number.isInteger(sessionId) || sessionId < 1) {
      res.status(400).json({ ok: false, error: "Valid workspaceId and sessionId are required." });
      return;
    }

    try {
      workspaces.getWorkspace(workspaceId);
      const snapshot = processSessions.peek(workspaceId, sessionId, 50_000);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, snapshot });
    } catch (error) {
      res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/console/processes/:sessionId/terminate", express.json(), async (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    const sessionId = Number(req.params.sessionId);
    if (!workspaceId || !Number.isInteger(sessionId) || sessionId < 1) {
      res.status(400).json({ ok: false, error: "Valid workspaceId and sessionId are required." });
      return;
    }

    try {
      workspaces.getWorkspace(workspaceId);
      const processInfo = await processSessions.terminate(workspaceId, sessionId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, process: processInfo });
    } catch (error) {
      res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/console/history", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceRoot = typeof req.query.workspaceRoot === "string"
      ? req.query.workspaceRoot.trim()
      : "";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required." });
      return;
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 250))
      : 100;
    const before = typeof req.query.before === "string" && req.query.before
      ? req.query.before
      : undefined;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...consoleEvents.history({ workspaceRoot, before, limit }),
    });
  });

  app.get("/console/memory", async (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceRoot = typeof req.query.workspaceRoot === "string"
      ? req.query.workspaceRoot.trim()
      : "";
    const mode = req.query.mode === "worktree" ? "worktree" : "checkout";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required." });
      return;
    }

    try {
      const memory = await workspaces.getMemorySnapshotByRoot(workspaceRoot, mode, 20);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, ...memory });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/console/memory/resume", async (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceRoot = typeof req.query.workspaceRoot === "string"
      ? req.query.workspaceRoot.trim()
      : "";
    const mode = req.query.mode === "worktree" ? "worktree" : "checkout";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required." });
      return;
    }

    try {
      const cleared = await workspaces.clearResumeStateByRoot(workspaceRoot, mode);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, cleared });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/console/events/:id/favorite", express.json(), (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    if (typeof req.body?.favorite !== "boolean") {
      res.status(400).json({ ok: false, error: "favorite must be a boolean." });
      return;
    }

    const event = consoleEvents.setFavorite(req.params.id, req.body.favorite);
    if (!event) {
      res.status(404).json({ ok: false, error: "Console event not found." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, event });
  });

  app.post("/console/cleanup", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, settings: consoleEvents.cleanupExpired() });
  });

  app.delete("/console/events", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, settings: consoleEvents.clearEvents() });
  });

  app.put("/console/settings", express.json(), (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const retentionDays = Number(req.body?.retentionDays);
    if (
      !Number.isInteger(retentionDays)
      || retentionDays < MIN_CONSOLE_RETENTION_DAYS
      || retentionDays > MAX_CONSOLE_RETENTION_DAYS
    ) {
      res.status(400).json({
        ok: false,
        error: `retentionDays must be an integer between ${MIN_CONSOLE_RETENTION_DAYS} and ${MAX_CONSOLE_RETENTION_DAYS}.`,
      });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, settings: consoleEvents.setRetentionDays(retentionDays) });
  });

  app.get("/console/events", (req, res) => {
    const ownerToken = req.header("x-devspace-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");

    const unsubscribe = consoleEvents.subscribe((event) => {
      res.write(`id: ${event.id}\n`);
      res.write("event: tool_call\n");
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
          localAgentStore,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        oauthProvider.close();
        localAgentStore?.close();
        closeConsoleEventStore(config);
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

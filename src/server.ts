import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as readTextFile, writeFile as writeTextFile, realpath } from "node:fs/promises";
import { extname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
import { ConcurrentRequestLimiter, McpRequestOptimizer, smartTruncateOutput } from "./mcp-request-optimizer.js";
import { readImageFile } from "./image-utils.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
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
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { moveWorkspacePath } from "./move-file.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createHealthStatus, createRuntimeStatus } from "./runtime-status.js";
import { applySkillToTarget, formatPathForPrompt, listAllSkillsInfo, removeSkillFromTarget } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  buildWorkspaceContinuation,
  captureWorkspaceFacts,
  normalizeResumeState,
  type WorkspaceResumeStateInput,
} from "./workspace-memory.js";
import { formatAgentsPath, WorkspaceRegistry, type Workspace } from "./workspaces.js";
import { WEBMCP_VERSION } from "./version.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
import { loadWebmcpFiles, webmcpConfigPath, writeWebmcpConfig } from "./user-config.js";
import { resolve } from "node:path";
import {
  bindConsoleEventStore,
  closeConsoleEventStore,
  consoleEventStoreFor,
  ConsoleEventStore,
  MAX_CONSOLE_RETENTION_DAYS,
  MIN_CONSOLE_RETENTION_DAYS,
  type ConsoleToolUi,
} from "./console-events.js";

import * as Diff from "diff";
import {
  getSymbolsOverview,
  formatSymbolsOverview,
  findSymbol,
  replaceSymbolBody,
  insertSymbol,
  checkSyntaxDiagnostics,
  applySmartEdit,
} from "./symbols/index.js";

const LEGACY_CHECKPOINT_PREFIX = "checkpoint";
const workspaceTodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
const workspaceTodoReportModeSchema = z.enum(["each", "summary"]);
const workspaceTodoInputSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1),
  status: workspaceTodoStatusSchema.optional(),
});
const workspaceTodoOutputSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: workspaceTodoStatusSchema,
});

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
interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
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
  readImage: "read_image",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
  applyPatch: "apply_patch",
  codeExplore: "code_explore",
  skillsList: "skills_list",
  skillRead: "skill_read",
  getSymbolsOverview: "get_symbols_overview",
  findSymbol: "find_symbol",
  replaceSymbolBody: "replace_symbol_body",
  insertSymbol: "insert_symbol",
} as const;

const workspaceIdDescription =
  "Optional after open_workspace. Omit it to use the workspace bound to the current ChatGPT conversation; pass it explicitly for compatibility or when disambiguation is required.";

function optionalWorkspaceIdSchema() {
  return z.string().optional().describe(workspaceIdDescription);
}

function resolveToolWorkspace(
  workspaces: WorkspaceRegistry,
  workspaceId: string | undefined,
  meta: unknown,
): Workspace {
  if (workspaceId) return workspaces.getWorkspace(workspaceId);

  const conversationScopeId = openAiConversationScopeId(meta);
  const workspace = conversationScopeId
    ? workspaces.getConversationWorkspace(conversationScopeId)
    : undefined;
  if (workspace) return workspace;

  throw new Error(
    "No workspace is bound to this conversation. Call open_workspace first, or pass workspaceId explicitly.",
  );
}

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
    ? " When the user supplies or generates a file that is not present on the WebMCP host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const memoryInstruction =
    " Use checkpoint only at meaningful milestones, before switching tasks, or when the user pauses work; do not checkpoint after every tool call. Use history_search only when a previous checkpoint is needed to recover an older decision or detail that is not in the current continuation. Compatibility: if the user says exactly `checkpoint` but this conversation does not expose the checkpoint tool, use the existing bash tool with command `checkpoint` and immediately follow the returned machine instruction without asking the user for more input.";

  if (config.toolMode === "codex") {
    return `Use WebMCP for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree. That call binds the current ChatGPT conversation to the workspace, so subsequent tools should normally omit workspaceId; pass it only for compatibility or disambiguation. Open another workspace only when changing projects or creating another isolated worktree. Use ${toolNames.codeExplore} for compact source structure, ${toolNames.read} for one or several direct file reads, ${toolNames.applyPatch} for transactional multi-file content changes, move_file for explicit moves or renames, and exec_command for inspection, tests, builds, and other commands. ${SHELL_GIT_WRITE_ALLOWANCE} Use ${toolNames.skillsList} only when skill discovery is relevant, then ${toolNames.skillRead} for one matching skill. Use write_stdin to poll or interact with running processes, list_processes/get_process to inspect managed process state without consuming output, and kill_process to terminate a managed process session. When invoking WebMCP tools, you may provide a brief Chinese description in \`purpose\` explaining what you are doing (e.g. '重构 getXmSign 函数体', '运行单元测试'). Follow instructions returned by ${toolNames.openWorkspace}. Keep final user responses concise. Do not reprint entire file contents or long terminal logs in the chat unless specifically requested.${memoryInstruction}${artifactInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When a task may match a skill, use ${toolNames.skillsList} to discover available skills and ${toolNames.skillRead} to load only the matching skill before proceeding. Do not enumerate or preload skills when they are irrelevant. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Always provide a concise Chinese description in the \`purpose\` argument of each tool call explaining the user-facing goal (e.g. '重构 getXmSign 函数实现', '运行测试套件'). Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  const managedProcessInstruction = config.toolMode === "full"
    ? " Use exec_command for long-running or interactive commands, write_stdin to poll or interact with them, list_processes/get_process to inspect managed process state without consuming output, and kill_process to terminate a managed process session."
    : "";

  return `Use WebMCP for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree. That call binds the current ChatGPT conversation to the workspace, so subsequent tools should normally omit workspaceId; pass it only for compatibility or disambiguation. Open another workspace only when changing projects or creating another isolated worktree. ${agentsMd}${skills}${inspection}Prefer ${toolNames.codeExplore} for compact source structure, ${toolNames.read} for one or several direct file reads, ${toolNames.applyPatch} for transactional multi-file modifications, ${toolNames.edit} for a small single-file exact replacement, ${toolNames.write} only for new files or complete rewrites, move_file for moves or renames, and ${toolNames.shell} for one-shot tests, builds, git inspection, package scripts, and commands that are better executed by the shell. ${SHELL_GIT_WRITE_ALLOWANCE} Except for that Git metadata exception, do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${managedProcessInstruction}${memoryInstruction}${artifactInstruction}`;
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

const MODEL_READ_MAX_CHARACTERS = 24_000;
const MODEL_SEARCH_MAX_CHARACTERS = 12_000;
const MODEL_COMMAND_MAX_CHARACTERS = 12_000;
const MODEL_ERROR_MAX_CHARACTERS = 6_000;
const CODE_EXPLORE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".dart", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
const CODE_SYMBOL_PATTERN = /^\s*(?:export\s+)?(?:abstract\s+|final\s+|sealed\s+|static\s+|async\s+)*(class|mixin|enum|extension|typedef|interface|struct|func|function|def|fn)\s+([A-Za-z_][\w]*)/;

function truncateModelText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  const result = smartTruncateOutput(text, { maxCharacters });
  return {
    text: result.text,
    truncated: result.truncated,
  };
}

function boundedModelText(content: ToolContent[], maxCharacters: number): { text: string; truncated: boolean } {
  return truncateModelText(contentText(content), maxCharacters);
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
  const rawResult = processResult(snapshot);
  const bounded = truncateModelText(rawResult, MODEL_COMMAND_MAX_CHARACTERS);
  const result = bounded.text;
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
      outputTruncated: snapshot.outputTruncated || bounded.truncated,
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
        workspaceId: optionalWorkspaceIdSchema(),
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
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId: workspace.id,
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
        workspaceId: workspace.id,
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
          workspaceId: workspace.id,
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

      return processToolResponse("exec_command", workspace.id, snapshot, {
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
        workspaceId: optionalWorkspaceIdSchema(),
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
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const snapshot = await processSessions.write({
        workspaceId: workspace.id,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId: workspace.id,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        sessionId,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        outputPreview: consoleOutputPreview(snapshot.output),
        consoleUi: consoleToolUi("write_stdin", {
          workspaceId: workspace.id,
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

      return processToolResponse("write_stdin", workspace.id, snapshot, {
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
        workspaceId: optionalWorkspaceIdSchema(),
        includeCompleted: z
          .boolean()
          .optional()
          .describe("Include recently completed sessions retained by WebMCP. Defaults to true."),
      },
      outputSchema: resultOutputSchema({
        processes: z.array(processInfoSchema()),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, includeCompleted }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const processes = processSessions.list(workspace.id, includeCompleted ?? true);
      const result = processes.length === 0
        ? "No managed process sessions found."
        : `${processes.length} managed process session${processes.length === 1 ? "" : "s"}.`;
      logToolCall(config, {
        tool: "list_processes",
        workspaceId: workspace.id,
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
        workspaceId: optionalWorkspaceIdSchema(),
        sessionId: z.number().int().positive().describe("Managed process session identifier."),
      },
      outputSchema: resultOutputSchema({
        process: processInfoSchema(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, sessionId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const processInfo = processSessions.get(workspace.id, sessionId);
      const result = processInfo.running
        ? `Process session ${sessionId} is running.`
        : `Process session ${sessionId} has completed.`;
      logToolCall(config, {
        tool: "get_process",
        workspaceId: workspace.id,
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
        "Terminate a managed process session. WebMCP first requests graceful termination, waits briefly, then force-kills the process tree if it is still running.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
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
    async ({ workspaceId, sessionId, gracePeriodMs }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const processInfo = await processSessions.terminate(workspace.id, sessionId, gracePeriodMs);
      const result = processInfo.running
        ? `Force termination was sent to process session ${sessionId}, but it still reports as running.`
        : `Process session ${sessionId} terminated.`;
      logToolCall(config, {
        tool: "kill_process",
        workspaceId: workspace.id,
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

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
): McpServer {
  const server = new McpServer(
    {
      name: "webmcp",
      title: "WebMCP",
      version: WEBMCP_VERSION,
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
        skillCount: z.number().int().nonnegative().optional(),
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
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "This conversation is now bound to this workspace; subsequent tools should normally omit workspaceId. When calling tools, specify a concise Chinese summary in `purpose` (max 80 chars) explaining your intent to the user. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. Use skills_list only when skill discovery is relevant, then skill_read for the matching skill."
        : "This conversation is now bound to this workspace; subsequent tools should normally omit workspaceId. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with the workspace already bound to this conversation.",
            "Keep following the project instructions and use lazy capability discovery when needed.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "This conversation is now bound to this isolated worktree. Follow the project instructions and use lazy capability discovery when needed."
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
            config.skillsEnabled && includeBootstrapContext && cardSkills.length > 0
              ? `${cardSkills.length} skill(s) available; use skills_list only if this task needs one.`
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
                skillCount: cardSkills.length,
              }
            : {}),
          ...(continuation ? { continuation } : {}),
          instruction,
        },
      };
    },
  );

  if (config.skillsEnabled) {
    server.registerTool(
      toolNames.skillsList,
      {
        title: "List workspace skills",
        description:
          "List skills available to the workspace. Call this only when the current task may match a skill; use skill_read to load one matching skill.",
        inputSchema: {
          workspaceId: optionalWorkspaceIdSchema(),
        },
        outputSchema: resultOutputSchema({
          count: z.number().int().nonnegative(),
          skills: z.array(workspaceSkillOutputSchema),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        const skills = workspace.skills
          .filter((skill) => !skill.disableModelInvocation)
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
          }));
        const result = skills.length > 0
          ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
          : "No model-invokable skills are available for this workspace.";
        logToolCall(config, {
          tool: toolNames.skillsList,
          workspaceId: workspace.id,
          path: workspace.root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.skillsList, {
            workspaceId: workspace.id,
            path: workspace.root,
            summary: { count: skills.length },
          }),
        });
        return {
          content: [textBlock(result)],
          structuredContent: { result, count: skills.length, skills },
        };
      },
    );

    server.registerTool(
      toolNames.skillRead,
      {
        title: "Read workspace skill",
        description:
          "Read the full SKILL.md body for one skill returned by skills_list. Do not load unrelated skills.",
        inputSchema: {
          workspaceId: optionalWorkspaceIdSchema(),
          name: z.string().min(1).describe("Skill name returned by skills_list."),
        },
        outputSchema: resultOutputSchema({
          name: z.string(),
          description: z.string(),
          path: z.string(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, name }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        const skill = workspace.skills.find(
          (candidate) => candidate.name === name && !candidate.disableModelInvocation,
        );
        if (!skill) {
          const message = `Unknown or unavailable skill: ${name}. Use skills_list first.`;
          return { isError: true, content: [textBlock(message)] };
        }

        const readPath = workspaces.resolveReadPath(workspace, skill.filePath);
        const response = await readFileTool(
          { path: readPath.absolutePath },
          {
            cwd: workspace.root,
            root: workspace.root,
            readRoots: readPath.readRoots,
          },
        );
        if (response.isError) {
          const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
          return { ...response, content: [textBlock(bounded.text)] };
        }
        workspaces.markReadPathLoaded(workspace, readPath);
        const bounded = boundedModelText(response.content, MODEL_READ_MAX_CHARACTERS);
        const result = bounded.text;
        logToolCall(config, {
          tool: toolNames.skillRead,
          workspaceId: workspace.id,
          path: formatPathForPrompt(skill.filePath),
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.skillRead, {
            workspaceId: workspace.id,
            path: formatPathForPrompt(skill.filePath),
            summary: { name: skill.name, ...textSummary(response.content) },
            payload: { content: response.content },
          }),
        });
        return {
          ...response,
          content: [textBlock(result)],
          structuredContent: {
            result,
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
          },
        };
      },
    );
  }

  server.registerTool(
    "todo_write",
    {
      title: "Write workspace todo list",
      description:
        "Create or replace the lightweight todo list for the current workspace. Use this to persist the model's current execution checklist. This is separate from checkpoints and is not a Goal system.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        todos: z.array(workspaceTodoInputSchema).max(100).describe("Complete todo list in execution order."),
        reportMode: workspaceTodoReportModeSchema.optional().describe("Use summary when the user requested a final report after all items are complete."),
      },
      outputSchema: resultOutputSchema({
        todos: z.array(workspaceTodoOutputSchema),
        reportMode: workspaceTodoReportModeSchema,
        updatedAt: z.string(),
      }),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, todos, reportMode }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const ids = new Set<string>();
      const normalizedTodos = todos.map((todo) => {
        const id = todo.id?.trim() || randomUUID();
        if (ids.has(id)) {
          throw new Error(`Duplicate todo id: ${id}`);
        }
        ids.add(id);
        return {
          id,
          content: todo.content.trim(),
          status: todo.status ?? "pending" as const,
        };
      });
      const saved = await workspaces.saveTodos(workspace, normalizedTodos, reportMode);
      const result = normalizedTodos.length === 0
        ? "Cleared workspace todo list."
        : `Saved ${normalizedTodos.length} workspace todo(s).`;
      logToolCall(config, {
        tool: "todo_write",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("todo_write", {
          workspaceId: workspace.id,
          path: workspace.root,
          todos: saved.todos,
          summary: { count: saved.todos.length },
        }),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, todos: saved.todos, reportMode: saved.reportMode, updatedAt: saved.updatedAt },
      };
    },
  );

  server.registerTool(
    "todo_update",
    {
      title: "Update workspace todo",
      description:
        "Update one item in the workspace todo list by id. Use this as work starts or completes so the checklist remains current. When reportMode is summary, do not report completion until all items are completed.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        id: z.string().min(1).describe("Todo id returned by todo_write."),
        status: workspaceTodoStatusSchema.describe("New todo status."),
        content: z.string().min(1).optional().describe("Optional replacement todo text."),
      },
      outputSchema: resultOutputSchema({
        todo: workspaceTodoOutputSchema,
        todos: z.array(workspaceTodoOutputSchema),
        shouldReport: z.boolean(),
        updatedAt: z.string(),
      }),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, id, status, content }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const current = await workspaces.getTodos(workspace);
      if (!current) {
        throw new Error("No todo list exists for this workspace. Call todo_write first.");
      }
      const index = current.todos.findIndex((todo) => todo.id === id);
      if (index < 0) {
        throw new Error(`Todo not found: ${id}`);
      }
      const updatedTodo = {
        ...current.todos[index],
        status,
        ...(content !== undefined ? { content: content.trim() } : {}),
      };
      const todos = [...current.todos];
      todos[index] = updatedTodo;
      const saved = await workspaces.saveTodos(workspace, todos, current.reportMode);
      const result = `Updated todo ${id} to ${status}.`;
      logToolCall(config, {
        tool: "todo_update",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("todo_update", {
          workspaceId: workspace.id,
          path: workspace.root,
          todo: updatedTodo,
          todos: saved.todos,
          summary: { status },
        }),
      });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          todo: updatedTodo,
          todos: saved.todos,
          shouldReport: saved.todos.every((todo) => todo.status === "completed"),
          updatedAt: saved.updatedAt,
        },
      };
    },
  );

    server.registerTool(
    "summary",
    {
      title: "Round summary",
      description:
        "Optional end-of-round tool to mark completion of the current user request. Provide a concise 1-paragraph summary of what was completed, verified, or changed. Do not use bullets or line breaks.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        title: z.string().max(80).optional().describe("Optional short title for this round summary."),
        summary: z.string().min(1).max(600).describe("One concise user-facing paragraph summarizing the result."),
      },
      outputSchema: resultOutputSchema({
        title: z.string(),
        summary: z.string(),
        endedAt: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, title, summary }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const text = summary.replace(/\s+/g, " ").trim();
      const resultTitle = title?.trim() || "本轮处理完成";
      logToolCall(config, {
        tool: "summary",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("summary", {
          workspaceId: workspace.id,
          path: workspace.root,
          summary: { title: resultTitle, summary: text },
        }),
      });
      return {
        content: [textBlock(text)],
        structuredContent: {
          result: `Summary: ${resultTitle}`,
          title: resultTitle,
          summary: text,
          endedAt: new Date().toISOString(),
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
        workspaceId: optionalWorkspaceIdSchema(),
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
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const { state, facts, checkpoint } = await saveWorkspaceCheckpoint(
        workspace.id,
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
        workspaceId: optionalWorkspaceIdSchema(),
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
    async ({ workspaceId, query, limit }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
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
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("history_search", {
          workspaceId: workspace.id,
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
    toolNames.readImage,
    {
      title: "Read image",
      description:
        "Read an image file from the workspace as multimodal image content (PNG, JPEG, WebP, GIF, SVG, BMP, ICO). Use this when inspecting UI screenshots, diagrams, assets, or visual output.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().min(1).describe("Image file path relative to the workspace root."),
      },
      outputSchema: resultOutputSchema({
        mimeType: z.string(),
        sizeBytes: z.number(),
        extension: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const absolutePath = workspaces.resolvePath(workspace, path);
      try {
        const imageResult = await readImageFile(absolutePath);
        const result = `Loaded image ${path} (${imageResult.mimeType}, ${(imageResult.sizeBytes / 1024).toFixed(1)} KB)`;
        logToolCall(config, {
          tool: toolNames.readImage,
          workspaceId: workspace.id,
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.readImage, {
            workspaceId: workspace.id,
            path,
            summary: {
              mimeType: imageResult.mimeType,
              sizeBytes: imageResult.sizeBytes,
            },
          }),
        });

        return {
          content: [
            {
              type: "image" as const,
              data: imageResult.base64Data,
              mimeType: imageResult.mimeType,
            },
            textBlock(result),
          ],
          structuredContent: {
            result,
            mimeType: imageResult.mimeType,
            sizeBytes: imageResult.sizeBytes,
            extension: imageResult.extension,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logFailedToolResponse(
          config,
          { tool: toolNames.readImage, workspaceId: workspace.id, path },
          [textBlock(errorMessage)],
          startedAt,
        );
        return {
          isError: true,
          content: [textBlock(errorMessage)],
        };
      }
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read files",
      description:
        "Read one file with path, or several files with paths (max 20). Prefer one multi-file call when several known files are needed. For nested AGENTS.md or CLAUDE.md instructions, read the listed instruction file before working in its scope. Use skill_read rather than read for skill discovery.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().min(1).optional().describe("One file path relative to the workspace root."),
        paths: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Several file paths to read in one call. Maximum 20."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from, applied to every selected file."),
        limit: z
          .number()
          .int()
          .positive()
          .max(2_000)
          .optional()
          .describe("Maximum lines per file. Multi-file reads default to 400 lines per file."),
      },
      outputSchema: resultOutputSchema({
        files: z.array(
          z.object({
            path: z.string(),
            ok: z.boolean(),
            characters: z.number().int().nonnegative(),
            error: z.string().optional(),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path, paths, offset, limit }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const targets = [
        ...(path?.trim() ? [path.trim()] : []),
        ...((paths ?? []).map((item) => item.trim()).filter(Boolean)),
      ];
      const uniqueTargets = [...new Set(targets)].slice(0, 20);
      if (uniqueTargets.length === 0) {
        return {
          isError: true,
          content: [textBlock("path or paths is required")],
        };
      }

      const perFileLimit = limit ?? (uniqueTargets.length > 1 ? 400 : undefined);
      const rendered: string[] = [];
      const files: Array<{ path: string; ok: boolean; characters: number; error?: string }> = [];
      const consoleFiles: Array<{ path: string; content: ToolContent[]; error?: string }> = [];

      for (const target of uniqueTargets) {
        try {
          const readPath = workspaces.resolveReadPath(workspace, target);
          const response = await readFileTool(
            {
              path: readPath.absolutePath,
              offset,
              limit: perFileLimit,
            },
            {
              cwd: workspace.root,
              root: workspace.root,
              readRoots: readPath.readRoots,
            },
          );
          const rawText = contentText(response.content);
          if (response.isError) {
            const error = truncateModelText(rawText, MODEL_ERROR_MAX_CHARACTERS).text;
            if (uniqueTargets.length > 1) rendered.push(`=== ${target} (error) ===\n${error}`);
            else rendered.push(error);
            files.push({ path: target, ok: false, characters: rawText.length, error });
            consoleFiles.push({ path: target, content: response.content, error: rawText });
            continue;
          }

          workspaces.markReadPathLoaded(workspace, readPath);
          if (uniqueTargets.length > 1) rendered.push(`=== ${target} ===\n${rawText}`);
          else rendered.push(rawText);
          files.push({ path: target, ok: true, characters: rawText.length });
          consoleFiles.push({ path: target, content: response.content });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (uniqueTargets.length > 1) rendered.push(`=== ${target} (error) ===\n${message}`);
          else rendered.push(message);
          files.push({ path: target, ok: false, characters: 0, error: message });
          consoleFiles.push({ path: target, content: [], error: message });
        }
      }

      const rawResult = rendered.join("\n");
      const bounded = truncateModelText(rawResult, MODEL_READ_MAX_CHARACTERS);
      const success = files.some((file) => file.ok);
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId: workspace.id,
        path: uniqueTargets.length === 1 ? uniqueTargets[0] : `${uniqueTargets.length} files`,
        success,
        durationMs: Math.round(performance.now() - startedAt),
        error: success ? undefined : files.map((file) => file.error).filter(Boolean).join("; "),
        consoleUi: consoleToolUi(toolNames.read, {
          workspaceId: workspace.id,
          path: uniqueTargets.length === 1 ? uniqueTargets[0] : `${uniqueTargets.length} files`,
          summary: {
            files: files.length,
            ok: files.filter((file) => file.ok).length,
            characters: rawResult.length,
            modelTruncated: bounded.truncated,
            offset: offset ?? 1,
            limit: perFileLimit,
          },
          payload: { files: consoleFiles },
        }),
      });

      return {
        ...(success ? {} : { isError: true }),
        content: [textBlock(bounded.text)],
        structuredContent: {
          result: bounded.text,
          files,
          truncated: bounded.truncated || targets.length > uniqueTargets.length,
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
        workspaceId: optionalWorkspaceIdSchema(),
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
    async ({ workspaceId, source, destination }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const moved = await moveWorkspacePath(workspace.root, source, destination);
      const result = `Moved ${moved.source} to ${moved.destination}.`;
      logToolCall(config, {
        tool: "move_file",
        workspaceId: workspace.id,
        path: moved.source,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi("move_file", {
          workspaceId: workspace.id,
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
        workspaceId: optionalWorkspaceIdSchema(),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId: workspace.id,
          path: input.path,
        }, response.content, startedAt);
        const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
        return { ...response, content: [textBlock(bounded.text)] };
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
        workspaceId: workspace.id,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.write, {
          workspaceId: workspace.id,
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
        `Edit one file in a workspace by replacing text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file (supports \".*?\" non-greedy regex wildcards for robust pattern matching). Automatically normalizes CRLF/LF line endings and performs syntax validation on modification.`,
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Text or regex pattern to replace. Supports '.*?' non-greedy wildcards. Must match uniquely in the original file.",
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
    async ({ workspaceId, ...input }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const absolutePath = workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      let finalPatch = response.details?.patch ?? response.details?.diff;
      let additions = 0;
      let removals = 0;
      let finalContent: string | undefined;

      if (response.isError) {
        // Smart fallback: handles CRLF/LF mismatch, non-greedy .*? regex wildcard, etc.
        const smartResult = await applySmartEdit(absolutePath, input.edits);
        if (!smartResult.success) {
          logFailedToolResponse(config, {
            tool: toolNames.edit,
            workspaceId: workspace.id,
            path: input.path,
          }, response.content, startedAt);
          const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
          return { ...response, content: [textBlock(bounded.text)] };
        }

        finalPatch = smartResult.patch;
        additions = smartResult.additions;
        removals = smartResult.removals;
        finalContent = smartResult.content;
      } else {
        const stats = countDiffStats(finalPatch);
        additions = stats.additions;
        removals = stats.removals;
      }

      // Run edit-time syntax diagnostics
      let diagnosticsSummary: string | undefined;
      try {
        const fileBytes = finalContent ?? await readTextFile(absolutePath, "utf8");
        const diag = checkSyntaxDiagnostics(input.path, fileBytes);
        if (!diag.valid && diag.formattedSummary) {
          diagnosticsSummary = diag.formattedSummary;
        }
      } catch {
        // Ignore diagnostics read error
      }

      const summary = {
        additions,
        removals,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${additions} -${removals}).` +
        (diagnosticsSummary ? `\n\n⚠️ ${diagnosticsSummary}` : "");
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId: workspace.id,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.edit, {
          workspaceId: workspace.id,
          path: input.path,
          summary,
          payload: {
            diff: finalPatch,
            patch: finalPatch,
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
  server.registerTool(
    toolNames.getSymbolsOverview,
    {
      title: "Get symbols overview",
      description:
        "Extract high-level code symbols (functions, classes, methods, constructors, interfaces, types) from a file. Provides exact line numbers and signatures using AST parsing with minimal tokens. Ideal for understanding a file before editing.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().min(1).describe("File path relative to the workspace root."),
        depth: z.number().int().positive().max(10).optional().describe("Maximum nesting depth of symbols. Defaults to 3."),
      },
      outputSchema: resultOutputSchema({
        filePath: z.string(),
        totalSymbols: z.number(),
        overview: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path, depth }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const absolutePath = workspaces.resolvePath(workspace, path);
      try {
        const fileContent = await readTextFile(absolutePath, "utf8");
        const lineCount = fileContent.split(/\r?\n/).length;
        const overview = getSymbolsOverview(path, fileContent, depth ?? 3);
        const formatted = formatSymbolsOverview(overview, lineCount);

        logToolCall(config, {
          tool: toolNames.getSymbolsOverview,
          workspaceId: workspace.id,
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.getSymbolsOverview, {
            workspaceId: workspace.id,
            path,
            summary: { symbols: overview.totalSymbols, lines: lineCount },
          }),
        });

        return {
          content: [textBlock(formatted)],
          structuredContent: {
            result: formatted,
            filePath: path,
            totalSymbols: overview.totalSymbols,
            overview: formatted,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [textBlock(`Failed to get symbols overview for ${path}: ${message}`)],
        };
      }
    },
  );

  server.registerTool(
    toolNames.findSymbol,
    {
      title: "Find symbol",
      description:
        "Find a specific symbol (function, class, method) by name or path pattern. Can return the complete implementation body directly (includeBody: true), eliminating the need to read the entire file.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        name: z.string().min(1).describe("Symbol name or path (e.g. 'calculateSignature' or 'PaymentService/process')."),
        path: z.string().optional().describe("Optional file path relative to workspace root. If omitted, searches across code files in workspace."),
        includeBody: z.boolean().optional().describe("If true, returns the complete implementation body of matching symbols. Defaults to false."),
      },
      outputSchema: resultOutputSchema({
        matches: z.array(
          z.object({
            name: z.string(),
            namePath: z.string(),
            kind: z.string(),
            startLine: z.number(),
            endLine: z.number(),
            signature: z.string().optional(),
            body: z.string().optional(),
            filePath: z.string().optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, name, path, includeBody }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      
      const filePaths: string[] = [];
      if (path?.trim()) {
        filePaths.push(path.trim());
      } else {
        const discovery = await findFilesTool(
          { pattern: "**/*", path: ".", limit: 200 },
          { cwd: workspace.root, root: workspace.root },
        );
        if (!discovery.isError) {
          const files = contentText(discovery.content)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("[") && CODE_EXPLORE_EXTENSIONS.has(extname(l).toLowerCase()));
          filePaths.push(...files.slice(0, 100));
        }
      }

      const allMatches: Array<{
        name: string;
        namePath: string;
        kind: string;
        startLine: number;
        endLine: number;
        signature?: string;
        body?: string;
        filePath: string;
      }> = [];

      for (const relPath of filePaths) {
        try {
          const absolutePath = workspaces.resolvePath(workspace, relPath);
          const fileContent = await readTextFile(absolutePath, "utf8");
          const overview = getSymbolsOverview(relPath, fileContent, 10);
          const matches = findSymbol(overview, fileContent, name, includeBody ?? false);
          for (const m of matches) {
            allMatches.push({ ...m, filePath: relPath });
          }
        } catch {
          // Skip unreadable files
        }
      }

      const lines: string[] = [
        `Found ${allMatches.length} symbol match(es) for '${name}':`,
      ];
      for (const m of allMatches) {
        lines.push(`\n- [${m.kind}] ${m.filePath} -> ${m.namePath} [L${m.startLine}-L${m.endLine}]${m.signature ? `\n  ${m.signature}` : ""}`);
        if (m.body) {
          lines.push(`\n\`\`\`\n${m.body}\n\`\`\``);
        }
      }

      const text = lines.join("\n");
      logToolCall(config, {
        tool: toolNames.findSymbol,
        workspaceId: workspace.id,
        path: path ?? ".",
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.findSymbol, {
          workspaceId: workspace.id,
          path: path ?? ".",
          summary: { matches: allMatches.length, query: name },
        }),
      });

      return {
        content: [textBlock(text)],
        structuredContent: {
          result: text,
          matches: allMatches,
        },
      };
    },
  );

  server.registerTool(
    toolNames.replaceSymbolBody,
    {
      title: "Replace symbol body",
      description:
        "Replace the body of a function, method, or class using AST symbol resolution. Does NOT require providing oldText. Eliminates exact-match failures and newline mismatches. Automatically verifies syntax diagnostics after edit.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().min(1).describe("File path relative to the workspace root."),
        symbolName: z.string().min(1).describe("Target symbol name or path (e.g. 'calculateSignature' or 'PaymentService/createOrder')."),
        newBody: z.string().describe("New body content for the symbol. Can be enclosed in { ... } or provided as bare statements."),
      },
      outputSchema: resultOutputSchema({
        symbolName: z.string(),
        linesChanged: z.string(),
        diagnostics: z.array(z.string()).optional(),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, symbolName, newBody }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const absolutePath = workspaces.resolvePath(workspace, path);

      let fileContent: string;
      try {
        fileContent = await readTextFile(absolutePath, "utf8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [textBlock(`Could not read ${path}: ${msg}`)] };
      }

      const replaceResult = replaceSymbolBody(path, fileContent, symbolName, newBody);
      if (!replaceResult.success) {
        return {
          isError: true,
          content: [textBlock(`Failed to replace symbol body: ${replaceResult.error}`)],
        };
      }

      // Check syntax diagnostics before/after
      const diag = checkSyntaxDiagnostics(path, replaceResult.newContent);

      // Write updated content
      await writeTextFile(absolutePath, replaceResult.newContent, "utf8");

      // Generate diff patch
      const patchStr = Diff.createPatch(path, fileContent, replaceResult.newContent, "", "");
      const stats = countDiffStats(patchStr);

      let resultMsg = `Successfully replaced body of '${replaceResult.replacedSymbol?.namePath ?? symbolName}' in ${path} (+${stats.additions} -${stats.removals}).`;
      if (!diag.valid && diag.formattedSummary) {
        resultMsg += `\n\n⚠️ ${diag.formattedSummary}`;
      }

      logToolCall(config, {
        tool: toolNames.replaceSymbolBody,
        workspaceId: workspace.id,
        path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.replaceSymbolBody, {
          workspaceId: workspace.id,
          path,
          summary: { symbol: symbolName, ...stats },
          payload: { patch: patchStr },
        }),
      });

      return {
        content: [textBlock(resultMsg)],
        structuredContent: {
          result: resultMsg,
          symbolName,
          linesChanged: `+${stats.additions} -${stats.removals}`,
          diagnostics: diag.diagnostics.map((d) => `L${d.line}: ${d.message}`),
        },
      };
    },
  );

  server.registerTool(
    toolNames.insertSymbol,
    {
      title: "Insert symbol",
      description:
        "Insert a new function, method, class, or symbol relative to an existing symbol ('before' or 'after'). Automatically adjusts spacing and runs edit-time syntax diagnostics.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().min(1).describe("File path relative to the workspace root."),
        targetSymbol: z.string().min(1).describe("Existing reference symbol name or path."),
        position: z.enum(["before", "after"]).describe("Insert position relative to target symbol."),
        code: z.string().min(1).describe("New symbol code to insert."),
      },
      outputSchema: resultOutputSchema({
        insertedAtLine: z.number().optional(),
        diagnostics: z.array(z.string()).optional(),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, targetSymbol, position, code }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const absolutePath = workspaces.resolvePath(workspace, path);

      let fileContent: string;
      try {
        fileContent = await readTextFile(absolutePath, "utf8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [textBlock(`Could not read ${path}: ${msg}`)] };
      }

      const insertResult = insertSymbol(path, fileContent, targetSymbol, position, code);
      if (!insertResult.success) {
        return {
          isError: true,
          content: [textBlock(`Failed to insert symbol: ${insertResult.error}`)],
        };
      }

      // Check syntax diagnostics
      const diag = checkSyntaxDiagnostics(path, insertResult.newContent);

      // Write updated content
      await writeTextFile(absolutePath, insertResult.newContent, "utf8");

      let resultMsg = `Inserted symbol ${position} '${targetSymbol}' at approximately line ${insertResult.insertedAtLine} in ${path}.`;
      if (!diag.valid && diag.formattedSummary) {
        resultMsg += `\n\n⚠️ ${diag.formattedSummary}`;
      }

      logToolCall(config, {
        tool: toolNames.insertSymbol,
        workspaceId: workspace.id,
        path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.insertSymbol, {
          workspaceId: workspace.id,
          path,
          summary: { target: targetSymbol, position, line: insertResult.insertedAtLine },
        }),
      });

      return {
        content: [textBlock(resultMsg)],
        structuredContent: {
          result: resultMsg,
          insertedAtLine: insertResult.insertedAtLine,
          diagnostics: diag.diagnostics.map((d) => `L${d.line}: ${d.message}`),
        },
      };
    },
  );
  server.registerTool(
    toolNames.codeExplore,
    {
      title: "Explore code structure",
      description:
        "Return a compact outline of source files and top-level symbols. Use this before broad grep/read sequences when you need a map of an unfamiliar area.",
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
        path: z.string().optional().describe("Directory relative to the workspace root. Defaults to the workspace root."),
        maxFiles: z.number().int().positive().max(300).optional().describe("Maximum source files to outline. Defaults to 80."),
      },
      outputSchema: resultOutputSchema({
        root: z.string(),
        fileCount: z.number().int().nonnegative(),
        outline: z.array(
          z.object({
            path: z.string(),
            lines: z.number().int().nonnegative(),
            symbols: z.array(z.string()),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path, maxFiles }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const scope = path?.trim() || ".";
      workspaces.resolvePath(workspace, scope);
      const fileLimit = maxFiles ?? 80;
      const discovery = await findFilesTool(
        {
          pattern: "**/*",
          path: scope,
          limit: Math.min(2_000, Math.max(fileLimit * 8, fileLimit)),
        },
        { cwd: workspace.root, root: workspace.root },
      );
      if (discovery.isError) return discovery;

      const discovered = contentText(discovery.content)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("[") && line !== "No files found matching pattern");
      const candidates = discovered
        .map((relativePath) => scope === "." ? relativePath : joinPath(scope, relativePath).split("\\").join("/"))
        .filter((relativePath) => CODE_EXPLORE_EXTENSIONS.has(extname(relativePath).toLowerCase()))
        .slice(0, fileLimit);

      const outline: Array<{ path: string; lines: number; symbols: string[] }> = [];
      const rendered: string[] = [];
      for (const relativePath of candidates) {
        try {
          const absolutePath = workspaces.resolvePath(workspace, relativePath);
          const raw = await readTextFile(absolutePath, "utf8");
          const lines = raw.replaceAll("\r\n", "\n").split("\n");
          if (raw.endsWith("\n")) lines.pop();
          const symbols: string[] = [];
          for (let index = 0; index < lines.length && symbols.length < 12; index += 1) {
            const match = CODE_SYMBOL_PATTERN.exec(lines[index] ?? "");
            if (match) symbols.push(`${match[1]} ${match[2]} (L${index + 1})`);
          }
          outline.push({ path: relativePath, lines: lines.length, symbols });
          rendered.push(`${relativePath} · ${lines.length} lines`, ...symbols.map((symbol) => `    ${symbol}`));
        } catch {
          // Files can disappear during discovery; skip them rather than failing the whole outline.
        }
      }

      const bounded = truncateModelText(rendered.join("\n") || "(empty)", MODEL_SEARCH_MAX_CHARACTERS);
      logToolCall(config, {
        tool: toolNames.codeExplore,
        workspaceId: workspace.id,
        path: scope,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        consoleUi: consoleToolUi(toolNames.codeExplore, {
          workspaceId: workspace.id,
          path: scope,
          summary: { files: outline.length, discovered: discovered.length, modelTruncated: bounded.truncated },
          payload: { outline },
        }),
      });
      return {
        content: [textBlock(bounded.text)],
        structuredContent: {
          result: bounded.text,
          root: scope,
          fileCount: outline.length,
          outline,
          truncated: bounded.truncated || candidates.length < discovered.filter((relativePath) => CODE_EXPLORE_EXTENSIONS.has(extname(relativePath).toLowerCase())).length,
        },
      };
    },
  );

  server.registerTool(
      toolNames.applyPatch,
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
        inputSchema: {
          workspaceId: optionalWorkspaceIdSchema(),
          patch: z
            .string()
            .describe("One Codex-style multi-file patch enclosed by *** Begin Patch and *** End Patch markers."),
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
      async ({ workspaceId, patch }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: toolNames.applyPatch,
          workspaceId: workspace.id,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.applyPatch, {
            workspaceId: workspace.id,
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

  if (config.toolMode === "full") {
    server.registerTool(
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
        inputSchema: {
          workspaceId: optionalWorkspaceIdSchema(),
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
      async ({ workspaceId, ...input }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId: workspace.id,
            path: input.path,
          }, response.content, startedAt);
          const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
          return { ...response, content: [textBlock(bounded.text)] };
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId: workspace.id,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.grep, {
            workspaceId: workspace.id,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        const bounded = boundedModelText(response.content, MODEL_SEARCH_MAX_CHARACTERS);
        return {
          ...response,
          content: [textBlock(bounded.text)],
          structuredContent: {
            result: bounded.text,
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
          workspaceId: optionalWorkspaceIdSchema(),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId: workspace.id,
            path: input.path,
          }, response.content, startedAt);
          const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
          return { ...response, content: [textBlock(bounded.text)] };
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId: workspace.id,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.glob, {
            workspaceId: workspace.id,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        const bounded = boundedModelText(response.content, MODEL_SEARCH_MAX_CHARACTERS);
        return {
          ...response,
          content: [textBlock(bounded.text)],
          structuredContent: {
            result: bounded.text,
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
          workspaceId: optionalWorkspaceIdSchema(),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, { _meta }) => {
        const startedAt = performance.now();
        const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId: workspace.id,
            path: input.path,
          }, response.content, startedAt);
          const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
          return { ...response, content: [textBlock(bounded.text)] };
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId: workspace.id,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          consoleUi: consoleToolUi(toolNames.ls, {
            workspaceId: workspace.id,
            path: input.path,
            summary,
            payload: { content: response.content },
          }),
        });

        const bounded = boundedModelText(response.content, MODEL_SEARCH_MAX_CHARACTERS);
        return {
          ...response,
          content: [textBlock(bounded.text)],
          structuredContent: {
            result: bounded.text,
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
        ? `Run a shell command in a workspace. Underlying shell: Git Bash (standard Unix tools like grep, awk, find, sed work natively; do NOT use PowerShell cmdlets or Windows findstr; do NOT run long-running/background servers that do not exit). Use only for tests, builds, git inspection, approved Git metadata writes, package scripts, search, file discovery, and directory inspection. ${SHELL_GIT_WRITE_ALLOWANCE} In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Except for the approved Git metadata writes, do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Legacy checkpoint compatibility: command exactly \`checkpoint\` is intercepted by WebMCP and is never executed by the shell; follow the returned instruction immediately. This is powerful execution and should only be exposed behind strong authentication.`
        : `Run a shell command in a workspace. Use only for tests, builds, git inspection, approved Git metadata writes, package scripts, and commands that are better executed by the shell. ${SHELL_GIT_WRITE_ALLOWANCE} Except for the approved Git metadata writes, do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Legacy checkpoint compatibility: command exactly \`checkpoint\` is intercepted by WebMCP and is never executed by the shell; follow the returned instruction immediately. This is powerful execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: optionalWorkspaceIdSchema(),
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
      const workspace = resolveToolWorkspace(workspaces, workspaceId, _meta);
      const legacyCheckpoint = parseLegacyCheckpointCommand(input.command);

      if (legacyCheckpoint?.kind === "prepare") {
        const result = [
          "WebMCP_CHECKPOINT_STATE_REQUIRED",
          "The user asked to save this legacy conversation as a workspace checkpoint.",
          "Do not ask the user any follow-up question. Immediately call this same bash tool again; the current conversation workspace binding will be reused automatically.",
          "The command must start with `checkpoint ` followed by one JSON object containing the semantic state you can infer from the current conversation.",
          "Required JSON fields: goal, currentTask. Optional array fields: completed, decisions, files, verification, blockers, next.",
          "Example: checkpoint {\"goal\":\"Continue the project\",\"currentTask\":\"Finish the current phase\",\"completed\":[],\"decisions\":[],\"files\":[],\"verification\":[],\"blockers\":[],\"next\":[]}",
          "WebMCP will intercept the second command too; neither command is executed by the operating system.",
        ].join("\n");
        return {
          content: [textBlock(result)],
          structuredContent: { result },
        };
      }

      if (legacyCheckpoint?.kind === "save") {
        const { checkpoint } = await saveWorkspaceCheckpoint(
          workspace.id,
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
          workspaceId: workspace.id,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        const bounded = boundedModelText(response.content, MODEL_ERROR_MAX_CHARACTERS);
        return { ...response, content: [textBlock(bounded.text)] };
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId: workspace.id,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        outputPreview: consoleOutputPreview(contentText(response.content)),
        consoleUi: consoleToolUi(toolNames.shell, {
          workspaceId: workspace.id,
          path: workingDirectory,
          summary,
          payload: { content: response.content },
        }),
      });

      const bounded = boundedModelText(response.content, MODEL_COMMAND_MAX_CHARACTERS);
      return {
        ...response,
        content: [textBlock(bounded.text)],
        structuredContent: {
          result: bounded.text,
        },
      };
    },
  );
  }

  if (config.toolMode !== "minimal") {
    registerManagedProcessTools(server, config, workspaces, processSessions);
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
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const processSessions = new ProcessSessionManager();
  const consoleEvents = new ConsoleEventStore(2_000, config.stateDir);
  bindConsoleEventStore(config, consoleEvents);

  const mcpOptimizer = new McpRequestOptimizer();
  const requestLimiter = new ConcurrentRequestLimiter();
  const cleanupInterval = mcpOptimizer.startCacheCleanup();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, _res, next) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (ownerToken && !req.header("x-webmcp-owner-token")) {
      req.headers["x-webmcp-owner-token"] = ownerToken;
    }
    next();
  });

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
      resourceName: "WebMCP",
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json(createHealthStatus());
  });

  app.get("/statusz", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(createRuntimeStatus(config));
  });

  app.get("/statusz/optimizer", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      concurrent: requestLimiter.getStats(),
      cache: mcpOptimizer.getStats(),
    });
  });

  app.get("/console/snapshot", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
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

  app.get("/console/roots", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const allSessions = workspaceStore.listSessions(500);
    const rootsInfo = config.allowedRoots.map((rootPath) => {
      const isDrive = /^[a-zA-Z]:[\\/]?$/.test(rootPath);
      const exists = existsSync(rootPath);
      const wsCount = allSessions.filter((s) =>
        process.platform === "win32"
          ? s.root.toLowerCase().startsWith(rootPath.toLowerCase())
          : s.root.startsWith(rootPath)
      ).length;
      return {
        path: rootPath,
        exists,
        isDrive,
        workspacesCount: wsCount,
      };
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      allowedRoots: rootsInfo,
      workspaces: allSessions,
      configPath: webmcpConfigPath(),
    });
  });

  app.post("/console/roots", express.json(), async (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const rawPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!rawPath) {
      res.status(400).json({ ok: false, error: "path is required." });
      return;
    }

    try {
      const resolved = resolve(expandHomePath(rawPath));
      const exists = existsSync(resolved);
      if (!exists) {
        res.status(400).json({ ok: false, error: `路径不存在: ${resolved}` });
        return;
      }

      const alreadyCovered = config.allowedRoots.some((r) =>
        isPathInsideRoot(resolved, r) ||
        (process.platform === "win32" ? r.toLowerCase() === resolved.toLowerCase() : r === resolved)
      );

      if (!config.allowedRoots.some((r) =>
        process.platform === "win32" ? r.toLowerCase() === resolved.toLowerCase() : r === resolved
      )) {
        config.allowedRoots.push(resolved);
      }

      // Persist to config.json
      const userFiles = loadWebmcpFiles();
      const roots = Array.isArray(userFiles.config.allowedRoots) ? [...userFiles.config.allowedRoots] : [];
      if (!roots.some((r) =>
        process.platform === "win32" ? r.toLowerCase() === resolved.toLowerCase() : r === resolved
      )) {
        roots.push(resolved);
        writeWebmcpConfig({
          ...userFiles.config,
          allowedRoots: roots,
        });
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        message: `目录 ${resolved} 已成功添加至白名单`,
        allowedRoots: config.allowedRoots,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/console/roots/remove", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const rawPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!rawPath) {
      res.status(400).json({ ok: false, error: "path is required." });
      return;
    }

    const resolved = resolve(expandHomePath(rawPath));
    config.allowedRoots = config.allowedRoots.filter((r) =>
      process.platform === "win32" ? r.toLowerCase() !== resolved.toLowerCase() : r !== resolved
    );

    // Persist to config.json
    try {
      const userFiles = loadWebmcpFiles();
      const roots = (Array.isArray(userFiles.config.allowedRoots) ? userFiles.config.allowedRoots : [])
        .filter((r) =>
          process.platform === "win32" ? r.toLowerCase() !== resolved.toLowerCase() : r !== resolved
        );
      writeWebmcpConfig({
        ...userFiles.config,
        allowedRoots: roots,
      });
    } catch {
      // Ignore file error
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      message: `目录 ${resolved} 已从白名单中移除`,
      allowedRoots: config.allowedRoots,
    });
  });

  app.post("/console/workspaces/remove", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : "";
    if (!workspaceId) {
      res.status(400).json({ ok: false, error: "workspaceId is required." });
      return;
    }

    const ok = workspaces.removeWorkspaceSession(workspaceId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok,
      message: ok ? "工作区会话已成功移除" : "未找到指定工作区会话",
    });
  });

  app.post("/console/workspaces", express.json(), async (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
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
      // Auto-add canonicalPath to config.allowedRoots in-memory and in ~/.webmcp/config.json
      const isAllowed = config.allowedRoots.some((root) => isPathInsideRoot(canonicalPath, root));
      if (!isAllowed) {
        config.allowedRoots.push(canonicalPath);
      }
      try {
        const userFiles = loadWebmcpFiles();
        const roots = Array.isArray(userFiles.config.allowedRoots) ? [...userFiles.config.allowedRoots] : [];
        const normalizedRoots = roots.map((r) => resolve(expandHomePath(r)));
        const alreadyInFile = normalizedRoots.some((r) =>
          isPathInsideRoot(canonicalPath, r)
          || (process.platform === "win32" ? r.toLowerCase() === canonicalPath.toLowerCase() : r === canonicalPath)
        );
        if (!alreadyInFile) {
          roots.push(canonicalPath);
          writeWebmcpConfig({
            ...userFiles.config,
            allowedRoots: roots,
          });
        }
      } catch {
        // Ignore file write error if in restricted environment
      }
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
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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

  app.get("/console/skills", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const workspaceRoot = typeof req.query.workspaceRoot === "string" ? req.query.workspaceRoot.trim() : undefined;
    try {
      const result = listAllSkillsInfo(config, workspaceRoot);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/console/skills/apply", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const { skillName, target, workspaceRoot } = req.body ?? {};
    if (!skillName || typeof skillName !== "string") {
      res.status(400).json({ ok: false, error: "skillName is required." });
      return;
    }
    if (target !== "workspace" && target !== "global") {
      res.status(400).json({ ok: false, error: "target must be 'workspace' or 'global'." });
      return;
    }

    try {
      const result = applySkillToTarget(skillName, target, workspaceRoot);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/console/skills/remove", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const { skillName, target, workspaceRoot } = req.body ?? {};
    if (!skillName || typeof skillName !== "string") {
      res.status(400).json({ ok: false, error: "skillName is required." });
      return;
    }
    if (target !== "workspace" && target !== "global") {
      res.status(400).json({ ok: false, error: "target must be 'workspace' or 'global'." });
      return;
    }

    try {
      const result = removeSkillFromTarget(skillName, target, workspaceRoot);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/console/events/:id/favorite", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, settings: consoleEvents.cleanupExpired() });
  });

  app.delete("/console/events", (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
    if (!ownerTokenMatches(ownerToken, config.oauth.ownerToken)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, settings: consoleEvents.clearEvents() });
  });

  app.put("/console/settings", express.json(), (req, res) => {
    const ownerToken = req.header("x-webmcp-owner-token");
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
    const ownerToken = req.header("x-webmcp-owner-token");
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

  app.post("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    const releaseRequest = requestLimiter.tryAcquire();
    if (!releaseRequest) {
      logEvent(config.logging, "warn", "mcp_throttled", {
        requestId,
        stats: requestLimiter.getStats(),
      });
      sendJsonRpcError(res, 429, -32000, "Too many concurrent requests");
      return;
    }

    try {
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

      // Authentication and resource validation intentionally happen before the
      // fast path. Cache hits must never bypass OAuth verification.
      if (mcpOptimizer.tryServeCached(req, res)) {
        logEvent(config.logging, "debug", "mcp_cache_hit", { requestId });
        return;
      }

      logEvent(config.logging, "debug", "mcp_request", {
        requestId,
        method: req.method,
        stateless: true,
        legacySessionHeaderPresent: Boolean(req.header("mcp-session-id")),
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcpServer = createMcpServer(
        config,
        workspaces,
        processSessions,
        incomingArtifactAdapters,
      );

      let closed = false;
      const closeRequestRuntime = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await transport.close().catch(() => undefined);
        await mcpServer.close().catch(() => undefined);
      };
      res.once("close", () => {
        void closeRequestRuntime();
      });

      const cacheableRequest = mcpOptimizer.isCacheableRequest(req);
      let responseBody = "";
      const originalWrite = res.write;
      const originalEnd = res.end;
      const captureChunk = (chunk: unknown): void => {
        if (typeof chunk === "string") responseBody += chunk;
        else if (Buffer.isBuffer(chunk)) responseBody += chunk.toString("utf8");
        else if (chunk instanceof Uint8Array) responseBody += Buffer.from(chunk).toString("utf8");
      };

      if (cacheableRequest) {
        res.write = ((chunk: unknown, ...args: unknown[]) => {
          captureChunk(chunk);
          return Reflect.apply(originalWrite, res, [chunk, ...args]) as boolean;
        }) as typeof res.write;
        res.end = ((chunk?: unknown, ...args: unknown[]) => {
          captureChunk(chunk);
          return Reflect.apply(originalEnd, res, [chunk, ...args]) as Response;
        }) as typeof res.end;
      }

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);

        if (cacheableRequest && responseBody) {
          try {
            mcpOptimizer.cacheResponse(req, JSON.parse(responseBody));
          } catch {
            // A malformed or non-JSON response is never cached; the response
            // already sent to the client remains authoritative.
          }
        }
      } catch (error) {
        logEvent(config.logging, "error", "mcp_request_error", {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      } finally {
        if (cacheableRequest) {
          res.write = originalWrite;
          res.end = originalEnd;
        }
        if (res.writableEnded || res.destroyed) {
          await closeRequestRuntime();
        }
      }
    } finally {
      releaseRequest();
    }
  });

  const rejectStatelessMcpMethod = (req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    sendJsonRpcError(res, 405, -32000, "Method not allowed. This MCP endpoint is stateless; use POST.");
  };
  app.get("/mcp", rejectStatelessMcpMethod);
  app.delete("/mcp", rejectStatelessMcpMethod);

  // Global JSON-aware Express error handler to prevent HTML error responses
  app.use((err: unknown, req: Request, res: Response, _next: () => void) => {
    logEvent(config.logging, "error", "unhandled_express_error", {
      path: requestPath(req),
      error: err instanceof Error ? err.message : String(err),
    });
    if (res.headersSent) return;
    if (req.path === "/mcp" || req.path.startsWith("/mcp/")) {
      sendJsonRpcError(res, 500, -32603, err instanceof Error ? err.message : "Internal server error");
    } else {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(cleanupInterval);
        mcpOptimizer.clearCache();
        processSessions.shutdown();
        oauthProvider.close();
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
  const { app, config, close } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `webmcp listening on http://${config.host}:${config.port}/mcp`,
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
      console.error("webmcp shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

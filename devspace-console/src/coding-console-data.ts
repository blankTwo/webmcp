import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { consoleApi, withQuery } from "./console-api";
import type { ActionKind, ConsoleToolUi, DiffStats, LogEvent, LogKind, LogStatus, SymbolContext, WorkspaceItem, WorkspaceStatus } from "./types";

interface RawWorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: "checkout" | "worktree";
  createdAt: string;
  lastUsedAt: string;
}

interface RawConsoleEvent {
  id: string;
  timestamp: string;
  type: "tool_call";
  tool: string;
  purpose?: string;
  actionKind?: ActionKind;
  diffStats?: DiffStats;
  symbolContext?: SymbolContext;
  diagnosticsState?: "valid" | "warning";
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  commandPreview?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
  sessionId?: number;
  running?: boolean;
  exitCode?: number;
  outputPreview?: string;
  consoleUi?: ConsoleToolUi;
  favorite?: boolean;
}

interface ConsoleStorageSettings {
  retentionDays: number;
  storedEvents: number;
  databasePath?: string;
  databaseBytes: number;
}

interface ConsoleSnapshot {
  server: {
    ok: boolean;
    name: string;
    version: string;
    uptimeSeconds: number;
  };
  settings: ConsoleStorageSettings;
  workspaceEventCounts: Record<string, number>;
  runningWorkspaceIds: string[];
  workspaces: RawWorkspaceSession[];
  events: RawConsoleEvent[];
}

interface ConsoleHistoryResponse {
  ok: boolean;
  events: RawConsoleEvent[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface WorkspaceHistoryState {
  nextCursor?: string;
  hasMore: boolean;
  total: number;
  loaded: boolean;
  loading: boolean;
  error?: string;
}

interface UpdateFavoriteResponse {
  ok: boolean;
  event: RawConsoleEvent;
}

interface UpdateConsoleSettingsResponse {
  ok: boolean;
  settings: ConsoleStorageSettings;
}

function workspaceName(root: string) {
  const normalized = root.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? root;
}

function kindForTool(tool: string): LogKind {
  if (["exec_command", "bash"].includes(tool)) return "command";
  if (["write_stdin", "list_processes", "get_process", "kill_process"].includes(tool)) return "process";
  if (["edit", "apply_patch"].includes(tool)) return "edit";
  if (["read", "write", "move_file", "delete"].includes(tool)) return "file";
  if (["grep", "glob", "ls"].includes(tool)) return "search";
  return "system";
}

function statusForEvent(event: RawConsoleEvent): LogStatus {
  if (!event.success) return "error";
  if (event.running) return "running";
  if (typeof event.exitCode === "number" && event.exitCode !== 0) return "warning";
  return "success";
}

export function inferActionKind(event: RawConsoleEvent): ActionKind {
  if (event.actionKind) return event.actionKind;
  const tool = (event.tool || "").toLowerCase();
  const cmd = (event.commandPreview || "").toLowerCase();
  if (tool.includes("symbol")) return "symbol";
  if (tool === "checkpoint" || tool === "save_checkpoint") return "checkpoint";
  if (tool.includes("todo")) return "todo";
  if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("vitest") || cmd.includes("pytest")) return "test";
  if (tool === "read" || tool === "list_dir" || tool === "ls" || tool === "move_file") return "file";
  if (tool === "grep" || tool === "glob" || tool === "search" || tool === "code_explore") return "search";
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "edit";
  if (tool === "write_stdin" || tool === "run_terminal_command") return "process";
  return "command";
}

function summaryForEvent(event: RawConsoleEvent): string {
  if (event.error) return `执行异常: ${event.error}`;
  if (event.purpose && event.purpose.trim()) return event.purpose.trim();

  const tool = event.tool;
  const path = event.path ?? "";
  const basename = path.split(/[\\/]/).pop() || path;
  const cmd = event.commandPreview ?? "";

  if (tool === "read") {
    if (path.includes("test") || path.includes("spec")) return `查阅测试用例源码 (${basename})`;
    if (path.includes("model") || path.includes("dto") || path.includes("entity") || path.includes("form")) return `分析业务数据模型定义 (${basename})`;
    if (path.includes("service") || path.includes("controller") || path.includes("handler") || path.includes("api")) return `探查核心业务逻辑实现 (${basename})`;
    if (path.includes("config") || path.includes(".json") || path.includes(".yml") || path.includes(".env")) return `检查项目配置参数 (${basename})`;
    return basename ? `阅读并解析源文件 (${basename})` : "阅读项目文件内容";
  }
  if (tool === "grep") {
    const cardSummary = (event.consoleUi?.card?.summary || {}) as Record<string, unknown>;
    const pattern = (cardSummary.pattern as string) || "";
    if (pattern) return `在代码库中检索关键字 “${pattern}”`;
    return basename ? `检索代码调用与关键字引用 (${basename})` : "检索代码库关键字与调用点";
  }
  if (tool === "glob") {
    return `按通配规则查找项目文件 (${path || "全工作区"})`;
  }
  if (tool === "apply_patch" || tool === "edit") {
    return `应用代码重构与变更 (${basename || "工作区"})`;
  }
  if (tool === "write") {
    return `新建/覆盖写入源文件 (${basename})`;
  }
  if (tool === "replace_symbol_body") {
    const sym = event.symbolContext?.name || "";
    return sym ? `重构核心实现体 [${sym}]` : `AST 语法树精准替换函数实现 (${basename})`;
  }
  if (tool === "insert_symbol") {
    const sym = event.symbolContext?.name || "";
    return sym ? `在 [${sym}] 旁注入新声明` : `向源文件注入新符号定义 (${basename})`;
  }
  if (tool === "find_symbol") {
    const sym = event.symbolContext?.name || "";
    return sym ? `定位代码符号定义 [${sym}]` : `AST 检索符号声明与导出 (${basename})`;
  }
  if (tool === "code_explore") {
    return "巡检代码骨架与顶层模块结构";
  }
  if (tool === "checkpoint") {
    const summary = event.consoleUi?.card.summary;
    const currentTask = summary && typeof summary === "object" && !Array.isArray(summary) && "currentTask" in summary
      ? summary.currentTask
      : undefined;
    return typeof currentTask === "string" && currentTask
      ? `记录开发里程碑: ${currentTask}`
      : "记录阶段开发里程碑与意图检查点";
  }
  if (tool.includes("todo")) {
    return "同步与更新任务执行追踪清单";
  }
  if (tool === "exec_command" || tool === "bash" || tool === "shell" || tool === "run_terminal_command") {
    if (cmd.includes("git status")) return "检查 Git 工作树改动状态";
    if (cmd.includes("git diff")) return "审查未提交的代码变更 Diff";
    if (cmd.includes("git log")) return "查询版本提交历史记录";
    if (cmd.includes("test")) return `执行自动化测试套件 ($ ${cmd})`;
    if (cmd.includes("build") || cmd.includes("tsc")) return `编译与构建工程 ($ ${cmd})`;
    if (cmd.includes("install") || cmd.includes("add")) return `安装管理依赖包 ($ ${cmd})`;
    return cmd ? `运行终端指令: ${cmd}` : "执行控制台指令";
  }
  if (tool === "open_workspace") {
    return `打开并接入工作区 ${basename}`.trim();
  }
  return event.tool.replaceAll("_", " ");
}

function durationLabel(durationMs: number) {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 1 : 2)}s`;
  return `${durationMs}ms`;
}

function eventTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeRoot(root: string) {
  const normalized = root.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")
    ? normalized.toLowerCase()
    : normalized;
}

function compareRawEvents(a: RawConsoleEvent, b: RawConsoleEvent) {
  const timestamp = a.timestamp.localeCompare(b.timestamp);
  return timestamp !== 0 ? timestamp : a.id.localeCompare(b.id);
}

function mergeRawEvents(current: RawConsoleEvent[], incoming: RawConsoleEvent[]) {
  if (!incoming.length) return current;
  const merged = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) merged.set(event.id, event);
  return Array.from(merged.values()).sort(compareRawEvents);
}

function mapData(
  sessions: RawWorkspaceSession[],
  rawEvents: RawConsoleEvent[],
  eventCounts: Record<string, number>,
  runningWorkspaceIds: string[],
) {
  const sessionToRoot = new Map<string, string>();
  const rootSessions = new Map<string, RawWorkspaceSession>();

  for (const session of sessions) {
    sessionToRoot.set(session.id, session.root);
    const key = normalizeRoot(session.root);
    const existing = rootSessions.get(key);
    if (!existing || existing.lastUsedAt < session.lastUsedAt) rootSessions.set(key, session);
  }

  for (const event of rawEvents) {
    if (event.tool === "open_workspace" && event.workspaceId && event.path) {
      sessionToRoot.set(event.workspaceId, event.path);
      const key = normalizeRoot(event.path);
      if (!rootSessions.has(key)) {
        rootSessions.set(key, {
          id: event.workspaceId,
          root: event.path,
          status: "active",
          mode: "checkout",
          createdAt: event.timestamp,
          lastUsedAt: event.timestamp,
        });
      }
    }
  }

  const events: LogEvent[] = rawEvents
    .slice()
    .sort((a, b) => compareRawEvents(b, a))
    .map((event): LogEvent | null => {
      const root = event.workspaceId ? sessionToRoot.get(event.workspaceId) : undefined;
      if (!root) return null;
      const checkpointSummary = event.tool === "checkpoint" ? event.consoleUi?.card.summary : undefined;
      const checkpointTask = checkpointSummary && typeof checkpointSummary === "object" && !Array.isArray(checkpointSummary) && "currentTask" in checkpointSummary
        ? checkpointSummary.currentTask
        : undefined;
      const target = typeof checkpointTask === "string" && checkpointTask
        ? checkpointTask
        : event.path ?? event.workingDirectory ?? event.commandPreview;
      const stdout = event.outputPreview ? event.outputPreview.split(/\r?\n/) : undefined;
      const uiFiles = Array.isArray(event.consoleUi?.card.files)
        ? event.consoleUi.card.files
            .map((file) => {
              if (typeof file === "string") return file;
              if (file && typeof file === "object" && "path" in file && typeof file.path === "string") return file.path;
              return undefined;
            })
            .filter((file): file is string => Boolean(file))
        : [];
      const cardPath = typeof event.consoleUi?.card.path === "string" ? event.consoleUi.card.path : undefined;
      const relatedFiles = Array.from(new Set([
        ...uiFiles,
        ...(cardPath ? [cardPath] : []),
        ...(event.path && !event.path.endsWith(".") ? [event.path] : []),
      ]));
      return {
        id: event.id,
        workspaceId: normalizeRoot(root),
        timestamp: event.timestamp,
        time: eventTime(event.timestamp),
        tool: event.tool,
        kind: kindForTool(event.tool),
        actionKind: inferActionKind(event),
        purpose: event.purpose,
        diffStats: event.diffStats,
        symbolContext: event.symbolContext,
        diagnosticsState: event.diagnosticsState,
        status: statusForEvent(event),
        summary: summaryForEvent(event),
        target,
        duration: durationLabel(event.durationMs),
        durationMs: event.durationMs,
        command: event.commandPreview,
        stdout,
        stderr: event.error ? [event.error] : undefined,
        params: {
          workspaceId: event.workspaceId,
          ...(event.path ? { path: event.path } : {}),
          ...(event.workingDirectory ? { workingDirectory: event.workingDirectory } : {}),
          ...(event.commandPreview ? { command: event.commandPreview } : {}),
          ...(typeof event.sessionId === "number" ? { sessionId: event.sessionId } : {}),
          ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
          ...(typeof event.running === "boolean" ? { running: event.running } : {}),
        },
        files: relatedFiles.length ? relatedFiles : undefined,
        consoleUi: event.consoleUi,
        favorite: event.favorite ?? false,
      };
    })
    .filter((event): event is LogEvent => Boolean(event));

  const runningIds = new Set(runningWorkspaceIds);
  const runningRoots = new Set(
    sessions.filter((session) => runningIds.has(session.id)).map((session) => normalizeRoot(session.root)),
  );
  const normalizedCounts = new Map(
    Object.entries(eventCounts).map(([root, count]) => [normalizeRoot(root), count]),
  );

  const now = Date.now();
  const workspaces: WorkspaceItem[] = Array.from(rootSessions.values())
    .map((session) => {
      const id = normalizeRoot(session.root);
      const workspaceEvents = events.filter((event) => event.workspaceId === id);
      const hasError = workspaceEvents.slice(0, 10).some((event) => event.status === "error");
      const eventCount = normalizedCounts.get(id) ?? workspaceEvents.length;
      const lastUsedMs = session.lastUsedAt ? new Date(session.lastUsedAt).getTime() : 0;
      const diffMs = now - lastUsedMs;

      let status: WorkspaceStatus = "idle";
      if (runningRoots.has(id) || (lastUsedMs > 0 && diffMs < 45_000)) {
        status = "running";
      } else if (hasError) {
        status = "error";
      } else if (lastUsedMs > 0 && diffMs < 5 * 60_000) {
        status = "active";
      } else {
        status = "idle";
      }

      return {
        id,
        name: workspaceName(session.root),
        path: session.root,
        status,
        eventCount,
        lastActiveAt: session.lastUsedAt,
      } satisfies WorkspaceItem;
    })
    .sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));

  return { workspaces, events };
}

export function useCodingConsoleData() {
  const [sessions, setSessions] = useState<RawWorkspaceSession[]>([]);
  const [rawEvents, setRawEvents] = useState<RawConsoleEvent[]>([]);
  const [serverVersion, setServerVersion] = useState("—");
  const [workspaceEventCounts, setWorkspaceEventCounts] = useState<Record<string, number>>({});
  const [runningWorkspaceIds, setRunningWorkspaceIds] = useState<string[]>([]);
  const [retentionDays, setRetentionDaysState] = useState(7);
  const [storedEvents, setStoredEvents] = useState(0);
  const [databasePath, setDatabasePath] = useState("");
  const [databaseBytes, setDatabaseBytes] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyByWorkspace, setHistoryByWorkspace] = useState<Record<string, WorkspaceHistoryState>>({});
  const historyRef = useRef<Record<string, WorkspaceHistoryState>>({});

  const refresh = useCallback(async () => {
    try {
      const snapshot = await consoleApi<ConsoleSnapshot>("GET", "/console/snapshot?limit=160");
      setSessions(snapshot.workspaces);
      setRawEvents((current) => mergeRawEvents(current, snapshot.events));
      setServerVersion(snapshot.server.version);
      setWorkspaceEventCounts(snapshot.workspaceEventCounts ?? {});
      setRunningWorkspaceIds(snapshot.runningWorkspaceIds ?? []);
      setRetentionDaysState(snapshot.settings.retentionDays);
      setStoredEvents(snapshot.settings.storedEvents);
      setDatabasePath(snapshot.settings.databasePath ?? "");
      setDatabaseBytes(snapshot.settings.databaseBytes ?? 0);
      setConnected(true);
      setError(null);
    } catch (cause) {
      setConnected(false);
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const loadWorkspaceHistory = useCallback(async (
    workspaceRoot: string,
    options: { reset?: boolean; loadMore?: boolean } = {},
  ) => {
    const key = normalizeRoot(workspaceRoot);
    const existing = historyRef.current[key];
    if (existing?.loading) return;
    if (!options.reset && !options.loadMore && existing?.loaded) return;
    if (options.loadMore && (!existing?.loaded || !existing.hasMore)) return;

    const loadingState: WorkspaceHistoryState = {
      nextCursor: options.reset ? undefined : existing?.nextCursor,
      hasMore: existing?.hasMore ?? true,
      total: existing?.total ?? 0,
      loaded: existing?.loaded ?? false,
      loading: true,
    };
    historyRef.current = { ...historyRef.current, [key]: loadingState };
    setHistoryByWorkspace(historyRef.current);

    try {
      const response = await consoleApi<ConsoleHistoryResponse>(
        "GET",
        withQuery("/console/history", {
          workspaceRoot,
          before: options.loadMore && !options.reset ? existing?.nextCursor : undefined,
          limit: 100,
        }),
      );
      setRawEvents((current) => mergeRawEvents(current, response.events));
      const loadedState: WorkspaceHistoryState = {
        nextCursor: response.nextCursor,
        hasMore: response.hasMore,
        total: response.total,
        loaded: true,
        loading: false,
      };
      historyRef.current = { ...historyRef.current, [key]: loadedState };
      setHistoryByWorkspace(historyRef.current);
    } catch (cause) {
      const failedState: WorkspaceHistoryState = {
        nextCursor: historyRef.current[key]?.nextCursor,
        hasMore: historyRef.current[key]?.hasMore ?? true,
        total: historyRef.current[key]?.total ?? 0,
        loaded: historyRef.current[key]?.loaded ?? false,
        loading: false,
        error: String(cause),
      };
      historyRef.current = { ...historyRef.current, [key]: failedState };
      setHistoryByWorkspace(historyRef.current);
      throw cause;
    }
  }, []);

  const setEventFavorite = useCallback(async (id: string, favorite: boolean) => {
    const response = await consoleApi<UpdateFavoriteResponse>(
      "PUT",
      `/console/events/${encodeURIComponent(id)}/favorite`,
      { favorite },
    );
    setRawEvents((current) => mergeRawEvents(current, [response.event]));
    return response.event;
  }, []);

  const resetEventCache = useCallback(async () => {
    historyRef.current = {};
    setHistoryByWorkspace({});
    setRawEvents([]);
    await refresh();
  }, [refresh]);

  const applyStorageSettings = (settings: ConsoleStorageSettings) => {
    setRetentionDaysState(settings.retentionDays);
    setStoredEvents(settings.storedEvents);
    setDatabasePath(settings.databasePath ?? "");
    setDatabaseBytes(settings.databaseBytes ?? 0);
  };

  const updateRetentionDays = useCallback(async (days: number) => {
    const response = await consoleApi<UpdateConsoleSettingsResponse>("PUT", "/console/settings", {
      retentionDays: days,
    });
    applyStorageSettings(response.settings);
    await resetEventCache();
    return response.settings;
  }, [resetEventCache]);

  const cleanupEvents = useCallback(async () => {
    const response = await consoleApi<UpdateConsoleSettingsResponse>("POST", "/console/cleanup");
    applyStorageSettings(response.settings);
    await resetEventCache();
    return response.settings;
  }, [resetEventCache]);

  const clearEvents = useCallback(async () => {
    const response = await consoleApi<UpdateConsoleSettingsResponse>("DELETE", "/console/events");
    applyStorageSettings(response.settings);
    await resetEventCache();
    return response.settings;
  }, [resetEventCache]);

  const mapped = useMemo(
    () => mapData(sessions, rawEvents, workspaceEventCounts, runningWorkspaceIds),
    [rawEvents, runningWorkspaceIds, sessions, workspaceEventCounts],
  );
  return {
    ...mapped,
    serverVersion,
    retentionDays,
    storedEvents,
    databasePath,
    databaseBytes,
    connected,
    loading,
    error,
    refresh,
    updateRetentionDays,
    historyByWorkspace,
    loadWorkspaceHistory,
    setEventFavorite,
    cleanupEvents,
    clearEvents,
  };
}

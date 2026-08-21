import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleToolUi, LogEvent, LogKind, LogStatus, WorkspaceItem } from "./types";

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

interface AddWorkspaceResponse {
  ok: boolean;
  workspace: RawWorkspaceSession;
  reused: boolean;
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

function summaryForEvent(event: RawConsoleEvent) {
  if (event.error) return event.error;
  switch (event.tool) {
    case "open_workspace":
      return `打开工作区 ${event.path ?? ""}`.trim();
    case "exec_command":
    case "bash":
      return event.commandPreview ? `执行 ${event.commandPreview}` : "执行命令";
    case "write_stdin":
      return event.running ? "等待运行中进程输出" : "进程输出已更新";
    case "read":
      return `读取 ${event.path ?? "文件"}`;
    case "edit":
      return `编辑 ${event.path ?? "文件"}`;
    case "write":
      return `写入 ${event.path ?? "文件"}`;
    case "apply_patch":
      return "应用代码补丁";
    case "grep":
      return `搜索内容 ${event.path ?? ""}`.trim();
    case "glob":
      return `查找文件 ${event.path ?? ""}`.trim();
    case "ls":
      return `查看目录 ${event.path ?? ""}`.trim();
    case "checkpoint": {
      const summary = event.consoleUi?.card.summary;
      const currentTask = summary && typeof summary === "object" && !Array.isArray(summary) && "currentTask" in summary
        ? summary.currentTask
        : undefined;
      return typeof currentTask === "string" && currentTask
        ? `已保存工作区上下文 · ${currentTask}`
        : "已保存工作区上下文";
    }
    case "history_search":
      return "搜索工作区历史上下文";
    default:
      return event.tool.replaceAll("_", " ");
  }
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

  const workspaces: WorkspaceItem[] = Array.from(rootSessions.values())
    .map((session) => {
      const id = normalizeRoot(session.root);
      const workspaceEvents = events.filter((event) => event.workspaceId === id);
      const hasError = workspaceEvents.slice(0, 10).some((event) => event.status === "error");
      return {
        id,
        name: workspaceName(session.root),
        path: session.root,
        status: runningRoots.has(id) ? "running" : hasError ? "error" : "idle",
        eventCount: normalizedCounts.get(id) ?? workspaceEvents.length,
        lastActiveAt: session.lastUsedAt,
      } satisfies WorkspaceItem;
    })
    .sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));

  return { workspaces, events };
}

export function useDevSpaceData() {
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
      const snapshot = await invoke<ConsoleSnapshot>("fetch_console_snapshot");
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

    let disposed = false;
    let unlistenEvent: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    void listen<RawConsoleEvent>("devspace-tool-event", (message) => {
      if (disposed) return;
      setRawEvents((current) => mergeRawEvents(current, [message.payload]));
      setStoredEvents((current) => current + 1);
      if (message.payload.tool === "open_workspace") void refresh();
    }).then((unlisten) => { unlistenEvent = unlisten; });

    void listen<{ connected: boolean; error?: string }>("devspace-stream-status", (message) => {
      if (disposed) return;
      setConnected(Boolean(message.payload.connected));
      if (message.payload.error) setError(message.payload.error);
      else if (message.payload.connected) setError(null);
    }).then((unlisten) => { unlistenStatus = unlisten; });

    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlistenEvent?.();
      unlistenStatus?.();
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
      const response = await invoke<ConsoleHistoryResponse>("fetch_console_history", {
        workspaceRoot,
        before: options.loadMore && !options.reset ? existing?.nextCursor ?? null : null,
        limit: 100,
      });
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

  const addWorkspace = useCallback(async (path: string) => {
    const response = await invoke<AddWorkspaceResponse>("add_console_workspace", { path });
    setSessions((current) => {
      const next = current.filter((session) => session.id !== response.workspace.id);
      return [response.workspace, ...next];
    });
    await refresh();
    return response.workspace;
  }, [refresh]);

  const setEventFavorite = useCallback(async (id: string, favorite: boolean) => {
    const response = await invoke<UpdateFavoriteResponse>("set_console_event_favorite", { id, favorite });
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
    const response = await invoke<UpdateConsoleSettingsResponse>("update_console_settings", {
      retentionDays: days,
    });
    applyStorageSettings(response.settings);
    await resetEventCache();
    return response.settings;
  }, [resetEventCache]);

  const cleanupEvents = useCallback(async () => {
    const response = await invoke<UpdateConsoleSettingsResponse>("cleanup_console_events");
    applyStorageSettings(response.settings);
    await resetEventCache();
    return response.settings;
  }, [resetEventCache]);

  const clearEvents = useCallback(async () => {
    const response = await invoke<UpdateConsoleSettingsResponse>("clear_console_events");
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
    addWorkspace,
    cleanupEvents,
    clearEvents,
  };
}

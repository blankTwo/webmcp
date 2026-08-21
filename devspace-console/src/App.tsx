import {
  Activity,
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Cloud,
  Code2,
  Command,
  Copy,
  Database,
  Download,
  FileCode2,
  FileSearch,
  Files,
  Folder,
  FolderOpen,
  GitCompareArrows,
  HardDrive,
  ListFilter,
  Minus,
  Square,
  Plus,
  Play,
  RefreshCw,
  Server,
  Settings,
  Sun,
  Moon,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDevSpaceData } from "./devspace-data";
import { ProcessManager } from "./ProcessManager";
import type { LogEvent, LogKind, LogStatus, WorkspaceItem } from "./types";

const categories: Array<{ id: "all" | LogKind; label: string; icon: typeof Command }> = [
  { id: "all", label: "全部", icon: Activity },
  { id: "command", label: "命令", icon: TerminalSquare },
  { id: "file", label: "文件操作", icon: Files },
  { id: "edit", label: "编辑", icon: Code2 },
  { id: "process", label: "进程", icon: CircleDot },
  { id: "search", label: "搜索", icon: FileSearch },
  { id: "system", label: "系统", icon: Settings },
];

type MainView = "activity" | "processes";
type Theme = "dark" | "light";

interface ProcessSummaryResponse {
  processes: Array<{ running: boolean }>;
}

interface LocalServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
  version?: string;
  cwd?: string;
  entry?: string;
  executable?: string;
  command?: string | string[];
  startedAt?: string;
  uptimeSeconds?: number;
  serviceName?: string;
  serviceStartMode?: string;
  configPath?: string;
  processCount?: number;
  localAddress?: string;
  publicAddress?: string;
  targetAddress?: string;
  host?: string;
  port?: number;
}

interface LocalServiceStatuses {
  devspace: LocalServiceStatus;
  cloudflare: LocalServiceStatus;
}

interface ServiceOperationLog {
  service: "devspace" | "cloudflare";
  level: "info" | "success" | "error";
  message: string;
  timestampMs: number;
}

interface WorkspaceResumeState {
  goal?: string;
  currentTask?: string;
  completed?: string[];
  decisions?: string[];
  files?: string[];
  verification?: string[];
  blockers?: string[];
  next?: string[];
}

interface WorkspaceMemoryFacts {
  gitBranch?: string;
  gitHead?: string;
  changedFiles?: string[];
}

interface WorkspaceResumeRecord {
  checkpointId: string;
  updatedAt: string;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
}

interface WorkspaceCheckpointRecord {
  id: string;
  createdAt: string;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
}

interface WorkspaceMemorySnapshot {
  ok: boolean;
  root: string;
  mode: "checkout" | "worktree";
  resume?: WorkspaceResumeRecord;
  checkpoints: WorkspaceCheckpointRecord[];
}

interface WorkspaceMemoryApiResponse {
  ok: boolean;
  root?: string;
  mode?: "checkout" | "worktree";
  resume?: WorkspaceResumeRecord;
  resumeState?: WorkspaceResumeRecord;
  checkpoints?: WorkspaceCheckpointRecord[];
}

function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

type WorkspaceMemoryExportFormat = "json" | "markdown";

type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

function safeExportName(value: string) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, "-");
  return cleaned.replace(/^-+|-+$/g, "") || "workspace";
}

function memoryListMarkdown(title: string, items: string[] | undefined) {
  if (!items?.length) return `## ${title}\n\n- —`;
  return `## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function workspaceMemoryMarkdown(workspace: WorkspaceItem, memory: WorkspaceMemorySnapshot) {
  const resume = memory.resume;
  if (!resume) return "";
  const state = resume.state;
  const facts = resume.facts;
  const lines = [
    "# DevSpace Workspace Memory",
    "",
    `- Workspace: \`${workspace.path}\``,
    `- Mode: ${memory.mode}`,
    `- Exported: ${new Date().toISOString()}`,
    `- Last checkpoint: ${resume.updatedAt}`,
    `- Checkpoint ID: \`${resume.checkpointId}\``,
    facts.gitBranch ? `- Git branch: \`${facts.gitBranch}\`` : undefined,
    facts.gitHead ? `- Git HEAD: \`${facts.gitHead}\`` : undefined,
    "",
    "## Goal",
    "",
    state.goal || "—",
    "",
    "## Current Task",
    "",
    state.currentTask || "—",
    "",
    memoryListMarkdown("Completed", state.completed),
    "",
    memoryListMarkdown("Decisions", state.decisions),
    "",
    memoryListMarkdown("Files", state.files),
    "",
    memoryListMarkdown("Verification", state.verification),
    "",
    memoryListMarkdown("Blockers", state.blockers),
    "",
    memoryListMarkdown("Next", state.next),
    "",
    memoryListMarkdown("Changed Files", facts.changedFiles),
    "",
    "# Checkpoint History",
    "",
    ...(memory.checkpoints.length
      ? memory.checkpoints.flatMap((checkpoint, index) => [
          `## ${index + 1}. ${checkpoint.state.currentTask || checkpoint.state.goal || "Checkpoint"}`,
          "",
          `- Created: ${checkpoint.createdAt}`,
          `- ID: \`${checkpoint.id}\``,
          checkpoint.facts.gitBranch ? `- Git branch: \`${checkpoint.facts.gitBranch}\`` : undefined,
          checkpoint.facts.gitHead ? `- Git HEAD: \`${checkpoint.facts.gitHead}\`` : undefined,
          "",
          `**Goal:** ${checkpoint.state.goal || "—"}`,
          "",
          `**Current Task:** ${checkpoint.state.currentTask || "—"}`,
          "",
          checkpoint.state.next?.length ? `**Next:** ${checkpoint.state.next.join(" · ")}` : "**Next:** —",
          "",
        ])
      : ["暂无历史 checkpoint", ""]),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function workspaceMemoryJson(workspace: WorkspaceItem, memory: WorkspaceMemorySnapshot) {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      path: workspace.path,
      mode: memory.mode,
    },
    resume: memory.resume ?? null,
  }, null, 2);
}

async function saveWorkspaceMemoryExport(
  workspace: WorkspaceItem,
  memory: WorkspaceMemorySnapshot,
  format: WorkspaceMemoryExportFormat,
) {
  if (!memory.resume) throw new Error("当前工作区还没有可导出的 Resume State。");
  const baseName = `${safeExportName(workspace.name)}-memory`;
  const isJson = format === "json";
  const fileName = `${baseName}.${isJson ? "json" : "md"}`;
  const mimeType = isJson ? "application/json" : "text/markdown";
  const content = isJson
    ? workspaceMemoryJson(workspace, memory)
    : workspaceMemoryMarkdown(workspace, memory);
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: fileName,
        types: [{
          description: isJson ? "JSON" : "Markdown",
          accept: { [mimeType]: [isJson ? ".json" : ".md"] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return fileName;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  }

  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return fileName;
}

function formatPath(path: string) {
  return path.length > 34 ? `…${path.slice(-33)}` : path;
}

async function copyText(text: string) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
}

function consoleUiPayloadText(event: LogEvent): string | undefined {
  const payload = event.consoleUi?.card.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("content" in payload)) return undefined;
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function consoleUiPatch(event: LogEvent): string | undefined {
  const payload = event.consoleUi?.card.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if ("patch" in payload && typeof payload.patch === "string") return payload.patch;
  if ("diff" in payload && typeof payload.diff === "string") return payload.diff;
  return undefined;
}

function workspaceKey(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\")
    ? normalized.toLowerCase()
    : normalized;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
}

function serviceCommand(service: LocalServiceStatus) {
  if (Array.isArray(service.command)) return service.command.join(" ");
  return service.command ?? "—";
}

function relativeActivity(timestamp: string | undefined) {
  if (!timestamp) return "";
  const delta = Math.max(0, Date.now() - Date.parse(timestamp));
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} 小时前`;
  const days = Math.floor(delta / (24 * 60 * 60_000));
  return days < 7 ? `${days} 天前` : new Date(timestamp).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function eventIcon(event: LogEvent) {
  switch (event.kind) {
    case "command":
      return TerminalSquare;
    case "edit":
      return Code2;
    case "file":
      return FileCode2;
    case "process":
      return CircleDot;
    case "search":
      return FileSearch;
    default:
      return Settings;
  }
}

function statusIcon(status: LogStatus) {
  switch (status) {
    case "success":
      return Check;
    case "warning":
      return AlertTriangle;
    case "error":
      return XCircle;
    case "running":
      return CircleDot;
    default:
      return Clock3;
  }
}

function WorkspaceRow({
  workspace,
  selected,
  onClick,
}: {
  workspace: WorkspaceItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={classNames("workspace-row", selected && "selected")} onClick={onClick}>
      <span className={classNames("workspace-folder", workspace.status)}>
        <Folder size={18} strokeWidth={1.8} />
      </span>
      <span className="workspace-copy">
        <span className="workspace-name-line">
          <strong>{workspace.name}</strong>
          {workspace.status === "running" && <span className="workspace-running">运行中</span>}
        </span>
        <span className="workspace-path">{workspace.path}</span>
      </span>
      <span className="workspace-side-meta">
        <strong>{workspace.eventCount || "—"}</strong>
        <small>{relativeActivity(workspace.lastActiveAt)}</small>
      </span>
    </button>
  );
}

function EventRow({ event, selected, onClick }: { event: LogEvent; selected: boolean; onClick: () => void }) {
  const ToolIcon = eventIcon(event);
  const StatusIcon = statusIcon(event.status);
  return (
    <button className={classNames("event-row", selected && "selected")} onClick={onClick}>
      <span className="event-expand"><ChevronRight size={15} /></span>
      <span className="event-time">{event.time}</span>
      <span className={classNames("event-tool-icon", event.kind)}><ToolIcon size={17} /></span>
      <span className="event-primary">
        <strong>{event.tool}</strong>
        <span>{event.summary}</span>
      </span>
      <span className="event-target" title={event.target}>{event.target ?? "—"}</span>
      <span className={classNames("event-duration", event.status)}>{event.duration}</span>
      <span className={classNames("event-status", event.status)}><StatusIcon size={14} /></span>
    </button>
  );
}

function eventDayLabel(timestamp: string | undefined) {
  if (!timestamp) return "未知日期";
  const date = new Date(timestamp);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  const calendar = date.toLocaleDateString("zh-CN", {
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (daysAgo === 0) return `今天 · ${calendar}`;
  if (daysAgo === 1) return `昨天 · ${calendar}`;
  return calendar;
}

function VirtualEventList({
  events,
  selectedEventId,
  detailOpen,
  resetKey,
  onSelect,
  empty,
  footer,
}: {
  events: LogEvent[];
  selectedEventId: string | null;
  detailOpen: boolean;
  resetKey: string;
  onSelect: (event: LogEvent) => void;
  empty: ReactNode;
  footer?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const [unreadCount, setUnreadCount] = useState(0);

  const timeline = useMemo(() => {
    type TimelineItem =
      | { type: "day"; key: string; top: number; height: number; label: string; count: number }
      | { type: "event"; key: string; top: number; height: number; event: LogEvent };
    const groups: Array<{ key: string; label: string; events: LogEvent[] }> = [];
    for (const event of events) {
      const key = event.timestamp ? new Date(event.timestamp).toDateString() : "unknown";
      let group = groups.at(-1);
      if (!group || group.key !== key) {
        group = { key, label: eventDayLabel(event.timestamp), events: [] };
        groups.push(group);
      }
      group.events.push(event);
    }

    const items: TimelineItem[] = [];
    let top = 0;
    for (const group of groups) {
      items.push({ type: "day", key: `day:${group.key}`, top, height: 34, label: group.label, count: group.events.length });
      top += 34;
      for (const event of group.events) {
        items.push({ type: "event", key: event.id, top, height: 60, event });
        top += 60;
      }
    }
    return { items, height: Math.max(0, top - 6) };
  }, [events]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.clientHeight || 500);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const previousTimelineRef = useRef<typeof timeline | null>(null);
  const previousEventsRef = useRef<LogEvent[]>(events);
  const previousResetKeyRef = useRef(resetKey);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const previousTimeline = previousTimelineRef.current;
    const previousEvents = previousEventsRef.current;
    const resetChanged = previousResetKeyRef.current !== resetKey;

    if (viewport) {
      if (resetChanged) {
        viewport.scrollTop = 0;
        setScrollTop(0);
        setUnreadCount(0);
      } else if (
        previousTimeline
        && previousEvents.length > 0
        && events.length > 0
        && previousEvents[0].id !== events[0].id
      ) {
        const previousFirstId = previousEvents[0].id;
        const prependedCount = events.findIndex((event) => event.id === previousFirstId);
        if (prependedCount > 0) {
          const previousTop = previousTimeline.items.find(
            (item) => item.type === "event" && item.event.id === previousFirstId,
          )?.top;
          const nextTop = timeline.items.find(
            (item) => item.type === "event" && item.event.id === previousFirstId,
          )?.top;

          if (viewport.scrollTop > 8 && previousTop !== undefined && nextTop !== undefined) {
            const nextScrollTop = viewport.scrollTop + (nextTop - previousTop);
            viewport.scrollTop = nextScrollTop;
            setScrollTop(nextScrollTop);
            setUnreadCount((current) => current + prependedCount);
          } else {
            viewport.scrollTop = 0;
            setScrollTop(0);
            setUnreadCount(0);
          }
        }
      }
    }

    previousTimelineRef.current = timeline;
    previousEventsRef.current = events;
    previousResetKeyRef.current = resetKey;
  }, [events, resetKey, timeline]);

  const overscanPx = 420;
  const lower = Math.max(0, scrollTop - overscanPx);
  const upper = scrollTop + viewportHeight + overscanPx;
  let start = 0;
  let end = timeline.items.length;
  if (timeline.items.length) {
    let low = 0;
    let high = timeline.items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const item = timeline.items[middle];
      if (item.top + item.height < lower) low = middle + 1;
      else high = middle;
    }
    start = low;
    end = start;
    while (end < timeline.items.length && timeline.items[end].top <= upper) end += 1;
  }
  const visible = timeline.items.slice(start, end);

  return (
    <div
      ref={viewportRef}
      className="event-scroll"
      onScroll={(event) => {
        const nextScrollTop = event.currentTarget.scrollTop;
        setScrollTop(nextScrollTop);
        if (nextScrollTop <= 8 && unreadCount > 0) setUnreadCount(0);
      }}
    >
      {unreadCount > 0 && (
        <button
          className="new-events-indicator"
          onClick={() => {
            viewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            setUnreadCount(0);
          }}
        >{unreadCount} 条新日志 · 回到最新</button>
      )}
      {events.length ? (
        <div className="virtual-event-list" style={{ height: timeline.height }}>
          {visible.map((item) => item.type === "day" ? (
            <div key={item.key} className="virtual-date-header" style={{ transform: `translateY(${item.top}px)` }}>
              <ChevronDown size={13} /><span>{item.label}</span><em>{item.count} 条</em>
            </div>
          ) : (
            <div key={item.key} className="virtual-event-row" style={{ transform: `translateY(${item.top}px)` }}>
              <EventRow
                event={item.event}
                selected={selectedEventId === item.event.id && detailOpen}
                onClick={() => onSelect(item.event)}
              />
            </div>
          ))}
        </div>
      ) : empty}
      {footer}
    </div>
  );
}

function EmptyState({ workspace }: { workspace: WorkspaceItem }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Activity size={26} /></div>
      <strong>这个工作区暂时没有匹配的日志</strong>
      <span>{workspace.path}</span>
    </div>
  );
}

function AddWorkspaceDialog({
  saving,
  error,
  onClose,
  onAdd,
}: {
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAdd: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const submit = () => {
    const value = path.trim();
    if (value && !saving) void onAdd(value);
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-dialog add-workspace-dialog" role="dialog" aria-modal="true" aria-label="添加工作区">
        <header className="settings-dialog-header">
          <div>
            <span className="settings-dialog-icon"><FolderOpen size={18} /></span>
            <div><strong>添加工作区</strong><small>输入本机已有项目目录</small></div>
          </div>
          <button className="icon-button compact" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="settings-dialog-body">
          <label className="workspace-path-field">
            <span>工作区路径</span>
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              placeholder="例如 D:\\project"
            />
            <small>目录必须已存在，并位于 DevSpace 的 allowedRoots 范围内。</small>
          </label>
          {error && <div className="settings-error">{error}</div>}
        </div>
        <footer className="settings-dialog-footer">
          <button className="settings-button secondary" onClick={onClose}>取消</button>
          <button className="settings-button primary" disabled={saving || !path.trim()} onClick={submit}>
            {saving ? "添加中…" : "添加工作区"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ServiceStatusCard({
  service,
  kind,
  busy,
  onStart,
  onRestart,
}: {
  service: LocalServiceStatus | undefined;
  kind: "devspace" | "cloudflare";
  busy: boolean;
  onStart?: () => Promise<void>;
  onRestart: () => Promise<void>;
}) {
  const Icon = kind === "devspace" ? Server : Cloud;
  const running = Boolean(service?.running);
  const address = kind === "devspace" ? service?.localAddress : service?.targetAddress;
  return (
    <section className={classNames("service-status-card", running ? "running" : "stopped")}>
      <header>
        <div className="service-card-title">
          <span className="service-card-icon"><Icon size={18} /></span>
          <div>
            <strong>{service?.name ?? (kind === "devspace" ? "DevSpace" : "Cloudflare Tunnel")}</strong>
            <span><i className="service-state-dot" />{busy ? "操作中…" : running ? "运行中" : "未运行"}</span>
          </div>
        </div>
        {running ? (
          <button className="service-action-button" disabled={busy} onClick={() => void onRestart()}>
            <RefreshCw size={13} className={busy ? "spinning" : undefined} />{busy ? "重启中" : "重启"}
          </button>
        ) : onStart ? (
          <button className="service-action-button start" disabled={busy} onClick={() => void onStart()}>
            <Play size={12} fill="currentColor" />{busy ? "启动中" : "启动"}
          </button>
        ) : (
          <button className="service-action-button" disabled>未运行</button>
        )}
      </header>

      <dl className="service-detail-grid">
        <dt>PID</dt><dd>{service?.pid ?? "—"}</dd>
        <dt>运行时长</dt><dd>{formatUptime(service?.uptimeSeconds)}</dd>
        {service?.version && <><dt>版本</dt><dd>{service.version}</dd></>}
        {service?.startedAt && <><dt>启动时间</dt><dd>{new Date(service.startedAt).toLocaleString("zh-CN", { hour12: false })}</dd></>}
        {service?.processCount !== undefined && service.processCount > 1 && <><dt>检测进程</dt><dd>{service.processCount} 个 cloudflared</dd></>}
        {service?.serviceName && <><dt>Windows Service</dt><dd>{service.serviceName}</dd></>}
        {service?.serviceStartMode && <><dt>启动类型</dt><dd>{service.serviceStartMode}</dd></>}
        {service?.configPath && <><dt>配置文件</dt><dd className="mono" title={service.configPath}>{service.configPath}</dd></>}
        <dt>{kind === "devspace" ? "本地地址" : "目标地址"}</dt><dd className="mono" title={address}>{address ?? "—"}</dd>
        <dt>公网地址</dt><dd className="mono" title={service?.publicAddress}>{service?.publicAddress ?? "—"}</dd>
        {service?.port !== undefined && <><dt>端口</dt><dd>{service.port}</dd></>}
        {service?.cwd && <><dt>工作目录</dt><dd className="mono" title={service.cwd}>{service.cwd}</dd></>}
        {(service?.entry || service?.executable) && <><dt>入口</dt><dd className="mono" title={service.entry ?? service.executable}>{service.entry ?? service.executable}</dd></>}
        <dt>启动命令</dt><dd className="mono service-command" title={serviceCommand(service ?? { name: "", running: false })}>{service ? serviceCommand(service) : "—"}</dd>
      </dl>
    </section>
  );
}

function SettingsDialog({
  retentionDays,
  storedEvents,
  databasePath,
  databaseBytes,
  saving,
  error,
  serviceStatusError,
  services,
  serviceLogs,
  startingDevSpace,
  restartingDevSpace,
  startingCloudflare,
  restartingCloudflare,
  workspace,
  workspaceMemory,
  workspaceMemoryLoading,
  workspaceMemoryError,
  clearingWorkspaceMemory,
  onClose,
  onSave,
  onCleanup,
  onClear,
  onStartDevSpace,
  onRestartDevSpace,
  onStartCloudflare,
  onRestartCloudflare,
  onClearWorkspaceMemory,
}: {
  retentionDays: number;
  storedEvents: number;
  databasePath: string;
  databaseBytes: number;
  saving: boolean;
  error: string | null;
  serviceStatusError: string | null;
  services: LocalServiceStatuses | null;
  serviceLogs: ServiceOperationLog[];
  startingDevSpace: boolean;
  restartingDevSpace: boolean;
  startingCloudflare: boolean;
  restartingCloudflare: boolean;
  workspace: WorkspaceItem;
  workspaceMemory: WorkspaceMemorySnapshot | null;
  workspaceMemoryLoading: boolean;
  workspaceMemoryError: string | null;
  clearingWorkspaceMemory: boolean;
  onClose: () => void;
  onSave: (days: number) => Promise<void>;
  onCleanup: () => Promise<void>;
  onClear: () => Promise<void>;
  onStartDevSpace: () => Promise<void>;
  onRestartDevSpace: () => Promise<void>;
  onStartCloudflare: () => Promise<void>;
  onRestartCloudflare: () => Promise<void>;
  onClearWorkspaceMemory: () => Promise<void>;
}) {
  const [draftDays, setDraftDays] = useState(retentionDays);
  const [memoryExporting, setMemoryExporting] = useState<WorkspaceMemoryExportFormat | null>(null);
  const [memoryExportStatus, setMemoryExportStatus] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraftDays(retentionDays), [retentionDays]);
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [serviceLogs]);

  const exportWorkspaceMemory = async (format: WorkspaceMemoryExportFormat) => {
    if (!workspaceMemory?.resume || memoryExporting) return;
    setMemoryExporting(format);
    setMemoryExportStatus(null);
    try {
      const fileName = await saveWorkspaceMemoryExport(workspace, workspaceMemory, format);
      setMemoryExportStatus(fileName ? `已导出 ${fileName}` : null);
    } catch (cause) {
      setMemoryExportStatus(`导出失败：${String(cause)}`);
    } finally {
      setMemoryExporting(null);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-dialog service-settings-dialog" role="dialog" aria-modal="true" aria-label="DevSpace Console 设置">
        <header className="settings-dialog-header">
          <div>
            <span className="settings-dialog-icon"><Settings size={18} /></span>
            <div><strong>Console 设置</strong><small>本机服务状态与日志存储</small></div>
          </div>
          <button className="icon-button compact" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="settings-dialog-body">
          <div className="settings-section-title"><strong>本机服务</strong><span>状态每 8 秒自动刷新</span></div>
          <div className="service-status-grid">
            <ServiceStatusCard
              service={services?.devspace}
              kind="devspace"
              busy={startingDevSpace || restartingDevSpace}
              onStart={onStartDevSpace}
              onRestart={onRestartDevSpace}
            />
            <ServiceStatusCard
              service={services?.cloudflare}
              kind="cloudflare"
              busy={startingCloudflare || restartingCloudflare}
              onStart={onStartCloudflare}
              onRestart={onRestartCloudflare}
            />
          </div>
          {serviceStatusError && <div className="settings-error">服务状态读取失败：{serviceStatusError}</div>}

          <div className="settings-section-title service-log-title"><strong>操作日志</strong><span>启动 / 重启过程</span></div>
          <div className="service-log-panel" ref={logRef}>
            {serviceLogs.length === 0 ? (
              <div className="service-log-empty">暂无操作日志</div>
            ) : serviceLogs.map((entry, index) => (
              <div className={classNames("service-log-line", entry.level)} key={`${entry.timestampMs}-${index}`}>
                <time>{new Date(entry.timestampMs).toLocaleTimeString("zh-CN", { hour12: false })}</time>
                <span>{entry.service === "devspace" ? "DevSpace" : "Tunnel"}</span>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>

          <div className="settings-section-title memory-section-title">
            <strong>工作区上下文</strong>
            <span>{workspace.id === "__empty__" ? "暂无工作区" : workspace.name}</span>
          </div>
          <section className="workspace-memory-panel">
            <header className="workspace-memory-header">
              <div>
                <span className="setting-icon"><Box size={18} /></span>
                <div>
                  <strong>Resume State</strong>
                  <span className="mono" title={workspace.path}>{workspace.path}</span>
                </div>
              </div>
              {workspaceMemory?.resume && (
                <div className="memory-header-actions">
                  <details className="memory-export-menu">
                    <summary className={memoryExporting ? "disabled" : undefined}>
                      <Download size={13} />
                      {memoryExporting ? "导出中…" : "导出"}
                      <ChevronDown size={12} />
                    </summary>
                    <div className="memory-export-options">
                      <button disabled={Boolean(memoryExporting)} onClick={() => void exportWorkspaceMemory("json")}>
                        <strong>当前状态 JSON</strong>
                        <span>Resume State + Git 信息</span>
                      </button>
                      <button disabled={Boolean(memoryExporting)} onClick={() => void exportWorkspaceMemory("markdown")}>
                        <strong>完整上下文 Markdown</strong>
                        <span>当前状态 + Checkpoint 历史</span>
                      </button>
                    </div>
                  </details>
                  <button
                    className="memory-clear-button"
                    disabled={clearingWorkspaceMemory}
                    onClick={() => void onClearWorkspaceMemory()}
                  >{clearingWorkspaceMemory ? "清除中…" : "清除当前状态"}</button>
                </div>
              )}
            </header>

            {workspace.id === "__empty__" ? (
              <div className="workspace-memory-empty">选择一个工作区后可查看 Resume State。</div>
            ) : workspaceMemoryLoading ? (
              <div className="workspace-memory-empty">正在读取工作区上下文…</div>
            ) : workspaceMemoryError ? (
              <div className="settings-error">上下文读取失败：{workspaceMemoryError}</div>
            ) : !workspaceMemory?.resume ? (
              <div className="workspace-memory-empty">当前工作区还没有 checkpoint。模型完成一个阶段后调用 checkpoint 即会在这里保存。</div>
            ) : (
              <>
                <div className="memory-meta-row">
                  <span><Clock3 size={13} /> 最后 checkpoint</span>
                  <strong>{new Date(workspaceMemory.resume.updatedAt).toLocaleString("zh-CN", { hour12: false })}</strong>
                </div>
                <div className="memory-summary-grid">
                  <div><span>Goal</span><strong>{workspaceMemory.resume.state.goal ?? "—"}</strong></div>
                  <div><span>Current Task</span><strong>{workspaceMemory.resume.state.currentTask ?? "—"}</strong></div>
                  <div className="wide"><span>Next</span><strong>{workspaceMemory.resume.state.next?.length ? workspaceMemory.resume.state.next.join(" · ") : "—"}</strong></div>
                </div>
                {(workspaceMemory.resume.facts.gitBranch || workspaceMemory.resume.facts.gitHead) && (
                  <div className="memory-git-row">
                    <GitCompareArrows size={13} />
                    <span>{workspaceMemory.resume.facts.gitBranch ?? "Git"}</span>
                    {workspaceMemory.resume.facts.gitHead && <code>{workspaceMemory.resume.facts.gitHead.slice(0, 8)}</code>}
                  </div>
                )}
              </>
            )}

            {memoryExportStatus && (
              <div className={classNames("memory-export-status", memoryExportStatus.startsWith("导出失败") && "error")}>{memoryExportStatus}</div>
            )}

            <div className="checkpoint-history">
              <div className="checkpoint-history-heading"><strong>最近 Checkpoint</strong><span>{workspaceMemory?.checkpoints.length ?? 0} 条</span></div>
              {workspaceMemory?.checkpoints.length ? workspaceMemory.checkpoints.map((checkpoint) => (
                <div className="checkpoint-history-row" key={checkpoint.id}>
                  <div>
                    <strong>{checkpoint.state.currentTask ?? checkpoint.state.goal ?? "未命名 checkpoint"}</strong>
                    <span>{new Date(checkpoint.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  </div>
                  <code>{checkpoint.id.slice(0, 12)}</code>
                </div>
              )) : <div className="checkpoint-history-empty">暂无历史 checkpoint</div>}
            </div>
          </section>

          <div className="settings-section-title storage-section-title"><strong>日志存储</strong><span>SQLite</span></div>
          <div className="setting-row">
            <div className="setting-copy">
              <span className="setting-icon"><Database size={18} /></span>
              <div>
                <strong>SQLite 日志保留</strong>
                <span>超过保留时间的工具调用日志会由 DevSpace 自动清理。</span>
              </div>
            </div>
            <select value={draftDays} onChange={(event) => setDraftDays(Number(event.target.value))}>
              {[1, 3, 7, 14, 30, 90].map((days) => (
                <option key={days} value={days}>{days} 天</option>
              ))}
            </select>
          </div>

          <div className="settings-storage-summary">
            <span><Database size={15} /> 当前 SQLite 已保存</span>
            <strong>{storedEvents.toLocaleString("zh-CN")} 条 · {formatBytes(databaseBytes)}</strong>
          </div>

          <div className="settings-storage-path" title={databasePath}>
            <HardDrive size={14} /><span>{databasePath || "SQLite 路径不可用"}</span>
          </div>

          <div className="settings-maintenance-actions">
            <button disabled={saving} onClick={() => void onCleanup()}>立即清理过期日志</button>
            <button className="danger" disabled={saving || storedEvents === 0} onClick={() => void onClear()}>清空全部日志</button>
          </div>

          {error && <div className="settings-error">{error}</div>}
        </div>

        <footer className="settings-dialog-footer">
          <button className="settings-button secondary" onClick={onClose}>取消</button>
          <button className="settings-button primary" disabled={saving} onClick={() => void onSave(draftDays)}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </footer>
      </section>
    </div>
  );
}

interface LocalFilePreview {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

function RelatedFilePreview({ workspaceRoot, file }: { workspaceRoot: string; file: string }) {
  const [preview, setPreview] = useState<LocalFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setError(null);
    void invoke<LocalFilePreview>("read_local_file", { workspaceRoot, path: file })
      .then((result) => {
        if (!disposed) setPreview(result);
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [file, workspaceRoot]);

  return (
    <div className="related-file-card">
      <div className="related-file-head">
        <span><FileCode2 size={15} /> {file}</span>
        {preview && <small>{formatBytes(preview.size)}{preview.truncated ? " · 已截断" : ""}</small>}
      </div>
      {error ? (
        <div className="related-file-error">无法读取：{error}</div>
      ) : !preview ? (
        <div className="related-file-loading">正在读取文件…</div>
      ) : preview.binary ? (
        <div className="related-file-error">二进制文件，不显示内容。</div>
      ) : (
        <pre className="related-file-content">{preview.content || "（空文件）"}</pre>
      )}
    </div>
  );
}

function DetailPanel({
  event,
  workspace,
  onClose,
}: {
  event: LogEvent | null;
  workspace: WorkspaceItem;
  onClose: () => void;
}) {
  const [outputTab, setOutputTab] = useState<"stdout" | "stderr">("stdout");
  const [copied, setCopied] = useState<"output" | "params" | null>(null);

  useEffect(() => {
    setOutputTab("stdout");
    setCopied(null);
  }, [event?.id]);

  const copyValue = async (kind: "output" | "params", value: string) => {
    await copyText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_200);
  };

  if (!event) {
    return (
      <aside className="detail-panel detail-empty">
        <div className="detail-header">
          <span><ListFilter size={17} /> 执行详情</span>
        </div>
        <div className="detail-empty-body">
          <Box size={30} />
          <strong>选择一条日志</strong>
          <span>查看参数、输出、相关文件与执行上下文</span>
        </div>
      </aside>
    );
  }

  const ToolIcon = eventIcon(event);
  const output = outputTab === "stdout" ? event.stdout : event.stderr;
  const processSessionId = event.params?.sessionId;
  const exitCode = event.params?.exitCode;
  const workingDirectory = event.params?.workingDirectory;
  const consoleResult = consoleUiPayloadText(event);
  const changePatch = consoleUiPatch(event);
  const changeSummary = event.consoleUi?.card.summary;
  const additions = changeSummary && typeof changeSummary === "object" && !Array.isArray(changeSummary) && "additions" in changeSummary && typeof changeSummary.additions === "number"
    ? changeSummary.additions
    : undefined;
  const removals = changeSummary && typeof changeSummary === "object" && !Array.isArray(changeSummary) && "removals" in changeSummary && typeof changeSummary.removals === "number"
    ? changeSummary.removals
    : undefined;

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <span><ListFilter size={17} /> 执行详情</span>
        <div className="detail-header-actions">
          <button className="icon-button compact" onClick={onClose}><X size={16} /></button>
        </div>
      </div>

      <div className="detail-tool-head">
        <div className={classNames("detail-tool-icon", event.kind)}><ToolIcon size={19} /></div>
        <div className="detail-title-copy">
          <strong>{event.tool}</strong>
          <span><Clock3 size={13} /> {event.time} <i /> {event.duration}</span>
        </div>
        <span className={classNames("status-pill", event.status)}>{event.status === "success" ? "成功" : event.status === "running" ? "运行中" : event.status === "warning" ? "警告" : event.status === "error" ? "失败" : "完成"}</span>
      </div>

      <section className="detail-section">
        <h3>基本信息</h3>
        <dl className="info-grid">
          <dt>工作区</dt><dd>{workspace.path}</dd>
          <dt>工具</dt><dd>{event.tool}</dd>
          <dt>目标</dt><dd className="mono ellipsis" title={event.target}>{event.target ?? "—"}</dd>
          <dt>工作目录</dt><dd>{typeof workingDirectory === "string" ? workingDirectory : workspace.path}</dd>
          <dt>进程 Session</dt><dd>{processSessionId === undefined ? "—" : String(processSessionId)}</dd>
          <dt>退出码</dt><dd>{exitCode === undefined ? "—" : String(exitCode)}</dd>
        </dl>
      </section>

      {(event.stdout || event.stderr) && (
        <section className="detail-section">
          <div className="section-title-row">
            <h3><TerminalSquare size={15} /> 命令输出</h3>
            <button className="copy-button" onClick={() => void copyValue("output", output?.join("\n") ?? "")}><Copy size={13} /> {copied === "output" ? "已复制" : "复制"}</button>
          </div>
          <div className="output-tabs">
            <button className={outputTab === "stdout" ? "active" : ""} onClick={() => setOutputTab("stdout")}>stdout</button>
            <button className={outputTab === "stderr" ? "active" : ""} onClick={() => setOutputTab("stderr")}>stderr</button>
          </div>
          <pre className="terminal-output">{output?.length ? output.join("\n") : "No output"}</pre>
        </section>
      )}

      {changePatch && (
        <section className="detail-section">
          <div className="section-title-row">
            <h3><GitCompareArrows size={15} /> 变更内容 {additions !== undefined || removals !== undefined ? <span className="change-stats">+{additions ?? 0} / -{removals ?? 0}</span> : null}</h3>
          </div>
          <pre className="json-output change-output">{changePatch}</pre>
        </section>
      )}

      {consoleResult && !event.stdout?.length && !changePatch && (
        <section className="detail-section">
          <div className="section-title-row">
            <h3><Code2 size={15} /> 工具结果</h3>
          </div>
          <pre className="json-output tool-result-output">{consoleResult}</pre>
        </section>
      )}

      {event.params && (
        <section className="detail-section">
          <div className="section-title-row">
            <h3>参数</h3>
            <button className="copy-button" onClick={() => void copyValue("params", JSON.stringify(event.params, null, 2))}><Copy size={13} /> {copied === "params" ? "已复制" : "复制"}</button>
          </div>
          <pre className="json-output">{JSON.stringify(event.params, null, 2)}</pre>
        </section>
      )}

      {event.files?.length ? (
        <section className="detail-section">
          <h3>相关文件</h3>
          <div className="related-files">
            {event.files.map((file) => (
              <RelatedFilePreview key={`${event.id}:${file}`} workspaceRoot={workspace.path} file={file} />
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}

export default function App() {
  const {
    workspaces,
    events: logEvents,
    serverVersion,
    retentionDays,
    storedEvents,
    databasePath,
    databaseBytes,
    connected,
    loading,
    error,
    updateRetentionDays,
    historyByWorkspace,
    loadWorkspaceHistory,
    addWorkspace,
    cleanupEvents,
    clearEvents,
    refresh,
  } = useDevSpaceData();
  const [workspaceId, setWorkspaceId] = useState("");
  const [mainView, setMainView] = useState<MainView>("activity");
  const [category, setCategory] = useState<"all" | LogKind>("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>("evt-01");
  const [detailOpen, setDetailOpen] = useState(true);
  const [runningProcessCount, setRunningProcessCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceSaving, setAddWorkspaceSaving] = useState(false);
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [startingDevSpace, setStartingDevSpace] = useState(false);
  const [restartingDevSpace, setRestartingDevSpace] = useState(false);
  const [startingCloudflare, setStartingCloudflare] = useState(false);
  const [restartingCloudflare, setRestartingCloudflare] = useState(false);
  const [startDevSpaceError, setStartDevSpaceError] = useState<string | null>(null);
  const [serviceStatuses, setServiceStatuses] = useState<LocalServiceStatuses | null>(null);
  const [serviceStatusError, setServiceStatusError] = useState<string | null>(null);
  const [serviceLogs, setServiceLogs] = useState<ServiceOperationLog[]>([]);
  const [workspaceMemory, setWorkspaceMemory] = useState<WorkspaceMemorySnapshot | null>(null);
  const [workspaceMemoryLoading, setWorkspaceMemoryLoading] = useState(false);
  const [workspaceMemoryError, setWorkspaceMemoryError] = useState<string | null>(null);
  const [clearingWorkspaceMemory, setClearingWorkspaceMemory] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("devspace-console-theme");
    return saved === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("devspace-console-theme", theme);
  }, [theme]);

  const refreshServiceStatuses = useCallback(async () => {
    try {
      const statuses = await invoke<LocalServiceStatuses>("fetch_local_service_statuses");
      setServiceStatuses(statuses);
      setServiceStatusError(null);
    } catch (cause) {
      setServiceStatusError(String(cause));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void refreshServiceStatuses();
    const timer = window.setInterval(() => void refreshServiceStatuses(), 8_000);
    void listen<ServiceOperationLog>("service-operation-log", (message) => {
      if (disposed) return;
      setServiceLogs((current) => {
        const previous = current.at(-1);
        if (
          previous
          && previous.timestampMs === message.payload.timestampMs
          && previous.service === message.payload.service
          && previous.level === message.payload.level
          && previous.message === message.payload.message
        ) {
          return current;
        }
        return [...current.slice(-119), message.payload];
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [refreshServiceStatuses]);

  const defaultWorkspace = useMemo(() => workspaces.reduce<WorkspaceItem | undefined>((latest, item) => {
    if (!latest) return item;
    const latestTime = Date.parse(latest.lastActiveAt ?? "") || 0;
    const itemTime = Date.parse(item.lastActiveAt ?? "") || 0;
    return itemTime > latestTime ? item : latest;
  }, undefined), [workspaces]);

  const workspace = workspaces.find((item) => item.id === workspaceId) ?? defaultWorkspace ?? {
    id: "__empty__",
    name: loading ? "正在连接 DevSpace" : "暂无工作区",
    path: error ?? "等待 DevSpace 工具调用…",
    status: connected ? "idle" : "error",
    eventCount: 0,
  } satisfies WorkspaceItem;
  const workspaceEvents = useMemo(() => logEvents.filter((event) => event.workspaceId === workspace.id), [logEvents, workspace.id]);
  const workspaceHistory = historyByWorkspace[workspace.id];
  const visibleEvents = useMemo(() => workspaceEvents.filter((event) => {
    if (category !== "all" && event.kind !== category) return false;
    return true;
  }), [category, workspaceEvents]);

  const selectedEvent = visibleEvents.find((event) => event.id === selectedEventId)
    ?? workspaceEvents.find((event) => event.id === selectedEventId)
    ?? visibleEvents[0]
    ?? null;

  useEffect(() => {
    if (!defaultWorkspace) return;
    if (!workspaces.some((item) => item.id === workspaceId)) setWorkspaceId(defaultWorkspace.id);
  }, [defaultWorkspace, workspaceId, workspaces]);

  useEffect(() => {
    if (workspace.id === "__empty__") return;
    void loadWorkspaceHistory(workspace.path).catch(() => undefined);
  }, [loadWorkspaceHistory, workspace.id, workspace.path]);

  useEffect(() => {
    if (!workspaceId) return;
    setCategory("all");
    setSelectedEventId(null);
    setDetailOpen(false);
  }, [workspaceId]);

  useEffect(() => {
    if (selectedEventId || workspaceEvents.length === 0) return;
    setSelectedEventId(workspaceEvents[0].id);
    setDetailOpen(true);
  }, [selectedEventId, workspaceEvents]);

  const successCount = workspaceEvents.filter((event) => event.status === "success").length;
  const avgMs = workspaceEvents.length
    ? Math.round(workspaceEvents.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) / workspaceEvents.length)
    : 0;
  const successRate = workspaceEvents.length ? ((successCount / workspaceEvents.length) * 100).toFixed(1) : "100";
  const totalWorkspaceEvents = workspaceHistory?.total ?? workspaceEvents.length;

  useEffect(() => {
    if (workspace.id === "__empty__") {
      setRunningProcessCount(0);
      return;
    }
    let disposed = false;
    const refreshProcessCount = async () => {
      try {
        const response = await invoke<ProcessSummaryResponse>("fetch_console_processes", { workspaceRoot: workspace.path });
        if (!disposed) setRunningProcessCount(response.processes.filter((process) => process.running).length);
      } catch {
        if (!disposed) setRunningProcessCount(0);
      }
    };
    void refreshProcessCount();
    const timer = window.setInterval(() => void refreshProcessCount(), 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [workspace.id, workspace.path]);

  const saveRetentionDays = async (days: number) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await updateRetentionDays(days);
      setSettingsOpen(false);
    } catch (cause) {
      setSettingsError(String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const cleanupStoredEvents = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await cleanupEvents();
    } catch (cause) {
      setSettingsError(String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const clearStoredEvents = async () => {
    if (!window.confirm("确定清空全部 Console 历史日志吗？\n\n这个操作不会删除工作区，但无法恢复日志。")) return;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await clearEvents();
      setSelectedEventId(null);
      setDetailOpen(false);
    } catch (cause) {
      setSettingsError(String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const refreshWorkspaceMemory = useCallback(async (workspaceRoot: string) => {
    if (!workspaceRoot || workspaceRoot === "等待 DevSpace 工具调用…") {
      setWorkspaceMemory(null);
      setWorkspaceMemoryError(null);
      return;
    }
    setWorkspaceMemoryLoading(true);
    setWorkspaceMemoryError(null);
    try {
      const response = await invoke<WorkspaceMemoryApiResponse>("fetch_workspace_memory", { workspaceRoot });
      setWorkspaceMemory({
        ok: response.ok,
        root: response.root ?? workspaceRoot,
        mode: response.mode ?? "checkout",
        resume: response.resume ?? response.resumeState,
        checkpoints: response.checkpoints ?? [],
      });
    } catch (cause) {
      setWorkspaceMemory(null);
      setWorkspaceMemoryError(String(cause));
    } finally {
      setWorkspaceMemoryLoading(false);
    }
  }, []);

  const openSettings = () => {
    setSettingsError(null);
    setSettingsOpen(true);
    void refreshServiceStatuses();
    if (workspace.id !== "__empty__") void refreshWorkspaceMemory(workspace.path);
  };

  const clearWorkspaceMemory = async () => {
    if (workspace.id === "__empty__" || !workspaceMemory?.resume || clearingWorkspaceMemory) return;
    if (!window.confirm("确定清除这个工作区的当前 Resume State 吗？\n\n历史 checkpoint 会保留，新会话将不再自动恢复当前状态，直到产生新的 checkpoint。")) return;
    setClearingWorkspaceMemory(true);
    setWorkspaceMemoryError(null);
    try {
      await invoke("clear_workspace_resume_state", { workspaceRoot: workspace.path });
      await refreshWorkspaceMemory(workspace.path);
    } catch (cause) {
      setWorkspaceMemoryError(String(cause));
    } finally {
      setClearingWorkspaceMemory(false);
    }
  };

  useEffect(() => {
    if (!settingsOpen || workspace.id === "__empty__") return;
    void refreshWorkspaceMemory(workspace.path);
  }, [refreshWorkspaceMemory, settingsOpen, workspace.id, workspace.path]);

  const startDevSpace = async () => {
    if (startingDevSpace || connected) return;
    setStartingDevSpace(true);
    setStartDevSpaceError(null);
    try {
      await invoke("start_devspace_server");
      await Promise.all([refresh(), refreshServiceStatuses()]);
    } catch (cause) {
      setStartDevSpaceError(String(cause));
      await refreshServiceStatuses();
    } finally {
      setStartingDevSpace(false);
    }
  };

  const restartDevSpace = async () => {
    if (restartingDevSpace || startingDevSpace || !connected) return;
    setRestartingDevSpace(true);
    setStartDevSpaceError(null);
    try {
      await invoke("restart_devspace_server");
      await Promise.all([refresh(), refreshServiceStatuses()]);
    } catch (cause) {
      setStartDevSpaceError(String(cause));
      await refreshServiceStatuses();
    } finally {
      setRestartingDevSpace(false);
    }
  };

  const startCloudflare = async () => {
    if (startingCloudflare || restartingCloudflare || serviceStatuses?.cloudflare.running) return;
    setStartingCloudflare(true);
    setSettingsError(null);
    try {
      await invoke("start_cloudflare_tunnel");
      await refreshServiceStatuses();
    } catch (cause) {
      setSettingsError(String(cause));
      await refreshServiceStatuses();
    } finally {
      setStartingCloudflare(false);
    }
  };

  const restartCloudflare = async () => {
    if (restartingCloudflare || startingCloudflare || !serviceStatuses?.cloudflare.running) return;
    setRestartingCloudflare(true);
    setSettingsError(null);
    try {
      await invoke("restart_cloudflare_tunnel");
      await refreshServiceStatuses();
    } catch (cause) {
      setSettingsError(String(cause));
      await refreshServiceStatuses();
    } finally {
      setRestartingCloudflare(false);
    }
  };

  const openAddWorkspace = () => {
    setAddWorkspaceError(null);
    setAddWorkspaceOpen(true);
  };

  const submitAddWorkspace = async (path: string) => {
    setAddWorkspaceSaving(true);
    setAddWorkspaceError(null);
    try {
      const added = await addWorkspace(path);
      setWorkspaceId(workspaceKey(added.root));
      setAddWorkspaceOpen(false);
    } catch (cause) {
      setAddWorkspaceError(String(cause));
    } finally {
      setAddWorkspaceSaving(false);
    }
  };

  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    try {
      const current = getCurrentWindow();
      if (action === "minimize") await current.minimize();
      if (action === "maximize") await current.toggleMaximize();
      if (action === "close") await current.close();
    } catch {
      // Browser preview has no Tauri window runtime.
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === "o") {
        event.preventDefault();
        setAddWorkspaceError(null);
        setAddWorkspaceOpen(true);
        return;
      }
      if (modifier && event.key === ",") {
        event.preventDefault();
        setSettingsError(null);
        setSettingsOpen(true);
        return;
      }
      if (event.key !== "Escape") return;

      if (addWorkspaceOpen) setAddWorkspaceOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (detailOpen) setDetailOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addWorkspaceOpen, detailOpen, settingsOpen]);

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark"><GitCompareArrows size={18} /></span>
          <strong>DevSpace Console</strong>
          <span className="version">v1.0.0</span>
        </div>
        <div className="window-controls">
          <button
            className="theme-toggle"
            title={theme === "dark" ? "切换到浅色主题" : "切换到暗色主题"}
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          >{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button title="最小化" onClick={() => windowAction("minimize")}><Minus size={16} /></button>
          <button title="最大化" onClick={() => windowAction("maximize")}><Square size={13} /></button>
          <button className="close" onClick={() => windowAction("close")}><X size={16} /></button>
        </div>
      </header>

      <div className={classNames("console-layout", mainView === "activity" && detailOpen && selectedEvent && "with-detail")}>
        <aside className="sidebar">
          <div className="sidebar-section workspace-section">
            <div className="sidebar-heading"><span><FolderOpen size={16} /> 工作区</span><button className="icon-button compact" title="添加工作区 (Ctrl+O)" onClick={openAddWorkspace}><Plus size={15} /></button></div>
            <div className="workspace-list">
              {workspaces.map((item) => <WorkspaceRow key={item.id} workspace={item} selected={item.id === workspace.id} onClick={() => { setWorkspaceId(item.id); setMainView("activity"); }} />)}
              {workspaces.length === 0 && <div className="workspace-search-empty">暂无工作区</div>}
            </div>
            {workspaces.length > 5 && <div className="more-workspaces">共 {workspaces.length} 个工作区</div>}
          </div>

          <div className="sidebar-section system-section">
            <div className="sidebar-heading plain">系统</div>
            <button className={classNames("system-row", mainView === "processes" && "selected")} onClick={() => { setMainView("processes"); setDetailOpen(false); }}><CircleDot size={16} /><span>进程管理</span><em>{runningProcessCount}</em></button>
            <button className="system-row" title="设置 (Ctrl+,)" onClick={openSettings}><Settings size={16} /><span>设置</span></button>
          </div>

          <div className="sidebar-services" title="点击查看服务详情" onClick={openSettings}>
            <button className={classNames("service-footer-row", (serviceStatuses?.devspace.running ?? connected) ? "online" : "offline")}>
              <span className="server-dot" />
              <div><strong>DevSpace</strong><span>{restartingDevSpace ? "重启中…" : startingDevSpace ? "启动中…" : (serviceStatuses?.devspace.running ?? connected) ? "已连接" : startDevSpaceError ? "操作失败" : "未连接"}</span></div>
              <small>{serviceStatuses?.devspace.version ? `v${serviceStatuses.devspace.version}` : serverVersion !== "—" ? `v${serverVersion}` : ""}</small>
            </button>
            <button className={classNames("service-footer-row", serviceStatuses?.cloudflare.running ? "online" : "offline")}>
              <span className="server-dot" />
              <div><strong>Cloudflare Tunnel</strong><span>{restartingCloudflare ? "重启中…" : startingCloudflare ? "启动中…" : serviceStatuses?.cloudflare.running ? "运行中" : "未运行"}</span></div>
              <small>{serviceStatuses?.cloudflare.pid ? `PID ${serviceStatuses.cloudflare.pid}` : ""}</small>
            </button>
          </div>
        </aside>

        <main className={classNames("main-area", mainView === "processes" && "process-view")}>
          <section className="workspace-header compact-header">
            <div className="summary-strip">
              <div><span>总记录</span><strong>{totalWorkspaceEvents} <small>次</small></strong></div>
              <div><span>成功率</span><strong>{successRate}%</strong></div>
              <div><span>平均耗时</span><strong>{avgMs >= 1000 ? `${(avgMs / 1000).toFixed(2)}s` : `${avgMs}ms`}</strong></div>
              <div><span>运行中进程</span><strong>{runningProcessCount}</strong></div>
            </div>
            <div className="header-actions"><button className="icon-button" title="设置 (Ctrl+,)" onClick={openSettings}><Settings size={16} /></button></div>
          </section>

          {mainView === "activity" ? <>
          <section className="activity-toolbar">
            <div className="category-tabs">
              {categories.map((item) => {
                const Icon = item.icon;
                return <button key={item.id} className={classNames(category === item.id && "active")} onClick={() => setCategory(item.id)}><Icon size={14} />{item.label}</button>;
              })}
            </div>
          </section>

          <section className="timeline-area">
            <VirtualEventList
              events={visibleEvents}
              selectedEventId={selectedEvent?.id ?? null}
              detailOpen={detailOpen}
              resetKey={`${workspace.id}|${category}`}
              onSelect={(event) => {
                setSelectedEventId(event.id);
                setDetailOpen(true);
              }}
              empty={workspace.id === "__empty__"
                ? <div className="empty-state"><div className="empty-icon"><Activity size={26} /></div><strong>{connected ? "暂无工作区" : error ? "无法连接 DevSpace" : "正在连接 DevSpace…"}</strong><span>{error ?? "等待工作区和工具调用数据"}</span></div>
                : workspaceHistory?.loading && !workspaceHistory.loaded
                  ? <div className="empty-state"><div className="empty-icon"><Activity size={26} /></div><strong>正在加载历史日志…</strong><span>{workspace.path}</span></div>
                  : <EmptyState workspace={workspace} />}
              footer={workspaceHistory?.error ? (
                <div className="load-more history-load-error">
                  <span>历史日志加载失败：{workspaceHistory.error}</span>
                  <button onClick={() => void loadWorkspaceHistory(workspace.path, { reset: !workspaceHistory.loaded }).catch(() => undefined)}>重试</button>
                </div>
              ) : (workspaceHistory?.hasMore || workspaceHistory?.loading) ? (
                <div className="load-more">
                  <span>已加载 {workspaceEvents.length} / {totalWorkspaceEvents} 条记录</span>
                  <button
                    disabled={workspaceHistory?.loading}
                    onClick={() => void loadWorkspaceHistory(workspace.path, { loadMore: true }).catch(() => undefined)}
                  >{workspaceHistory?.loading ? "加载中…" : "加载更多"}</button>
                </div>
              ) : undefined}
            />
          </section>
          </> : <ProcessManager workspace={workspace} />}
        </main>

        {mainView === "activity" && detailOpen && <DetailPanel
          event={selectedEvent}
          workspace={workspace}
          onClose={() => setDetailOpen(false)}
        />}
      </div>

      {addWorkspaceOpen && (
        <AddWorkspaceDialog
          saving={addWorkspaceSaving}
          error={addWorkspaceError}
          onClose={() => setAddWorkspaceOpen(false)}
          onAdd={submitAddWorkspace}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          retentionDays={retentionDays}
          storedEvents={storedEvents}
          databasePath={databasePath}
          databaseBytes={databaseBytes}
          saving={settingsSaving}
          error={settingsError}
          serviceStatusError={serviceStatusError}
          services={serviceStatuses}
          serviceLogs={serviceLogs}
          startingDevSpace={startingDevSpace}
          restartingDevSpace={restartingDevSpace}
          startingCloudflare={startingCloudflare}
          restartingCloudflare={restartingCloudflare}
          workspace={workspace}
          workspaceMemory={workspaceMemory}
          workspaceMemoryLoading={workspaceMemoryLoading}
          workspaceMemoryError={workspaceMemoryError}
          clearingWorkspaceMemory={clearingWorkspaceMemory}
          onClose={() => setSettingsOpen(false)}
          onSave={saveRetentionDays}
          onCleanup={cleanupStoredEvents}
          onClear={clearStoredEvents}
          onStartDevSpace={startDevSpace}
          onRestartDevSpace={restartDevSpace}
          onStartCloudflare={startCloudflare}
          onRestartCloudflare={restartCloudflare}
          onClearWorkspaceMemory={clearWorkspaceMemory}
        />
      )}
    </div>
  );
}

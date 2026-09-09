import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Code2,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FileCode2,
  FileSearch,
  Folder,
  Gauge,
  Globe,
  HardDrive,
  Loader2,
  Minus,
  Moon,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Star,
  Sun,
  TerminalSquare,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCodingConsoleData } from "./coding-console-data";
import { consoleApi, withQuery } from "./console-api";
import { ProcessManager } from "./ProcessManager";
import type { LogEvent, LogKind, LogStatus, WorkspaceItem } from "./types";

type MainView = "logs" | "processes" | "optimizer" | "environment";
type Theme = "light" | "dark";
type StatusFilter = "all" | "error" | "success" | "running";

interface ClientStatus {
  connected: boolean;
  configured: boolean;
  localUrl: string;
  version?: string;
  error?: string;
}

interface ServiceControlResult {
  ok: boolean;
  message: string;
}

interface CloudflaredTunnelInfo {
  installed: boolean;
  running: boolean;
  url: string | null;
  pid: number | null;
  logs: string[];
  error: string | null;
}

interface DriveCandidate {
  drive: string;
  hasProject: boolean;
  projectPath?: string | null;
}

interface ProjectPathInfo {
  currentRoot?: string | null;
  customRoot?: string | null;
  availableDrives: DriveCandidate[];
  cliExists: boolean;
}

interface RuntimeStatus {
  ok: boolean;
  name: string;
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  pid: number;
  cwd: string;
  execPath: string;
  entry: string;
  configDir: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedRoots: string[];
  toolMode: string;
  widgets: string;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
}

interface OptimizerStatus {
  concurrent: { active: number; limit: number };
  cache: { size: number; hits: number; misses: number; writes: number };
}


interface GitDiffFile {
  path: string;
  status: string;
  additions: number;
  removals: number;
  diff: string;
}

interface GitDiffSnapshot {
  workspaceRoot: string;
  isGit: boolean;
  clean: boolean;
  totalFiles: number;
  totalAdditions: number;
  totalRemovals: number;
  files: GitDiffFile[];
  fullPatch: string;
}

interface ProcessListResponse {
  ok: boolean;
  processes: Array<{ running: boolean }>;
}

const categories: Array<{ id: "all" | LogKind; label: string; icon: typeof Activity }> = [
  { id: "all", label: "全部", icon: Activity },
  { id: "command", label: "命令", icon: TerminalSquare },
  { id: "edit", label: "编辑", icon: Code2 },
  { id: "file", label: "文件", icon: FileCode2 },
  { id: "process", label: "进程", icon: Cpu },
  { id: "search", label: "搜索", icon: FileSearch },
  { id: "system", label: "系统", icon: Settings },
];

function formatUptime(seconds: number | undefined) {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function statusLabel(status: LogStatus) {
  switch (status) {
    case "success": return "成功";
    case "running": return "运行中";
    case "warning": return "警告";
    case "error": return "异常";
    default: return "等待";
  }
}

function iconForKind(kind: LogKind) {
  switch (kind) {
    case "command": return TerminalSquare;
    case "edit": return Code2;
    case "file": return FileCode2;
    case "process": return Cpu;
    case "search": return FileSearch;
    default: return Activity;
  }
}

function statusIcon(status: LogStatus) {
  if (status === "error") return <XCircle size={15} />;
  if (status === "warning") return <AlertTriangle size={15} />;
  if (status === "running") return <CircleDot size={15} />;
  return <CheckCircle2 size={15} />;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function Metric({
  label,
  value,
  note,
  progress,
  progressColor,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  progress?: number;
  progressColor?: string;
}) {
  return (
    <div className="monitor-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
      {progress !== undefined && (
        <div className="monitor-metric-bar">
          <div
            className={`monitor-metric-bar-fill ${progressColor ?? ""}`}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </div>
  );
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
    <button className={classNames("monitor-workspace", selected && "selected")} onClick={onClick}>
      <span className={classNames("monitor-workspace-dot", workspace.status)} />
      <span className="monitor-workspace-copy">
        <strong>{workspace.name}</strong>
        <small title={workspace.path}>
          {workspace.status === "running" ? "运行中" : workspace.status === "error" ? "最近有异常" : "等待调用"}
        </small>
      </span>
      <span className="monitor-workspace-count">{workspace.eventCount}</span>
    </button>
  );
}

function ExpandedEvent({
  event,
  onFavorite,
}: {
  event: LogEvent;
  onFavorite: (event: LogEvent) => Promise<void>;
}) {
  const [cmdCopied, setCmdCopied] = useState(false);
  const [outCopied, setOutCopied] = useState(false);
  const output = [...(event.stdout ?? []), ...(event.stderr ?? [])].join("\n");
  const params = event.params as Record<string, any> | undefined;

  const copyCommand = async () => {
    if (!event.command) return;
    await navigator.clipboard.writeText(event.command);
    setCmdCopied(true);
    setTimeout(() => setCmdCopied(false), 1500);
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setOutCopied(true);
    setTimeout(() => setOutCopied(false), 1500);
  };

  const hasCodeEdit = Boolean(
    params && (params.targetContent !== undefined || params.replacementContent !== undefined || params.codeContent !== undefined)
  );

  return (
    <div className={classNames("monitor-event-expanded", `status-${event.status}`)}>
      <header>
        <span className={classNames("monitor-expanded-icon", event.status)}>{statusIcon(event.status)}</span>
        <div>
          <strong>{event.summary}</strong>
          <small>{event.tool} · {event.time} · {event.duration}</small>
        </div>
        <button
          className={classNames("monitor-icon-button", event.favorite && "active")}
          title={event.favorite ? "取消收藏" : "收藏日志"}
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            void onFavorite(event);
          }}
        >
          <Star size={15} fill={event.favorite ? "currentColor" : "none"} />
        </button>
      </header>

      <div className="monitor-expanded-summary">
        <div><span>状态</span><strong>{statusLabel(event.status)}</strong></div>
        <div><span>工具</span><strong className="mono">{event.tool}</strong></div>
        <div><span>耗时</span><strong>{event.duration}</strong></div>
        <div><span>目标</span><strong className="mono ellipsis" title={event.target}>{event.target ?? "—"}</strong></div>
      </div>

      {event.command && (
        <section className="monitor-expanded-section">
          <div className="monitor-section-title">
            <span>执行命令</span>
            <button onClick={() => void copyCommand()}>
              {cmdCopied ? <Check size={12} color="var(--monitor-green)" /> : <Copy size={12} />}
              {cmdCopied ? "已复制" : "复制"}
            </button>
          </div>
          <pre>{event.command}</pre>
        </section>
      )}

      {hasCodeEdit && (
        <section className="monitor-expanded-section">
          <div className="monitor-section-title">
            <span>代码改动审查 (Inline Diff)</span>
          </div>
          {params?.instruction && (
            <div style={{ fontSize: 12, color: "var(--monitor-text-soft)", marginBottom: 8, padding: "4px 8px", background: "var(--monitor-panel-soft)", borderRadius: 4 }}>
              <strong>改动意图:</strong> {params.instruction}
            </div>
          )}
          {params?.targetContent !== undefined && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#f87171", fontWeight: 600, marginBottom: 4 }}>- 替换前内容 (Original / Target):</div>
              <pre style={{ background: "#200d11", border: "1px solid #4c1d24", color: "#fca5a5", maxHeight: 180, overflowY: "auto" }}>{params.targetContent}</pre>
            </div>
          )}
          {params?.replacementContent !== undefined && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#34d399", fontWeight: 600, marginBottom: 4 }}>+ 替换后内容 (Replacement):</div>
              <pre style={{ background: "#051f18", border: "1px solid #064e3b", color: "#6ee7b7", maxHeight: 180, overflowY: "auto" }}>{params.replacementContent}</pre>
            </div>
          )}
          {params?.codeContent !== undefined && (
            <div>
              <div style={{ fontSize: 11, color: "#38bdf8", fontWeight: 600, marginBottom: 4 }}>写入文件完整内容:</div>
              <pre style={{ maxHeight: 200, overflowY: "auto" }}>{params.codeContent}</pre>
            </div>
          )}
        </section>
      )}

      {output && (
        <section className="monitor-expanded-section">
          <div className="monitor-section-title">
            <span>标准输出 / 错误流</span>
            <button onClick={() => void copyOutput()}>
              {outCopied ? <Check size={12} color="var(--monitor-green)" /> : <Copy size={12} />}
              {outCopied ? "已复制" : "复制"}
            </button>
          </div>
          <pre>{output}</pre>
        </section>
      )}

      <section className="monitor-expanded-section">
        <div className="monitor-section-title"><span>调用参数 (JSON)</span></div>
        <pre>{JSON.stringify(event.params ?? {}, null, 2)}</pre>
      </section>

      {event.files?.length ? (
        <section className="monitor-files">
          <span>关联文件:</span>
          {event.files.map((file) => (
            <code key={file} title={file}>{file}</code>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function SettingsDialog({
  retentionDays,
  storedEvents,
  databasePath,
  databaseBytes,
  busy,
  onClose,
  onSave,
  onCleanup,
  onClear,
}: {
  retentionDays: number;
  storedEvents: number;
  databasePath: string;
  databaseBytes: number;
  busy: boolean;
  onClose: () => void;
  onSave: (days: number) => Promise<void>;
  onCleanup: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [days, setDays] = useState(retentionDays);
  return (
    <div className="monitor-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="monitor-modal" role="dialog" aria-modal="true" aria-label="Console 设置">
        <header>
          <div>
            <span className="monitor-modal-icon"><Settings size={18} /></span>
            <div><strong>Console 全局设置</strong><small>日志存储与本地遥测监控</small></div>
          </div>
          <button className="monitor-icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="monitor-modal-body">
          <label className="monitor-setting-row">
            <div>
              <strong>日志保留时间</strong>
              <span>只影响 Console 本地 SQLite 旁路 telemetry 数据。</span>
            </div>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {[1, 3, 7, 14, 30, 90].map((value) => <option key={value} value={value}>{value} 天</option>)}
            </select>
          </label>
          <div className="monitor-storage-card">
            <Database size={18} color="var(--monitor-blue)" />
            <div>
              <strong>{storedEvents.toLocaleString("zh-CN")} 条日志记录</strong>
              <span title={databasePath}>{databasePath || "SQLite 路径不可用"}</span>
            </div>
            <small>{databaseBytes ? `${(databaseBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</small>
          </div>
          <div className="monitor-maintenance-actions">
            <button disabled={busy} onClick={() => void onCleanup()}>清理过期日志</button>
            <button className="danger" disabled={busy || storedEvents === 0} onClick={() => void onClear()}>清空全部日志</button>
          </div>
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void onSave(days)}>
            {busy ? "保存中…" : "保存设置"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AddWorkspaceDialog({
  busy,
  error,
  onClose,
  onAdd,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onAdd: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  return (
    <div className="monitor-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="monitor-modal small" role="dialog" aria-modal="true" aria-label="添加工作区">
        <header>
          <div>
            <span className="monitor-modal-icon"><Folder size={18} /></span>
            <div><strong>添加本地工作区</strong><small>连接一个已有项目目录</small></div>
          </div>
          <button className="monitor-icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="monitor-modal-body">
          <label className="monitor-path-field">
            <span>绝对路径</span>
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="例如: D:\my-project 或 /Users/name/my-project"
            />
          </label>
          {error && <div className="monitor-inline-error">{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !path.trim()} onClick={() => void onAdd(path.trim())}>
            {busy ? "添加中…" : "确认添加"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function App() {
  const {
    workspaces,
    events,
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
  } = useCodingConsoleData();

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("logs");
  const [category, setCategory] = useState<"all" | LogKind>("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("console-theme") as Theme | null) ?? "light");
  const [clientStatus, setClientStatus] = useState<ClientStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [optimizer, setOptimizer] = useState<OptimizerStatus | null>(null);
  const [processCount, setProcessCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceBusy, setAddWorkspaceBusy] = useState(false);
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Service management states
  const [serviceActionBusy, setServiceActionBusy] = useState(false);
  const [serviceFeedback, setServiceFeedback] = useState<string | null>(null);
  const [serviceLogs, setServiceLogs] = useState<string[]>([]);
  const [showServiceLogs, setShowServiceLogs] = useState(false);
  const serviceLogsEndRef = useRef<HTMLDivElement | null>(null);

  // Cloudflare Tunnel & Custom Public Domain management states
  const [tunnelInfo, setTunnelInfo] = useState<CloudflaredTunnelInfo | null>(null);
  const [tunnelActionBusy, setTunnelActionBusy] = useState(false);
  const [tunnelFeedback, setTunnelFeedback] = useState<string | null>(null);
  const [showTunnelLogs, setShowTunnelLogs] = useState(false);
  const [gptmcpConfig, setGptmcpConfig] = useState<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null } | null>(null);
  const [customDomainInput, setCustomDomainInput] = useState<string>("");
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainFeedback, setDomainFeedback] = useState<string | null>(null);
  const [showDomainEditor, setShowDomainEditor] = useState(false);

  // Project Root & Drive selection states
  const [projectPathInfo, setProjectPathInfo] = useState<ProjectPathInfo | null>(null);
  const [customPathInput, setCustomPathInput] = useState<string>("");
  const [pathSaving, setPathSaving] = useState(false);
  const [pathFeedback, setPathFeedback] = useState<string | null>(null);


  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("console-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!workspaces.length) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (!selectedWorkspaceId || !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  const workspace = useMemo(
    () => workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (!workspace) return;
    void loadWorkspaceHistory(workspace.path).catch(() => undefined);
  }, [loadWorkspaceHistory, workspace?.id, workspace?.path]);

  const updateServiceLogs = useCallback(async () => {
    try {
      const logs = await invoke<string[]>("get_gptmcp_service_logs");
      setServiceLogs(logs);
    } catch {
      // ignore
    }
  }, []);

  const handleClearServiceLogs = async () => {
    try {
      await invoke("clear_gptmcp_service_logs");
      setServiceLogs([]);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (showServiceLogs || serviceActionBusy) {
      void updateServiceLogs();
      const interval = setInterval(() => {
        void updateServiceLogs();
      }, 800);
      return () => clearInterval(interval);
    }
  }, [showServiceLogs, serviceActionBusy, updateServiceLogs]);

  useEffect(() => {
    if (showServiceLogs && serviceLogsEndRef.current) {
      serviceLogsEndRef.current.scrollTop = serviceLogsEndRef.current.scrollHeight;
    }
  }, [serviceLogs, showServiceLogs]);

  const updateTunnelStatus = useCallback(async () => {
    try {
      const info = await invoke<CloudflaredTunnelInfo>("get_cloudflared_status");
      setTunnelInfo(info);
    } catch {
      // ignore
    }
  }, []);

  const updateGptmcpConfig = useCallback(async () => {
    try {
      const config = await invoke<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null }>("get_gptmcp_config");
      setGptmcpConfig(config);
      if (config.publicBaseUrl) {
        setCustomDomainInput(config.publicBaseUrl);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSaveDomain = async (urlToSave?: string | null) => {
    setDomainSaving(true);
    setDomainFeedback("正在保存公网域名配置并重启服务…");
    try {
      const targetUrl = urlToSave !== undefined ? urlToSave : (customDomainInput.trim() ? customDomainInput.trim() : null);
      const res = await invoke<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null }>("set_gptmcp_public_url", { url: targetUrl });
      setGptmcpConfig(res);
      setDomainFeedback(targetUrl ? `固定公网域名已保存并生效: ${targetUrl}` : "已清除公网域名 (恢复本地 127.0.0.1 模式)");
      setShowDomainEditor(false);
      await refreshAll();
    } catch (err) {
      setDomainFeedback(`保存域名失败: ${String(err)}`);
    } finally {
      setDomainSaving(false);
      setTimeout(() => setDomainFeedback(null), 5000);
    }
  };

  const updateProjectPathInfo = useCallback(async () => {
    try {
      const info = await invoke<ProjectPathInfo>("get_project_path_info");
      setProjectPathInfo(info);
      if (info.customRoot) {
        setCustomPathInput(info.customRoot);
      } else if (info.currentRoot) {
        setCustomPathInput(info.currentRoot);
      }
    } catch {
      // ignore
    }
  }, []);

  const updateStatus = async () => {
    const [clientResult, runtimeResult, optimizerResult] = await Promise.allSettled([
      invoke<ClientStatus>("get_client_status"),
      consoleApi<RuntimeStatus>("GET", "/statusz"),
      consoleApi<OptimizerStatus>("GET", "/statusz/optimizer"),
    ]);
    if (clientResult.status === "fulfilled") setClientStatus(clientResult.value);
    if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value);
    else if (runtimeResult.status === "rejected") setRuntime(null);
    if (optimizerResult.status === "fulfilled") setOptimizer(optimizerResult.value);
    else if (optimizerResult.status === "rejected") setOptimizer(null);
  };

  useEffect(() => {
    let disposed = false;
    const runUpdate = async () => {
      if (disposed) return;
      await updateStatus();
      await updateTunnelStatus();
      await updateProjectPathInfo();
      await updateGptmcpConfig();
    };
    void runUpdate();
    const timer = window.setInterval(() => void runUpdate(), 4_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [updateTunnelStatus, updateProjectPathInfo, updateGptmcpConfig]);

  useEffect(() => {
    if (!workspace) {
      setProcessCount(0);
      return;
    }
    let disposed = false;
    const updateProcesses = async () => {
      try {
        const response = await consoleApi<ProcessListResponse>(
          "GET",
          withQuery("/console/processes", { workspaceRoot: workspace.path }),
        );
        if (!disposed) setProcessCount(response.processes.filter((process) => process.running).length);
      } catch {
        if (!disposed) setProcessCount(0);
      }
    };
    void updateProcesses();
    const timer = window.setInterval(() => void updateProcesses(), 3_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [workspace?.id, workspace?.path]);

  const workspaceEvents = useMemo(() => {
    if (!workspace) return [];
    return events.filter((event) => event.workspaceId === workspace.id);
  }, [events, workspace]);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workspaceEvents.filter((event) => {
      if (statusFilter === "error" && event.status !== "error" && event.status !== "warning") return false;
      if (statusFilter === "success" && event.status !== "success") return false;
      if (statusFilter === "running" && event.status !== "running") return false;
      if (category !== "all" && event.kind !== category) return false;
      if (!normalizedQuery) return true;
      return [event.tool, event.summary, event.target, event.command]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [category, statusFilter, query, workspaceEvents]);

  const errorCount = workspaceEvents.filter((event) => event.status === "error" || event.status === "warning").length;
  const history = workspace ? historyByWorkspace[workspace.id] : undefined;
  const totalEvents = history?.total ?? workspace?.eventCount ?? workspaceEvents.length;

  const isServiceOnline = clientStatus?.connected ?? connected;

  const publicTunnelUrl = tunnelInfo?.url ?? (runtime?.publicBaseUrl ? runtime.publicBaseUrl.replace(/\/+$/, "") : "");
  const mcpEndpoint = publicTunnelUrl ? `${publicTunnelUrl}/mcp` : `${clientStatus?.localUrl ?? "http://127.0.0.1:7676"}/mcp`;

  const refreshAll = async () => {
    setIsRefreshing(true);
    try {
      await refresh();
      await updateStatus();
      await updateTunnelStatus();
      await updateProjectPathInfo();
      if (workspace) await loadWorkspaceHistory(workspace.path, { reset: true }).catch(() => undefined);
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  const handleStartService = async () => {
    setServiceActionBusy(true);
    setShowServiceLogs(true);
    setServiceFeedback("正在启动 GPTMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("start_gptmcp_service");
      setServiceFeedback(result.message);
      await updateServiceLogs();
      await refreshAll();
    } catch (err) {
      setServiceFeedback(`启动失败: ${String(err)}`);
      await updateServiceLogs();
    } finally {
      setServiceActionBusy(false);
      setTimeout(() => setServiceFeedback(null), 4000);
    }
  };

  const handleStopService = async () => {
    if (!window.confirm("确定停止 GPTMCP 后台服务吗？这将中断当前连接。")) return;
    setServiceActionBusy(true);
    setShowServiceLogs(true);
    setServiceFeedback("正在停止 GPTMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("stop_gptmcp_service");
      setServiceFeedback(result.message);
      await updateServiceLogs();
      await refreshAll();
    } catch (err) {
      setServiceFeedback(`停止失败: ${String(err)}`);
      await updateServiceLogs();
    } finally {
      setServiceActionBusy(false);
      setTimeout(() => setServiceFeedback(null), 4000);
    }
  };

  const handleRestartService = async () => {
    setServiceActionBusy(true);
    setShowServiceLogs(true);
    setServiceFeedback("正在重启 GPTMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("restart_gptmcp_service");
      setServiceFeedback(result.message);
      await updateServiceLogs();
      await refreshAll();
    } catch (err) {
      setServiceFeedback(`重启失败: ${String(err)}`);
      await updateServiceLogs();
    } finally {
      setServiceActionBusy(false);
      setTimeout(() => setServiceFeedback(null), 4000);
    }
  };

  const handleStartTunnel = async () => {
    setTunnelActionBusy(true);
    setTunnelFeedback("正在初始化 Cloudflare 临时公网隧道 (TryCloudflare)…");
    try {
      const info = await invoke<CloudflaredTunnelInfo>("start_cloudflared_tunnel");
      setTunnelInfo(info);
      if (info.url) {
        setTunnelFeedback(`Cloudflare 临时域名已分配: ${info.url}`);
      } else if (info.error) {
        setTunnelFeedback(info.error);
      }
    } catch (err) {
      setTunnelFeedback(`启动隧道失败: ${String(err)}`);
    } finally {
      setTunnelActionBusy(false);
      setTimeout(() => setTunnelFeedback(null), 6000);
    }
  };

  const handleStopTunnel = async () => {
    setTunnelActionBusy(true);
    setTunnelFeedback("正在关闭 Cloudflare 隧道…");
    try {
      const info = await invoke<CloudflaredTunnelInfo>("stop_cloudflared_tunnel");
      setTunnelInfo(info);
      setTunnelFeedback("Cloudflare 临时公网隧道已安全关闭");
    } catch (err) {
      setTunnelFeedback(`停止隧道失败: ${String(err)}`);
    } finally {
      setTunnelActionBusy(false);
      setTimeout(() => setTunnelFeedback(null), 4000);
    }
  };

  const handleRestartTunnel = async () => {
    setTunnelActionBusy(true);
    setTunnelFeedback("正在重新申请 Cloudflare 临时域名…");
    try {
      const info = await invoke<CloudflaredTunnelInfo>("start_cloudflared_tunnel");
      setTunnelInfo(info);
      if (info.url) {
        setTunnelFeedback(`新临时域名已分配: ${info.url}`);
      }
    } catch (err) {
      setTunnelFeedback(`重新获取失败: ${String(err)}`);
    } finally {
      setTunnelActionBusy(false);
      setTimeout(() => setTunnelFeedback(null), 6000);
    }
  };

  const handleSaveCustomPath = async (target?: string | null) => {
    setPathSaving(true);
    const newPath = target !== undefined ? target : (customPathInput.trim() || null);
    try {
      const info = await invoke<ProjectPathInfo>("set_custom_project_root", { path: newPath });
      setProjectPathInfo(info);
      if (info.customRoot) {
        setPathFeedback(`项目路径已自定义设置为: ${info.customRoot}`);
      } else {
        setPathFeedback(`已恢复自动探测模式，当前生效路径: ${info.currentRoot ?? "未找到"}`);
      }
      await refreshAll();
    } catch (err) {
      setPathFeedback(`保存路径失败: ${String(err)}`);
    } finally {
      setPathSaving(false);
      setTimeout(() => setPathFeedback(null), 4000);
    }
  };

  const handleSelectDrive = async (drive: DriveCandidate) => {
    const target = drive.projectPath || `${drive.drive}devspace-main`;
    setCustomPathInput(target);
    await handleSaveCustomPath(target);
  };

  const toggleFavorite = async (event: LogEvent) => {
    await setEventFavorite(event.id, !event.favorite);
  };

  const copyWorkspacePath = async () => {
    if (!workspace?.path) return;
    await navigator.clipboard.writeText(workspace.path);
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1500);
  };

  const copyMcpEndpoint = async () => {
    await navigator.clipboard.writeText(mcpEndpoint);
    setMcpUrlCopied(true);
    setTimeout(() => setMcpUrlCopied(false), 1500);
  };

  const addWorkspace = async (path: string) => {
    setAddWorkspaceBusy(true);
    setAddWorkspaceError(null);
    try {
      await consoleApi("POST", "/console/workspaces", { path });
      await refresh();
      setAddWorkspaceOpen(false);
    } catch (cause) {
      setAddWorkspaceError(String(cause));
    } finally {
      setAddWorkspaceBusy(false);
    }
  };

  const saveSettings = async (days: number) => {
    setSettingsBusy(true);
    try {
      await updateRetentionDays(days);
      setSettingsOpen(false);
    } finally {
      setSettingsBusy(false);
    }
  };

  const cleanup = async () => {
    setSettingsBusy(true);
    try { await cleanupEvents(); } finally { setSettingsBusy(false); }
  };

  const clear = async () => {
    if (!window.confirm("确定清空 Console 的全部旁路日志吗？此操作不可撤销。")) return;
    setSettingsBusy(true);
    try { await clearEvents(); } finally { setSettingsBusy(false); }
  };

  const appWindow = getCurrentWindow();

  // Optimizer metrics calculations
  const cacheHitTotal = (optimizer?.cache.hits ?? 0) + (optimizer?.cache.misses ?? 0);
  const cacheHitRate = cacheHitTotal > 0 ? Math.round(((optimizer?.cache.hits ?? 0) / cacheHitTotal) * 100) : 0;
  const concurrentUsage = optimizer?.concurrent.limit
    ? Math.round(((optimizer.concurrent.active) / optimizer.concurrent.limit) * 100)
    : 0;

  return (
    <div className="monitor-shell">
      <header className="monitor-titlebar" data-tauri-drag-region>
        <div className="monitor-brand" data-tauri-drag-region>
          <span className="monitor-brand-mark"><Code2 size={16} /></span>
          <strong>GPTMCP Console</strong>
          <small>v{serverVersion === "—" ? clientStatus?.version ?? "1.0" : serverVersion}</small>
        </div>
        <div className="monitor-window-actions">
          <button
            title={theme === "light" ? "切换深色主题" : "切换浅色主题"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          <button title="最小化" onClick={() => void appWindow.minimize()}><Minus size={15} /></button>
          <button title="最大化 / 还原" onClick={() => void appWindow.toggleMaximize()}><Square size={12} /></button>
          <button className="close" title="关闭" onClick={() => void appWindow.close()}><X size={15} /></button>
        </div>
      </header>

      <div className="monitor-layout">
        <aside className="monitor-sidebar">
          <section className="monitor-sidebar-section workspace-section">
            <div className="monitor-sidebar-heading">
              <span>工作区</span>
              <button
                className="monitor-icon-button"
                title="添加本地工作区"
                onClick={() => setAddWorkspaceOpen(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="monitor-workspace-list">
              {workspaces.map((item) => (
                <WorkspaceRow
                  key={item.id}
                  workspace={item}
                  selected={item.id === workspace?.id}
                  onClick={() => {
                    setSelectedWorkspaceId(item.id);
                    setExpandedEventId(null);
                    setView("logs");
                  }}
                />
              ))}
              {!workspaces.length && !loading && (
                <div className="monitor-sidebar-empty">
                  <Folder size={24} color="var(--monitor-muted)" />
                  <span>暂无已连接工作区</span>
                  <small>通过 GPTMCP 打开或点击上方加号添加本地项目</small>
                </div>
              )}
              {loading && !workspaces.length && (
                <div className="monitor-sidebar-empty">
                  <Loader2 className="spinning" size={22} color="var(--monitor-blue)" />
                  <span>正在连接本地服务…</span>
                </div>
              )}
            </div>
          </section>

          <section className="monitor-sidebar-section monitor-global-nav">
            <div className="monitor-sidebar-heading muted"><span>控制面板</span></div>
            <button className={classNames(view === "logs" && "selected")} onClick={() => setView("logs")}>
              <Activity size={15} />
              <span>实时日志</span>
              <em>{workspaceEvents.length}</em>
            </button>
            <button className={classNames(view === "processes" && "selected")} onClick={() => setView("processes")}>
              <TerminalSquare size={15} />
              <span>运行进程</span>
              <em>{processCount}</em>
            </button>
            <button className={classNames(view === "optimizer" && "selected")} onClick={() => setView("optimizer")}>
              <Zap size={15} />
              <span>性能与缓存</span>
              <em>{optimizer?.cache.size ?? "—"}</em>
            </button>
            <button className={classNames(view === "environment" && "selected")} onClick={() => setView("environment")}>
              <ShieldCheck size={15} />
              <span>环境与服务</span>
            </button>
            <button onClick={() => setSettingsOpen(true)}>
              <Settings size={15} />
              <span>全局设置</span>
            </button>
          </section>

          <section className="monitor-service-footer">
            <button
              className={classNames("monitor-service-card", !isServiceOnline && "offline")}
              onClick={() => setView("environment")}
            >
              <span className="monitor-service-icon"><Server size={16} /></span>
              <span>
                <strong>{isServiceOnline ? "本地 MCP 服务" : "服务未启动"}</strong>
                <small>{clientStatus?.localUrl ?? "127.0.0.1:7676"}</small>
              </span>
              <i />
            </button>

            {/* Cloudflare Tunnel Status Indicator in Footer */}
            {publicTunnelUrl ? (
              <button
                className="monitor-service-card"
                onClick={() => setView("environment")}
                style={{ marginTop: 2 }}
                title={publicTunnelUrl}
              >
                <span className="monitor-service-icon secondary"><Cloud size={16} /></span>
                <span>
                  <strong>Cloudflare Tunnel</strong>
                  <small className="mono">{publicTunnelUrl}</small>
                </span>
                <i />
              </button>
            ) : null}

            <div className="monitor-service-quick-actions">
              {!isServiceOnline ? (
                <button
                  className="monitor-service-quick-btn primary"
                  disabled={serviceActionBusy}
                  onClick={() => void handleStartService()}
                >
                  <Play size={11} />
                  {serviceActionBusy ? "启动中…" : "一键启动服务"}
                </button>
              ) : (
                <>
                  <button
                    className="monitor-service-quick-btn"
                    disabled={serviceActionBusy}
                    onClick={() => void handleRestartService()}
                    title="重启后台服务"
                  >
                    <RotateCw size={11} className={serviceActionBusy ? "spinning" : ""} />
                    重启
                  </button>
                  <button
                    className="monitor-service-quick-btn"
                    disabled={serviceActionBusy}
                    onClick={() => void handleStopService()}
                    title="停止服务"
                  >
                    <Square size={10} />
                    停止
                  </button>
                </>
              )}
            </div>
          </section>
        </aside>

        <main className="monitor-main">
          <header className="monitor-workspace-header">
            <div className="monitor-workspace-title">
              <span className={classNames("monitor-live-dot", isServiceOnline && "online")} />
              <div>
                <div>
                  <strong>{workspace?.name ?? "DevSpace"}</strong>
                  <span className={classNames("monitor-status-pill", isServiceOnline ? "online" : "offline")}>
                    {isServiceOnline ? "在线运行中" : "服务已停止"}
                  </span>
                </div>
                <div className="monitor-path-container">
                  <span className="monitor-path-pill" title={workspace?.path}>
                    {workspace?.path ?? "等待工作区连接"}
                  </span>
                  {workspace?.path && (
                    <button
                      className="monitor-copy-badge"
                      title="复制工作区绝对路径"
                      onClick={() => void copyWorkspacePath()}
                    >
                      {pathCopied ? <Check size={11} color="var(--monitor-green)" /> : <Copy size={11} />}
                      {pathCopied ? "已复制" : "复制"}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="monitor-header-actions">
              <button
                className="monitor-icon-button"
                title="刷新数据"
                onClick={() => void refreshAll()}
              >
                <RefreshCw size={15} className={isRefreshing ? "spinning" : ""} />
              </button>
              <button
                className="monitor-icon-button"
                title="Console 全局设置"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={15} />
              </button>
            </div>
          </header>

          {view === "logs" && (
            <>
              <section className="monitor-log-toolbar">
                <div className="monitor-view-tabs">
                  <button className="active"><Activity size={14} />实时日志</button>
                  <button onClick={() => setView("processes")}><TerminalSquare size={14} />运行终端</button>
                </div>

                <div className="monitor-status-filters">
                  <button
                    className={classNames("monitor-filter-chip", statusFilter === "all" && "active")}
                    onClick={() => setStatusFilter("all")}
                  >
                    全部
                  </button>
                  <button
                    className={classNames("monitor-filter-chip danger", statusFilter === "error" && "active")}
                    onClick={() => setStatusFilter(statusFilter === "error" ? "all" : "error")}
                  >
                    <AlertTriangle size={12} />
                    异常 ({errorCount})
                  </button>
                  <button
                    className={classNames("monitor-filter-chip", statusFilter === "success" && "active")}
                    onClick={() => setStatusFilter(statusFilter === "success" ? "all" : "success")}
                  >
                    <CheckCircle2 size={12} />
                    成功
                  </button>
                </div>

                <div className="monitor-inline-stats">
                  <span><Zap size={12} />{totalEvents} 调用</span>
                  <span><TerminalSquare size={12} />{processCount} 进程</span>
                  <span><FileSearch size={12} />{filteredEvents.length} 条可见</span>
                </div>

                <div className="monitor-search">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="按工具名、命令或参数搜索..."
                  />
                  {query && (
                    <button onClick={() => setQuery("")}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              </section>

              <section className="monitor-category-bar">
                {categories.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      className={category === item.id ? "active" : ""}
                      onClick={() => setCategory(item.id)}
                    >
                      <Icon size={13} />
                      {item.label}
                    </button>
                  );
                })}
              </section>

              <section className="monitor-events">
                {!isServiceOnline && (
                  <div className="monitor-service-offline-banner">
                    <div>
                      <AlertTriangle size={18} color="var(--monitor-amber)" />
                      <div>
                        <strong>GPTMCP 本地服务未运行</strong>
                        <span>启动后台守护服务以监听 MCP 工具调用与遥测数据。</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button
                        className="service-action-btn"
                        onClick={() => {
                          setView("environment");
                          setShowServiceLogs(true);
                        }}
                      >
                        <TerminalSquare size={13} />
                        查看服务日志
                      </button>
                      <button
                        disabled={serviceActionBusy}
                        onClick={() => void handleStartService()}
                      >
                        <Play size={13} />
                        {serviceActionBusy ? "正在启动…" : "一键启动服务"}
                      </button>
                    </div>
                  </div>
                )}

                {error && isServiceOnline && (
                  <div className="monitor-connection-warning">
                    <AlertTriangle size={16} />
                    <div>
                      <strong>Console 数据连接异常</strong>
                      <span>{error}</span>
                    </div>
                    <button onClick={() => void refreshAll()}>重试</button>
                  </div>
                )}

                {filteredEvents.map((event) => {
                  const Icon = iconForKind(event.kind);
                  const expanded = expandedEventId === event.id;
                  return (
                    <article key={event.id} className={classNames("monitor-event-card", expanded && "expanded")}>
                      <button className="monitor-event-row" onClick={() => setExpandedEventId(expanded ? null : event.id)}>
                        <span className="monitor-expand">
                          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </span>
                        <time>{event.time}</time>
                        <span className={classNames("monitor-tool-icon", event.kind)}><Icon size={15} /></span>
                        <span className="monitor-event-primary">
                          <strong>{event.tool}</strong>
                          <small>{event.summary}</small>
                        </span>
                        <code title={event.target}>{event.target ?? "—"}</code>
                        <span className={classNames("monitor-duration", event.status)}>{event.duration}</span>
                        <span className={classNames("monitor-event-state", event.status)}>{statusIcon(event.status)}</span>
                      </button>
                      {expanded && <ExpandedEvent event={event} onFavorite={toggleFavorite} />}
                    </article>
                  );
                })}

                {!filteredEvents.length && !loading && isServiceOnline && (
                  <div className="monitor-empty-state">
                    <Activity size={32} />
                    <strong>{workspace ? "当前筛选条件下暂无日志" : "暂无工作区数据"}</strong>
                    <span>{workspace ? "尝试清空搜索框或重置分类筛选。" : "先在 GPTMCP 中打开工作区以查看实时动态。"}</span>
                  </div>
                )}
                {loading && !filteredEvents.length && isServiceOnline && (
                  <div className="monitor-empty-state">
                    <Loader2 className="spinning" size={28} color="var(--monitor-blue)" />
                    <strong>正在同步并加载遥测日志…</strong>
                  </div>
                )}

                {workspace && history?.hasMore && (
                  <div className="monitor-load-more">
                    <span>已加载 {workspaceEvents.length} / {history.total} 条日志</span>
                    <button disabled={history.loading} onClick={() => void loadWorkspaceHistory(workspace.path, { loadMore: true })}>
                      {history.loading ? "加载中…" : "加载更早日志"}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          {view === "processes" && workspace && (
            <ProcessManager workspace={workspace} />
          )}

          {view === "optimizer" && (
            <section className="monitor-overview-view">
              <div className="monitor-page-heading">
                <span className="monitor-page-icon"><Zap size={20} /></span>
                <div>
                  <strong>Optimizer 性能与缓存监控</strong>
                  <small>MCP 请求并发限制、工具列表缓存状态与响应加速</small>
                </div>
              </div>
              <div className="monitor-metric-grid">
                <Metric
                  label="当前并发"
                  value={`${optimizer?.concurrent.active ?? 0} / ${optimizer?.concurrent.limit ?? "—"}`}
                  note={`负载率 ${concurrentUsage}%`}
                  progress={concurrentUsage}
                />
                <Metric
                  label="缓存命中率"
                  value={`${cacheHitRate}%`}
                  note={`${optimizer?.cache.hits ?? 0} 命中 · ${optimizer?.cache.misses ?? 0} 未命中`}
                  progress={cacheHitRate}
                  progressColor="green"
                />
                <Metric label="缓存条目数" value={optimizer?.cache.size ?? 0} note="当前内存活跃条目" />
                <Metric label="缓存写入数" value={optimizer?.cache.writes ?? 0} note="累积写入次数" />
              </div>

              <div className="monitor-info-panel">
                <header>
                  <Gauge size={16} color="var(--monitor-blue)" />
                  <strong>实时遥测状态快照</strong>
                  <span>每 4 秒自动刷新</span>
                </header>
                <pre>{JSON.stringify(optimizer ?? { status: "waiting_for_response" }, null, 2)}</pre>
              </div>
            </section>
          )}

          {view === "environment" && (
            <section className="monitor-overview-view">
              <div className="monitor-page-heading">
                <span className="monitor-page-icon"><ShieldCheck size={20} /></span>
                <div>
                  <strong>环境检查与服务主控</strong>
                  <small>GPTMCP 本地服务生命周期管理、隧道状态与运行配置详情</small>
                </div>
              </div>

              {/* Service Control Card */}
              <div className="monitor-service-manager-card">
                <div className="monitor-service-manager-header">
                  <div className="monitor-service-manager-info">
                    <span className={classNames("monitor-service-manager-icon", isServiceOnline && "online")}>
                      <Server size={22} />
                    </span>
                    <div className="monitor-service-manager-title">
                      <strong>GPTMCP 核心服务 ({isServiceOnline ? "运行中" : "已停止"})</strong>
                      <span>
                        {isServiceOnline
                          ? `服务监听在 ${clientStatus?.localUrl ?? "http://127.0.0.1:7676"}`
                          : "本地 7676 端口未连接或服务处于停止状态"}
                      </span>
                    </div>
                  </div>

                  <div className="monitor-service-control-buttons">
                    {!isServiceOnline ? (
                      <button
                        className="service-action-btn start"
                        disabled={serviceActionBusy}
                        onClick={() => void handleStartService()}
                      >
                        <Play size={14} />
                        {serviceActionBusy ? "正在启动…" : "启动服务"}
                      </button>
                    ) : (
                      <>
                        <button
                          className="service-action-btn restart"
                          disabled={serviceActionBusy}
                          onClick={() => void handleRestartService()}
                        >
                          <RotateCw size={14} className={serviceActionBusy ? "spinning" : ""} />
                          {serviceActionBusy ? "重启中…" : "重启服务"}
                        </button>
                        <button
                          className="service-action-btn stop"
                          disabled={serviceActionBusy}
                          onClick={() => void handleStopService()}
                        >
                          <Square size={13} />
                          停止服务
                        </button>
                      </>
                    )}
                    <button
                      className={classNames("service-action-btn", showServiceLogs && "active")}
                      onClick={() => {
                        const nextState = !showServiceLogs;
                        setShowServiceLogs(nextState);
                        if (nextState) void updateServiceLogs();
                      }}
                      title="展开/收起核心服务运行与重启日志"
                    >
                      <TerminalSquare size={13} />
                      {showServiceLogs ? "收起日志" : "服务日志"}
                    </button>
                    <button
                      className="service-action-btn"
                      onClick={() => void refreshAll()}
                      title="刷新连接检测"
                    >
                      <RefreshCw size={13} className={isRefreshing ? "spinning" : ""} />
                      检测
                    </button>
                  </div>
                </div>

                {serviceFeedback && (
                  <div className="monitor-inline-error" style={{ background: "var(--monitor-panel-soft)", color: "var(--monitor-text)", border: "1px solid var(--monitor-line)" }}>
                    {serviceFeedback}
                  </div>
                )}

                {showServiceLogs && (
                  <div className="monitor-info-panel" style={{ marginTop: 12, border: "1px solid var(--monitor-line)" }}>
                    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--monitor-panel-soft)", borderBottom: "1px solid var(--monitor-line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <TerminalSquare size={14} color="var(--monitor-blue)" />
                        <strong>GPTMCP 核心服务生命周期与启停日志</strong>
                        <span style={{ fontSize: 11, color: "var(--monitor-text-soft)" }}>
                          {isServiceOnline ? "状态: 7676 端口运行中" : "状态: 服务已停止"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="service-action-btn"
                          style={{ padding: "2px 8px", fontSize: 11 }}
                          onClick={() => void handleClearServiceLogs()}
                          title="清空服务日志"
                        >
                          清空
                        </button>
                        <button
                          className="service-action-btn"
                          style={{ padding: "2px 8px", fontSize: 11 }}
                          onClick={() => void updateServiceLogs()}
                          title="刷新服务日志"
                        >
                          刷新
                        </button>
                      </div>
                    </header>
                    <div
                      ref={serviceLogsEndRef}
                      style={{
                        maxHeight: 260,
                        overflowY: "auto",
                        background: "#090d16",
                        color: "#e2e8f0",
                        padding: "12px 14px",
                        fontSize: 12,
                        lineHeight: 1.6,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        boxShadow: "inset 0 2px 4px rgba(0,0,0,0.5)"
                      }}
                    >
                      {serviceLogs?.length ? (
                        serviceLogs.map((line, idx) => {
                          let color = "#e2e8f0";
                          if (line.includes("✅")) color = "#34d399";
                          else if (line.includes("❌") || line.includes("异常") || line.includes("错误") || line.includes("Fail")) color = "#f87171";
                          else if (line.includes("⚠️") || line.includes("警告") || line.includes("⏹️") || line.includes("🧹") || line.includes("🔪")) color = "#fb923c";
                          else if (line.includes("📦") || line.includes("⚙️") || line.includes("📁")) color = "#c084fc";
                          else if (line.includes("🚀") || line.includes("🔄") || line.includes("正在") || line.includes("准备") || line.includes("⚡") || line.includes("🩺") || line.includes("🌐")) color = "#60a5fa";
                          return (
                            <div key={idx} style={{ color, padding: "1px 0", wordBreak: "break-all" }}>
                              {line}
                            </div>
                          );
                        })
                      ) : (
                        <div style={{ color: "#64748b" }}>暂无启停日志。点击「启动服务」、「停止服务」或「重启服务」查看全流程生命周期事件。</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Public Tunnel & Cloudflare Tunnel Status Card */}
              <div className="monitor-service-manager-card">
                <div className="monitor-service-manager-header">
                  <div className="monitor-service-manager-info">
                    <span className={classNames("monitor-service-manager-icon", (tunnelInfo?.running || publicTunnelUrl) ? "online" : "")}>
                      <Cloud size={22} />
                    </span>
                    <div className="monitor-service-manager-title">
                      <strong>Cloudflare 临时公网隧道 (TryCloudflare)</strong>
                      <span>
                        {tunnelInfo?.running && tunnelInfo?.url
                          ? `临时域名已就绪: ${tunnelInfo.url}`
                          : tunnelInfo?.running
                          ? "正在与 Cloudflare 边缘节点握手并分配临时域名…"
                          : publicTunnelUrl
                          ? `已配置公网隧道: ${publicTunnelUrl}`
                          : "无需域名或账号，一键生成 Cloudflare 免费临时公网域名，直连 ChatGPT"}
                      </span>
                    </div>
                  </div>

                  <div className="monitor-service-control-buttons">
                    {!tunnelInfo?.running ? (
                      <button
                        className="service-action-btn start"
                        disabled={tunnelActionBusy}
                        onClick={() => void handleStartTunnel()}
                        title="一键启动 Cloudflare TryCloudflare 免费临时隧道"
                      >
                        <Play size={14} />
                        {tunnelActionBusy ? "初始化中…" : "一键启动临时隧道"}
                      </button>
                    ) : (
                      <>
                        <button
                          className="service-action-btn restart"
                          disabled={tunnelActionBusy}
                          onClick={() => void handleRestartTunnel()}
                          title="重新向 Cloudflare 申请新的临时域名"
                        >
                          <RotateCw size={14} className={tunnelActionBusy ? "spinning" : ""} />
                          {tunnelActionBusy ? "申请中…" : "更换临时域名"}
                        </button>
                        <button
                          className="service-action-btn stop"
                          disabled={tunnelActionBusy}
                          onClick={() => void handleStopTunnel()}
                          title="停止 Cloudflare 临时隧道"
                        >
                          <Square size={13} />
                          停止隧道
                        </button>
                      </>
                    )}
                    <button
                      className={classNames("service-action-btn", showTunnelLogs && "active")}
                      onClick={() => setShowTunnelLogs(!showTunnelLogs)}
                      title="展开/收起隧道实时日志"
                    >
                      <TerminalSquare size={13} />
                      {showTunnelLogs ? "收起日志" : "隧道日志"}
                    </button>
                  </div>
                </div>

                {tunnelFeedback && (
                  <div className="monitor-inline-error" style={{ background: "var(--monitor-panel-soft)", color: "var(--monitor-text)", border: "1px solid var(--monitor-line)" }}>
                    {tunnelFeedback}
                  </div>
                )}

                {/* Full-width ChatGPT MCP Endpoint Box */}
                <div className="monitor-endpoint-banner">
                  <div className="monitor-endpoint-label">
                    <Globe size={15} color="var(--monitor-blue)" />
                    <strong>ChatGPT MCP 连接端点 (Endpoint URL)</strong>
                    <span className="monitor-endpoint-tag">{publicTunnelUrl ? (tunnelInfo?.url ? "TryCloudflare 临时域名" : "自定义公网域名") : "本地模式"}</span>
                    <button
                      className="service-action-btn"
                      style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 11 }}
                      onClick={() => setShowDomainEditor(!showDomainEditor)}
                      title="配置自定义固定公网域名 (如自有服务器反代域名)"
                    >
                      <Settings size={12} />
                      {showDomainEditor ? "收起域名设置" : (gptmcpConfig?.publicBaseUrl ? "修改固定公网域名" : "配置固定公网域名")}
                    </button>
                  </div>
                  <div className="monitor-endpoint-input-wrap">
                    <input
                      readOnly
                      className="monitor-endpoint-input"
                      value={mcpEndpoint}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      title="点击全选 URL"
                    />
                    <button
                      className="monitor-endpoint-copy-btn"
                      onClick={() => void copyMcpEndpoint()}
                      title="复制完整 MCP 连接端点"
                    >
                      {mcpUrlCopied ? <Check size={14} color="var(--monitor-green)" /> : <Copy size={14} />}
                      {mcpUrlCopied ? "已复制" : "复制端点"}
                    </button>
                  </div>

                  {showDomainEditor && (
                    <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: "var(--monitor-panel)", border: "1px solid var(--monitor-line)" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "var(--monitor-text)" }}>
                        🌐 配置固定公网 Base URL（支持自有反代域名）
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="text"
                          className="monitor-endpoint-input"
                          style={{ flex: 1, padding: "6px 10px", fontSize: 13, background: "var(--monitor-bg)", border: "1px solid var(--monitor-line)" }}
                          placeholder="例如: https://devspace.do3bvk.cn"
                          value={customDomainInput}
                          onChange={(e) => setCustomDomainInput(e.target.value)}
                        />
                        <button
                          className="service-action-btn start"
                          disabled={domainSaving}
                          onClick={() => void handleSaveDomain()}
                        >
                          {domainSaving ? "保存中…" : "保存并生效"}
                        </button>
                        {gptmcpConfig?.publicBaseUrl && (
                          <button
                            className="service-action-btn stop"
                            disabled={domainSaving}
                            onClick={() => void handleSaveDomain(null)}
                            title="清除已配置的公网域名"
                          >
                            清除域名
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--monitor-text-soft)", marginTop: 6 }}>
                        保存后将自动更新 <code>config.json</code> 中的 <code>publicBaseUrl</code> 与 <code>allowedHosts</code> 白名单并重启服务，无需命令行操作。
                      </div>
                    </div>
                  )}

                  {domainFeedback && (
                    <div className="monitor-inline-error" style={{ background: "var(--monitor-panel-soft)", color: "var(--monitor-text)", border: "1px solid var(--monitor-line)", marginTop: 8 }}>
                      {domainFeedback}
                    </div>
                  )}

                  <div className="monitor-endpoint-hint">
                    💡 在 ChatGPT 网页/客户端创建 GPTs 或自定义 Actions 时，直接在 MCP Server URL 中填入上方完整端点。
                  </div>
                </div>

                {showTunnelLogs && (
                  <div className="monitor-info-panel" style={{ marginTop: 12, border: "1px solid var(--monitor-line)" }}>
                    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--monitor-panel-soft)", borderBottom: "1px solid var(--monitor-line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <TerminalSquare size={14} color="var(--monitor-blue)" />
                        <strong>cloudflared 实时日志</strong>
                        <span>PID: {tunnelInfo?.pid ?? "—"}</span>
                      </div>
                    </header>
                    <pre
                      style={{
                        maxHeight: 240,
                        overflowY: "auto",
                        background: "#090d16",
                        color: "#e2e8f0",
                        padding: "12px 14px",
                        fontSize: 12,
                        lineHeight: 1.6,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        boxShadow: "inset 0 2px 4px rgba(0,0,0,0.5)"
                      }}
                    >
                      {tunnelInfo?.logs?.length ? tunnelInfo.logs.join("\n") : "暂无隧道日志输出。"}
                    </pre>
                  </div>
                )}

                <div className="monitor-info-list">
                  <div>
                    <span>临时公网 Base URL</span>
                    <code className="mono">{publicTunnelUrl || "未启动 (默认本地: 127.0.0.1:7676)"}</code>
                  </div>
                  <div>
                    <span>本地反向代理目标</span>
                    <code className="mono">http://127.0.0.1:7676</code>
                  </div>
                  <div>
                    <span>cloudflared CLI 状态</span>
                    <span style={{ fontSize: 11, color: "var(--monitor-text-soft)" }}>
                      {tunnelInfo?.installed
                        ? "✅ 已安装 (支持一键初始化 TryCloudflare 免费临时隧道)"
                        : "❌ 未检测到 cloudflared。可运行 `winget install --id Cloudflare.cloudflared` 安装"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Project Root & Drive Selection Card */}
              <div className="monitor-service-manager-card">
                <div className="monitor-service-manager-header">
                  <div className="monitor-service-manager-info">
                    <span className={classNames("monitor-service-manager-icon", projectPathInfo?.cliExists ? "online" : "")}>
                      <HardDrive size={22} />
                    </span>
                    <div className="monitor-service-manager-title">
                      <strong>GPTMCP 主程序根路径与盘符选择</strong>
                      <span>
                        当前生效路径: <code className="mono" style={{ color: "var(--monitor-blue)", fontSize: 12 }}>{projectPathInfo?.currentRoot ?? "自动探测中…"}</code>
                      </span>
                    </div>
                  </div>

                  <span className={classNames("monitor-endpoint-tag", projectPathInfo?.cliExists ? "" : "warning")} style={projectPathInfo?.cliExists ? { color: "var(--monitor-green)", background: "var(--monitor-green-soft)", borderColor: "rgba(16,185,129,0.3)" } : {}}>
                    {projectPathInfo?.cliExists ? "✅ dist/cli.js 就绪" : "⚠️ 未找到 dist/cli.js"}
                  </span>
                </div>

                {pathFeedback && (
                  <div className="monitor-inline-error" style={{ background: "var(--monitor-panel-soft)", color: "var(--monitor-text)", border: "1px solid var(--monitor-line)" }}>
                    {pathFeedback}
                  </div>
                )}

                {/* Quick Drive Selector Buttons */}
                <div className="monitor-drive-selector-row">
                  <span className="monitor-drive-label">快速切换磁盘盘符:</span>
                  <div className="monitor-drive-pills">
                    {projectPathInfo?.availableDrives?.map((drive) => {
                      const isSelected = projectPathInfo?.currentRoot?.toLowerCase().startsWith(drive.drive.toLowerCase());
                      return (
                        <button
                          key={drive.drive}
                          className={classNames("monitor-drive-pill", isSelected && "selected", drive.hasProject && "has-project")}
                          onClick={() => void handleSelectDrive(drive)}
                          title={drive.hasProject ? `在 ${drive.drive} 已检测到 devspace-main 项目` : `选择 ${drive.drive} 盘`}
                        >
                          <HardDrive size={12} />
                          <strong>{drive.drive}</strong>
                          {drive.hasProject && <span className="drive-match-tag">已匹配</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Path Input Box */}
                <div className="monitor-custom-path-bar">
                  <input
                    className="monitor-custom-path-input"
                    value={customPathInput}
                    onChange={(e) => setCustomPathInput(e.target.value)}
                    placeholder="输入或粘贴项目绝对路径，例如: D:\devspace-main 或 E:\gptmcp"
                  />
                  <button
                    className="monitor-service-quick-btn primary"
                    disabled={pathSaving}
                    onClick={() => void handleSaveCustomPath()}
                    style={{ padding: "6px 14px" }}
                  >
                    {pathSaving ? "保存中…" : "应用路径"}
                  </button>
                  {projectPathInfo?.customRoot && (
                    <button
                      className="monitor-service-quick-btn"
                      disabled={pathSaving}
                      onClick={() => void handleSaveCustomPath(null)}
                      title="清除自定义指定路径，恢复为相对目录与全盘符自动探测模式"
                      style={{ padding: "6px 12px" }}
                    >
                      恢复自动探测
                    </button>
                  )}
                </div>
              </div>

              <div className="monitor-metric-grid">
                <Metric label="进程 PID" value={runtime?.pid ?? "—"} />
                <Metric label="运行时长" value={formatUptime(runtime?.uptimeSeconds)} />
                <Metric label="Node.js 版本" value={runtime?.nodeVersion ?? "—"} />
                <Metric label="GPTMCP 版本" value={runtime?.version ?? clientStatus?.version ?? "—"} />
              </div>

              <div className="monitor-info-list">
                <div>
                  <span>工作目录</span>
                  <code title={runtime?.cwd}>{runtime?.cwd ?? "—"}</code>
                </div>
                <div>
                  <span>主程序入口</span>
                  <code title={runtime?.entry}>{runtime?.entry ?? "—"}</code>
                </div>
                <div>
                  <span>配置目录</span>
                  <code title={runtime?.configDir}>{runtime?.configDir ?? "—"}</code>
                </div>
                <div>
                  <span>状态持久化目录</span>
                  <code title={runtime?.stateDir}>{runtime?.stateDir ?? "—"}</code>
                </div>
                <div>
                  <span>Git 工作树目录</span>
                  <code title={runtime?.worktreeRoot}>{runtime?.worktreeRoot ?? "—"}</code>
                </div>
                <div>
                  <span>Tool Mode</span>
                  <code>{runtime?.toolMode ?? "default"}</code>
                </div>
                <div>
                  <span>Skills 插件扩展</span>
                  <code>{runtime ? `${runtime.skillsEnabled ? "已启用" : "已停用"} (${runtime.skillPaths.length} 路径)` : "—"}</code>
                </div>
              </div>
            </section>
          )}

          {view === "processes" && !workspace && (
            <div className="monitor-empty-state" style={{ height: "100%" }}>
              <TerminalSquare size={36} />
              <strong>暂无选中的工作区</strong>
              <span>在左侧选择一个工作区以查看其托管的进程与终端。</span>
            </div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsDialog
          retentionDays={retentionDays}
          storedEvents={storedEvents}
          databasePath={databasePath}
          databaseBytes={databaseBytes}
          busy={settingsBusy}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onCleanup={cleanup}
          onClear={clear}
        />
      )}

      {addWorkspaceOpen && (
        <AddWorkspaceDialog
          busy={addWorkspaceBusy}
          error={addWorkspaceError}
          onClose={() => { setAddWorkspaceOpen(false); setAddWorkspaceError(null); }}
          onAdd={addWorkspace}
        />
      )}
    </div>
  );
}

export default App;

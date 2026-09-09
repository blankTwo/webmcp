import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  BarChart2,
  BookmarkCheck,
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
  Download,
  ExternalLink,
  FileCode2,
  FileSearch,
  FileText,
  Folder,
  Gauge,
  Globe,
  HardDrive,
  Info,
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
  Sparkles,
  Square,
  Star,
  Sun,
  TerminalSquare,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCodingConsoleData } from "./coding-console-data";
import { consoleApi, withQuery } from "./console-api";
import { ProcessManager } from "./ProcessManager";
import type { AllowedRootInfo, LogEvent, LogKind, LogStatus, SkillItemInfo, WorkspaceCheckpointRecord, WorkspaceItem, WorkspaceSessionInfo } from "./types";

type MainView = "logs" | "processes" | "optimizer" | "environment" | "skills" | "roots" | "settings";
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
}: {
  event: LogEvent;
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
      </header>

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
    </div>
  );
}

function getCheckpointMarkdown(cp: WorkspaceCheckpointRecord): string {
  const lines: string[] = [
    `# WebMCP Checkpoint - ${cp.id}`,
    "",
    `- **保存时间**: ${new Date(cp.createdAt).toLocaleString("zh-CN")}`,
    `- **项目工作区**: \`${cp.root}\``,
    ...(cp.facts?.gitBranch ? [`- **Git 分支**: \`${cp.facts.gitBranch}\``] : []),
    ...(cp.facts?.gitHead ? [`- **Git 提交**: \`${cp.facts.gitHead}\``] : []),
    "",
    `## 🎯 目标 (Goal)`,
    cp.state.goal,
    "",
    `## ⚡ 当前任务 (Current Task)`,
    cp.state.currentTask,
    "",
  ];
  if (cp.state.completed && cp.state.completed.length > 0) {
    lines.push("## ✅ 已完成清单 (Completed)");
    cp.state.completed.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  if (cp.state.decisions && cp.state.decisions.length > 0) {
    lines.push("## 💡 决策与依据 (Decisions)");
    cp.state.decisions.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  if (cp.state.files && cp.state.files.length > 0) {
    lines.push("## 📁 关键文件 (Files)");
    cp.state.files.forEach((item) => lines.push(`- \`${item}\``));
    lines.push("");
  }
  if (cp.state.verification && cp.state.verification.length > 0) {
    lines.push("## 🧪 验证与测试 (Verification)");
    cp.state.verification.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  if (cp.state.blockers && cp.state.blockers.length > 0) {
    lines.push("## ⚠️ 阻塞项与风险 (Blockers)");
    cp.state.blockers.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  if (cp.state.next && cp.state.next.length > 0) {
    lines.push("## 🚀 下一步计划 (Next Steps)");
    cp.state.next.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  return lines.join("\n");
}

function SettingsAndCheckpointsView({
  workspace,
  retentionDays,
  storedEvents,
  databasePath,
  databaseBytes,
  busy,
  onSave,
  onCleanup,
  onClear,
}: {
  workspace: WorkspaceItem | null;
  retentionDays: number;
  storedEvents: number;
  databasePath: string;
  databaseBytes: number;
  busy: boolean;
  onSave: (days: number) => Promise<void>;
  onCleanup: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [days, setDays] = useState(retentionDays);
  const [savedNotice, setSavedNotice] = useState(false);
  const [checkpoints, setCheckpoints] = useState<WorkspaceCheckpointRecord[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [expandedCpId, setExpandedCpId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async () => {
    if (!workspace?.path) {
      setCheckpoints([]);
      return;
    }
    setLoadingCheckpoints(true);
    setCheckpointError(null);
    try {
      const res = await consoleApi<{ ok: boolean; checkpoints?: WorkspaceCheckpointRecord[]; error?: string }>(
        "GET",
        withQuery("/console/memory", { workspaceRoot: workspace.path, mode: "checkout" }),
      );
      if (res.ok && Array.isArray(res.checkpoints)) {
        setCheckpoints(res.checkpoints);
        if (res.checkpoints.length > 0 && !expandedCpId) {
          setExpandedCpId(res.checkpoints[0].id);
        }
      } else {
        setCheckpoints([]);
        if (res.error) setCheckpointError(res.error);
      }
    } catch (err) {
      setCheckpointError(err instanceof Error ? err.message : String(err));
      setCheckpoints([]);
    } finally {
      setLoadingCheckpoints(false);
    }
  }, [workspace?.path]);

  useEffect(() => {
    void loadCheckpoints();
  }, [loadCheckpoints]);

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleDownload = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveSettings = async () => {
    await onSave(days);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <section className="monitor-overview-view monitor-settings-view">
      <div className="monitor-page-heading">
        <span className="monitor-page-icon"><BookmarkCheck size={20} /></span>
        <div>
          <strong>快照管理与 Console 设置</strong>
          <small>查看工作区 Checkpoint 历史快照、导出 Markdown/JSON 及维护本地遥测存储</small>
        </div>
      </div>

      {/* Checkpoints Section */}
      <div className="monitor-info-panel monitor-checkpoints-panel">
        <header>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <BookmarkCheck size={17} color="var(--monitor-blue)" />
            <strong>工作区 Checkpoint 历史快照 ({checkpoints.length})</strong>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--monitor-muted)" }}>
              {workspace ? workspace.path : "未选择工作区"}
            </span>
            <button
              className="monitor-service-quick-btn"
              disabled={loadingCheckpoints}
              onClick={() => void loadCheckpoints()}
              style={{ padding: "4px 10px" }}
            >
              <RefreshCw size={12} className={loadingCheckpoints ? "spinning" : ""} />
              <span>刷新快照</span>
            </button>
          </div>
        </header>

        <div className="monitor-checkpoints-list">
          {checkpointError && (
            <div className="monitor-connection-warning" style={{ margin: "12px 16px" }}>
              <AlertTriangle size={15} />
              <div><strong>快照读取失败</strong><span>{checkpointError}</span></div>
            </div>
          )}

          {!checkpoints.length && !loadingCheckpoints && (
            <div className="monitor-sidebar-empty" style={{ minHeight: 140 }}>
              <BookmarkCheck size={26} color="var(--monitor-muted)" />
              <span>当前工作区暂无 Checkpoint 检查点</span>
              <small>在 AI 对话中达成阶段性目标或暂停工作时，AI 会自动调用 checkpoint 保存快照并同步导出 MD/JSON 文件。</small>
            </div>
          )}

          {loadingCheckpoints && !checkpoints.length && (
            <div className="monitor-sidebar-empty" style={{ minHeight: 120 }}>
              <Loader2 className="spinning" size={22} color="var(--monitor-blue)" />
              <span>正在读取 Checkpoint 历史记录…</span>
            </div>
          )}

          {checkpoints.map((cp) => {
            const isExpanded = expandedCpId === cp.id;
            const md = getCheckpointMarkdown(cp);
            const json = JSON.stringify(cp, null, 2);
            const dateStr = new Date(cp.createdAt).toLocaleString("zh-CN");

            return (
              <div key={cp.id} className={classNames("monitor-checkpoint-card", isExpanded && "expanded")}>
                <div className="monitor-checkpoint-header" onClick={() => setExpandedCpId(isExpanded ? null : cp.id)}>
                  <span className="monitor-expand">
                    {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                  <div className="monitor-checkpoint-meta">
                    <span className="monitor-cp-time">{dateStr}</span>
                    <code className="monitor-cp-id">{cp.id.slice(0, 8)}</code>
                    {cp.facts?.gitBranch && (
                      <span className="monitor-cp-tag">{cp.facts.gitBranch}</span>
                    )}
                  </div>
                  <div className="monitor-cp-goal-snippet" title={cp.state.goal}>
                    <strong>{cp.state.goal}</strong>
                    <span>{cp.state.currentTask}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="monitor-checkpoint-body">
                    <div className="monitor-checkpoint-grid">
                      <div className="monitor-cp-block">
                        <label>🎯 核心目标 (Goal)</label>
                        <p>{cp.state.goal}</p>
                      </div>
                      <div className="monitor-cp-block">
                        <label>⚡ 当前任务 (Current Task)</label>
                        <p>{cp.state.currentTask}</p>
                      </div>
                    </div>

                    {cp.state.completed && cp.state.completed.length > 0 && (
                      <div className="monitor-cp-section">
                        <label>✅ 已完成清单 (Completed)</label>
                        <ul>{cp.state.completed.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                      </div>
                    )}

                    {cp.state.decisions && cp.state.decisions.length > 0 && (
                      <div className="monitor-cp-section">
                        <label>💡 架构决策与依据 (Decisions)</label>
                        <ul>{cp.state.decisions.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                      </div>
                    )}

                    {cp.state.files && cp.state.files.length > 0 && (
                      <div className="monitor-cp-section">
                        <label>📁 关键文件 (Files)</label>
                        <div className="monitor-cp-file-list">
                          {cp.state.files.map((file, idx) => <code key={idx}>{file}</code>)}
                        </div>
                      </div>
                    )}

                    {cp.state.verification && cp.state.verification.length > 0 && (
                      <div className="monitor-cp-section">
                        <label>🧪 验证与测试 (Verification)</label>
                        <ul>{cp.state.verification.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                      </div>
                    )}

                    {cp.state.blockers && cp.state.blockers.length > 0 && (
                      <div className="monitor-cp-section danger">
                        <label>⚠️ 阻塞项与风险 (Blockers)</label>
                        <ul>{cp.state.blockers.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                      </div>
                    )}

                    {cp.state.next && cp.state.next.length > 0 && (
                      <div className="monitor-cp-section next">
                        <label>🚀 下一步计划 (Next Steps)</label>
                        <ul>{cp.state.next.map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                      </div>
                    )}

                    <div className="monitor-checkpoint-actions-bar">
                      <button
                        className="monitor-service-quick-btn"
                        onClick={() => handleCopy(`md-${cp.id}`, md)}
                      >
                        {copiedId === `md-${cp.id}` ? <Check size={13} color="var(--monitor-green)" /> : <FileText size={13} />}
                        <span>{copiedId === `md-${cp.id}` ? "已复制 Markdown" : "复制 Markdown"}</span>
                      </button>
                      <button
                        className="monitor-service-quick-btn"
                        onClick={() => handleCopy(`json-${cp.id}`, json)}
                      >
                        {copiedId === `json-${cp.id}` ? <Check size={13} color="var(--monitor-green)" /> : <Code2 size={13} />}
                        <span>{copiedId === `json-${cp.id}` ? "已复制 JSON" : "复制 JSON"}</span>
                      </button>
                      <button
                        className="monitor-service-quick-btn primary"
                        onClick={() => handleDownload(`CHECKPOINT_${cp.id.slice(0, 8)}.md`, md, "text/markdown")}
                      >
                        <Download size={13} />
                        <span>导出 .md 文件</span>
                      </button>
                      <button
                        className="monitor-service-quick-btn"
                        onClick={() => handleDownload(`CHECKPOINT_${cp.id.slice(0, 8)}.json`, json, "application/json")}
                      >
                        <Download size={13} />
                        <span>导出 .json 文件</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Storage & Telemetry Settings Section */}
      <div className="monitor-info-panel">
        <header>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Database size={17} color="var(--monitor-blue)" />
            <strong>Console 本地遥测与日志存储设置</strong>
          </div>
        </header>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <label className="monitor-setting-row" style={{ margin: 0 }}>
            <div>
              <strong>日志自动保留周期</strong>
              <span>控制 Console 本地 SQLite 遥测数据的自动过期清理时间。</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {[1, 3, 7, 14, 30, 90].map((value) => <option key={value} value={value}>{value} 天</option>)}
              </select>
              <button className="monitor-service-quick-btn primary" disabled={busy} onClick={() => void handleSaveSettings()}>
                {busy ? "保存中…" : savedNotice ? "已保存 ✓" : "保存设置"}
              </button>
            </div>
          </label>

          <div className="monitor-storage-card">
            <Database size={20} color="var(--monitor-blue)" />
            <div>
              <strong>{storedEvents.toLocaleString("zh-CN")} 条遥测日志记录</strong>
              <span title={databasePath}>{databasePath || "SQLite 数据库就绪"}</span>
            </div>
            <small>{databaseBytes ? `${(databaseBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</small>
          </div>

          <div className="monitor-maintenance-actions">
            <button className="monitor-service-quick-btn" disabled={busy} onClick={() => void onCleanup()}>
              清理过期日志
            </button>
            <button className="monitor-service-quick-btn danger" disabled={busy || storedEvents === 0} onClick={() => void onClear()}>
              清空全部历史日志
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SkillsManagerView({
  workspace,
}: {
  workspace: WorkspaceItem | null;
}) {
  const [skills, setSkills] = useState<SkillItemInfo[]>([]);
  const [bundledDir, setBundledDir] = useState<string>("");
  const [globalDir, setGlobalDir] = useState<string>("");
  const [workspaceDir, setWorkspaceDir] = useState<string | undefined>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSkillName, setExpandedSkillName] = useState<string | null>(null);
  const [copiedSkillName, setCopiedSkillName] = useState<string | null>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await consoleApi<{
        ok: boolean;
        skills: SkillItemInfo[];
        bundledDir: string;
        workspaceDir?: string;
        globalDir: string;
        error?: string;
      }>("GET", withQuery("/console/skills", { workspaceRoot: workspace?.path }));
      if (res.ok) {
        setSkills(res.skills || []);
        setBundledDir(res.bundledDir || "");
        setGlobalDir(res.globalDir || "");
        setWorkspaceDir(res.workspaceDir);
      } else {
        setError(res.error || "获取技能列表失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspace?.path]);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  const handleApply = async (skillName: string, target: "workspace" | "global") => {
    setActionBusy(`${skillName}-${target}`);
    setActionFeedback(null);
    try {
      const res = await consoleApi<{ ok: boolean; message?: string; error?: string }>(
        "POST",
        "/console/skills/apply",
        { skillName, target, workspaceRoot: workspace?.path },
      );
      if (res.ok) {
        setActionFeedback(res.message || "应用成功！");
        await fetchSkills();
      } else {
        setError(res.error || "应用失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
      setTimeout(() => setActionFeedback(null), 3000);
    }
  };

  const handleRemove = async (skillName: string, target: "workspace" | "global") => {
    setActionBusy(`${skillName}-${target}`);
    setActionFeedback(null);
    try {
      const res = await consoleApi<{ ok: boolean; message?: string; error?: string }>(
        "POST",
        "/console/skills/remove",
        { skillName, target, workspaceRoot: workspace?.path },
      );
      if (res.ok) {
        setActionFeedback(res.message || "移除成功！");
        await fetchSkills();
      } else {
        setError(res.error || "移除失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
      setTimeout(() => setActionFeedback(null), 3000);
    }
  };

  const handleCopySkill = (name: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedSkillName(name);
    setTimeout(() => setCopiedSkillName(null), 1800);
  };

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.content.toLowerCase().includes(q),
    );
  }, [skills, searchQuery]);

  return (
    <section className="monitor-overview-view monitor-skills-view">
      <div className="monitor-page-heading">
        <span className="monitor-page-icon"><Sparkles size={20} /></span>
        <div>
          <strong>Skills 技能中心 (Codex & WebMCP 扩展)</strong>
          <small>内置标准化开发规范技能库，随时一键应用到当前工作区或全局环境</small>
        </div>
      </div>

      {actionFeedback && (
        <div className="monitor-feedback-banner success" style={{ margin: "0 0 16px" }}>
          <Check size={16} />
          <span>{actionFeedback}</span>
        </div>
      )}

      {error && (
        <div className="monitor-connection-warning" style={{ margin: "0 0 16px" }}>
          <AlertTriangle size={16} />
          <div><strong>操作失败</strong><span>{error}</span></div>
          <button onClick={() => void fetchSkills()}>重试</button>
        </div>
      )}

      {/* Directory Status Row */}
      <div className="monitor-metric-grid" style={{ marginBottom: 16 }}>
        <Metric label="内置技能库目录" value={bundledDir ? bundledDir.split(/[\\/]/).pop() || "skills" : "skills"} note={bundledDir || "dist/skills"} />
        <Metric
          label="当前工作区技能"
          value={workspace ? `${skills.filter((s) => s.appliedToWorkspace).length} 已应用` : "未选择工作区"}
          note={workspaceDir || "—"}
        />
        <Metric
          label="全局技能目录"
          value={`${skills.filter((s) => s.installedGlobally).length} 已安装`}
          note={globalDir || "~/.webmcp/skills"}
        />
      </div>

      {/* Toolbar & Search */}
      <div className="monitor-skills-toolbar">
        <div className="monitor-search" style={{ maxWidth: 360 }}>
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索技能名称、描述或规范内容..."
          />
          {searchQuery && <button onClick={() => setSearchQuery("")}><X size={12} /></button>}
        </div>

        <button
          className="monitor-service-quick-btn"
          disabled={loading}
          onClick={() => void fetchSkills()}
          style={{ padding: "6px 12px" }}
        >
          <RefreshCw size={13} className={loading ? "spinning" : ""} />
          <span>刷新技能库</span>
        </button>
      </div>

      {/* Skills Grid */}
      <div className="monitor-skills-grid">
        {!filteredSkills.length && !loading && (
          <div className="monitor-sidebar-empty" style={{ gridColumn: "1 / -1", minHeight: 180 }}>
            <Sparkles size={32} color="var(--monitor-muted)" />
            <span>未找到匹配的技能</span>
            <small>尝试清空搜索框或检查内置技能库目录。</small>
          </div>
        )}

        {filteredSkills.map((skill) => {
          const isExpanded = expandedSkillName === skill.name;
          const isWorkspaceBusy = actionBusy === `${skill.name}-workspace`;
          const isGlobalBusy = actionBusy === `${skill.name}-global`;

          return (
            <article key={skill.name} className={classNames("monitor-skill-card", isExpanded && "expanded")}>
              <div className="monitor-skill-card-top">
                <div className="monitor-skill-header-row">
                  <div className="monitor-skill-title-group">
                    <span className="monitor-skill-icon"><Sparkles size={16} /></span>
                    <strong>{skill.name}</strong>
                    {skill.version && <span className="monitor-skill-ver">v{skill.version}</span>}
                  </div>
                  <div className="monitor-skill-status-tags">
                    {skill.appliedToWorkspace && (
                      <span className="monitor-tag-badge workspace" title="已在当前工作区激活">
                        <Check size={11} /> 工作区已应用
                      </span>
                    )}
                    {skill.installedGlobally && (
                      <span className="monitor-tag-badge global" title="已在全局环境激活">
                        <Globe size={11} /> 全局已安装
                      </span>
                    )}
                  </div>
                </div>

                <p className="monitor-skill-desc">{skill.description}</p>
              </div>

              <div className="monitor-skill-card-actions">
                <button
                  className="monitor-skill-expand-btn"
                  onClick={() => setExpandedSkillName(isExpanded ? null : skill.name)}
                >
                  <FileText size={12} />
                  <span>{isExpanded ? "收起说明" : "查看 SKILL.md"}</span>
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>

                <div className="monitor-skill-btn-group">
                  {workspace && (
                    skill.appliedToWorkspace ? (
                      <button
                        className="monitor-service-quick-btn danger"
                        disabled={!!actionBusy}
                        onClick={() => void handleRemove(skill.name, "workspace")}
                        title="从当前工作区移除此技能"
                      >
                        <Trash2 size={12} />
                        <span>{isWorkspaceBusy ? "移除中…" : "从工作区移除"}</span>
                      </button>
                    ) : (
                      <button
                        className="monitor-service-quick-btn primary"
                        disabled={!!actionBusy}
                        onClick={() => void handleApply(skill.name, "workspace")}
                        title="将此技能复制并应用到当前工作区"
                      >
                        <Plus size={12} />
                        <span>{isWorkspaceBusy ? "应用中…" : "应用到工作区"}</span>
                      </button>
                    )
                  )}

                  {skill.installedGlobally ? (
                    <button
                      className="monitor-service-quick-btn"
                      disabled={!!actionBusy}
                      onClick={() => void handleRemove(skill.name, "global")}
                      title="从全局 ~/.webmcp/skills 移除"
                    >
                      <Trash2 size={12} />
                      <span>{isGlobalBusy ? "移除中…" : "全局卸载"}</span>
                    </button>
                  ) : (
                    <button
                      className="monitor-service-quick-btn"
                      disabled={!!actionBusy}
                      onClick={() => void handleApply(skill.name, "global")}
                      title="安装到全局 ~/.webmcp/skills"
                    >
                      <Globe size={12} />
                      <span>{isGlobalBusy ? "安装中…" : "安装到全局"}</span>
                    </button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="monitor-skill-expanded-content">
                  <div className="monitor-skill-content-header">
                    <span><code>{skill.filePath}</code></span>
                    <button
                      className="monitor-service-quick-btn"
                      onClick={() => handleCopySkill(skill.name, skill.content)}
                      style={{ padding: "3px 8px" }}
                    >
                      {copiedSkillName === skill.name ? <Check size={11} color="var(--monitor-green)" /> : <Copy size={11} />}
                      <span>{copiedSkillName === skill.name ? "已复制" : "复制规范"}</span>
                    </button>
                  </div>
                  <pre className="monitor-skill-markdown-view">{skill.content}</pre>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}


interface TelemetryHistoryPoint {
  time: string;
  active: number;
  limit: number;
  hitRate: number;
  hits: number;
  misses: number;
  size: number;
}

function OptimizerTelemetryGraphic({
  optimizer,
  floatBallActive,
  onToggleFloatBall,
}: {
  optimizer: OptimizerStatus | null;
  floatBallActive?: boolean;
  onToggleFloatBall?: () => void;
}) {
  const [history, setHistory] = useState<TelemetryHistoryPoint[]>([]);
  const [showRawJson, setShowRawJson] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!optimizer) return;
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    const hits = optimizer.cache.hits ?? 0;
    const misses = optimizer.cache.misses ?? 0;
    const total = hits + misses;
    const hitRate = total > 0 ? Math.round((hits / total) * 100) : 0;
    const active = optimizer.concurrent.active ?? 0;
    const limit = optimizer.concurrent.limit ?? 6;
    const size = optimizer.cache.size ?? 0;

    setHistory((prev) => {
      const next = [...prev, { time: timeStr, active, limit, hitRate, hits, misses, size }];
      return next.length > 20 ? next.slice(next.length - 20) : next;
    });
  }, [optimizer]);

  const hits = optimizer?.cache.hits ?? 0;
  const misses = optimizer?.cache.misses ?? 0;
  const cacheHitTotal = hits + misses;
  const cacheHitRate = cacheHitTotal > 0 ? Math.round((hits / cacheHitTotal) * 100) : 0;
  const activeConcurrent = optimizer?.concurrent.active ?? 0;
  const limitConcurrent = optimizer?.concurrent.limit ?? 6;
  const concurrentUsage = limitConcurrent > 0 ? Math.round((activeConcurrent / limitConcurrent) * 100) : 0;
  const cacheSize = optimizer?.cache.size ?? 0;
  const cacheWrites = optimizer?.cache.writes ?? 0;

  // Circular gauge calculations (R=36, circumference ~ 226.19)
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const gaugeOffset = circumference - (Math.min(100, Math.max(0, concurrentUsage)) / 100) * circumference;

  const handleCopyJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(optimizer ?? {}, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // SVG Trend Chart Data Calculation
  const maxLimit = Math.max(limitConcurrent, ...history.map((h) => h.active), 1);
  const chartW = 700;
  const chartH = 110;
  const padLeft = 36;
  const padRight = 36;
  const padTop = 15;
  const padBottom = 25;
  const innerW = chartW - padLeft - padRight;
  const innerH = chartH - padTop - padBottom;

  const pointsCount = Math.max(history.length, 2);
  const getX = (idx: number) => padLeft + (idx / (pointsCount - 1)) * innerW;
  const getYActive = (val: number) => padTop + innerH - (Math.min(val, maxLimit) / maxLimit) * innerH;
  const getYHitRate = (rate: number) => padTop + innerH - (Math.min(rate, 100) / 100) * innerH;

  const activePointsStr = history.map((pt, i) => `${getX(i)},${getYActive(pt.active)}`).join(" ");
  const activeAreaPath = history.length > 0
    ? `M ${getX(0)},${padTop + innerH} L ${history.map((pt, i) => `${getX(i)},${getYActive(pt.active)}`).join(" L ")} L ${getX(history.length - 1)},${padTop + innerH} Z`
    : "";

  const hitRatePointsStr = history.map((pt, i) => `${getX(i)},${getYHitRate(pt.hitRate)}`).join(" ");

  return (
    <div className="monitor-info-panel" style={{ overflow: "hidden" }}>
      <header className="monitor-card-header-clean">
        <div className="monitor-card-header-title">
          <Gauge size={17} color="var(--monitor-blue)" />
          <strong>实时遥测状态看板 (Real-time Telemetry)</strong>
          <span className="monitor-pulse-badge">
            <span className="pulse-dot"></span>
            实时监控中 (4s)
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onToggleFloatBall && (
            <button
              className={classNames("monitor-service-quick-btn monitor-btn-compact", floatBallActive && "primary")}
              onClick={onToggleFloatBall}
              title={floatBallActive ? "隐藏桌面悬浮球" : "在桌面打开置顶透明悬浮球"}
            >
              <CircleDot size={13} color={floatBallActive ? "var(--monitor-green)" : "currentColor"} />
              <span>{floatBallActive ? "桌面悬浮球 (开启)" : "开启桌面悬浮球"}</span>
            </button>
          )}
          <button
            className={classNames("monitor-service-quick-btn monitor-btn-compact", !showRawJson && "primary")}
            onClick={() => setShowRawJson(false)}
            title="图形化视图"
          >
            <BarChart2 size={13} />
            <span>图形视图</span>
          </button>
          <button
            className={classNames("monitor-service-quick-btn monitor-btn-compact", showRawJson && "primary")}
            onClick={() => setShowRawJson(true)}
            title="原始 JSON 报文"
          >
            <Code2 size={13} />
            <span>原始 JSON</span>
          </button>
        </div>
      </header>

      {showRawJson ? (
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <button
              className="monitor-service-quick-btn monitor-btn-compact"
              onClick={handleCopyJson}
            >
              <Copy size={13} />
              <span>{copied ? "已复制 JSON" : "复制 JSON"}</span>
            </button>
          </div>
          <pre className="monitor-raw-json-view">{JSON.stringify(optimizer ?? { status: "waiting_for_response" }, null, 2)}</pre>
        </div>
      ) : (
        <div className="monitor-telemetry-container">
          {/* Row 1: Dual Cards */}
          <div className="monitor-telemetry-grid">
            {/* Card 1: Concurrency Gauge & Slot Matrix */}
            <div className="monitor-telemetry-card">
              <div className="monitor-telemetry-card-title">
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Zap size={15} color="var(--monitor-blue)" />
                  并发调度负载与 Worker 槽位
                </span>
                {activeConcurrent === 0 ? (
                  <span className="monitor-tag-badge workspace"><Check size={11} /> 空闲就绪</span>
                ) : activeConcurrent < limitConcurrent ? (
                  <span className="monitor-tag-badge" style={{ background: "var(--monitor-blue-soft)", color: "var(--monitor-blue)" }}>
                    <Activity size={11} /> 调度正常
                  </span>
                ) : (
                  <span className="monitor-tag-badge" style={{ background: "rgba(245, 158, 11, 0.15)", color: "#d97706" }}>
                    <AlertTriangle size={11} /> 槽位饱和
                  </span>
                )}
              </div>

              <div className="monitor-gauge-row">
                <div className="monitor-gauge-svg-box">
                  <svg width="90" height="90" viewBox="0 0 90 90">
                    <circle
                      cx="45"
                      cy="45"
                      r={radius}
                      fill="transparent"
                      stroke="var(--monitor-panel-hover)"
                      strokeWidth="7"
                    />
                    <circle
                      cx="45"
                      cy="45"
                      r={radius}
                      fill="transparent"
                      stroke="url(#concurrency-grad)"
                      strokeWidth="7"
                      strokeDasharray={circumference}
                      strokeDashoffset={gaugeOffset}
                      strokeLinecap="round"
                      transform="rotate(-90 45 45)"
                      style={{ transition: "stroke-dashoffset 0.4s ease" }}
                    />
                    <defs>
                      <linearGradient id="concurrency-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#3b82f6" />
                        <stop offset="100%" stopColor="#8b5cf6" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div className="monitor-gauge-center-text">
                    <strong>{activeConcurrent}/{limitConcurrent}</strong>
                    <small>{concurrentUsage}%</small>
                  </div>
                </div>

                <div className="monitor-slots-col">
                  <span style={{ fontSize: 11, color: "var(--monitor-muted)", fontWeight: 500 }}>
                    处理线程 Worker 槽位分配:
                  </span>
                  <div className="monitor-slots-grid">
                    {Array.from({ length: Math.max(limitConcurrent, 1) }).map((_, i) => {
                      const isActive = i < activeConcurrent;
                      return (
                        <div key={i} className={classNames("monitor-slot-box", isActive && "active")}>
                          {isActive ? <Zap size={12} /> : <CircleDot size={12} />}
                          <span>槽位 #{i + 1} {isActive ? "处理中" : "待命中"}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: Cache Efficiency & Breakdown */}
            <div className="monitor-telemetry-card">
              <div className="monitor-telemetry-card-title">
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Database size={15} color="#10b981" />
                  MCP 请求缓存效率与分流
                </span>
                <span className="monitor-tag-badge" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
                  命中率 {cacheHitRate}%
                </span>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--monitor-text-soft)", marginBottom: 6 }}>
                  <span>命中: {hits} 次 ({cacheHitRate}%)</span>
                  <span>穿透: {misses} 次 ({cacheHitTotal > 0 ? 100 - cacheHitRate : 0}%)</span>
                </div>
                <div className="monitor-cache-split-bar">
                  <div className="monitor-cache-split-fill hits" style={{ width: `${cacheHitRate}%` }} />
                  <div className="monitor-cache-split-fill misses" style={{ width: `${cacheHitTotal > 0 ? 100 - cacheHitRate : 0}%` }} />
                </div>
              </div>

              <div className="monitor-stat-mini-grid">
                <div className="monitor-stat-mini-item">
                  <span>缓存命中</span>
                  <strong style={{ color: "#10b981" }}>{hits}</strong>
                </div>
                <div className="monitor-stat-mini-item">
                  <span>穿透回源</span>
                  <strong style={{ color: "#f59e0b" }}>{misses}</strong>
                </div>
                <div className="monitor-stat-mini-item">
                  <span>内存活跃条目</span>
                  <strong>{cacheSize}</strong>
                </div>
                <div className="monitor-stat-mini-item">
                  <span>累积写入</span>
                  <strong>{cacheWrites}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Row 2: Real-time Trend SVG Graph */}
          <div className="monitor-telemetry-chart-card">
            <div className="monitor-chart-header-row">
              <div>
                <strong style={{ fontSize: 13, color: "var(--monitor-text)" }}>📈 实时吞吐与命中时序趋势</strong>
                <span style={{ fontSize: 11.5, color: "var(--monitor-muted)", marginLeft: 8 }}>
                  最近 {history.length} 个采样周期 (更新中)
                </span>
              </div>
              <div className="monitor-chart-legend">
                <div className="monitor-legend-item">
                  <span className="monitor-legend-dot concurrency" />
                  <span>并发请求 (0 ~ {maxLimit})</span>
                </div>
                <div className="monitor-legend-item">
                  <span className="monitor-legend-dot cache" />
                  <span>缓存命中率 (0 ~ 100%)</span>
                </div>
              </div>
            </div>

            <div className="monitor-svg-chart-wrapper">
              <svg width="100%" height="100%" viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="none">
                <defs>
                  <linearGradient id="area-blue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Grid Lines */}
                <line x1={padLeft} y1={padTop} x2={chartW - padRight} y2={padTop} stroke="var(--monitor-line)" strokeDasharray="3 3" />
                <line x1={padLeft} y1={padTop + innerH / 2} x2={chartW - padRight} y2={padTop + innerH / 2} stroke="var(--monitor-line)" strokeDasharray="3 3" />
                <line x1={padLeft} y1={padTop + innerH} x2={chartW - padRight} y2={padTop + innerH} stroke="var(--monitor-line)" />

                {/* Y-Axis labels */}
                <text x={padLeft - 6} y={padTop + 4} textAnchor="end" fontSize="9" fill="var(--monitor-muted)">{maxLimit}</text>
                <text x={padLeft - 6} y={padTop + innerH / 2 + 3} textAnchor="end" fontSize="9" fill="var(--monitor-muted)">{Math.round(maxLimit / 2)}</text>
                <text x={padLeft - 6} y={padTop + innerH} textAnchor="end" fontSize="9" fill="var(--monitor-muted)">0</text>

                {/* Right Y-Axis (100% Hit Rate) */}
                <text x={chartW - padRight + 4} y={padTop + 4} textAnchor="start" fontSize="9" fill="#10b981">100%</text>
                <text x={chartW - padRight + 4} y={padTop + innerH} textAnchor="start" fontSize="9" fill="#10b981">0%</text>

                {history.length > 1 && (
                  <>
                    {/* Active Concurrency Area & Line */}
                    <path d={activeAreaPath} fill="url(#area-blue)" />
                    <polyline
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={activePointsStr}
                    />

                    {/* Cache Hit Rate Line */}
                    <polyline
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="2"
                      strokeDasharray="4 3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={hitRatePointsStr}
                    />

                    {/* Dots for Concurrency */}
                    {history.map((pt, i) => (
                      <circle
                        key={`c-${i}`}
                        cx={getX(i)}
                        cy={getYActive(pt.active)}
                        r="3.5"
                        fill="#3b82f6"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                      />
                    ))}
                  </>
                )}

                {/* X-Axis time labels */}
                {history.length > 0 && (
                  <>
                    <text x={padLeft} y={chartH - 4} textAnchor="start" fontSize="9" fill="var(--monitor-muted)">
                      {history[0].time}
                    </text>
                    {history.length > 1 && (
                      <text x={chartW - padRight} y={chartH - 4} textAnchor="end" fontSize="9" fill="var(--monitor-muted)">
                        {history[history.length - 1].time} (最新)
                      </text>
                    )}
                  </>
                )}
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeDisplayPath(p: string): string {
  if (!p) return "";
  return p.replace(/[\\/]+/g, "\\");
}

function RootsManagerView({
  onSelectWorkspace,
  onRefreshWorkspaces,
}: {
  onSelectWorkspace: (id: string) => void;
  onRefreshWorkspaces: () => Promise<void>;
}) {
  const [roots, setRoots] = useState<AllowedRootInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSessionInfo[]>([]);
  const [configPath, setConfigPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [newRootInput, setNewRootInput] = useState("");
  const [isServiceOfflineNotice, setIsServiceOfflineNotice] = useState(false);

  const fetchRootsData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsServiceOfflineNotice(false);

    try {
      // 1. Try to fetch from online WebMCP backend
      const res = await consoleApi<{
        ok: boolean;
        allowedRoots: AllowedRootInfo[];
        workspaces: WorkspaceSessionInfo[];
        configPath: string;
        error?: string;
      }>("GET", "/console/roots");
      if (res.ok) {
        setRoots(res.allowedRoots || []);
        setWorkspaces(res.workspaces || []);
        setConfigPath(res.configPath || "");
        return;
      }
    } catch {
      // Fallback to local config file if service is offline
    }

    try {
      const cfg = await invoke<{
        publicBaseUrl?: string | null;
        ownerToken?: string | null;
        allowedRoots?: string[];
        configDir?: string | null;
      }>("get_webmcp_config");

      const rootsList = cfg.allowedRoots || [];
      const localRoots: AllowedRootInfo[] = rootsList.map((r) => ({
        path: r,
        exists: true,
        isDrive: /^[a-zA-Z]:[\\/]?$/.test(r),
        workspacesCount: 0,
      }));

      setRoots(localRoots);
      setConfigPath(cfg.configDir ? `${cfg.configDir}\\config.json` : "~/.webmcp/config.json");
      setIsServiceOfflineNotice(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRootsData();
  }, [fetchRootsData]);

  const handleBrowseFolder = async () => {
    try {
      const selected = await invoke<string | null>("select_folder_dialog");
      if (selected) {
        setNewRootInput(normalizeDisplayPath(selected));
      }
    } catch (err) {
      setError(`选择文件夹失败: ${String(err)}`);
    }
  };

  const handleAddRoot = async (targetPath?: string) => {
    const raw = (targetPath || newRootInput).trim();
    if (!raw) return;
    const p = normalizeDisplayPath(raw);
    setActionBusy("add-root");
    setActionFeedback(null);
    try {
      const res = await consoleApi<{ ok: boolean; message?: string; error?: string }>(
        "POST",
        "/console/roots",
        { path: p },
      );
      if (res.ok) {
        setActionFeedback(res.message || "添加成功！");
        setNewRootInput("");
        await fetchRootsData();
        return;
      }
    } catch {
      // Backend service might be offline, fallback to direct Tauri IPC
    }

    try {
      const current = roots.map((r) => normalizeDisplayPath(r.path));
      if (!current.some((r) => r.toLowerCase() === p.toLowerCase())) {
        const next = [...current, p];
        await invoke("save_webmcp_allowed_roots", { roots: next });
      }
      setActionFeedback(`目录 ${p} 已成功添加至白名单！`);
      setNewRootInput("");
      await fetchRootsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
      setTimeout(() => setActionFeedback(null), 3500);
    }
  };

  const handleRemoveRoot = async (rawPath: string) => {
    const pathToRemove = normalizeDisplayPath(rawPath);
    if (!window.confirm(`确定从白名单中移除该目录吗？\n${pathToRemove}\n\n移除后 ChatGPT 将无法访问该目录。`)) return;
    setActionBusy(`remove-${pathToRemove}`);
    setActionFeedback(null);
    try {
      const res = await consoleApi<{ ok: boolean; message?: string; error?: string }>(
        "POST",
        "/console/roots/remove",
        { path: pathToRemove },
      );
      if (res.ok) {
        setActionFeedback(res.message || "已成功移除白名单目录");
        await fetchRootsData();
        return;
      }
    } catch {
      // Backend service might be offline, fallback to direct Tauri IPC
    }

    try {
      const next = roots
        .map((r) => normalizeDisplayPath(r.path))
        .filter((r) => r.toLowerCase() !== pathToRemove.toLowerCase());
      await invoke("save_webmcp_allowed_roots", { roots: next });
      setActionFeedback("已成功移除白名单目录");
      await fetchRootsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
      setTimeout(() => setActionFeedback(null), 3500);
    }
  };

  const handleRemoveWorkspace = async (workspaceId: string) => {
    if (!window.confirm("确定移除该工作区会话记录吗？")) return;
    setActionBusy(`remove-ws-${workspaceId}`);
    try {
      const res = await consoleApi<{ ok: boolean; message?: string; error?: string }>(
        "POST",
        "/console/workspaces/remove",
        { workspaceId },
      );
      if (res.ok) {
        setActionFeedback(res.message || "工作区会话已移除");
        await fetchRootsData();
        await onRefreshWorkspaces();
      } else {
        setError(res.error || "移除失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
      setTimeout(() => setActionFeedback(null), 3500);
    }
  };

  return (
    <section className="monitor-overview-view monitor-roots-view">
      <div className="monitor-page-heading">
        <span className="monitor-page-icon"><ShieldCheck size={20} /></span>
        <div>
          <strong>目录白名单与工作区管理 (Allowed Roots & Workspaces)</strong>
          <small>配置允许 ChatGPT 与 WebMCP 访问的本地目录白名单及已连接工作区</small>
        </div>
      </div>

      {actionFeedback && (
        <div className="monitor-feedback-banner success" style={{ margin: "0 0 16px" }}>
          <Check size={16} />
          <span>{actionFeedback}</span>
        </div>
      )}

      {isServiceOfflineNotice && (
        <div className="monitor-feedback-banner info" style={{ margin: "0 0 16px" }}>
          <Info size={16} />
          <span>后台 MCP 服务当前未启动，页面展示并直接管理本地 <code>config.json</code> 中的白名单配置。</span>
        </div>
      )}

      {error && (
        <div className="monitor-connection-warning" style={{ margin: "0 0 16px" }}>
          <AlertTriangle size={16} />
          <div><strong>操作提示</strong><span>{error}</span></div>
          <button onClick={() => void fetchRootsData()}>重试</button>
        </div>
      )}

      {/* Metric Cards */}
      <div className="monitor-metric-grid" style={{ marginBottom: 16 }}>
        <Metric label="已授权根目录" value={`${roots.length} 个`} note="ChatGPT 仅可访问白名单范围内的目录" />
        <Metric label="活跃工作区会话" value={`${workspaces.length} 个`} note="已在本地注册的工作区项目" />
        <Metric label="全局配置文件" value={configPath.split(/[\\/]/).pop() || "config.json"} note={configPath || "~/.webmcp/config.json"} />
      </div>

      {/* Allowed Roots Section */}
      <div className="monitor-info-panel" style={{ marginBottom: 16 }}>
        <header className="monitor-card-header-clean">
          <div className="monitor-card-header-title">
            <Folder size={17} color="var(--monitor-blue)" />
            <strong>授权访问根目录 (Allowed Roots 白名单)</strong>
          </div>
          <button
            className="monitor-service-quick-btn monitor-btn-compact"
            disabled={loading}
            onClick={() => void fetchRootsData()}
          >
            <RefreshCw size={12} className={loading ? "spinning" : ""} />
            <span>刷新列表</span>
          </button>
        </header>

        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Add root toolbar: Input + Browse Folder + Add Button */}
          <div className="monitor-roots-toolbar">
            <div className="monitor-roots-input-wrapper">
              <Folder size={15} className="monitor-input-icon" />
              <input
                value={newRootInput}
                onChange={(e) => setNewRootInput(e.target.value)}
                placeholder="输入或选择要授权的工作区目录绝对路径 (如 D:\my-project)"
                onKeyDown={(e) => { if (e.key === "Enter") void handleAddRoot(); }}
              />
            </div>
            <button
              className="monitor-service-quick-btn monitor-btn-browse"
              onClick={() => void handleBrowseFolder()}
              title="打开系统文件夹选择框选择目录"
            >
              <Folder size={13} />
              <span>选择文件夹…</span>
            </button>
            <button
              className="monitor-service-quick-btn primary monitor-btn-add"
              disabled={!newRootInput.trim() || !!actionBusy}
              onClick={() => void handleAddRoot()}
            >
              <Plus size={14} />
              <span>{actionBusy === "add-root" ? "添加中…" : "添加到白名单"}</span>
            </button>
          </div>

          {/* Roots List */}
          <div className="monitor-roots-list">
            {roots.map((root) => {
              const displayPath = normalizeDisplayPath(root.path);
              return (
                <div key={root.path} className="monitor-root-card">
                  <div className="monitor-root-card-left">
                    <div className="monitor-root-icon">
                      {root.isDrive ? <HardDrive size={18} /> : <Folder size={18} />}
                    </div>
                    <div className="monitor-root-details">
                      <div className="monitor-root-header-line">
                        <strong className="monitor-root-path-text">{displayPath}</strong>
                        {root.exists ? (
                          <span className="monitor-tag-badge workspace"><Check size={11} /> 路径有效</span>
                        ) : (
                          <span className="monitor-tag-badge" style={{ background: "rgba(239, 68, 68, 0.12)", color: "var(--monitor-red)" }}>
                            <AlertTriangle size={11} /> 路径不存在
                          </span>
                        )}
                        {root.isDrive && <span className="monitor-skill-ver">整盘根目录</span>}
                      </div>
                      <p className="monitor-root-sub-info">
                        允许网页端 ChatGPT 与 WebMCP 访问并操作该目录下的文件与代码
                        {root.workspacesCount > 0 && <span> • 包含 {root.workspacesCount} 个活跃工作区</span>}
                      </p>
                    </div>
                  </div>

                  <button
                    className="monitor-service-quick-btn danger monitor-btn-compact"
                    disabled={!!actionBusy}
                    onClick={() => void handleRemoveRoot(root.path)}
                    title="从白名单中移除该目录"
                  >
                    <Trash2 size={13} />
                    <span>移除</span>
                  </button>
                </div>
              );
            })}

            {!roots.length && (
              <div className="monitor-empty-state-card">
                <div className="monitor-empty-state-icon">
                  <ShieldCheck size={24} />
                </div>
                <div className="monitor-empty-state-title">暂无已配置的白名单目录</div>
                <p className="monitor-empty-state-desc">请在上方点击「选择文件夹」或直接输入路径并添加到白名单中。</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Active Workspaces Section */}
      <div className="monitor-info-panel">
        <header className="monitor-card-header-clean">
          <div className="monitor-card-header-title">
            <BookmarkCheck size={17} color="var(--monitor-blue)" />
            <strong>已记录的工作区会话 (Workspace Sessions)</strong>
          </div>
        </header>

        <div style={{ padding: "18px 20px" }}>
          <div className="monitor-roots-list">
            {workspaces.map((ws) => {
              const displayRoot = normalizeDisplayPath(ws.root);
              const name = displayRoot.split(/[\\/]/).filter(Boolean).pop() || displayRoot;
              return (
                <div key={ws.id} className="monitor-root-card">
                  <div className="monitor-root-card-left">
                    <div className="monitor-root-icon" style={{ background: "var(--monitor-panel-soft)", color: "var(--monitor-text-soft)" }}>
                      <Folder size={18} />
                    </div>
                    <div className="monitor-root-details">
                      <div className="monitor-root-header-line">
                        <strong>{name}</strong>
                        <span className="monitor-tag-badge workspace">{ws.mode}</span>
                        <code style={{ fontSize: 11, color: "var(--monitor-text-muted)" }}>{displayRoot}</code>
                      </div>
                      <p className="monitor-root-sub-info">
                        最后活跃: {new Date(ws.lastUsedAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <button
                      className="monitor-service-quick-btn primary monitor-btn-compact"
                      onClick={() => onSelectWorkspace(ws.id)}
                    >
                      <Play size={12} />
                      <span>查看日志</span>
                    </button>
                    <button
                      className="monitor-service-quick-btn monitor-btn-compact"
                      disabled={!!actionBusy}
                      onClick={() => void handleRemoveWorkspace(ws.id)}
                      title="移除此工作区会话记录"
                    >
                      <Trash2 size={13} />
                      <span>移除</span>
                    </button>
                  </div>
                </div>
              );
            })}

            {!workspaces.length && (
              <div className="monitor-empty-state-card">
                <div className="monitor-empty-state-icon">
                  <Folder size={24} />
                </div>
                <div className="monitor-empty-state-title">暂无活跃工作区会话</div>
                <p className="monitor-empty-state-desc">当 ChatGPT 或本地打开任意项目工作区后，将在此自动记录会话与操作日志。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
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
            <div><strong>添加本地工作区</strong><small>连接已有项目并自动同步至 allowedRoots 白名单</small></div>
          </div>
          <button className="monitor-icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="monitor-modal-body">
          <label className="monitor-path-field">
            <span>项目绝对路径</span>
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="例如: D:\my-project 或 /Users/name/my-project"
            />
          </label>
          <div style={{ fontSize: 11.5, color: "var(--monitor-text-soft)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <ShieldCheck size={14} color="var(--monitor-green)" style={{ flexShrink: 0 }} />
            <span>添加后将自动加入 <code>allowedRoots</code>，允许 ChatGPT 访问与操作该目录。</span>
          </div>
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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("console-theme") as Theme | null) ?? "light");
  const [clientStatus, setClientStatus] = useState<ClientStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [optimizer, setOptimizer] = useState<OptimizerStatus | null>(null);
  const [processCount, setProcessCount] = useState(0);
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
  const [webmcpConfig, setWebmcpConfig] = useState<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null } | null>(null);
  const [customDomainInput, setCustomDomainInput] = useState<string>("");
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainFeedback, setDomainFeedback] = useState<string | null>(null);
  const [showDomainEditor, setShowDomainEditor] = useState(false);

  // Desktop Floating Ball state
  const [floatBallActive, setFloatBallActive] = useState(false);

  useEffect(() => {
    invoke<boolean>("is_float_ball_visible")
      .then((vis) => setFloatBallActive(Boolean(vis)))
      .catch(() => undefined);
  }, []);

  const handleToggleFloatBall = async () => {
    try {
      const next = !floatBallActive;
      const res = await invoke<boolean>("toggle_float_ball", { show: next });
      setFloatBallActive(Boolean(res));
    } catch (err) {
      console.error("Toggle float ball failed:", err);
    }
  };

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
      const logs = await invoke<string[]>("get_webmcp_service_logs");
      setServiceLogs(logs);
    } catch {
      // ignore
    }
  }, []);

  const handleClearServiceLogs = async () => {
    try {
      await invoke("clear_webmcp_service_logs");
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

  const updateWebmcpConfig = useCallback(async () => {
    try {
      const config = await invoke<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null }>("get_webmcp_config");
      setWebmcpConfig(config);
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
      const res = await invoke<{ publicBaseUrl?: string | null; ownerToken?: string | null; allowedRoots: string[]; configDir?: string | null }>("set_webmcp_public_url", { url: targetUrl });
      setWebmcpConfig(res);
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
      await updateWebmcpConfig();
    };
    void runUpdate();
    const timer = window.setInterval(() => void runUpdate(), 4_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [updateTunnelStatus, updateProjectPathInfo, updateWebmcpConfig]);

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
      if (!normalizedQuery) return true;
      return [event.tool, event.summary, event.target, event.command]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [statusFilter, query, workspaceEvents]);

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
    setServiceFeedback("正在启动 WebMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("start_webmcp_service");
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
    if (!window.confirm("确定停止 WebMCP 后台服务吗？这将中断当前连接。")) return;
    setServiceActionBusy(true);
    setShowServiceLogs(true);
    setServiceFeedback("正在停止 WebMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("stop_webmcp_service");
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
    setServiceFeedback("正在重启 WebMCP 后台服务…");
    try {
      const result = await invoke<ServiceControlResult>("restart_webmcp_service");
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
    const target = drive.projectPath || `${drive.drive}webmcp-main`;
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
          <strong>WebMCP Console</strong>
          <small>v{serverVersion === "—" ? clientStatus?.version ?? "1.0" : serverVersion}</small>
        </div>
        <div className="monitor-window-actions">
          <button
            className={classNames("monitor-floatball-toggle-btn", floatBallActive && "active")}
            title={floatBallActive ? "隐藏桌面悬浮球" : "开启桌面悬浮球 (实时并发与缓存监控)"}
            onClick={() => void handleToggleFloatBall()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0 10px",
              width: "auto",
              borderRadius: 6,
              background: floatBallActive ? "var(--monitor-green-soft)" : "transparent",
              color: floatBallActive ? "var(--monitor-green)" : "var(--monitor-text-soft)",
              border: floatBallActive ? "1px solid rgba(34, 197, 94, 0.3)" : "1px solid transparent"
            }}
          >
            <CircleDot size={13} color={floatBallActive ? "var(--monitor-green)" : "currentColor"} />
            <span style={{ fontSize: 11.5, fontWeight: 500 }}>{floatBallActive ? "悬浮球已开" : "桌面悬浮球"}</span>
          </button>
          <button
            title={theme === "light" ? "切换深色主题" : "切换浅色主题"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          <button title="最小化" onClick={() => void appWindow.minimize()}><Minus size={15} /></button>
          <button title="最大化 / 还原" onClick={() => void appWindow.toggleMaximize()}><Square size={12} /></button>
          <button className="close" title="关闭窗口 (后台保持 MCP 服务与悬浮球运行)" onClick={() => void appWindow.hide()}><X size={15} /></button>
        </div>
      </header>

      <div className="monitor-layout">
        <aside className="monitor-sidebar">
          <section className="monitor-sidebar-section workspace-section">
            <div className="monitor-sidebar-heading">
              <span>工作区</span>
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
                  <small>在下方「目录白名单与工作区」管理或通过 WebMCP 访问</small>
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

          <section className="monitor-sidebar-section monitor-sidebar-nav">
            <div className="monitor-sidebar-heading muted"><span>控制面板</span></div>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "logs" && "active")}
              onClick={() => setView("logs")}
            >
              <Activity size={15} />
              <span>实时日志</span>
              <em>{workspaceEvents.length}</em>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "processes" && "active")}
              onClick={() => setView("processes")}
            >
              <TerminalSquare size={15} />
              <span>运行终端</span>
              <em>{processCount}</em>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "optimizer" && "active")}
              onClick={() => setView("optimizer")}
            >
              <Zap size={15} />
              <span>性能与缓存</span>
              <em>{optimizer?.cache.size ?? 0}</em>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "environment" && "active")}
              onClick={() => setView("environment")}
            >
              <ShieldCheck size={15} />
              <span>环境与服务</span>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "skills" && "active")}
              onClick={() => setView("skills")}
            >
              <Sparkles size={15} />
              <span>Skills 技能库</span>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "roots" && "active")}
              onClick={() => setView("roots")}
            >
              <HardDrive size={15} />
              <span>工作区与白名单</span>
            </button>
            <button
              className={classNames("monitor-sidebar-nav-item", view === "settings" && "active")}
              onClick={() => setView("settings")}
            >
              <BookmarkCheck size={15} />
              <span>快照与设置</span>
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
                  <span>启动服务</span>
                </button>
              ) : (
                <button
                  className="monitor-service-quick-btn danger"
                  disabled={serviceActionBusy}
                  onClick={() => void handleStopService()}
                >
                  <Square size={11} />
                  <span>停止服务</span>
                </button>
              )}
              <button
                className="monitor-service-quick-btn"
                disabled={serviceActionBusy}
                onClick={() => void handleRestartService()}
              >
                <RotateCw size={11} className={serviceActionBusy ? "spinning" : ""} />
                <span>重启</span>
              </button>
            </div>
          </section>
        </aside>

        <main className="monitor-main">
          <header className="monitor-workspace-header">
            <div className="monitor-workspace-title">
              <span className={classNames("monitor-live-dot", isServiceOnline && "online")} />
              <div>
                <div>
                  <strong>{workspace?.name ?? "WebMCP"}</strong>
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
                className={classNames("monitor-icon-button", view === "settings" && "active")}
                title="快照管理与 Console 设置"
                onClick={() => setView("settings")}
              >
                <Settings size={15} />
              </button>
            </div>
          </header>

          {view === "logs" && (
            <>
              <section className="monitor-log-toolbar">
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

                <div className="monitor-search">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索工具、命令或执行结果..."
                  />
                  {query && (
                    <button onClick={() => setQuery("")}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              </section>

              <section className="monitor-events">
                {!isServiceOnline && (
                  <div className="monitor-service-offline-banner">
                    <div>
                      <AlertTriangle size={18} color="var(--monitor-amber)" />
                      <div>
                        <strong>WebMCP 本地服务未运行</strong>
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
                      {expanded && <ExpandedEvent event={event} />}
                    </article>
                  );
                })}

                {!filteredEvents.length && !loading && isServiceOnline && (
                  <div className="monitor-empty-state">
                    <Activity size={32} />
                    <strong>{workspace ? "当前筛选条件下暂无日志" : "暂无工作区数据"}</strong>
                    <span>{workspace ? "尝试清空搜索框或切换筛选状态。" : "先在 WebMCP 中打开工作区以查看实时动态。"}</span>
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

              <OptimizerTelemetryGraphic
                optimizer={optimizer}
                floatBallActive={floatBallActive}
                onToggleFloatBall={handleToggleFloatBall}
              />
            </section>
          )}

          {view === "environment" && (
            <section className="monitor-overview-view">
              <div className="monitor-page-heading">
                <span className="monitor-page-icon"><ShieldCheck size={20} /></span>
                <div>
                  <strong>环境检查与服务主控</strong>
                  <small>WebMCP 本地服务生命周期管理、隧道状态与运行配置详情</small>
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
                      <strong>WebMCP 核心服务 ({isServiceOnline ? "运行中" : "已停止"})</strong>
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
                        <strong>WebMCP 核心服务生命周期与启停日志</strong>
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
                      {showDomainEditor ? "收起域名设置" : (webmcpConfig?.publicBaseUrl ? "修改固定公网域名" : "配置固定公网域名")}
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
                          placeholder="例如: https://webmcp.do3bvk.cn"
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
                        {webmcpConfig?.publicBaseUrl && (
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
                      <strong>WebMCP 主程序根路径与盘符选择</strong>
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
                          title={drive.hasProject ? `在 ${drive.drive} 已检测到 webmcp-main 项目` : `选择 ${drive.drive} 盘`}
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
                    placeholder="输入或粘贴项目绝对路径，例如: D:\webmcp-main 或 E:\webmcp"
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
                <Metric label="WebMCP 版本" value={runtime?.version ?? clientStatus?.version ?? "—"} />
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

          {view === "skills" && (
            <SkillsManagerView workspace={workspace} />
          )}

          {view === "roots" && (
            <RootsManagerView
              onSelectWorkspace={(id) => {
                setSelectedWorkspaceId(id);
                setView("logs");
              }}
              onRefreshWorkspaces={refresh}
            />
          )}

          {view === "settings" && (
            <SettingsAndCheckpointsView
              workspace={workspace}
              retentionDays={retentionDays}
              storedEvents={storedEvents}
              databasePath={databasePath}
              databaseBytes={databaseBytes}
              busy={settingsBusy}
              onSave={saveSettings}
              onCleanup={cleanup}
              onClear={clear}
            />
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

import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  CircleDot,
  Clock3,
  Copy,
  Cpu,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceItem } from "./types";

interface ConsoleProcess {
  workspaceId: string;
  sessionId: number;
  pid?: number;
  command: string;
  cwd: string;
  tty: boolean;
  startedAt: number;
  wallTimeMs: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
}

interface ProcessListResponse {
  ok: boolean;
  processes: ConsoleProcess[];
}

interface ProcessOutputResponse {
  ok: boolean;
  snapshot: {
    sessionId?: number;
    output: string;
    outputTruncated: boolean;
    running: boolean;
    exitCode?: number;
    signal?: string;
    wallTimeMs: number;
  };
}

function durationLabel(ms: number) {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function startedLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ProcessManager({ workspace }: { workspace: WorkspaceItem }) {
  const [processes, setProcesses] = useState<ConsoleProcess[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [outputTruncated, setOutputTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminating, setTerminating] = useState(false);

  const selected = useMemo(() => processes.find((process) =>
    `${process.workspaceId}:${process.sessionId}` === selectedKey) ?? null, [processes, selectedKey]);

  const refresh = async () => {
    if (workspace.id === "__empty__") return;
    try {
      const response = await invoke<ProcessListResponse>("fetch_console_processes", {
        workspaceRoot: workspace.path,
      });
      setProcesses(response.processes);
      setSelectedKey((current) => {
        if (current && response.processes.some((process) => `${process.workspaceId}:${process.sessionId}` === current)) {
          return current;
        }
        const first = response.processes[0];
        return first ? `${first.workspaceId}:${first.sessionId}` : null;
      });
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  const refreshOutput = async (process: ConsoleProcess | null) => {
    if (!process) {
      setOutput("");
      setOutputTruncated(false);
      return;
    }
    try {
      const response = await invoke<ProcessOutputResponse>("fetch_console_process_output", {
        workspaceId: process.workspaceId,
        sessionId: process.sessionId,
      });
      setOutput(response.snapshot.output);
      setOutputTruncated(response.snapshot.outputTruncated);
    } catch (cause) {
      setOutput(`无法读取进程输出：${String(cause)}`);
      setOutputTruncated(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setProcesses([]);
    setSelectedKey(null);
    setOutput("");
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [workspace.path]);

  useEffect(() => {
    void refreshOutput(selected);
    if (!selected?.running) return;
    const timer = window.setInterval(() => void refreshOutput(selected), 1_500);
    return () => window.clearInterval(timer);
  }, [selected?.workspaceId, selected?.sessionId, selected?.running]);

  const terminate = async () => {
    if (!selected?.running || terminating) return;
    if (!window.confirm(`确定终止这个进程吗？\n\n${selected.command}`)) return;
    setTerminating(true);
    try {
      await invoke("terminate_console_process", {
        workspaceId: selected.workspaceId,
        sessionId: selected.sessionId,
      });
      await refresh();
      await refreshOutput(selected);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setTerminating(false);
    }
  };

  const runningCount = processes.filter((process) => process.running).length;

  return (
    <section className="process-manager">
      <header className="process-manager-toolbar">
        <div>
          <span className="process-manager-icon"><Cpu size={18} /></span>
          <div><strong>进程管理</strong><span>{runningCount} 个运行中 · {processes.length} 个最近进程</span></div>
        </div>
        <button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14} />刷新</button>
      </header>

      {error && <div className="process-error">{error}</div>}

      <div className="process-manager-body">
        <div className="process-list">
          {processes.map((process) => {
            const key = `${process.workspaceId}:${process.sessionId}`;
            return (
              <button key={key} className={`process-row ${selectedKey === key ? "selected" : ""}`} onClick={() => setSelectedKey(key)}>
                <span className={`process-state ${process.running ? "running" : "done"}`}>
                  {process.running ? <CircleDot size={15} /> : <CheckCircle2 size={15} />}
                </span>
                <span className="process-copy">
                  <strong title={process.command}>{process.command}</strong>
                  <span title={process.cwd}>PID {process.pid ?? "—"} · {process.cwd}</span>
                </span>
                <span className="process-meta"><Clock3 size={12} />{durationLabel(process.wallTimeMs)}</span>
              </button>
            );
          })}
          {!processes.length && !loading && (
            <div className="process-empty"><TerminalSquare size={28} /><strong>当前没有托管进程</strong><span>通过 exec_command 启动的进程会显示在这里。</span></div>
          )}
          {loading && <div className="process-empty"><CircleDot size={26} /><strong>正在读取进程状态…</strong></div>}
        </div>

        <aside className="process-detail">
          {selected ? (
            <>
              <div className="process-detail-head">
                <div><strong>{selected.running ? "运行中" : "已结束"}</strong><span>Session #{selected.sessionId} · PID {selected.pid ?? "—"}</span></div>
                {selected.running && <button className="terminate-process" disabled={terminating} onClick={() => void terminate()}><Square size={13} />{terminating ? "终止中…" : "终止进程"}</button>}
              </div>
              <dl className="process-info-grid">
                <dt>启动时间</dt><dd>{startedLabel(selected.startedAt)}</dd>
                <dt>运行时长</dt><dd>{durationLabel(selected.wallTimeMs)}</dd>
                <dt>TTY</dt><dd>{selected.tty ? "是" : "否"}</dd>
                <dt>退出码</dt><dd>{selected.exitCode ?? "—"}</dd>
                <dt>Signal</dt><dd>{selected.signal ?? "—"}</dd>
                <dt>工作目录</dt><dd title={selected.cwd}>{selected.cwd}</dd>
              </dl>
              <div className="process-command"><span>命令</span><code>{selected.command}</code></div>
              <div className="process-output-head"><span>实时输出 {outputTruncated ? "· 已截断" : ""}</span><button onClick={() => void navigator.clipboard.writeText(output)}><Copy size={13} />复制</button></div>
              <pre className="process-output">{output || "暂无未消费输出"}</pre>
            </>
          ) : (
            <div className="process-detail-empty"><TerminalSquare size={30} /><strong>选择一个进程</strong><span>查看命令、状态和当前输出。</span></div>
          )}
        </aside>
      </div>
    </section>
  );
}

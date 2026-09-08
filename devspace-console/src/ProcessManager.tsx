import {
  CheckCircle2,
  CircleDot,
  Clock3,
  Copy,
  Cpu,
  RefreshCw,
  TerminalSquare,
  Check,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { consoleApi, withQuery } from "./console-api";
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
  const [copied, setCopied] = useState(false);
  const terminalRef = useRef<HTMLPreElement | null>(null);

  const selected = useMemo(
    () =>
      processes.find(
        (process) => `${process.workspaceId}:${process.sessionId}` === selectedKey
      ) ?? null,
    [processes, selectedKey]
  );

  const refresh = async () => {
    if (workspace.id === "__empty__") return;
    try {
      const response = await consoleApi<ProcessListResponse>(
        "GET",
        withQuery("/console/processes", { workspaceRoot: workspace.path })
      );
      setProcesses(response.processes);
      setSelectedKey((current) => {
        if (
          current &&
          response.processes.some(
            (process) => `${process.workspaceId}:${process.sessionId}` === current
          )
        ) {
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
      const response = await consoleApi<ProcessOutputResponse>(
        "GET",
        withQuery(`/console/processes/${process.sessionId}/output`, {
          workspaceId: process.workspaceId,
        })
      );
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

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const runningCount = processes.filter((process) => process.running).length;

  return (
    <section className="process-manager-view">
      <header className="process-manager-toolbar">
        <div>
          <span className="process-manager-icon">
            <Cpu size={18} />
          </span>
          <div>
            <strong>进程管理与终端</strong>
            <span>
              {runningCount} 个运行中 · {processes.length} 个历史会话
            </span>
          </div>
        </div>
        <button
          className="monitor-icon-button"
          title="刷新进程列表"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={loading ? "spinning" : ""} />
        </button>
      </header>

      {error && <div className="monitor-connection-warning">{error}</div>}

      <div className="process-manager-body">
        <div className="process-list">
          {processes.map((process) => {
            const key = `${process.workspaceId}:${process.sessionId}`;
            const isSelected = selectedKey === key;
            return (
              <button
                key={key}
                className={`process-card ${isSelected ? "selected" : ""}`}
                onClick={() => setSelectedKey(key)}
              >
                <div className="process-card-header">
                  <span
                    className={`process-pill ${
                      process.running ? "running" : "done"
                    }`}
                  >
                    {process.running ? (
                      <CircleDot size={12} />
                    ) : (
                      <CheckCircle2 size={12} />
                    )}
                    {process.running ? "运行中" : "已结束"}
                  </span>
                  <span className="process-time">
                    <Clock3 size={11} style={{ display: "inline", marginRight: 3 }} />
                    {durationLabel(process.wallTimeMs)}
                  </span>
                </div>
                <div className="process-command-text" title={process.command}>
                  {process.command}
                </div>
                <div className="process-cwd-text" title={process.cwd}>
                  PID: {process.pid ?? "—"} · {process.cwd}
                </div>
              </button>
            );
          })}
          {!processes.length && !loading && (
            <div className="monitor-empty-state">
              <TerminalSquare size={28} />
              <strong>当前没有托管进程</strong>
              <span>通过 GPTMCP 启动的后台长运行命令会实时显示在这里。</span>
            </div>
          )}
          {loading && !processes.length && (
            <div className="monitor-empty-state">
              <CircleDot size={26} className="spinning" />
              <strong>正在连接并读取进程状态…</strong>
            </div>
          )}
        </div>

        <div className="process-terminal-container">
          {selected ? (
            <>
              <div className="process-terminal-header">
                <div className="terminal-window-dots">
                  <span className="terminal-window-dot red" />
                  <span className="terminal-window-dot yellow" />
                  <span className="terminal-window-dot green" />
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--monitor-text-soft)",
                    }}
                  >
                    Session #{selected.sessionId}
                  </span>
                </div>
                <button
                  className="monitor-icon-button"
                  title="复制终端输出"
                  onClick={() => void copyOutput()}
                  style={{ width: "auto", padding: "0 10px", height: 28, fontSize: 11 }}
                >
                  {copied ? (
                    <>
                      <Check size={13} style={{ color: "var(--monitor-green)", marginRight: 4 }} />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy size={13} style={{ marginRight: 4 }} />
                      复制输出
                    </>
                  )}
                </button>
              </div>

              <div className="terminal-meta-grid">
                <div className="terminal-meta-item">
                  <span>PID / 状态</span>
                  <strong>
                    {selected.pid ?? "—"} ({selected.running ? "Active" : "Exited"})
                  </strong>
                </div>
                <div className="terminal-meta-item">
                  <span>启动时间</span>
                  <strong>{startedLabel(selected.startedAt)}</strong>
                </div>
                <div className="terminal-meta-item">
                  <span>运行时长</span>
                  <strong>{durationLabel(selected.wallTimeMs)}</strong>
                </div>
                <div className="terminal-meta-item">
                  <span>退出码</span>
                  <strong>{selected.exitCode ?? (selected.running ? "—" : "0")}</strong>
                </div>
              </div>

              <pre ref={terminalRef} className="process-terminal-viewport">
                {output || ">>> 进程已启动，暂无未消费的标准输出..."}
                {outputTruncated && "\n\n[提示：输出内容过长，仅展示最近截断片段]"}
              </pre>
            </>
          ) : (
            <div className="monitor-empty-state" style={{ height: "100%" }}>
              <TerminalSquare size={36} />
              <strong>选择一个进程查看实时终端</strong>
              <span>在左侧列表中点击任意运行中或已完成的进程。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

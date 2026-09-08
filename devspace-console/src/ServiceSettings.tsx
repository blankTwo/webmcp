import { Activity, Database, HardDrive, Server, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";

export interface LocalServiceStatus {
  name: string;
  running: boolean;
  healthy?: boolean;
  pid?: number;
  version?: string;
  startedAt?: string;
  uptimeSeconds?: number;
  localAddress?: string;
  publicAddress?: string;
  host?: string;
  port?: number;
  cpuPercent?: number;
  memoryBytes?: number;
  eventCount?: number;
  streamSubscribers?: number;
  databasePath?: string;
  databaseBytes?: number;
  retentionDays?: number;
}

export interface LocalServiceStatuses {
  codexMcp: LocalServiceStatus;
  consoleServer: LocalServiceStatus;
}

interface ServiceSettingsProps {
  retentionDays: number;
  storedEvents: number;
  databasePath: string;
  databaseBytes: number;
  saving: boolean;
  error: string | null;
  serviceStatusError: string | null;
  services: LocalServiceStatuses | null;
  onClose: () => void;
  onSave: (days: number) => Promise<void>;
  onCleanup: () => Promise<void>;
  onClear: () => Promise<void>;
}

function formatBytes(bytes: number | undefined) {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number | undefined) {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function ServiceCard({ service, icon }: { service: LocalServiceStatus | undefined; icon: "server" | "activity" }) {
  const Icon = icon === "server" ? Server : Activity;
  const running = Boolean(service?.running);
  const healthy = Boolean(service?.healthy);
  return (
    <section className={`service-status-card ${running ? "running" : "stopped"}`}>
      <header>
        <div className="service-card-title">
          <span className="service-card-icon"><Icon size={18} /></span>
          <div>
            <strong>{service?.name ?? "—"}</strong>
            <span><i className="service-state-dot" />{running ? healthy ? "运行正常" : "进程运行 / 健康检查失败" : "未运行"}</span>
          </div>
        </div>
      </header>
      <dl className="service-detail-grid">
        <dt>PID</dt><dd>{service?.pid ?? "—"}</dd>
        <dt>端口</dt><dd>{service?.port ?? "—"}</dd>
        <dt>运行时长</dt><dd>{formatUptime(service?.uptimeSeconds)}</dd>
        <dt>CPU</dt><dd>{service?.cpuPercent === undefined ? "—" : `${service.cpuPercent.toFixed(1)}%`}</dd>
        <dt>内存</dt><dd>{formatBytes(service?.memoryBytes)}</dd>
        {service?.version && <><dt>版本</dt><dd>{service.version}</dd></>}
        <dt>本地地址</dt><dd className="mono" title={service?.localAddress}>{service?.localAddress ?? "—"}</dd>
        {service?.publicAddress && <><dt>公网地址</dt><dd className="mono" title={service.publicAddress}>{service.publicAddress}</dd></>}
        {service?.eventCount !== undefined && <><dt>事件数</dt><dd>{service.eventCount.toLocaleString("zh-CN")}</dd></>}
        {service?.streamSubscribers !== undefined && <><dt>SSE 连接</dt><dd>{service.streamSubscribers}</dd></>}
        {service?.databaseBytes !== undefined && <><dt>SQLite</dt><dd>{formatBytes(service.databaseBytes)}</dd></>}
      </dl>
    </section>
  );
}

export function ServiceSettings({
  retentionDays,
  storedEvents,
  databasePath,
  databaseBytes,
  saving,
  error,
  serviceStatusError,
  services,
  onClose,
  onSave,
  onCleanup,
  onClear,
}: ServiceSettingsProps) {
  const [draftDays, setDraftDays] = useState(retentionDays);
  useEffect(() => setDraftDays(retentionDays), [retentionDays]);

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-dialog service-settings-dialog" role="dialog" aria-modal="true" aria-label="GPTMCP Console 设置">
        <header className="settings-dialog-header">
          <div>
            <span className="settings-dialog-icon"><Settings size={18} /></span>
            <div><strong>GPTMCP Console 设置</strong><small>旁路 telemetry 与本机服务状态</small></div>
          </div>
          <button className="icon-button compact" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="settings-dialog-body">
          <div className="settings-section-title"><strong>本机服务</strong><span>每 8 秒独立探测，不经过 MCP</span></div>
          <div className="service-status-grid">
            <ServiceCard service={services?.codexMcp} icon="server" />
            <ServiceCard service={services?.consoleServer} icon="activity" />
          </div>
          {serviceStatusError && <div className="settings-error">服务状态读取失败：{serviceStatusError}</div>}

          <div className="settings-section-title storage-section-title"><strong>日志存储</strong><span>独立 SQLite</span></div>
          <div className="setting-row">
            <div className="setting-copy">
              <span className="setting-icon"><Database size={18} /></span>
              <div>
                <strong>Telemetry 日志保留</strong>
                <span>只影响 GPTMCP Console 的旁路日志，不影响 GPTMCP 执行。</span>
              </div>
            </div>
            <select value={draftDays} onChange={(event) => setDraftDays(Number(event.target.value))}>
              {[1, 3, 7, 14, 30, 90].map((days) => <option key={days} value={days}>{days} 天</option>)}
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

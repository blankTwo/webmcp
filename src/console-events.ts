import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { ServerConfig } from "./config.js";
import { databasePath, openDatabase, type DatabaseHandle } from "./db/client.js";

export const DEFAULT_CONSOLE_RETENTION_DAYS = 7;
export const MIN_CONSOLE_RETENTION_DAYS = 1;
export const MAX_CONSOLE_RETENTION_DAYS = 3_650;
const RETENTION_SETTING_KEY = "retention_days";
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_CONSOLE_UI_JSON_BYTES = 256 * 1024;

export type ActionKind =
  | "command"
  | "test"
  | "edit"
  | "symbol"
  | "file"
  | "search"
  | "checkpoint"
  | "todo"
  | "process";

export interface SymbolContext {
  name: string;
  namePath: string;
  kind?: string;
  lineRange?: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}
export interface ConsoleToolUi {
  resource: string;
  card: Record<string, unknown>;
}

export interface ConsoleToolEvent {
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
  favorite: boolean;
}

export interface PublishConsoleToolEvent {
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
}

export interface ConsoleSettings {
  retentionDays: number;
  storedEvents: number;
  databasePath?: string;
  databaseBytes: number;
}

export interface ConsoleEventHistoryPage {
  events: ConsoleToolEvent[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

type ConsoleEventSubscriber = (event: ConsoleToolEvent) => void;

type ConsoleEventRow = {
  id: string;
  timestamp: string;
  tool: string;
  purpose: string | null;
  action_kind: string | null;
  diff_stats_json: string | null;
  symbol_context_json: string | null;
  diagnostics_state: string | null;
  workspace_id: string | null;
  path: string | null;
  working_directory: string | null;
  command_preview: string | null;
  command_length: number | null;
  success: number;
  duration_ms: number;
  error: string | null;
  session_id: number | null;
  running: number | null;
  exit_code: number | null;
  output_preview: string | null;
  console_ui_json: string | null;
  favorite: number;
};

export class ConsoleEventStore {
  private readonly events: ConsoleToolEvent[] = [];
  private readonly subscribers = new Set<ConsoleEventSubscriber>();
  private readonly database?: DatabaseHandle;
  private retentionDays = DEFAULT_CONSOLE_RETENTION_DAYS;
  private lastCleanupAt = 0;
  private lastTimestampMs = 0;

  constructor(
    private readonly maxEvents = 2_000,
    private readonly stateDir?: string,
  ) {
    if (!stateDir) return;

    this.database = openDatabase(stateDir);
    this.ensureSchema();
    this.retentionDays = this.loadRetentionDays();
    this.lastTimestampMs = this.loadLatestTimestampMs();
    this.pruneExpired(true);
  }

  private ensureSchema(): void {
    if (!this.database) return;
    this.database.sqlite.exec(`
      create table if not exists console_tool_events (
        id text primary key,
        timestamp text not null,
        tool text not null,
        workspace_id text,
        path text,
        working_directory text,
        command_preview text,
        command_length integer,
        success integer not null,
        duration_ms integer not null,
        error text,
        session_id integer,
        running integer,
        exit_code integer,
        output_preview text,
        favorite integer not null default 0,
        console_ui_json text
      );

      create index if not exists console_tool_events_timestamp_idx
        on console_tool_events(timestamp);

      create index if not exists console_tool_events_workspace_timestamp_idx
        on console_tool_events(workspace_id, timestamp);

      create index if not exists console_tool_events_favorite_timestamp_idx
        on console_tool_events(favorite, timestamp desc);

      create table if not exists console_settings (
        key text primary key,
        value text not null,
        updated_at text not null
      );
    `);

    try {
      this.database.sqlite.exec("alter table console_tool_events add column favorite integer not null default 0;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column console_ui_json text;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column purpose text;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column action_kind text;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column diff_stats_json text;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column symbol_context_json text;");
    } catch { /* Column already exists */ }
    try {
      this.database.sqlite.exec("alter table console_tool_events add column diagnostics_state text;");
    } catch { /* Column already exists */ }
  }

  publish(input: PublishConsoleToolEvent): ConsoleToolEvent {
    const event: ConsoleToolEvent = {
      id: randomUUID(),
      timestamp: this.nextTimestamp(),
      type: "tool_call",
      favorite: false,
      ...input,
    };

    if (this.database) {
      this.database.sqlite.prepare(`
        insert into console_tool_events (
          id, timestamp, tool, purpose, action_kind, diff_stats_json,
          symbol_context_json, diagnostics_state, workspace_id, path, working_directory,
          command_preview, command_length, success, duration_ms, error,
          session_id, running, exit_code, output_preview, console_ui_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.timestamp,
        event.tool,
        event.purpose ?? null,
        event.actionKind ?? null,
        event.diffStats ? JSON.stringify(event.diffStats) : null,
        event.symbolContext ? JSON.stringify(event.symbolContext) : null,
        event.diagnosticsState ?? null,
        event.workspaceId ?? null,
        event.path ?? null,
        event.workingDirectory ?? null,
        event.commandPreview ?? null,
        event.commandLength ?? null,
        event.success ? 1 : 0,
        event.durationMs,
        event.error ?? null,
        event.sessionId ?? null,
        event.running === undefined ? null : event.running ? 1 : 0,
        event.exitCode ?? null,
        event.outputPreview ?? null,
        serializeConsoleUi(event.consoleUi),
      );
      this.pruneExpired();
    } else {
      this.events.push(event);
      const overflow = this.events.length - this.maxEvents;
      if (overflow > 0) this.events.splice(0, overflow);
    }

    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  recent(limit = 500): ConsoleToolEvent[] {
    return this.history({ limit }).events.slice().reverse();
  }

  history(options: {
    limit?: number;
    before?: string;
    workspaceRoot?: string;
  } = {}): ConsoleEventHistoryPage {
    const boundedLimit = Math.max(1, Math.min(options.limit ?? 100, this.maxEvents));
    if (!this.database) {
      const filtered = options.workspaceRoot
        ? []
        : this.events.slice().reverse();
      const page = filtered.slice(0, boundedLimit);
      return {
        events: page,
        hasMore: filtered.length > page.length,
        total: filtered.length,
      };
    }

    const cursor = decodeHistoryCursor(options.before);
    const where: string[] = [];
    const params: unknown[] = [];
    let join = "";

    if (options.workspaceRoot) {
      join = "join workspace_sessions w on w.id = e.workspace_id";
      where.push("w.root = ?");
      params.push(options.workspaceRoot);
    }
    if (cursor) {
      where.push("(e.timestamp < ? or (e.timestamp = ? and e.id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = this.database.sqlite.prepare(`
      select e.id, e.timestamp, e.tool, e.purpose, e.action_kind, e.diff_stats_json, e.symbol_context_json, e.diagnostics_state, e.workspace_id, e.path, e.working_directory,
             e.command_preview, e.command_length, e.success, e.duration_ms, e.error,
             e.session_id, e.running, e.exit_code, e.output_preview, e.console_ui_json, e.favorite
      from console_tool_events e
      ${join}
      ${whereSql}
      order by e.timestamp desc, e.id desc
      limit ?
    `).all(...params, boundedLimit + 1) as ConsoleEventRow[];

    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    const totalRow = this.database.sqlite.prepare(`
      select count(*) as count
      from console_tool_events e
      ${join}
      ${options.workspaceRoot ? "where w.root = ?" : ""}
    `).get(...(options.workspaceRoot ? [options.workspaceRoot] : [])) as { count: number };

    return {
      events: pageRows.map(rowToConsoleEvent),
      nextCursor: hasMore && last ? encodeHistoryCursor(last.timestamp, last.id) : undefined,
      hasMore,
      total: totalRow.count,
    };
  }

  exportEvents(options: { workspaceRoot?: string; limit?: number } = {}): {
    events: ConsoleToolEvent[];
    total: number;
  } {
    const limit = Math.max(1, Math.min(options.limit ?? 5000, 20000));
    if (!this.database) {
      const filtered = options.workspaceRoot
        ? []
        : this.events.slice().reverse();
      return {
        events: filtered.slice(0, limit),
        total: filtered.length,
      };
    }

    const where: string[] = [];
    const params: unknown[] = [];
    let join = "";

    if (options.workspaceRoot) {
      join = "join workspace_sessions w on w.id = e.workspace_id";
      where.push("w.root = ?");
      params.push(options.workspaceRoot);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = this.database.sqlite.prepare(`
      select e.id, e.timestamp, e.tool, e.purpose, e.action_kind, e.diff_stats_json, e.symbol_context_json, e.diagnostics_state, e.workspace_id, e.path, e.working_directory,
             e.command_preview, e.command_length, e.success, e.duration_ms, e.error,
             e.session_id, e.running, e.exit_code, e.output_preview, e.console_ui_json, e.favorite
      from console_tool_events e
      ${join}
      ${whereSql}
      order by e.timestamp desc, e.id desc
      limit ?
    `).all(...params, limit) as ConsoleEventRow[];

    const totalRow = this.database.sqlite.prepare(`
      select count(*) as count
      from console_tool_events e
      ${join}
      ${whereSql}
    `).get(...params) as { count: number };

    return {
      events: rows.map(rowToConsoleEvent),
      total: totalRow.count,
    };
  }

  setFavorite(id: string, favorite: boolean): ConsoleToolEvent | undefined {
    if (!this.database) {
      const event = this.events.find((candidate) => candidate.id === id);
      if (!event) return undefined;
      event.favorite = favorite;
      return event;
    }

    const result = this.database.sqlite.prepare(
      "update console_tool_events set favorite = ? where id = ?",
    ).run(favorite ? 1 : 0, id);
    if (result.changes === 0) return undefined;

    const row = this.database.sqlite.prepare(`
      select id, timestamp, tool, workspace_id, path, working_directory,
             command_preview, command_length, success, duration_ms, error,
             session_id, running, exit_code, output_preview, console_ui_json, favorite
      from console_tool_events
      where id = ?
    `).get(id) as ConsoleEventRow | undefined;
    return row ? rowToConsoleEvent(row) : undefined;
  }

  countsByWorkspaceRoot(): Record<string, number> {
    if (!this.database) return {};
    const rows = this.database.sqlite.prepare(`
      select w.root as root, count(*) as count
      from console_tool_events e
      join workspace_sessions w on w.id = e.workspace_id
      group by w.root
    `).all() as Array<{ root: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.root, row.count]));
  }

  settings(): ConsoleSettings {
    return {
      retentionDays: this.retentionDays,
      storedEvents: this.countStoredEvents(),
      databasePath: this.stateDir ? databasePath(this.stateDir) : undefined,
      databaseBytes: this.databaseStorageBytes(),
    };
  }

  cleanupExpired(): ConsoleSettings {
    this.pruneExpired(true);
    return this.settings();
  }

  clearEvents(): ConsoleSettings {
    if (this.database) {
      this.database.sqlite.prepare("delete from console_tool_events").run();
    } else {
      this.events.splice(0, this.events.length);
    }
    return this.settings();
  }

  setRetentionDays(retentionDays: number): ConsoleSettings {
    if (
      !Number.isInteger(retentionDays)
      || retentionDays < MIN_CONSOLE_RETENTION_DAYS
      || retentionDays > MAX_CONSOLE_RETENTION_DAYS
    ) {
      throw new Error(
        `retentionDays must be an integer between ${MIN_CONSOLE_RETENTION_DAYS} and ${MAX_CONSOLE_RETENTION_DAYS}.`,
      );
    }

    this.retentionDays = retentionDays;
    if (this.database) {
      this.database.sqlite.prepare(`
        insert into console_settings (key, value, updated_at)
        values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
      `).run(RETENTION_SETTING_KEY, String(retentionDays), new Date().toISOString());
      this.pruneExpired(true);
    }

    return this.settings();
  }

  subscribe(subscriber: ConsoleEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    this.subscribers.clear();
    this.database?.close();
  }

  private nextTimestamp(): string {
    const now = Date.now();
    this.lastTimestampMs = Math.max(now, this.lastTimestampMs + 1);
    return new Date(this.lastTimestampMs).toISOString();
  }

  private loadLatestTimestampMs(): number {
    if (!this.database) return 0;
    const row = this.database.sqlite.prepare(
      "select timestamp from console_tool_events order by timestamp desc limit 1",
    ).get() as { timestamp?: string } | undefined;
    const parsed = row?.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private loadRetentionDays(): number {
    if (!this.database) return DEFAULT_CONSOLE_RETENTION_DAYS;

    const row = this.database.sqlite.prepare(
      "select value from console_settings where key = ?",
    ).get(RETENTION_SETTING_KEY) as { value?: string } | undefined;
    const parsed = Number(row?.value);
    if (
      Number.isInteger(parsed)
      && parsed >= MIN_CONSOLE_RETENTION_DAYS
      && parsed <= MAX_CONSOLE_RETENTION_DAYS
    ) {
      return parsed;
    }

    this.database.sqlite.prepare(`
      insert into console_settings (key, value, updated_at)
      values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
    `).run(
      RETENTION_SETTING_KEY,
      String(DEFAULT_CONSOLE_RETENTION_DAYS),
      new Date().toISOString(),
    );
    return DEFAULT_CONSOLE_RETENTION_DAYS;
  }

  private pruneExpired(force = false): number {
    if (!this.database) return 0;
    const now = Date.now();
    if (!force && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return 0;

    this.lastCleanupAt = now;
    const threshold = new Date(now - this.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    const result = this.database.sqlite.prepare(
      "delete from console_tool_events where timestamp < ?",
    ).run(threshold);
    return result.changes;
  }

  private databaseStorageBytes(): number {
    if (!this.stateDir) return 0;
    const path = databasePath(this.stateDir);
    return [path, `${path}-wal`, `${path}-shm`].reduce((total, candidate) => {
      if (!existsSync(candidate)) return total;
      try {
        return total + statSync(candidate).size;
      } catch {
        return total;
      }
    }, 0);
  }

  private countStoredEvents(): number {
    if (!this.database) return this.events.length;
    const row = this.database.sqlite.prepare(
      "select count(*) as count from console_tool_events",
    ).get() as { count: number };
    return row.count;
  }
}

function encodeHistoryCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp, id }), "utf8").toString("base64url");
}

function decodeHistoryCursor(cursor: string | undefined): { timestamp: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      timestamp?: unknown;
      id?: unknown;
    };
    if (typeof parsed.timestamp !== "string" || typeof parsed.id !== "string") return undefined;
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    return undefined;
  }
}

function serializeConsoleUi(consoleUi: ConsoleToolUi | undefined): string | null {
  if (!consoleUi) return null;

  const json = JSON.stringify(consoleUi);
  if (Buffer.byteLength(json, "utf8") <= MAX_CONSOLE_UI_JSON_BYTES) return json;

  const compact: ConsoleToolUi = {
    resource: consoleUi.resource,
    card: {
      ...consoleUi.card,
      payload: { truncated: true },
      truncated: true,
    },
  };
  const compactJson = JSON.stringify(compact);
  if (Buffer.byteLength(compactJson, "utf8") <= MAX_CONSOLE_UI_JSON_BYTES) return compactJson;

  return JSON.stringify({
    resource: consoleUi.resource,
    card: { truncated: true },
  } satisfies ConsoleToolUi);
}

function parseConsoleUi(value: string | null): ConsoleToolUi | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ConsoleToolUi>;
    if (typeof parsed.resource !== "string" || !parsed.card || typeof parsed.card !== "object" || Array.isArray(parsed.card)) {
      return undefined;
    }
    return {
      resource: parsed.resource,
      card: parsed.card as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

function rowToConsoleEvent(row: ConsoleEventRow): ConsoleToolEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: "tool_call",
    tool: row.tool,
    purpose: row.purpose ?? undefined,
    actionKind: (row.action_kind as ActionKind) ?? undefined,
    diffStats: row.diff_stats_json ? JSON.parse(row.diff_stats_json) : undefined,
    symbolContext: row.symbol_context_json ? JSON.parse(row.symbol_context_json) : undefined,
    diagnosticsState: (row.diagnostics_state as "valid" | "warning") ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    path: row.path ?? undefined,
    workingDirectory: row.working_directory ?? undefined,
    commandPreview: row.command_preview ?? undefined,
    commandLength: row.command_length ?? undefined,
    success: row.success !== 0,
    durationMs: row.duration_ms,
    error: row.error ?? undefined,
    sessionId: row.session_id ?? undefined,
    running: row.running === null ? undefined : row.running !== 0,
    exitCode: row.exit_code ?? undefined,
    outputPreview: row.output_preview ?? undefined,
    consoleUi: parseConsoleUi(row.console_ui_json),
    favorite: row.favorite !== 0,
  };
}

const stores = new WeakMap<ServerConfig, ConsoleEventStore>();

export function consoleEventStoreFor(config: ServerConfig): ConsoleEventStore {
  const existing = stores.get(config);
  if (existing) return existing;

  // Standalone MCP servers do not own the application SQLite lifecycle.
  // createServer binds the persistent store explicitly.
  const created = new ConsoleEventStore();
  stores.set(config, created);
  return created;
}

export function bindConsoleEventStore(config: ServerConfig, store: ConsoleEventStore): void {
  const existing = stores.get(config);
  if (existing && existing !== store) existing.close();
  stores.set(config, store);
}

export function closeConsoleEventStore(config: ServerConfig): void {
  const store = stores.get(config);
  if (!store) return;
  stores.delete(config);
  store.close();
}

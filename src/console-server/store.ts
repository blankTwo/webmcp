import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const DEFAULT_CONSOLE_RETENTION_DAYS = 7;
export const MIN_CONSOLE_RETENTION_DAYS = 1;
export const MAX_CONSOLE_RETENTION_DAYS = 3_650;

const RETENTION_SETTING_KEY = "retention_days";
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_HISTORY_PAGE = 250;
const MAX_PROCESS_OUTPUT_CHARS = 50_000;

export interface ToolTelemetryInput {
  version: 1;
  service: "codex-mcp";
  phase: "started" | "finished";
  invocationId: string;
  tool: string;
  timestamp: string;
  projectRoot?: string;
  inputSummary?: string;
  outputSummary?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
  path?: string;
  workingDirectory?: string;
  commandPreview?: string;
  commandLength?: number;
  sessionId?: number;
  running?: boolean;
  exitCode?: number;
  outputPreview?: string;
}

export interface ConsoleToolEvent {
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
  favorite: boolean;
}

export interface ConsoleWorkspace {
  id: string;
  root: string;
  status: "active";
  mode: "checkout";
  createdAt: string;
  lastUsedAt: string;
}

export interface ConsoleSettings {
  retentionDays: number;
  storedEvents: number;
  databasePath: string;
  databaseBytes: number;
}

type EventSubscriber = (event: ConsoleToolEvent) => void;

type EventRow = {
  id: string;
  started_at: string;
  timestamp: string;
  tool: string;
  project_root: string | null;
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
  favorite: number;
};

export function defaultConsoleStateDir(): string {
  return join(homedir(), ".coding-console");
}

export class TelemetryEventStore {
  private readonly sqlite: Database.Database;
  private readonly subscribers = new Set<EventSubscriber>();
  private retentionDays = DEFAULT_CONSOLE_RETENTION_DAYS;
  private lastCleanupAt = 0;

  constructor(private readonly stateDir = defaultConsoleStateDir()) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this.sqlite = new Database(this.databasePath());
    try { chmodSync(this.databasePath(), 0o600); } catch { /* Windows ACLs may ignore chmod. */ }
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("synchronous = NORMAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.migrate();
    this.retentionDays = this.loadRetentionDays();
    this.pruneExpired(true);
  }

  ingest(input: ToolTelemetryInput): ConsoleToolEvent {
    const timestamp = validTimestamp(input.timestamp) ?? new Date().toISOString();
    const existing = this.sqlite.prepare(
      "select favorite, started_at from telemetry_tool_events where id = ?",
    ).get(input.invocationId) as { favorite: number; started_at: string } | undefined;

    if (input.phase === "started") {
      this.sqlite.prepare(`
        insert into telemetry_tool_events (
          id, started_at, timestamp, tool, project_root, path, working_directory,
          command_preview, command_length, success, duration_ms, error,
          session_id, running, exit_code, output_preview, favorite
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, null, ?, 1, null, null, ?)
        on conflict(id) do update set
          timestamp = excluded.timestamp,
          tool = excluded.tool,
          project_root = coalesce(excluded.project_root, telemetry_tool_events.project_root),
          path = coalesce(excluded.path, telemetry_tool_events.path),
          working_directory = coalesce(excluded.working_directory, telemetry_tool_events.working_directory),
          command_preview = coalesce(excluded.command_preview, telemetry_tool_events.command_preview),
          command_length = coalesce(excluded.command_length, telemetry_tool_events.command_length),
          session_id = coalesce(excluded.session_id, telemetry_tool_events.session_id),
          running = 1
      `).run(
        input.invocationId,
        existing?.started_at ?? timestamp,
        timestamp,
        input.tool,
        input.projectRoot ?? null,
        input.path ?? null,
        input.workingDirectory ?? null,
        input.commandPreview ?? input.inputSummary ?? null,
        input.commandLength ?? null,
        input.sessionId ?? null,
        existing?.favorite ?? 0,
      );
    } else {
      this.sqlite.prepare(`
        insert into telemetry_tool_events (
          id, started_at, timestamp, tool, project_root, path, working_directory,
          command_preview, command_length, success, duration_ms, error,
          session_id, running, exit_code, output_preview, favorite
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          timestamp = excluded.timestamp,
          tool = excluded.tool,
          project_root = coalesce(excluded.project_root, telemetry_tool_events.project_root),
          path = coalesce(excluded.path, telemetry_tool_events.path),
          working_directory = coalesce(excluded.working_directory, telemetry_tool_events.working_directory),
          command_preview = coalesce(excluded.command_preview, telemetry_tool_events.command_preview),
          command_length = coalesce(excluded.command_length, telemetry_tool_events.command_length),
          success = excluded.success,
          duration_ms = excluded.duration_ms,
          error = excluded.error,
          session_id = coalesce(excluded.session_id, telemetry_tool_events.session_id),
          running = excluded.running,
          exit_code = excluded.exit_code,
          output_preview = excluded.output_preview
      `).run(
        input.invocationId,
        existing?.started_at ?? timestamp,
        timestamp,
        input.tool,
        input.projectRoot ?? null,
        input.path ?? null,
        input.workingDirectory ?? null,
        input.commandPreview ?? input.inputSummary ?? null,
        input.commandLength ?? null,
        input.success === false ? 0 : 1,
        Math.max(0, Math.round(input.durationMs ?? 0)),
        input.error ?? null,
        input.sessionId ?? null,
        input.running === undefined ? 0 : input.running ? 1 : 0,
        input.exitCode ?? null,
        input.outputPreview ?? input.outputSummary ?? null,
        existing?.favorite ?? 0,
      );
    }

    this.pruneExpired();
    const event = this.getEvent(input.invocationId) ?? fallbackEvent(input, timestamp);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  recent(limit = 100): ConsoleToolEvent[] {
    const rows = this.sqlite.prepare(`
      select ${EVENT_COLUMNS}
      from telemetry_tool_events
      order by timestamp desc, id desc
      limit ?
    `).all(bound(limit, 1, 500)) as EventRow[];
    return rows.map(rowToEvent).reverse();
  }

  history(options: { workspaceRoot?: string; before?: string; limit?: number }): {
    events: ConsoleToolEvent[];
    nextCursor?: string;
    hasMore: boolean;
    total: number;
  } {
    const limit = bound(options.limit ?? 100, 1, MAX_HISTORY_PAGE);
    const cursor = decodeCursor(options.before);
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceRoot) {
      where.push("project_root = ?");
      params.push(options.workspaceRoot);
    }
    if (cursor) {
      where.push("(timestamp < ? or (timestamp = ? and id < ?))");
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = this.sqlite.prepare(`
      select ${EVENT_COLUMNS}
      from telemetry_tool_events
      ${whereSql}
      order by timestamp desc, id desc
      limit ?
    `).all(...params, limit + 1) as EventRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    const countSql = options.workspaceRoot
      ? "select count(*) as count from telemetry_tool_events where project_root = ?"
      : "select count(*) as count from telemetry_tool_events";
    const count = (this.sqlite.prepare(countSql).get(...(options.workspaceRoot ? [options.workspaceRoot] : [])) as { count: number }).count;
    return {
      events: pageRows.map(rowToEvent),
      ...(hasMore && last ? { nextCursor: encodeCursor(last.timestamp, last.id) } : {}),
      hasMore,
      total: count,
    };
  }

  workspaces(): ConsoleWorkspace[] {
    const rows = this.sqlite.prepare(`
      select project_root as root, min(started_at) as created_at, max(timestamp) as last_used_at
      from telemetry_tool_events
      where project_root is not null and project_root <> ''
      group by project_root
      order by last_used_at desc
    `).all() as Array<{ root: string; created_at: string; last_used_at: string }>;
    return rows.map((row) => ({
      id: row.root,
      root: row.root,
      status: "active",
      mode: "checkout",
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  countsByWorkspaceRoot(): Record<string, number> {
    const rows = this.sqlite.prepare(`
      select project_root as root, count(*) as count
      from telemetry_tool_events
      where project_root is not null and project_root <> ''
      group by project_root
    `).all() as Array<{ root: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.root, row.count]));
  }

  runningWorkspaceIds(): string[] {
    const rows = this.sqlite.prepare(`
      select distinct project_root as root
      from telemetry_tool_events
      where running = 1 and project_root is not null and project_root <> ''
    `).all() as Array<{ root: string }>;
    return rows.map((row) => row.root);
  }

  setFavorite(id: string, favorite: boolean): ConsoleToolEvent | undefined {
    const result = this.sqlite.prepare(
      "update telemetry_tool_events set favorite = ? where id = ?",
    ).run(favorite ? 1 : 0, id);
    return result.changes ? this.getEvent(id) : undefined;
  }

  settings(): ConsoleSettings {
    return {
      retentionDays: this.retentionDays,
      storedEvents: this.count(),
      databasePath: this.databasePath(),
      databaseBytes: this.databaseBytes(),
    };
  }

  setRetentionDays(value: number): ConsoleSettings {
    if (!Number.isInteger(value) || value < MIN_CONSOLE_RETENTION_DAYS || value > MAX_CONSOLE_RETENTION_DAYS) {
      throw new Error(`retentionDays must be between ${MIN_CONSOLE_RETENTION_DAYS} and ${MAX_CONSOLE_RETENTION_DAYS}`);
    }
    this.retentionDays = value;
    this.sqlite.prepare(`
      insert into console_settings (key, value, updated_at) values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
    `).run(RETENTION_SETTING_KEY, String(value), new Date().toISOString());
    this.pruneExpired(true);
    return this.settings();
  }

  cleanupExpired(): ConsoleSettings {
    this.pruneExpired(true);
    return this.settings();
  }

  clearEvents(): ConsoleSettings {
    this.sqlite.prepare("delete from telemetry_tool_events").run();
    return this.settings();
  }

  processes(workspaceRoot: string): Array<Record<string, unknown>> {
    const rows = this.sqlite.prepare(`
      select ${EVENT_COLUMNS}
      from telemetry_tool_events
      where project_root = ? and session_id is not null and tool in ('exec_command', 'write_stdin')
      order by timestamp desc, id desc
      limit 1000
    `).all(workspaceRoot) as EventRow[];
    const grouped = new Map<number, EventRow[]>();
    for (const row of rows) {
      if (row.session_id === null) continue;
      const list = grouped.get(row.session_id) ?? [];
      list.push(row);
      grouped.set(row.session_id, list);
    }
    return [...grouped.entries()].map(([sessionId, events]) => {
      const latest = events[0]!;
      const origin = [...events].reverse().find((event) => event.tool === "exec_command") ?? events.at(-1)!;
      const startedAt = Date.parse(origin.started_at);
      const lastAt = Date.parse(latest.timestamp);
      const running = latest.running === 1;
      return {
        workspaceId: workspaceRoot,
        sessionId,
        command: origin.command_preview ?? "exec_command",
        cwd: origin.working_directory ?? workspaceRoot,
        tty: false,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
        wallTimeMs: Math.max(0, (running ? Date.now() : lastAt) - (Number.isFinite(startedAt) ? startedAt : lastAt)),
        running,
        ...(latest.exit_code === null ? {} : { exitCode: latest.exit_code }),
      };
    }).sort((left, right) => Number(right.startedAt) - Number(left.startedAt));
  }

  processOutput(workspaceRoot: string, sessionId: number): Record<string, unknown> | undefined {
    const rows = this.sqlite.prepare(`
      select ${EVENT_COLUMNS}
      from telemetry_tool_events
      where project_root = ? and session_id = ? and tool in ('exec_command', 'write_stdin')
      order by timestamp asc, id asc
    `).all(workspaceRoot, sessionId) as EventRow[];
    if (!rows.length) return undefined;
    const latest = rows.at(-1)!;
    const chunks = rows.map((row) => row.output_preview).filter((value): value is string => Boolean(value));
    const combined = chunks.join("\n");
    const truncated = combined.length > MAX_PROCESS_OUTPUT_CHARS;
    const output = truncated ? combined.slice(-MAX_PROCESS_OUTPUT_CHARS) : combined;
    const startedAt = Date.parse(rows[0]!.started_at);
    const lastAt = Date.parse(latest.timestamp);
    return {
      sessionId,
      output,
      outputTruncated: truncated,
      running: latest.running === 1,
      ...(latest.exit_code === null ? {} : { exitCode: latest.exit_code }),
      wallTimeMs: Math.max(0, (latest.running === 1 ? Date.now() : lastAt) - (Number.isFinite(startedAt) ? startedAt : lastAt)),
    };
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  count(): number {
    return (this.sqlite.prepare("select count(*) as count from telemetry_tool_events").get() as { count: number }).count;
  }

  close(): void {
    this.subscribers.clear();
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      create table if not exists telemetry_tool_events (
        id text primary key,
        started_at text not null,
        timestamp text not null,
        tool text not null,
        project_root text,
        path text,
        working_directory text,
        command_preview text,
        command_length integer,
        success integer not null default 1,
        duration_ms integer not null default 0,
        error text,
        session_id integer,
        running integer,
        exit_code integer,
        output_preview text,
        favorite integer not null default 0
      );
      create index if not exists telemetry_tool_events_timestamp_idx
        on telemetry_tool_events(timestamp desc);
      create index if not exists telemetry_tool_events_project_timestamp_idx
        on telemetry_tool_events(project_root, timestamp desc);
      create index if not exists telemetry_tool_events_process_idx
        on telemetry_tool_events(project_root, session_id, timestamp desc);
      create table if not exists console_settings (
        key text primary key,
        value text not null,
        updated_at text not null
      );
    `);
  }

  private getEvent(id: string): ConsoleToolEvent | undefined {
    const row = this.sqlite.prepare(`
      select ${EVENT_COLUMNS} from telemetry_tool_events where id = ?
    `).get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  private loadRetentionDays(): number {
    const row = this.sqlite.prepare("select value from console_settings where key = ?")
      .get(RETENTION_SETTING_KEY) as { value?: string } | undefined;
    const parsed = Number(row?.value);
    if (Number.isInteger(parsed) && parsed >= MIN_CONSOLE_RETENTION_DAYS && parsed <= MAX_CONSOLE_RETENTION_DAYS) {
      return parsed;
    }
    this.sqlite.prepare(`
      insert into console_settings (key, value, updated_at) values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
    `).run(RETENTION_SETTING_KEY, String(DEFAULT_CONSOLE_RETENTION_DAYS), new Date().toISOString());
    return DEFAULT_CONSOLE_RETENTION_DAYS;
  }

  private pruneExpired(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = now;
    const threshold = new Date(now - this.retentionDays * 86_400_000).toISOString();
    this.sqlite.prepare("delete from telemetry_tool_events where timestamp < ?").run(threshold);
  }

  private databasePath(): string {
    return join(this.stateDir, "console.sqlite");
  }

  private databaseBytes(): number {
    const path = this.databasePath();
    return [path, `${path}-wal`, `${path}-shm`].reduce((total, candidate) => {
      if (!existsSync(candidate)) return total;
      try { return total + statSync(candidate).size; } catch { return total; }
    }, 0);
  }
}

const EVENT_COLUMNS = `
  id, started_at, timestamp, tool, project_root, path, working_directory,
  command_preview, command_length, success, duration_ms, error,
  session_id, running, exit_code, output_preview, favorite
`;

function rowToEvent(row: EventRow): ConsoleToolEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: "tool_call",
    tool: row.tool,
    workspaceId: row.project_root ?? undefined,
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
    favorite: row.favorite !== 0,
  };
}

function fallbackEvent(input: ToolTelemetryInput, timestamp: string): ConsoleToolEvent {
  return {
    id: input.invocationId || randomUUID(),
    timestamp,
    type: "tool_call",
    tool: input.tool,
    workspaceId: input.projectRoot,
    path: input.path,
    workingDirectory: input.workingDirectory,
    commandPreview: input.commandPreview,
    commandLength: input.commandLength,
    success: input.success !== false,
    durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
    error: input.error,
    sessionId: input.sessionId,
    running: input.phase === "started" ? true : input.running,
    exitCode: input.exitCode,
    outputPreview: input.outputPreview,
    favorite: false,
  };
}

function validTimestamp(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function bound(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp, id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { timestamp: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.timestamp !== "string" || typeof parsed.id !== "string") return undefined;
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch {
    return undefined;
  }
}

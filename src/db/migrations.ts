import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-worker-pid",
    up: migrateLocalAgentWorkerPid,
  },
  {
    version: 6,
    name: "console-events",
    up: migrateConsoleEvents,
  },
  {
    version: 7,
    name: "console-event-favorites",
    up: migrateConsoleEventFavorites,
  },
  {
    version: 8,
    name: "console-event-ui-metadata",
    up: migrateConsoleEventUiMetadata,
  },
  {
    version: 9,
    name: "workspace-memory",
    up: migrateWorkspaceMemory,
  },
  {
    version: 10,
    name: "workspace-todos",
    up: migrateWorkspaceTodos,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists webmcp_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from webmcp_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into webmcp_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      worker_pid integer,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "worker_pid", "integer");
}

function migrateLocalAgentWorkerPid(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "worker_pid", "integer");
}

function migrateConsoleEvents(sqlite: Database.Database): void {
  sqlite.exec(`
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
      output_preview text
    );

    create index if not exists console_tool_events_timestamp_idx
      on console_tool_events(timestamp);

    create index if not exists console_tool_events_workspace_timestamp_idx
      on console_tool_events(workspace_id, timestamp);

    create table if not exists console_settings (
      key text primary key,
      value text not null,
      updated_at text not null
    );
  `);
}

function migrateConsoleEventFavorites(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "console_tool_events", "favorite", "integer not null default 0");
  sqlite.exec(`
    create index if not exists console_tool_events_favorite_timestamp_idx
      on console_tool_events(favorite, timestamp desc);
  `);
}

function migrateConsoleEventUiMetadata(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "console_tool_events", "console_ui_json", "text");
}

function migrateWorkspaceMemory(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_resume_state (
      workspace_key text primary key,
      root text not null,
      mode text not null,
      state_json text not null,
      facts_json text not null,
      source_conversation_id text,
      checkpoint_id text not null,
      updated_at text not null
    );

    create index if not exists workspace_resume_state_updated_idx
      on workspace_resume_state(updated_at desc);

    create table if not exists workspace_checkpoints (
      id text primary key,
      workspace_key text not null,
      root text not null,
      mode text not null,
      state_json text not null,
      facts_json text not null,
      source_conversation_id text,
      created_at text not null
    );

    create index if not exists workspace_checkpoints_workspace_created_idx
      on workspace_checkpoints(workspace_key, created_at desc);
  `);
}

function migrateWorkspaceTodos(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_todos (
      workspace_key text primary key,
      root text not null,
      mode text not null,
      todos_json text not null,
      updated_at text not null
    );

    create index if not exists workspace_todos_updated_idx
      on workspace_todos(updated_at desc);
  `);
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "console_tool_events",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}

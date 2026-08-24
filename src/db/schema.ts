import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const consoleToolEvents = sqliteTable(
  "console_tool_events",
  {
    id: text("id").primaryKey(),
    timestamp: text("timestamp").notNull(),
    tool: text("tool").notNull(),
    workspaceId: text("workspace_id"),
    path: text("path"),
    workingDirectory: text("working_directory"),
    commandPreview: text("command_preview"),
    commandLength: integer("command_length"),
    success: integer("success", { mode: "boolean" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    error: text("error"),
    sessionId: integer("session_id"),
    running: integer("running", { mode: "boolean" }),
    exitCode: integer("exit_code"),
    outputPreview: text("output_preview"),
    consoleUiJson: text("console_ui_json"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("console_tool_events_timestamp_idx").on(table.timestamp),
    index("console_tool_events_workspace_timestamp_idx").on(table.workspaceId, table.timestamp),
  ],
);

export const consoleSettings = sqliteTable(
  "console_settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const workspaceResumeStates = sqliteTable(
  "workspace_resume_state",
  {
    workspaceKey: text("workspace_key").primaryKey(),
    root: text("root").notNull(),
    mode: text("mode").notNull(),
    stateJson: text("state_json").notNull(),
    factsJson: text("facts_json").notNull(),
    sourceConversationId: text("source_conversation_id"),
    checkpointId: text("checkpoint_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("workspace_resume_state_updated_idx").on(table.updatedAt)],
);

export const workspaceTodos = sqliteTable(
  "workspace_todos",
  {
    workspaceKey: text("workspace_key").primaryKey(),
    root: text("root").notNull(),
    mode: text("mode").notNull(),
    todosJson: text("todos_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("workspace_todos_updated_idx").on(table.updatedAt)],
);

export const workspaceCheckpoints = sqliteTable(
  "workspace_checkpoints",
  {
    id: text("id").primaryKey(),
    workspaceKey: text("workspace_key").notNull(),
    root: text("root").notNull(),
    mode: text("mode").notNull(),
    stateJson: text("state_json").notNull(),
    factsJson: text("facts_json").notNull(),
    sourceConversationId: text("source_conversation_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("workspace_checkpoints_workspace_created_idx").on(table.workspaceKey, table.createdAt),
  ],
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    workerPid: integer("worker_pid"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type ConsoleToolEventRow = typeof consoleToolEvents.$inferSelect;
export type NewConsoleToolEventRow = typeof consoleToolEvents.$inferInsert;
export type ConsoleSettingRow = typeof consoleSettings.$inferSelect;
export type NewConsoleSettingRow = typeof consoleSettings.$inferInsert;
export type WorkspaceResumeStateRow = typeof workspaceResumeStates.$inferSelect;
export type NewWorkspaceResumeStateRow = typeof workspaceResumeStates.$inferInsert;
export type WorkspaceTodoRow = typeof workspaceTodos.$inferSelect;
export type NewWorkspaceTodoRow = typeof workspaceTodos.$inferInsert;
export type WorkspaceCheckpointRow = typeof workspaceCheckpoints.$inferSelect;
export type NewWorkspaceCheckpointRow = typeof workspaceCheckpoints.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;

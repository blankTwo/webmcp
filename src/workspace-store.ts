import { and, desc, eq, like } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceCheckpoints,
  workspaceConversationBindings,
  workspaceResumeStates,
  workspaceSessions,
  workspaceTodos,
  type WorkspaceCheckpointRow,
  type WorkspaceConversationBindingRow,
  type WorkspaceResumeStateRow,
  type WorkspaceSessionRow,
  type WorkspaceTodoRow,
} from "./db/schema.js";
import type {
  WorkspaceCheckpointRecord,
  WorkspaceMemoryFacts,
  WorkspaceResumeRecord,
  WorkspaceResumeState,
} from "./workspace-memory.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export type WorkspaceTodoStatus = "pending" | "in_progress" | "completed";

export interface WorkspaceTodoItem {
  id: string;
  content: string;
  status: WorkspaceTodoStatus;
}

export interface WorkspaceTodoRecord {
  workspaceKey: string;
  root: string;
  mode: WorkspaceMode;
  todos: WorkspaceTodoItem[];
  updatedAt: string;
}

export interface SaveWorkspaceTodosInput {
  workspaceKey: string;
  root: string;
  mode: WorkspaceMode;
  todos: WorkspaceTodoItem[];
}

export interface SaveWorkspaceCheckpointInput {
  id: string;
  workspaceKey: string;
  root: string;
  mode: WorkspaceMode;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
  sourceConversationId?: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  listSessions(limit?: number): WorkspaceSession[];
  touchSession(id: string): void;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  getResumeState(workspaceKey: string): WorkspaceResumeRecord | undefined;
  deleteResumeState(workspaceKey: string): boolean;
  getTodos(workspaceKey: string): WorkspaceTodoRecord | undefined;
  saveTodos(input: SaveWorkspaceTodosInput): WorkspaceTodoRecord;
  saveCheckpoint(input: SaveWorkspaceCheckpointInput): WorkspaceCheckpointRecord;
  searchCheckpoints(workspaceKey: string, query: string, limit?: number): WorkspaceCheckpointRecord[];
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listSessions(limit = 100): WorkspaceSession[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return this.database.db
      .select()
      .from(workspaceSessions)
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .limit(boundedLimit)
      .all()
      .map(rowToWorkspaceSession);
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  getResumeState(workspaceKey: string): WorkspaceResumeRecord | undefined {
    const row = this.database.db
      .select()
      .from(workspaceResumeStates)
      .where(eq(workspaceResumeStates.workspaceKey, workspaceKey))
      .get();
    return row ? rowToWorkspaceResumeRecord(row) : undefined;
  }

  deleteResumeState(workspaceKey: string): boolean {
    const result = this.database.db
      .delete(workspaceResumeStates)
      .where(eq(workspaceResumeStates.workspaceKey, workspaceKey))
      .run();
    return result.changes > 0;
  }

  getTodos(workspaceKey: string): WorkspaceTodoRecord | undefined {
    const row = this.database.db
      .select()
      .from(workspaceTodos)
      .where(eq(workspaceTodos.workspaceKey, workspaceKey))
      .get();
    return row ? rowToWorkspaceTodoRecord(row) : undefined;
  }

  saveTodos(input: SaveWorkspaceTodosInput): WorkspaceTodoRecord {
    const updatedAt = new Date().toISOString();
    const todosJson = JSON.stringify(input.todos);
    this.database.db
      .insert(workspaceTodos)
      .values({
        workspaceKey: input.workspaceKey,
        root: input.root,
        mode: input.mode,
        todosJson,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: workspaceTodos.workspaceKey,
        set: {
          root: input.root,
          mode: input.mode,
          todosJson,
          updatedAt,
        },
      })
      .run();

    return {
      workspaceKey: input.workspaceKey,
      root: input.root,
      mode: input.mode,
      todos: input.todos,
      updatedAt,
    };
  }

  saveCheckpoint(input: SaveWorkspaceCheckpointInput): WorkspaceCheckpointRecord {
    const createdAt = new Date().toISOString();
    const stateJson = JSON.stringify(input.state);
    const factsJson = JSON.stringify(input.facts);
    const save = this.database.sqlite.transaction(() => {
      this.database.db
        .insert(workspaceCheckpoints)
        .values({
          id: input.id,
          workspaceKey: input.workspaceKey,
          root: input.root,
          mode: input.mode,
          stateJson,
          factsJson,
          sourceConversationId: input.sourceConversationId ?? null,
          createdAt,
        })
        .run();

      this.database.db
        .insert(workspaceResumeStates)
        .values({
          workspaceKey: input.workspaceKey,
          root: input.root,
          mode: input.mode,
          stateJson,
          factsJson,
          sourceConversationId: input.sourceConversationId ?? null,
          checkpointId: input.id,
          updatedAt: createdAt,
        })
        .onConflictDoUpdate({
          target: workspaceResumeStates.workspaceKey,
          set: {
            root: input.root,
            mode: input.mode,
            stateJson,
            factsJson,
            sourceConversationId: input.sourceConversationId ?? null,
            checkpointId: input.id,
            updatedAt: createdAt,
          },
        })
        .run();
    });
    save.immediate();

    return {
      id: input.id,
      workspaceKey: input.workspaceKey,
      root: input.root,
      mode: input.mode,
      state: input.state,
      facts: input.facts,
      sourceConversationId: input.sourceConversationId,
      createdAt,
    };
  }

  searchCheckpoints(workspaceKey: string, query: string, limit = 8): WorkspaceCheckpointRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    const normalizedQuery = query.trim();
    const rows = normalizedQuery
      ? this.database.db
          .select()
          .from(workspaceCheckpoints)
          .where(
            and(
              eq(workspaceCheckpoints.workspaceKey, workspaceKey),
              like(workspaceCheckpoints.stateJson, `%${normalizedQuery}%`),
            ),
          )
          .orderBy(desc(workspaceCheckpoints.createdAt))
          .limit(boundedLimit)
          .all()
      : this.database.db
          .select()
          .from(workspaceCheckpoints)
          .where(eq(workspaceCheckpoints.workspaceKey, workspaceKey))
          .orderBy(desc(workspaceCheckpoints.createdAt))
          .limit(boundedLimit)
          .all();

    return rows.map(rowToWorkspaceCheckpointRecord);
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceTodoRecord(row: WorkspaceTodoRow): WorkspaceTodoRecord {
  return {
    workspaceKey: row.workspaceKey,
    root: row.root,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    todos: JSON.parse(row.todosJson) as WorkspaceTodoItem[],
    updatedAt: row.updatedAt,
  };
}

function rowToWorkspaceResumeRecord(row: WorkspaceResumeStateRow): WorkspaceResumeRecord {
  return {
    workspaceKey: row.workspaceKey,
    root: row.root,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    state: JSON.parse(row.stateJson) as WorkspaceResumeState,
    facts: JSON.parse(row.factsJson) as WorkspaceMemoryFacts,
    sourceConversationId: row.sourceConversationId ?? undefined,
    checkpointId: row.checkpointId,
    updatedAt: row.updatedAt,
  };
}

function rowToWorkspaceCheckpointRecord(row: WorkspaceCheckpointRow): WorkspaceCheckpointRecord {
  return {
    id: row.id,
    workspaceKey: row.workspaceKey,
    root: row.root,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    state: JSON.parse(row.stateJson) as WorkspaceResumeState,
    facts: JSON.parse(row.factsJson) as WorkspaceMemoryFacts,
    sourceConversationId: row.sourceConversationId ?? undefined,
    createdAt: row.createdAt,
  };
}

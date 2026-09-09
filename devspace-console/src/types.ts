export type WorkspaceStatus = "running" | "idle" | "error";
export type LogKind = "command" | "edit" | "file" | "process" | "search" | "system";
export type LogStatus = "success" | "running" | "warning" | "error" | "idle";

export interface ConsoleToolUi {
  resource: string;
  card: Record<string, unknown>;
}

export interface WorkspaceItem {
  id: string;
  name: string;
  path: string;
  status: WorkspaceStatus;
  eventCount: number;
  lastActiveAt?: string;
}

export interface LogEvent {
  id: string;
  workspaceId: string;
  timestamp?: string;
  time: string;
  tool: string;
  kind: LogKind;
  status: LogStatus;
  summary: string;
  target?: string;
  duration: string;
  durationMs?: number;
  conversationId?: string;
  command?: string;
  stdout?: string[];
  stderr?: string[];
  params?: Record<string, unknown>;
  files?: string[];
  consoleUi?: ConsoleToolUi;
  favorite?: boolean;
}

export interface WorkspaceCheckpointRecord {
  id: string;
  workspaceKey: string;
  root: string;
  mode: string;
  state: {
    goal: string;
    currentTask: string;
    completed?: string[];
    decisions?: string[];
    files?: string[];
    verification?: string[];
    blockers?: string[];
    next?: string[];
  };
  facts: {
    gitHead?: string;
    gitBranch?: string;
    gitClean?: boolean;
  };
  createdAt: string;
}

export interface SkillItemInfo {
  name: string;
  description: string;
  version?: string;
  source: "bundled" | "workspace" | "global";
  baseDir: string;
  filePath: string;
  content: string;
  appliedToWorkspace: boolean;
  installedGlobally: boolean;
}

export interface AllowedRootInfo {
  path: string;
  exists: boolean;
  isDrive: boolean;
  workspacesCount: number;
}

export interface WorkspaceSessionInfo {
  id: string;
  root: string;
  status: string;
  mode: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}


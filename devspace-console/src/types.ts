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

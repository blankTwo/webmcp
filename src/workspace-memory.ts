import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONTINUATION_CHARS = 4_000;
const MAX_LIST_ITEM_CHARS = 240;
const MAX_PATH_CHARS = 320;

export type WorkspaceMemoryMode = "checkout" | "worktree";

export interface WorkspaceResumeStateInput {
  goal: string;
  currentTask: string;
  completed?: string[];
  decisions?: string[];
  files?: string[];
  verification?: string[];
  blockers?: string[];
  next?: string[];
}

export interface WorkspaceResumeState {
  goal: string;
  currentTask: string;
  completed: string[];
  decisions: string[];
  files: string[];
  verification: string[];
  blockers: string[];
  next: string[];
}

export interface WorkspaceMemoryFacts {
  capturedAt: string;
  gitBranch?: string;
  gitHead?: string;
  changedFiles: string[];
}

export interface WorkspaceResumeRecord {
  workspaceKey: string;
  root: string;
  mode: WorkspaceMemoryMode;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
  sourceConversationId?: string;
  checkpointId: string;
  updatedAt: string;
}

export interface WorkspaceCheckpointRecord {
  id: string;
  workspaceKey: string;
  root: string;
  mode: WorkspaceMemoryMode;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
  sourceConversationId?: string;
  createdAt: string;
}

export interface WorkspaceContinuation {
  checkpointId: string;
  updatedAt: string;
  stale: boolean;
  staleReason?: string;
  state: WorkspaceResumeState;
  facts: WorkspaceMemoryFacts;
  text: string;
}

export function normalizeResumeState(input: WorkspaceResumeStateInput): WorkspaceResumeState {
  return {
    goal: cleanText(input.goal, 520),
    currentTask: cleanText(input.currentTask, 520),
    completed: cleanList(input.completed, 5),
    decisions: cleanList(input.decisions, 5),
    files: cleanList(input.files, 10, MAX_PATH_CHARS),
    verification: cleanList(input.verification, 5),
    blockers: cleanList(input.blockers, 5),
    next: cleanList(input.next, 6),
  };
}

export async function captureWorkspaceFacts(root: string): Promise<WorkspaceMemoryFacts> {
  const facts: WorkspaceMemoryFacts = {
    capturedAt: new Date().toISOString(),
    changedFiles: [],
  };

  try {
    const inside = (await runGit(root, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return facts;

    const [branch, head, status] = await Promise.all([
      runGit(root, ["branch", "--show-current"]).catch(() => ""),
      runGit(root, ["rev-parse", "HEAD"]).catch(() => ""),
      runGit(root, ["status", "--short", "--untracked-files=all"]).catch(() => ""),
    ]);

    const trimmedBranch = branch.trim();
    const trimmedHead = head.trim();
    if (trimmedBranch) facts.gitBranch = trimmedBranch;
    if (trimmedHead) facts.gitHead = trimmedHead;
    facts.changedFiles = status
      .split(/\r?\n/)
      .map((line) => line.length > 3 ? line.slice(3).trim() : line.trim())
      .filter(Boolean)
      .slice(0, 30)
      .map((path) => cleanText(path, MAX_PATH_CHARS));
  } catch {
    // Non-Git workspaces are valid. Resume memory still works without Git facts.
  }

  return facts;
}

export function buildWorkspaceContinuation(
  saved: WorkspaceResumeRecord,
  currentFacts: WorkspaceMemoryFacts,
): WorkspaceContinuation {
  const savedGitHead = saved.facts.gitHead;
  const currentGitHead = currentFacts.gitHead;
  const stale = Boolean(savedGitHead && currentGitHead && savedGitHead !== currentGitHead);
  const staleReason = savedGitHead && currentGitHead && stale
    ? `Git HEAD changed from ${shortSha(savedGitHead)} to ${shortSha(currentGitHead)} after this checkpoint.`
    : undefined;
  const lines: string[] = [
    `Continuation from DevSpace checkpoint ${saved.checkpointId} (${saved.updatedAt}).`,
    "This is persisted project state from a previous conversation. Current user instructions and current filesystem/Git state take precedence.",
  ];

  if (staleReason) lines.push(`State warning: ${staleReason}`);
  appendScalar(lines, "Goal", saved.state.goal);
  appendScalar(lines, "Current task", saved.state.currentTask);
  appendList(lines, "Completed", saved.state.completed);
  appendList(lines, "Key decisions", saved.state.decisions);
  appendList(lines, "Important files", saved.state.files);
  appendList(lines, "Verification", saved.state.verification);
  appendList(lines, "Blockers", saved.state.blockers);
  appendList(lines, "Next", saved.state.next);

  const currentGit = [
    currentFacts.gitBranch ? `branch ${currentFacts.gitBranch}` : undefined,
    currentFacts.gitHead ? `HEAD ${shortSha(currentFacts.gitHead)}` : undefined,
    currentFacts.changedFiles.length > 0
      ? `${currentFacts.changedFiles.length} changed file(s)`
      : undefined,
  ].filter(Boolean).join(", ");
  if (currentGit) appendScalar(lines, "Current Git", currentGit);

  return {
    checkpointId: saved.checkpointId,
    updatedAt: saved.updatedAt,
    stale,
    staleReason,
    state: saved.state,
    facts: currentFacts,
    text: boundContinuation(lines.join("\n")),
  };
}

function cleanList(
  values: string[] | undefined,
  limit: number,
  maxChars = MAX_LIST_ITEM_CHARS,
): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value, maxChars);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function cleanText(value: string, maxChars: number): string {
  const normalized = redactSensitiveText(String(value ?? ""))
    .replace(/\0/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key|authorization|cookie)\b(\s*[:=]\s*)[^\s,;]+/gi,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
    );
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 2_500,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function appendScalar(lines: string[], label: string, value: string | undefined): void {
  if (value) lines.push(`${label}: ${value}`);
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`${label}:`);
  for (const value of values) lines.push(`- ${value}`);
}

function boundContinuation(text: string): string {
  if (text.length <= MAX_CONTINUATION_CHARS) return text;
  return `${text.slice(0, MAX_CONTINUATION_CHARS - 2).trimEnd()}…`;
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}

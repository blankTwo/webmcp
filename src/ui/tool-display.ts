import {
  isEditTool,
  isPatchTool,
  isReviewTool,
  isShellTool,
  isWriteTool,
  summaryNumber,
  type ToolResultCard,
} from "./card-types.js";
import { toolIcons, type ToolIcon } from "./icons.js";
import {
  getFileChangePathDisplay,
  getPatchDisplayParts,
} from "./patch-display.js";

export interface ToolDisplay {
  icon: ToolIcon;
  title: string;
  label?: string;
  tone: string;
  state?: "running" | "success" | "error" | "cancelled";
}

export type ToolHeaderSummary =
  | { kind: "diff"; additions: number; removals: number }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export function getToolDisplay(card: ToolResultCard): ToolDisplay {
  if (card.status === "running") return runningToolDisplay(card);
  if (card.status === "cancelled") return cancelledToolDisplay(card);
  if (card.status === "error") return failedToolDisplay(card);

  switch (card.tool) {
    case "open_workspace":
      return {
        icon: card.mode === "worktree" ? toolIcons.gitBranch : toolIcons.folderOpen,
        title: workspaceTitle(card),
        label: card.root ?? card.path,
        tone: "workspace",
      };
    case "read":
      return {
        icon: toolIcons.readFile,
        title: "Read file",
        label: card.path,
        tone: "read",
      };
    case "write":
      return {
        icon: toolIcons.writeFile,
        title: "Wrote file",
        label: card.path,
        tone: "write",
      };
    case "edit":
      return {
        icon: toolIcons.editFile,
        title: "Edited file",
        label: card.path,
        tone: "edit",
      };
    case "apply_patch": {
      const display = getPatchDisplayParts(card);
      return {
        icon: patchIcon(display.iconKind),
        title: display.title,
        label: singleFilePath(card),
        tone: display.tone,
      };
    }
    case "grep":
      return {
        icon: toolIcons.search,
        title: "Searched files",
        label: searchLabel(card),
        tone: "search",
      };
    case "glob": {
      return {
        icon: toolIcons.files,
        title: "Found files",
        label: searchLabel(card),
        tone: "search",
      };
    }
    case "ls":
      return {
        icon: toolIcons.folderTree,
        title: "Listed directory",
        label: card.path,
        tone: "directory",
      };
    case "bash":
    case "exec_command":
      return {
        icon: toolIcons.terminalSquare,
        title: processTitle(card, "command"),
        label: processLabel(card),
        tone: "shell",
        state: processState(card),
      };
    case "write_stdin":
      return {
        icon: toolIcons.terminal,
        title: processTitle(card, "process"),
        label: processLabel(card),
        tone: "shell",
        state: processState(card),
      };
    case "show_changes": {
      const display = getPatchDisplayParts(card, { emptyTitle: "Changes ready" });
      const fileCount = card.files?.length ?? 0;
      return {
        icon: toolIcons.diff,
        title: fileCount > 0 || card.payload?.patch
          ? display.title
          : "No changes",
        label: singleFilePath(card),
        tone: "review",
      };
    }
  }
}

export function getToolInputCard(
  tool: ToolResultCard["tool"],
  args: Record<string, unknown> = {},
  status: "running" | "cancelled" = "running",
): ToolResultCard {
  const summary: Record<string, unknown> = {};
  const card: ToolResultCard = { tool, status, summary };

  switch (tool) {
    case "open_workspace": {
      const path = stringArgument(args, "path");
      card.path = path;
      card.root = path;
      const mode = stringArgument(args, "mode");
      if (mode === "checkout" || mode === "worktree") card.mode = mode;
      break;
    }
    case "read":
    case "write":
    case "edit":
    case "ls":
      card.path = stringArgument(args, "path");
      break;
    case "grep":
    case "glob":
      summary.pattern = stringArgument(args, "pattern");
      summary.scope = stringArgument(args, "path") ?? ".";
      card.path = stringArgument(args, "path");
      break;
    case "bash":
      summary.command = stringArgument(args, "command");
      summary.workingDirectory = stringArgument(args, "workingDirectory") ?? ".";
      summary.running = status === "running";
      break;
    case "exec_command":
      summary.command = stringArgument(args, "cmd");
      summary.workingDirectory = stringArgument(args, "workingDirectory") ?? ".";
      summary.running = status === "running";
      break;
    case "write_stdin":
      summary.sessionId = scalarArgument(args, "sessionId");
      summary.running = status === "running";
      break;
    case "apply_patch":
    case "show_changes":
      break;
  }

  return card;
}

export function getToolInputDisplay(
  tool: ToolResultCard["tool"],
  args: Record<string, unknown> = {},
  status: "running" | "cancelled" = "running",
): ToolDisplay {
  return getToolDisplay(getToolInputCard(tool, args, status));
}

export function getToolHeaderSummary(card: ToolResultCard): ToolHeaderSummary {
  if (card.status === "running") return { kind: "text", text: "Running" };
  if (card.status === "cancelled") return { kind: "text", text: "Cancelled" };
  if (card.status === "error") return { kind: "text", text: "Failed" };

  const summary = card.summary ?? {};

  if (isReviewTool(card.tool) || isPatchTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool)) {
    return {
      kind: "diff",
      additions: summaryNumber(summary, "additions") ?? 0,
      removals: summaryNumber(summary, "removals") ?? 0,
    };
  }

  if (card.tool === "open_workspace") {
    const parts = [
      countLabel(summaryNumber(summary, "agentsFiles"), "instruction"),
      countLabel(summaryNumber(summary, "skills"), "skill"),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? { kind: "text", text: parts.join(" · ") } : { kind: "empty" };
  }

  if (isShellTool(card.tool)) {
    const parts = [
      countLabel(summaryNumber(summary, "lines"), "line"),
      durationLabel(summaryNumber(summary, "wallTimeMs")),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? { kind: "text", text: parts.join(" · ") } : { kind: "empty" };
  }

  if (card.tool === "grep" || card.tool === "read" || card.tool === "ls") {
    const lines = countLabel(summaryNumber(summary, "lines"), "line");
    return lines ? { kind: "text", text: lines } : { kind: "empty" };
  }

  return { kind: "empty" };
}

function runningToolDisplay(card: ToolResultCard): ToolDisplay {
  const base = runningToolBase(card);
  return { ...base, state: "running" };
}

function cancelledToolDisplay(card: ToolResultCard): ToolDisplay {
  const base = runningToolBase(card);
  return {
    ...base,
    title: `${base.title} cancelled`,
    state: "cancelled",
  };
}

function failedToolDisplay(card: ToolResultCard): ToolDisplay {
  const base = runningToolBase(card);
  return {
    ...base,
    title: `${base.title} failed`,
    state: "error",
  };
}

function runningToolBase(card: ToolResultCard): Omit<ToolDisplay, "state"> {
  switch (card.tool) {
    case "open_workspace":
      return {
        icon: card.mode === "worktree" ? toolIcons.gitBranch : toolIcons.folderOpen,
        title: "Open workspace",
        label: card.root ?? card.path,
        tone: "workspace",
      };
    case "read":
      return { icon: toolIcons.readFile, title: "Read file", label: card.path, tone: "read" };
    case "write":
      return { icon: toolIcons.writeFile, title: "Write file", label: card.path, tone: "write" };
    case "edit":
      return { icon: toolIcons.editFile, title: "Edit file", label: card.path, tone: "edit" };
    case "apply_patch":
      return { icon: toolIcons.editFile, title: "Apply patch", tone: "edit" };
    case "grep":
      return { icon: toolIcons.search, title: "Grep", label: searchLabel(card), tone: "search" };
    case "glob":
      return { icon: toolIcons.files, title: "Glob", label: searchLabel(card), tone: "search" };
    case "ls":
      return { icon: toolIcons.folderTree, title: "Ls", label: card.path, tone: "directory" };
    case "bash":
      return { icon: toolIcons.terminalSquare, title: "Bash", label: processLabel(card), tone: "shell" };
    case "exec_command":
      return { icon: toolIcons.terminalSquare, title: "Execute command", label: processLabel(card), tone: "shell" };
    case "write_stdin":
      return { icon: toolIcons.terminal, title: "Process", label: processLabel(card), tone: "shell" };
    case "show_changes":
      return { icon: toolIcons.diff, title: "Show changes", tone: "review" };
  }
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scalarArgument(args: Record<string, unknown>, key: string): string | number | undefined {
  const value = args[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function patchIcon(kind: ReturnType<typeof getPatchDisplayParts>["iconKind"]): ToolIcon {
  if (kind === "added") return toolIcons.writeFile;
  if (kind === "deleted") return toolIcons.deleteFile;
  if (kind === "renamed" || kind === "renamed-edited") return toolIcons.files;
  return toolIcons.editFile;
}

function workspaceTitle(card: ToolResultCard): string {
  return `${card.workspaceReused ? "Reused" : "Opened"} workspace`;
}

function singleFilePath(card: ToolResultCard): string | undefined {
  if (card.files?.length === 1) {
    return getFileChangePathDisplay(card.files[0])?.title ?? card.path;
  }
  return undefined;
}

function searchLabel(card: ToolResultCard): string | undefined {
  const pattern = card.summary?.pattern;
  const scope = card.summary?.scope;
  if (typeof pattern !== "string") return card.path;
  return typeof scope === "string" && scope !== "." ? `${pattern} in ${scope}` : pattern;
}

function processTitle(card: ToolResultCard, subject: "command" | "process"): string {
  if (card.summary?.running === true) {
    return subject === "command" ? "Command running" : "Process running";
  }

  const exitCode = summaryNumber(card.summary, "exitCode");
  if (exitCode !== undefined && exitCode !== 0) {
    return subject === "command" ? "Command failed" : "Process failed";
  }

  return subject === "command" ? "Ran command" : "Process finished";
}

function processState(card: ToolResultCard): ToolDisplay["state"] {
  if (card.summary?.running === true) return "running";
  const exitCode = summaryNumber(card.summary, "exitCode");
  if (exitCode !== undefined && exitCode !== 0) return "error";
  return exitCode === 0 ? "success" : undefined;
}

function processLabel(card: ToolResultCard): string | undefined {
  const command = card.summary?.command;
  if (typeof command === "string") return command;
  const sessionId = card.summary?.sessionId;
  if (typeof sessionId === "number" || typeof sessionId === "string") {
    return `Session ${String(sessionId)}`;
  }
  return card.path;
}

function countLabel(count: number | undefined, noun: string): string | undefined {
  if (count === undefined) return undefined;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function durationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

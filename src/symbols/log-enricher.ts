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

export interface EnrichedMetadata {
  purpose: string;
  actionKind: ActionKind;
  diffStats?: { additions: number; removals: number };
  symbolContext?: SymbolContext;
  diagnosticsState?: "valid" | "warning";
}

/**
 * Deduce semantic action kind from tool name and arguments
 */
export function deduceActionKind(tool: string, args: Record<string, unknown>): ActionKind {
  if (tool === "replace_symbol_body" || tool === "insert_symbol") return "symbol";
  if (tool === "get_symbols_overview" || tool === "find_symbol" || tool === "code_explore") return "symbol";
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "edit";
  if (tool === "read" || tool === "read_image" || tool === "move_file") return "file";
  if (tool === "grep" || tool === "glob" || tool === "ls") return "search";
  if (tool === "checkpoint" || tool === "history_search") return "checkpoint";
  if (tool === "todo_write" || tool === "todo_update") return "todo";
  if (tool === "write_stdin" || tool === "list_processes" || tool === "get_process" || tool === "kill_process") return "process";
  if (tool === "bash" || tool === "exec_command") {
    const cmd = String(args.command || args.cmd || "").toLowerCase();
    if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("vitest") || cmd.includes("pytest")) {
      return "test";
    }
    return "command";
  }
  return "command";
}

/**
 * Infer a meaningful user-facing purpose if the model omitted it
 */
export function inferPurpose(tool: string, args: Record<string, unknown>): string {
  if (args.purpose && typeof args.purpose === "string" && args.purpose.trim()) {
    return args.purpose.trim();
  }

  const path = String(args.path || "");

  switch (tool) {
    case "replace_symbol_body":
      return `重构 ${args.symbolName || "符号"} 的实现体`;
    case "insert_symbol":
      return `在 ${args.targetSymbol || "目标位置"} 插入新符号`;
    case "get_symbols_overview":
      return `解析并提取 ${path || "文件"} 的代码大纲`;
    case "find_symbol":
      return `定位符号 ${args.name || ""}${path ? ` (${path})` : ""}`;
    case "code_explore":
      return `探索代码库架构与关键符号`;
    case "edit":
      return `编辑修改 ${path || "目标文件"}`;
    case "write":
      return `写入文件 ${path || ""}`;
    case "read":
      return `读取文件 ${path || (Array.isArray(args.paths) ? `${args.paths.length} 个文件` : "")}`;
    case "read_image":
      return `检查图像资源 ${path || ""}`;
    case "grep":
      return `在代码中检索模式 '${args.pattern || ""}'`;
    case "glob":
      return `按模式 '${args.pattern || ""}' 查找文件`;
    case "ls":
      return `查看目录 ${path || "根目录"} 结构`;
    case "open_workspace":
      return `打开并绑定工作区 ${path || ""}`;
    case "checkpoint":
      return `保存工作区里程碑快照: ${args.currentTask || args.goal || ""}`;
    case "history_search":
      return `搜索历史决策快照 '${args.query || ""}'`;
    case "todo_write":
      return `规划工作区任务清单 (${Array.isArray(args.todos) ? args.todos.length : 0} 项)`;
    case "todo_update":
      return `更新任务状态为 ${args.status || ""}`;
    case "exec_command":
    case "bash": {
      const cmd = String(args.command || args.cmd || "").trim();
      const firstWord = cmd.split(/\s+/)[0];
      if (firstWord === "npm" || firstWord === "pnpm" || firstWord === "yarn") {
        return `执行包管理命令: ${cmd.slice(0, 50)}`;
      }
      if (firstWord === "git") {
        return `执行 Git 操作: ${cmd.slice(0, 50)}`;
      }
      return `执行终端命令: ${cmd.slice(0, 50)}`;
    }
    case "write_stdin":
      return args.chars ? `向终端进程写入输入` : `轮询进程输出状态`;
    default:
      return `调用工具 ${tool}`;
  }
}

/**
 * Full enrichment helper combining purpose, actionKind, and status
 */
export function enrichToolEvent(
  tool: string,
  args: Record<string, unknown>,
  extra?: {
    diffStats?: { additions: number; removals: number };
    symbolContext?: SymbolContext;
    diagnosticsState?: "valid" | "warning";
  },
): EnrichedMetadata {
  return {
    purpose: inferPurpose(tool, args),
    actionKind: deduceActionKind(tool, args),
    diffStats: extra?.diffStats,
    symbolContext: extra?.symbolContext,
    diagnosticsState: extra?.diagnosticsState,
  };
}

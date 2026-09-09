# ChatGPT Coding Workflow

WebMCP brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`, but ChatGPT conversations are also bound to
the opened workspace server-side. On hosts that provide conversation metadata,
subsequent WebMCP tools should normally omit `workspaceId`; WebMCP resolves
the current workspace from that conversation binding. Passing the explicit ID
remains supported for compatibility and disambiguation.

Conversation binding is an OpenAI-host adapter detail, not a standard MCP
conversation field. Hosts without supported conversation metadata continue to
use the explicit `workspaceId` workflow. Reopening the same checkout in one
conversation reuses its persisted workspace without repeating bootstrap context.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. WebMCP opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.webmcp/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and makes it the current
workspace binding for that conversation. The returned `workspaceId` remains
available for explicit-host compatibility. Call `open_workspace` in worktree
mode again only when another isolated worktree is actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
WebMCP reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, WebMCP loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

WebMCP discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.webmcp/skills`

It also keeps compatibility with:

- `WebMCP_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `WebMCP_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `WebMCP_SKILL_PATHS` when needed.

`open_workspace` no longer injects the full skill catalog into every coding
conversation. When skill guidance may be relevant, call `skills_list`, then load
only the matching skill with `skill_read`. After a skill is activated, files
inside that skill directory may be read as needed.

Set `WebMCP_SKILLS=0` to hide skills from workspace output.

## Tool Names

By default WebMCP runs in `WebMCP_TOOL_MODE=full` and exposes:

- `open_workspace`
- `read` (one or several files)
- `move_file`
- `write`
- `edit`
- `apply_patch` (multi-file)
- `code_explore`
- `skills_list` / `skill_read` when skills are enabled
- `grep`
- `glob`
- `ls`
- `bash`
- `exec_command`
- `write_stdin`
- `list_processes`
- `get_process`
- `kill_process`

`bash` remains useful for one-shot commands. Use `exec_command` when a command
may outlive the initial yield window or needs a PTY, `write_stdin` to poll or
interact with that process, `list_processes` / `get_process` to inspect managed
session state without consuming output, and `kill_process` to terminate it.
Recently completed process sessions remain queryable for a short retention
window (five minutes by default).

Use `WebMCP_TOOL_MODE=minimal` when a deliberately smaller surface is needed;
it hides dedicated search and managed-process tools.

The experimental Codex-style surface is enabled with
`WebMCP_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read` (one or several files)
- `move_file`
- `apply_patch`
- `code_explore`
- `skills_list` / `skill_read` when skills are enabled
- `exec_command`
- `write_stdin`
- `list_processes`
- `get_process`
- `kill_process`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C; use `list_processes` / `get_process` for non-consuming
status inspection and `kill_process` for explicit termination. On POSIX,
termination requests SIGTERM before falling back to SIGKILL; Windows terminates
the whole process tree atomically to avoid orphaned shell children. Set `tty:
true` only for commands that need a terminal.

## Console UI metadata

WebMCP no longer attaches MCP App widgets to tool definitions. ChatGPT and
other MCP hosts receive normal tool content and structured results only; no
`ui.resourceUri` metadata or per-tool iframe resources are exposed.

Tool presentation metadata is emitted separately through the Console event
pipeline. Each stored/SSE tool event may include a `consoleUi` envelope with a
resource identifier such as `tool/read` or `tool/edit` plus the card metadata
needed by WebMCP Console (summary, payload, files, diff/patch information,
and similar presentation data).

This keeps the coding host lightweight while allowing the Tauri Console to
render rich tool details from SQLite history and the live SSE stream. The
legacy `WebMCP_WIDGETS=full` and `WebMCP_WIDGETS=changes` values are accepted
for configuration compatibility, but normalize to `off` and do not re-enable
MCP App widgets.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- approved Git metadata writes: `git init`, `git add`, `git commit`
- package scripts
- environment checks

`git init`, `git add`, and `git commit` are the explicit write exceptions when
the user asks to initialize, stage, or commit. `git push` still requires an
explicit user request. Working-tree file writes should go through the edit/write
tools rather than shell redirection, heredocs, `tee`, `sed -i`, or generated
scripts.

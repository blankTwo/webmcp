# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

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

Checkout mode is the default. DevSpace opens the actual directory:

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
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

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

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog plus native
`run_agent`, `get_agent`, `list_agents`, and `cancel_agent` tools. The
`subagent-delegation` skill teaches the model when delegation is appropriate;
normal MCP delegation should use those native tools rather than shelling out to
the `devspace agents` CLI.

## Tool Names

By default DevSpace runs in `DEVSPACE_TOOL_MODE=full` and exposes:

- `open_workspace`
- `read`
- `move_file`
- `write`
- `edit`
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

Use `DEVSPACE_TOOL_MODE=minimal` when a deliberately smaller surface is needed;
it hides dedicated search and managed-process tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `move_file`
- `apply_patch`
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

DevSpace no longer attaches MCP App widgets to tool definitions. ChatGPT and
other MCP hosts receive normal tool content and structured results only; no
`ui.resourceUri` metadata or per-tool iframe resources are exposed.

Tool presentation metadata is emitted separately through the Console event
pipeline. Each stored/SSE tool event may include a `consoleUi` envelope with a
resource identifier such as `tool/read` or `tool/edit` plus the card metadata
needed by DevSpace Console (summary, payload, files, diff/patch information,
and similar presentation data).

This keeps the coding host lightweight while allowing the Tauri Console to
render rich tool details from SQLite history and the live SSE stream. The
legacy `DEVSPACE_WIDGETS=full` and `DEVSPACE_WIDGETS=changes` values are accepted
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

# Configuration Reference

WebMCP can be configured through `webmcp init`, persisted config files, or
environment variables.

The default files are:

```text
~/.webmcp/config.json
~/.webmcp/auth.json
```

Use another config directory with:

```bash
WebMCP_CONFIG_DIR=/path/to/config npx webmcp serve
```

## Commands

```bash
npx webmcp init
npx webmcp serve
npx webmcp doctor
npx webmcp config get
npx webmcp config set publicBaseUrl https://webmcp.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `WebMCP_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `WebMCP_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `WebMCP_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `WebMCP_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `WebMCP_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.webmcp/worktrees`. |
| `WebMCP_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/webmcp`. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
WebMCP_ARTIFACTS=1 npx webmcp serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WebMCP_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `WebMCP_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.webmcp/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
WebMCP safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

WebMCP uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `WebMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `WebMCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `WebMCP_OAUTH_SCOPES` | `webmcp` |
| `WebMCP_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`WebMCP_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Exposes `open_workspace`, multi-file `read`, `move_file`, `write`, `edit`, multi-file `apply_patch`, `code_explore`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for other inspection. `skills_list` / `skill_read` are added when skills are enabled. |
| `full` | Default. Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls`, and managed-process tools `exec_command`, `write_stdin`, `list_processes`, `get_process`, and `kill_process`. |
| `codex` | Experimental short surface. Exposes `open_workspace`, multi-file `read`, `move_file`, `apply_patch`, `code_explore`, `exec_command`, `write_stdin`, `list_processes`, `get_process`, and `kill_process`; `skills_list` / `skill_read` are added when skills are enabled. Existing `write`, `edit`, `bash`, `grep`, `glob`, and `ls` tools are hidden. |

`WebMCP_MINIMAL_TOOLS` remains a backward-compatible alias when
`WebMCP_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `WebMCP_TOOL_MODE` and always uses
its fixed short tool names regardless of `WebMCP_TOOL_NAMING`.

Managed commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions. `list_processes` and `get_process` inspect managed session metadata
without consuming output. Completed sessions remain queryable for the normal
process-session retention window. `kill_process` uses graceful-then-forceful
termination on POSIX and whole-tree forced termination on Windows to avoid
orphaned shell children.

## Console UI metadata

WebMCP does not expose ChatGPT Apps iframe resources on MCP tools. Tool
presentation metadata is written to the Console event stream instead, where the
Tauri client consumes it from SQLite history and SSE.

`WebMCP_WIDGETS` is retained only for backwards-compatible configuration
parsing. `off`, `full`, and `changes` are accepted, but all normalize to `off`;
none of them attach `ui.resourceUri` metadata or register per-tool iframe
resources.

## Skills

| Variable | Purpose |
| --- | --- |
| `WebMCP_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `WebMCP_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `WebMCP_SKILL_PATHS` | Optional comma-separated additional skill directories. |

WebMCP discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.webmcp/skills`

It also keeps compatibility with:

- `WebMCP_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `WebMCP_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `WebMCP_SKILL_PATHS` when needed.

Example:

```bash
WebMCP_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx webmcp serve
```

## Logging

| Variable | Default |
| --- | --- |
| `WebMCP_LOG_LEVEL` | `info` |
| `WebMCP_LOG_FORMAT` | `json` |
| `WebMCP_LOG_REQUESTS` | `1` |
| `WebMCP_LOG_ASSETS` | `0` |
| `WebMCP_LOG_TOOL_CALLS` | `1` |
| `WebMCP_LOG_SHELL_COMMANDS` | `0` |
| `WebMCP_TRUST_PROXY` | `0` |

Set `WebMCP_LOG_FORMAT=pretty` for local debugging.

Set `WebMCP_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
WebMCP_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
WebMCP_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
WebMCP_PUBLIC_BASE_URL="https://webmcp.example.com" \
WebMCP_WORKTREE_ROOT="$HOME/.webmcp/worktrees" \
WebMCP_ARTIFACTS="1" \
WebMCP_TOOL_MODE="full" \
WebMCP_WIDGETS="full" \
npx webmcp serve
```

The environment assignments must be part of the same command invocation, or
exported first.

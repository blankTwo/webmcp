# Subagent profiles and WebMCP agent CLI plan

## Decision

Subagent profiles describe roles over built-in coding-agent providers.
WebMCP owns provider invocation and lifecycle. Custom CLI-backed agents,
provider action objects, and model-visible backend details are out of scope for
v1.

The model-facing workflow stays small:

```bash
webmcp agents ls
webmcp agents run <profile-or-id> "<prompt>"
webmcp agents show <id>
```

Profile discovery happens through the compact catalog returned by
`open_workspace`. `webmcp agents ls` lists existing subagent sessions for the
current workspace; it does not list profile definitions.

## Profile schema

Profiles are discovered from:

- `~/.webmcp/agents/*.md`
- project `.webmcp/agents/*.md`

Supported frontmatter fields:

```yaml
schema: webmcp-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
disabled: false
```

Supported providers:

- `codex`
- `claude`
- `opencode`
- `pi`
- `cursor`
- `copilot`

Removed from v1 profile schema:

- `backend`
- `command`
- `mode`
- `permissions`
- `actions`

## Provider mapping

WebMCP maps provider ids to native integrations:

- `codex`: Codex SDK
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: Pi RPC mode
- `cursor`: ACP
- `copilot`: ACP

The adapter registry is the internal seam future MCP tools can reuse if we move
from skill plus CLI guidance to first-class MCP agent tools.

## Model exposure

`open_workspace` exposes only compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4"
}
```

The profile body, provider protocol, raw provider transcript, and adapter
details stay outside the default model context.

Shell calls launched through WebMCP receive `WEBMCP_WORKSPACE_ID` and
`WEBMCP_WORKSPACE_ROOT`, so `webmcp agents ls` can scope itself without the
model passing workspace flags.

## Non-goals

- Custom or arbitrary subagent commands.
- Provider-specific action DSLs.
- Exposing raw provider transcripts by default.
- Tracking changed files or tests from provider output.

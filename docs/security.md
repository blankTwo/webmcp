# Security Model

GPTMCP exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

GPTMCP only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`gptmcp init` generates an Owner password and stores it in:

```text
~/.gptmcp/auth.json
```

When an MCP client connects, GPTMCP shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
GPTMCP_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

GPTMCP needs `GPTMCP_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `GPTMCP_PUBLIC_BASE_URL`.

By default, GPTMCP derives allowed Host headers from the local host and public
URL. Use `GPTMCP_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

GPTMCP does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. GPTMCP OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to GPTMCP file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

GPTMCP accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. GPTMCP does not extract or
execute transferred content.

## Runtime Status Endpoints

`GET /healthz` is intentionally safe for unauthenticated health checks. It
returns only basic server identity, version, Node version, and uptime and does
not expose local paths, process IDs, allowed roots, or configuration directories.

`GET /statusz` exposes local operational details used by `gptmcp status` and
`gptmcp restart`, including the running process command and effective
non-secret configuration. It requires the Owner password in the
`x-gptmcp-owner-token` header and returns `Cache-Control: no-store`. The Owner
password itself is never returned by either endpoint or written to request logs.

## Logs

By default, GPTMCP logs requests and tool calls. Shell command previews are
disabled unless `GPTMCP_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

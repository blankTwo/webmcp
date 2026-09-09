# Security Policy

WebMCP is designed to give MCP hosts (such as ChatGPT, Claude, and IDE assistants) controlled, auditable, and local access to development workspaces on your machine. Because WebMCP operates with your local user authority, maintaining strict security boundaries is a top priority.

---

## Security Model & Boundaries

### 1. Allowed-Root Containment
- **Approved Roots Boundary**: WebMCP strictly restricts all filesystem tool operations (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep_search`, `code_explore`, etc.) to configured `allowedRoots`.
- **Path Resolution & Traversal Prevention**: Every target path is resolved and validated against the workspace boundary. Symbolic link traversal outside approved roots is rejected.
- **Dynamic Configuration**: Allowed roots can be managed via the WebMCP Desktop Console or stored in `~/.webmcp/config.json`.

### 2. Command Execution & Local Authority
- **User Permissions**: Shell commands and process sessions executed through WebMCP run under your local operating system user account.
- **Not an Arbitrary Sandbox**: WebMCP does not isolate the host machine inside an OS sandbox. You should only connect MCP clients and run workflows that you trust.
- **Process Inspection & Control**: All running processes are tracked as active sessions with explicit lifecycle states, stdout/stderr streams, and immediate termination capabilities.

### 3. Authentication & Access Control
- **OAuth & Bearer Tokens**: All incoming MCP requests over HTTP / SSE require valid authentication.
- **Owner Password Approval**: Connection handshakes require approval with the local Owner Token stored in `~/.webmcp/auth.json`.
- **Local-Only Sensitive Endpoints**: Administrative status endpoints (`/statusz`, console control APIs) require explicit token validation and are restricted from unauthorized external callers.

### 4. Tunneling & Public Endpoints
- **User-Controlled Tunnels**: WebMCP is designed to operate behind user-controlled reverse proxies or secure tunnels (such as Cloudflare Tunnel, ngrok, Tailscale Funnel, or Pinggy).
- **No Shared Third-Party Relays**: WebMCP does not route your private code through centralized proprietary intermediate servers. Data flows directly between your MCP host and your local machine over your tunnel with TLS.

---

## Best Practices for Safe Usage

1. **Scope Allowed Roots Narrowly**: Only grant access to the specific project folders or repositories you intend to work on. Avoid adding broad directories like `/`, `C:\`, or entire user home directories.
2. **Protect Credentials**: Never check in or expose `~/.webmcp/auth.json` or your tunnel auth tokens.
3. **Use Git Worktrees**: For AI-driven code refactoring, leverage WebMCP's built-in Git Worktree support to isolate automated changes in temporary branches before merging into your main branch.
4. **Review Diffs Before Committing**: Use the WebMCP Desktop Console's visual diff review tool to inspect AI-generated code changes prior to committing or applying them.

---

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

---

## Reporting a Vulnerability

If you discover a security vulnerability in WebMCP:

1. **Do not create a public GitHub issue.**
2. Report it through GitHub's **Private Vulnerability Reporting** feature in the repository or reach out to the project maintainers.
3. Provide a clear description of the vulnerability, steps to reproduce, and potential impact.
4. Maintainers will acknowledge your report within 48 hours and work with you to validate, resolve, and publish a fix.
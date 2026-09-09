# WebMCP Console

WebMCP Console is a lightweight desktop client for a locally installed WebMCP
server. The installer does not bundle WebMCP, Node.js, or cloudflared.

## User setup

Install and start the server first:

```powershell
npm install -g webmcp
webmcp init
webmcp serve
```

WebMCP Console connects to `http://127.0.0.1:7676`, reads the Owner password
from `~/.webmcp/auth.json` inside its native process, and proxies only WebMCP's
status and Console endpoints. The password is never returned to the webview.

Existing `~/.webmcp` configuration remains a read-only compatibility fallback.

## Development

```powershell
cd D:\webmcp-main\webmcp-console
npm install
npm run tauri:dev
```

## Build the client installer

```powershell
npm run tauri:build
```

The NSIS installer is written under `src-tauri/target/release/bundle/nsis`.

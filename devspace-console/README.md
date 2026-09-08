# GPTMCP Console

GPTMCP Console is a lightweight desktop client for a locally installed GPTMCP
server. The installer does not bundle GPTMCP, Node.js, or cloudflared.

## User setup

Install and start the server first:

```powershell
npm install -g gptmcp
gptmcp init
gptmcp serve
```

GPTMCP Console connects to `http://127.0.0.1:7676`, reads the Owner password
from `~/.gptmcp/auth.json` inside its native process, and proxies only GPTMCP's
status and Console endpoints. The password is never returned to the webview.

Existing `~/.devspace` configuration remains a read-only compatibility fallback.

## Development

```powershell
cd D:\devspace-main\devspace-console
npm install
npm run tauri:dev
```

## Build the client installer

```powershell
npm run tauri:build
```

The NSIS installer is written under `src-tauri/target/release/bundle/nsis`.

# DevSpace Console

DevSpace Console 1.0 is a lightweight Tauri desktop log viewer for DevSpace workspaces.

## V1 scope

The product boundary is intentionally narrow:

- Switch between DevSpace workspaces
- View real-time tool logs
- Browse persisted SQLite history
- Search and filter logs
- Inspect execution details, stdout/stderr, params, related files, and process metadata when available
- Favorite important log entries
- View and terminate DevSpace-managed processes
- Configure SQLite retention and clear stored logs

It is not intended to become an IDE, conversation manager, resource-monitoring dashboard, or general DevSpace administration client. Conversation tracing, resource monitoring, complex process/timeline navigation, and other observability extensions are not V1 requirements.

## Data flow

```text
DevSpace Server
  ├─ authenticated snapshot/history HTTP APIs
  └─ authenticated SSE event stream
          ↓
      Tauri Rust bridge
          ↓
        React UI
```

The owner token is read by the Tauri Rust backend and is not exposed to the React page.

## Persistence

Console tool history is stored in the existing DevSpace state database:

```text
~/.local/share/devspace/devspace.sqlite
```

The default retention period is **7 days**. The Console settings dialog can change it to 1, 3, 7, 14, 30, or 90 days. The setting is persisted in SQLite and applies immediately without restarting DevSpace. Expired events are pruned by the DevSpace server.

## Current behavior

- Real workspace list from DevSpace SQLite state
- Real workspace activity counts and recent activity time
- Workspace switching and workspace search
- Real-time authenticated SSE logs with reconnect handling
- SQLite-backed history with cursor pagination
- Virtualized timeline for large histories
- New-log indicator without stealing the user's scroll position
- Filters by category, status, tool, time range, and text search
- Running / error / favorites views
- Date grouping for today, yesterday, and older history
- Execution detail panel with metadata, stdout/stderr, params, and related files
- Persistent favorites
- DevSpace-managed process list, read-only output peek, and terminate action
- SQLite path, file size, stored record count, retention cleanup, and clear-history actions
- Custom Tauri title bar and desktop shortcuts

## Run

```bash
npm install
npm run tauri:dev
```

For a browser-only UI preview, Tauri commands are unavailable, so the live DevSpace data source will not connect:

```bash
npm run dev
```

## Build

The current V1 configuration builds a standalone executable and keeps installer bundling disabled:

```bash
npm run tauri -- build --no-bundle
```

Output:

```text
src-tauri/target/release/devspace-console.exe
```

## Structure

- `src/` — React UI and DevSpace data adapter
- `src-tauri/` — Tauri 2 desktop shell and authenticated local DevSpace bridge
- `src/mock-data.ts` — empty legacy placeholder retained only because the current workspace tool surface has no delete-file primitive

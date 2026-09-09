# Contributing to WebMCP

Thank you for your interest in contributing to WebMCP!

WebMCP is an open-source local development execution layer that connects ChatGPT and MCP hosts directly to your local coding environment. We welcome community contributions, bug fixes, enhancements, and ideas that align with our core design taste.

---

## Core Principles & Product Model

Before submitting code, please familiarize yourself with our guiding architecture principles:

1. **The host is the orchestrator.** WebMCP exposes clear, composable capabilities and execution states. It does not hide workflows inside opaque, uninspectable agent loops.
2. **Everything happens in a workspace.** A workspace represents one local project directory or worktree, along with the instructions (`AGENTS.md`, `CLAUDE.md`) and state accumulated in it.
3. **Local authority stays explicit.** WebMCP runs with local user authority. Allowed roots, paths, commands, processes, and destructive operations are strict product boundaries.
4. **Adapters stay at the edges.** Keep core business logic independent of specific MCP clients, model providers, or UI quirks.
5. **Prefer composable primitives.** Build a small, reliable set of operations that can be combined cleanly rather than bloating the server with single-use monolithic tools.

---

## Development Setup

### Prerequisites
- **Node.js**: `>= 22.19 < 27`
- **npm**: `>= 10.0`
- **Rust / Cargo**: Required if building or modifying the Tauri Desktop Console.
- **Git**: For version control and worktree isolation.
- **Shell**: Bash, Zsh, or PowerShell.

### Clone and Install Dependencies

```bash
git clone https://github.com/blankTwo/webmcp.git
cd webmcp

# Install root MCP server dependencies
npm install

# Install console dependencies (if working on GUI)
cd devspace-console
npm install
cd ..
```

---

## Running in Development

### 1. MCP Server Backend

```bash
# Run server in watch/dev mode
npm run dev

# Typecheck TypeScript files
npm run typecheck

# Build the distribution packages
npm run build
```

### 2. Desktop Console (Tauri + React)

```bash
cd devspace-console

# Run Tauri desktop app with Vite hot-reloading
npm run tauri:dev

# Build production desktop installer/binary
npm run tauri:build
```

---

## Pull Request Guidelines

To keep review cycles fast and ensure top-notch quality:

1. **Keep PRs Focused**: Address a single problem, feature, or bug per PR. Avoid combining unrelated refactors or sweeping changes.
2. **Follow Conventional Commits**: Use conventional commit prefixes such as:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `refactor:` for code refactoring
   - `docs:` for documentation improvements
   - `chore:` for build tools or dependency updates
3. **UI / Visual Changes**: If your PR modifies the Desktop Console or Floating Ball widget, include clear before/after screenshots or short GIF/video clips.
4. **Verify Behavior**: Ensure `npm run typecheck` and `npm run build` pass with zero errors.
5. **Respect Security Boundaries**: Any change affecting allowed roots, path traversal, authentication, or shell execution must maintain strict isolation.

---

## Code Style & Standards

- **TypeScript**: Strict mode enabled. Avoid using `any` wherever possible; use explicit types or Zod schemas.
- **Formatting**: Clean, readable code with consistent spacing and naming.
- **Error Handling**: Preserve root errors and contextual details without leaking sensitive credentials or filesystem internals to MCP hosts.

---

## Community & Discussions

- Open a [GitHub Issue](https://github.com/blankTwo/webmcp/issues) for bug reports, questions, or feature requests.
- For architectural proposals or major scope additions, open an issue first to discuss the design before writing extensive code.
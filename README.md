# WebMCP

<p align="center">
  <strong>Local Development Execution Layer & Desktop Console for ChatGPT and MCP Agents</strong>
</p>

<p align="center">
  <a href="https://github.com/blankTwo/webmcp/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-brightgreen.svg" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-6.0-blue.svg" alt="TypeScript" /></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/tauri-v2-orange.svg" alt="Tauri v2" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/react-19-61dafb.svg" alt="React 19" /></a>
</p>

---

## Overview

**WebMCP** is an open-source, local-first bridge and execution runtime that connects **ChatGPT**, **Claude**, and other Model Context Protocol (MCP) clients directly to your local development environment.

It allows AI agents to read, write, search, execute shell commands, manage Git worktrees, and track long-running processes inside your real projects — **all within strictly configured, secure filesystem boundaries on your own machine**.

WebMCP also comes with a cross-platform **Desktop Console** (powered by Tauri v2 and React 19) and a lightweight **Desktop Floating Telemetry Ball** for real-time monitoring and workspace management.

---

## Key Features

- **🚀 Streamable HTTP MCP Server**: High-performance SSE / HTTP streaming transport (`/mcp`) with OAuth bearer token authentication and instant connection handshakes.
- **🛡️ Strict Allowed-Root Isolation**: Fine-grained filesystem containment prevents unauthorized directory traversal or access outside designated project folders.
- **🌳 Git Worktree Isolation**: Run parallel AI coding sessions in dedicated worktrees without dirtying your active working branch.
- **⚡ MCP Request Optimizer**:
  - **Dynamic Concurrency Limiter**: Backpressure queue (6 concurrent worker slots) preventing terminal saturation and host throttling.
  - **Fast-Path Metadata Cache**: Sub-millisecond response times for frequent tool and resource discovery requests (`tools/list`, `resources/list`).
- **🖥️ Modern Desktop GUI Console**:
  - **Live Event Stream**: Real-time inspection of tool calls, prompt executions, and system events.
  - **Visual Git Diff Viewer**: Inspect and review AI-generated code changes before committing.
  - **Skills & Instruction Manager**: Easily load and manage `AGENTS.md`, `CLAUDE.md`, and custom workspace skills.
  - **Allowed Roots GUI**: Add, inspect, and remove allowed project directories with native folder pickers.
- **🎈 Draggable Desktop Floating Ball**:
  - Always-on-top desktop overlay showing live concurrency load and cache hit ratios.
  - Smooth native window dragging (`data-tauri-drag-region`).
  - Shape toggle (circle / rounded square) and one-click console focus.
- **🔄 Long-Running Process Sessions**: Manage background dev servers, build pipelines, and interactive CLI sessions with streaming stdout/stderr.

---

## Quick Start

### Prerequisites
- Node.js `>= 22.19 < 27`
- Git installed on your system
- A tunnel/reverse proxy for ChatGPT access (e.g. Cloudflare Tunnel, ngrok, Tailscale Funnel, Pinggy)

### 1. Installation

Install globally via npm or run directly with npx:

```bash
# Global installation
npm install -g webmcp

# Or run directly
npx webmcp init
```

### 2. Initialization & Configuration

Initialize your WebMCP configuration:

```bash
webmcp init
```

During initialization, WebMCP will guide you through:
- Selecting the local project directories you want to expose (**Allowed Roots**).
- Setting the local server port (default: `7676`).
- Configuring your public HTTPS base URL (from your Cloudflare Tunnel / ngrok).
- Generating your secure **Owner Password** (stored in `~/.webmcp/auth.json`).

### 3. Start the Server & Console

```bash
# Start the MCP server
webmcp serve

# Start the Desktop GUI Console
webmcp console
```

---

## Connecting to ChatGPT / MCP Hosts

1. **Start your public tunnel** pointing to `http://127.0.0.1:7676`.
2. **Add MCP Connector in ChatGPT / Host**:
   - Connector URL: `https://your-tunnel-domain.example.com/mcp`
   - Authentication: Enter the **Owner Password** generated during `webmcp init`.
3. **Start Coding**: Ask ChatGPT to open one of your allowed project folders and begin inspecting, refactoring, building, or testing your codebase.

---

## What the AI Agent Can Do

| Capability | Tools Provided | Description |
|---|---|---|
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `list_dir`, `grep_search`, `code_explore` | High-speed, containment-checked reading, writing, and semantic exploration. |
| **Terminal & Processes** | `run_command`, `process_session_start`, `process_session_input`, `process_session_kill` | Execute one-shot shell commands or track long-running interactive processes. |
| **Git & Worktrees** | `git_status`, `git_diff`, `git_worktree_create`, `git_worktree_remove` | Isolate automated code edits in separate branches/worktrees. |
| **Skills & Instructions** | `skills_list`, `skill_read`, `instructions_load` | Read workspace `AGENTS.md` and custom skill instructions dynamically. |
| **Review & Checkpoints** | `review_checkpoint_save`, `review_checkpoint_inspect` | Save and inspect coherent snapshots of modifications. |

---

## Desktop Console & Floating Widget

WebMCP includes a cross-platform desktop application built with **Tauri v2** and **React 19**:

- **Main Dashboard**: Real-time status cards, active workspace handles, live tool logs, and system metrics.
- **Allowed Roots View**: Manage your local filesystem security boundaries with live folder selection and verification.
- **Skills Explorer**: Discover and configure project skills and global agent guidelines.
- **Desktop Floating Ball**: A lightweight, draggable floating monitor that provides at-a-glance visibility into MCP request scheduling and worker concurrency while you code in your IDE or browser.

---

## Architecture & Design

```
┌─────────────────────────────────────────────────────────────┐
│                 MCP Host (ChatGPT / Claude)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS / SSE Stream (/mcp)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                       WebMCP Server                         │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │  MCP Request Optimizer  │   │  Security Containment   │  │
│  │ (Concurrency / Cache)   │   │     (Allowed Roots)     │  │
│  └────────────┬────────────┘   └────────────┬────────────┘  │
│               │                             │               │
│               ▼                             ▼               │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │  Process & Terminal     │   │  Git Worktree Engine    │  │
│  │  Session Controller     │   │  & Workspace Lifecycle  │  │
│  └─────────────────────────┘   └─────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Local REST / SSE IPC
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             WebMCP Desktop Console (Tauri v2)               │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │  Dashboard & Diff GUI   │   │  Floating Telemetry Ball│  │
│  └─────────────────────────┘   └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Local Development & Building

To contribute or build WebMCP from source:

```bash
# 1. Clone the repository
git clone https://github.com/blankTwo/webmcp.git
cd webmcp

# 2. Build the MCP server
npm install
npm run build

# 3. Build the Desktop Console
cd devspace-console
npm install
npm run tauri:build
```

---

## License

This project is open-source and licensed under the [MIT License](LICENSE).
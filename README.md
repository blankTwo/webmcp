<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/webmcp/main/docs/assets/webmcp-logo-light.png" alt="WebMCP logo" width="140">
  </picture>
</p>

<h1 align="center">WebMCP</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/webmcp"><img alt="npm" src="https://img.shields.io/npm/v/webmcp?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/webmcp/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/webmcp/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/webmcp/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/webmcp?style=flat-square" /></a>
</p>

[![WebMCP connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/webmcp/main/docs/assets/webmcp-screenshot.png)](https://raw.githubusercontent.com/Waishnav/webmcp/main/docs/assets/webmcp-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

WebMCP is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

## Sponsors and Special Thanks

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>

<p>
  WebMCP is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

WebMCP requires Node `>=22.19 <27`.

Install the WebMCP CLI:

```bash
npm install -g webmcp
```

Then initialize and start the server:

```bash
webmcp init
webmcp serve
```

Or run it without a global install:

```bash
npx webmcp init
npx webmcp serve
```

During setup, WebMCP asks for:

- the local project folders ChatGPT is allowed to open through WebMCP
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or
  another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, WebMCP opens an Owner password approval page. Enter
the Owner password printed by `webmcp init`. It is also stored in:

```text
~/.webmcp/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using WebMCP as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> WebMCP. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

WebMCP gives ChatGPT tools to:

- read one or several files, write or edit files, and apply multi-file patches inside the opened workspace
- explore source structure with `code_explore`, then search code and inspect directories with dedicated read-only tools
- lazily discover skills with `skills_list` and load only the matching skill with `skill_read`
- run one-shot shell commands or managed long-running/interactive processes
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local skills from your skill folders
- keep rich tool details in WebMCP Console without adding per-tool iframe cards to ChatGPT

## Mental Model

WebMCP is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `webmcp serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

WebMCP supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Use the built-in operational commands to inspect or restart the local server:

```bash
webmcp status
webmcp doctor
webmcp restart
```

`status` reports the running PID, version, entry point, effective roots, tool mode,
widget mode, and state directories. `restart` restarts that exact running entry
point with the same effective non-secret runtime configuration, rather than
re-deriving it from the current shell directory.

The public `GET /healthz` endpoint only exposes basic health, version, Node, and
uptime information. Detailed local runtime data is available from `GET /statusz`
only when the request includes the configured Owner password in the
`x-webmcp-owner-token` header.

## Documentation

- [Setup Guide](https://github.com/Waishnav/webmcp/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/webmcp/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/webmcp/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/webmcp/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/webmcp/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/webmcp/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

WebMCP is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and Artifacts is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on WebMCP itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

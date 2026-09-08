#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { join, resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import {
  localServerUrl,
  restartEnvironment,
  type GPTMCPRuntimeStatus,
} from "./runtime-status.js";
import { GPTMCP_NODE_RANGE, GPTMCP_VERSION } from "./version.js";

type Command = "serve" | "init" | "status" | "restart" | "doctor" | "config" | "help" | "version";
const require = createRequire(import.meta.url);

async function main(argv: string[]): Promise<void> {
  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);
  if (commandRequiresSupportedNode(command)) assertSupportedNode();

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "status":
      await runStatus();
      return;
    case "restart":
      await runRestart();
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function commandRequiresSupportedNode(command: Command): boolean {
  return command === "serve" || command === "restart";
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "status" || command === "restart" || command === "doctor" || command === "config") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.GPTMCP_OAUTH_OWNER_TOKEN ?? process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "GPTMCP is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  gptmcp init",
        "",
        "Or provide GPTMCP_OAUTH_OWNER_TOKEN and GPTMCP_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`GPTMCP is already configured at ${files.dir}`);
    prompts.log.info("Run `gptmcp init --force` to update it.");
    return;
  }

  try {
    prompts.intro("GPTMCP setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should GPTMCP use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "GPTMCP needs a public base URL so ChatGPT can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "GPTMCP configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT asks you to approve GPTMCP access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `gptmcp serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`gptmcp listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because GPTMCP_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("gptmcp shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runStatus(): Promise<void> {
  const config = loadConfig();
  const runtime = await fetchRuntimeStatus(config);
  console.log(`GPTMCP CLI: ${GPTMCP_VERSION}`);
  console.log(`Local MCP URL: ${localServerUrl(config.host, config.port, "/mcp")}`);

  if (!runtime) {
    console.log("Server: not reachable");
    console.log(`Configured roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Tool mode: ${config.toolMode}`);
    console.log(`Widgets: ${config.widgets}`);
    return;
  }

  printRuntimeStatus(runtime);
}

async function runRestart(): Promise<void> {
  const config = loadConfig();
  const runtime = await fetchRuntimeStatus(config);
  if (!runtime) {
    throw new Error(
      `No running GPTMCP server found at ${localServerUrl(config.host, config.port, "/mcp")}. Run \`gptmcp serve\` first.`,
    );
  }
  if (!runtime.execPath || runtime.argv.length === 0) {
    throw new Error("The running GPTMCP server did not report a restartable process command.");
  }

  console.log(`Stopping GPTMCP ${runtime.version} (PID ${runtime.pid})...`);
  stopRuntimeProcess(runtime.pid);
  await waitForRuntimeState(config, false, 8_000);

  const replacementEnv = restartEnvironment(runtime);
  replacementEnv.GPTMCP_ALLOWED_ROOTS = config.allowedRoots.join(",");
  replacementEnv.GPTMCP_WIDGETS = config.widgets;

  const child = spawn(runtime.execPath, [...runtime.execArgv, ...runtime.argv], {
    cwd: runtime.cwd,
    env: replacementEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) throw new Error("Failed to start the replacement GPTMCP process.");
  child.unref();

  const restarted = await waitForRuntimeState(config, true, 12_000);
  if (!restarted) {
    throw new Error("GPTMCP stopped, but the replacement server did not become healthy within 12 seconds.");
  }

  console.log(`GPTMCP restarted as PID ${restarted.pid}.`);
  console.log(`Version: ${restarted.version}`);
  console.log(`Entry: ${restarted.entry}`);
  console.log(`Allowed roots: ${restarted.allowedRoots.join(", ")}`);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`GPTMCP CLI: ${GPTMCP_VERSION}`);
  console.log(`CLI entry: ${process.argv[1] ?? "unknown"}`);
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Tool mode: ${config.toolMode}`);
    console.log(`Widgets: ${config.widgets}`);
    const runtime = await fetchRuntimeStatus(config);
    if (runtime) {
      console.log(`Server: running (PID ${runtime.pid})`);
      console.log(`Server version: ${runtime.version}`);
      console.log(`Server entry: ${runtime.entry}`);
      console.log(`Server cwd: ${runtime.cwd}`);
      if (runtime.version !== GPTMCP_VERSION) {
        console.log(`Version mismatch: CLI ${GPTMCP_VERSION}, server ${runtime.version}`);
      }
    } else {
      console.log("Server: not reachable");
    }
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printRuntimeStatus(runtime: GPTMCPRuntimeStatus): void {
  console.log(`Server: running (PID ${runtime.pid})`);
  console.log(`Server version: ${runtime.version}`);
  console.log(`Node: ${runtime.nodeVersion}`);
  console.log(`Uptime: ${runtime.uptimeSeconds}s`);
  console.log(`Entry: ${runtime.entry}`);
  console.log(`Working directory: ${runtime.cwd}`);
  console.log(`Allowed roots: ${runtime.allowedRoots.join(", ")}`);
  console.log(`Allowed hosts: ${runtime.allowedHosts.join(", ")}`);
  console.log(`Tool mode: ${runtime.toolMode}`);
  console.log(`Widgets: ${runtime.widgets}`);
  console.log(`Artifacts: ${runtime.artifactsEnabled ? "enabled" : "disabled"}`);
  console.log(`State dir: ${runtime.stateDir}`);
  console.log(`Worktree dir: ${runtime.worktreeRoot}`);
  if (runtime.version !== GPTMCP_VERSION) {
    console.log(`Version mismatch: CLI ${GPTMCP_VERSION}, server ${runtime.version}`);
  }
}

async function fetchRuntimeStatus(config: ServerConfig): Promise<GPTMCPRuntimeStatus | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(localServerUrl(config.host, config.port, "/statusz"), {
      headers: { "x-gptmcp-owner-token": config.oauth.ownerToken },
      signal: controller.signal,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`GPTMCP status endpoint returned HTTP ${response.status}.`);
    }
    const value = await response.json();
    if (!isRuntimeStatus(value)) {
      throw new Error("GPTMCP status endpoint returned an invalid payload.");
    }
    return value;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
      return undefined;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRuntimeStatus(value: unknown): value is GPTMCPRuntimeStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<GPTMCPRuntimeStatus>;
  return status.ok === true
    && status.name === "gptmcp"
    && typeof status.version === "string"
    && typeof status.pid === "number"
    && typeof status.cwd === "string"
    && typeof status.execPath === "string"
    && Array.isArray(status.execArgv)
    && Array.isArray(status.argv)
    && typeof status.entry === "string"
    && Array.isArray(status.allowedRoots)
    && Array.isArray(status.allowedHosts)
    && typeof status.toolMode === "string"
    && typeof status.widgets === "string";
}

function stopRuntimeProcess(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Unable to stop GPTMCP process ${pid}.`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForRuntimeState(
  config: ServerConfig,
  running: boolean,
  timeoutMs: number,
): Promise<GPTMCPRuntimeStatus | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await fetchRuntimeStatus(config);
    if (running && runtime) return runtime;
    if (!running && !runtime) return undefined;
    await sleep(150);
  }

  if (running) return undefined;
  throw new Error("GPTMCP did not stop within the expected timeout.");
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl" && key !== "allowedRoots") {
    throw new Error("Supported config keys: publicBaseUrl, allowedRoots.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error(`Missing ${key} value.`);
  }

  const nextConfig = key === "allowedRoots"
    ? {
        ...files.config,
        allowedRoots: value
          .split(",")
          .map((root) => resolve(expandHomePath(root.trim())))
          .filter(Boolean),
      }
    : {
        ...files.config,
        publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
      };

  writeDevspaceConfig(nextConfig);
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "GPTMCP",
      "",
      "Usage:",
      "  gptmcp                    Run first-time setup if needed, then start the server",
      "  gptmcp serve              Start the server",
      "  gptmcp init               Create or update ~/.gptmcp/config.json and auth.json",
      "  gptmcp status             Show the running server and effective configuration",
      "  gptmcp restart            Restart the running server with the same runtime configuration",
      "  gptmcp doctor             Show config, runtime, dependency, and server diagnostics",
      "  gptmcp config get        Print persisted config",
      "  gptmcp config set publicBaseUrl <url|null>",
      "  gptmcp config set allowedRoots <root1,root2,...>",
      "  gptmcp -v, --version     Print the installed version",
      "",
      "For temporary tunnels:",
      "  GPTMCP_PUBLIC_BASE_URL=https://example.trycloudflare.com gptmcp serve",
    ].join("\n"),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printVersion(): void {
  console.log(GPTMCP_VERSION);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, GPTMCP_NODE_RANGE)) return;

  throw new Error(
    [
      `GPTMCP requires Node ${GPTMCP_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, GPTMCP_NODE_RANGE)
    ? `supported ${GPTMCP_NODE_RANGE}`
    : `unsupported, requires ${GPTMCP_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

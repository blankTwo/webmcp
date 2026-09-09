import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { webmcpSkillsDir, loadWebmcpFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  webmcpSkillsDir: string;
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function configEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`WEBMCP_${name}`];
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = configEnv(env, "TOOL_MODE");
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid WEBMCP_TOOL_MODE: ${mode}`);

  const legacyMinimalTools = configEnv(env, "MINIMAL_TOOLS");
  if (legacyMinimalTools !== undefined) {
    return parseBoolean(legacyMinimalTools) ? "minimal" : "full";
  }
  return "full";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid WEBMCP_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid WEBMCP_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(configEnv(env, "LOG_LEVEL")),
    format: parseLogFormat(configEnv(env, "LOG_FORMAT")),
    requests: configEnv(env, "LOG_REQUESTS") === undefined ? true : parseBoolean(configEnv(env, "LOG_REQUESTS")),
    assets: parseBoolean(configEnv(env, "LOG_ASSETS")),
    toolCalls: configEnv(env, "LOG_TOOL_CALLS") === undefined ? true : parseBoolean(configEnv(env, "LOG_TOOL_CALLS")),
    shellCommands: parseBoolean(configEnv(env, "LOG_SHELL_COMMANDS")),
    trustProxy: parseBoolean(configEnv(env, "TRUST_PROXY")),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "off" || value === "changes" || value === "full") return "off";

  throw new Error(`Invalid WEBMCP_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for WebMCP OAuth. Run: webmcp init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(configEnv(env, "OAUTH_OWNER_TOKEN") ?? ownerToken, "WEBMCP_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      configEnv(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS"),
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "WEBMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      configEnv(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS"),
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "WEBMCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.WEBMCP_OAUTH_SCOPES, ["webmcp"]),
    allowedRedirectHosts: parseStringList(configEnv(env, "OAUTH_ALLOWED_REDIRECT_HOSTS"), [
      "chatgpt.com",
      "claude.ai",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "webmcp");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".webmcp", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadWebmcpFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.WEBMCP_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.WEBMCP_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.WEBMCP_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(configEnv(env, "WIDGETS")),
    stateDir: resolve(expandHomePath(env.WEBMCP_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.WEBMCP_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled:
      configEnv(env, "ARTIFACTS") === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(configEnv(env, "ARTIFACTS")),
    artifactMaxFileBytes: parsePositiveInteger(
      configEnv(env, "ARTIFACT_MAX_FILE_BYTES") ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "WEBMCP_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: configEnv(env, "SKILLS") === undefined ? true : parseBoolean(configEnv(env, "SKILLS")),
    skillPaths: parsePathList(configEnv(env, "SKILL_PATHS")),
    webmcpSkillsDir: webmcpSkillsDir(env),
    agentDir: resolve(expandHomePath(configEnv(env, "AGENT_DIR") ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}

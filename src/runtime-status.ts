import type { ServerConfig } from "./config.js";
import { webmcpConfigDir } from "./user-config.js";
import { WEBMCP_VERSION } from "./version.js";

export interface WebMCPHealth {
  ok: true;
  name: "webmcp";
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
}

export interface WebMCPRuntimeStatus extends WebMCPHealth {
  pid: number;
  cwd: string;
  execPath: string;
  execArgv: string[];
  argv: string[];
  entry: string;
  configDir: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedRoots: string[];
  allowedHosts: string[];
  toolMode: ServerConfig["toolMode"];
  widgets: ServerConfig["widgets"];
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
  };
  logging: ServerConfig["logging"];
}

export type GPTMCPHealth = WebMCPHealth;
export type GPTMCPRuntimeStatus = WebMCPRuntimeStatus;

export function createHealthStatus(): WebMCPHealth {
  return {
    ok: true,
    name: "webmcp",
    version: WEBMCP_VERSION,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function createRuntimeStatus(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): WebMCPRuntimeStatus {
  return {
    ...createHealthStatus(),
    pid: process.pid,
    cwd: process.cwd(),
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: process.argv.slice(1),
    entry: process.argv[1] ?? "",
    configDir: webmcpConfigDir(env),
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    allowedRoots: [...config.allowedRoots],
    allowedHosts: [...config.allowedHosts],
    toolMode: config.toolMode,
    widgets: config.widgets,
    stateDir: config.stateDir,
    worktreeRoot: config.worktreeRoot,
    artifactsEnabled: config.artifactsEnabled,
    artifactMaxFileBytes: config.artifactMaxFileBytes,
    skillsEnabled: config.skillsEnabled,
    skillPaths: [...config.skillPaths],
    agentDir: config.agentDir,
    oauth: {
      accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
      scopes: [...config.oauth.scopes],
      allowedRedirectHosts: [...config.oauth.allowedRedirectHosts],
    },
    logging: { ...config.logging },
  };
}

export function restartEnvironment(
  status: WebMCPRuntimeStatus,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    WEBMCP_CONFIG_DIR: status.configDir,
    HOST: status.host,
    PORT: String(status.port),
    WEBMCP_PUBLIC_BASE_URL: status.publicBaseUrl,
    WEBMCP_ALLOWED_ROOTS: status.allowedRoots.join(","),
    WEBMCP_ALLOWED_HOSTS: status.allowedHosts.join(","),
    WEBMCP_TOOL_MODE: status.toolMode,
    WEBMCP_WIDGETS: status.widgets,
    WEBMCP_STATE_DIR: status.stateDir,
    WEBMCP_WORKTREE_ROOT: status.worktreeRoot,
    WEBMCP_ARTIFACTS: status.artifactsEnabled ? "1" : "0",
    WEBMCP_ARTIFACT_MAX_FILE_BYTES: String(status.artifactMaxFileBytes),
    WEBMCP_SKILLS: status.skillsEnabled ? "1" : "0",
    WEBMCP_SKILL_PATHS: status.skillPaths.join(","),
    WEBMCP_AGENT_DIR: status.agentDir,
    WEBMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: String(status.oauth.accessTokenTtlSeconds),
    WEBMCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: String(status.oauth.refreshTokenTtlSeconds),
    WEBMCP_OAUTH_SCOPES: status.oauth.scopes.join(","),
    WEBMCP_OAUTH_ALLOWED_REDIRECT_HOSTS: status.oauth.allowedRedirectHosts.join(","),
    WEBMCP_LOG_LEVEL: status.logging.level,
    WEBMCP_LOG_FORMAT: status.logging.format,
    WEBMCP_LOG_REQUESTS: status.logging.requests ? "1" : "0",
    WEBMCP_LOG_ASSETS: status.logging.assets ? "1" : "0",
    WEBMCP_LOG_TOOL_CALLS: status.logging.toolCalls ? "1" : "0",
    WEBMCP_LOG_SHELL_COMMANDS: status.logging.shellCommands ? "1" : "0",
    WEBMCP_TRUST_PROXY: status.logging.trustProxy ? "1" : "0",
  };
}

export function localServerUrl(host: string, port: number, pathname: string): URL {
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = localHost.includes(":") && !localHost.startsWith("[")
    ? `[${localHost}]`
    : localHost;
  return new URL(`http://${formattedHost}:${port}${pathname}`);
}

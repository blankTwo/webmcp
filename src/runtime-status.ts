import type { ServerConfig } from "./config.js";
import { devspaceConfigDir } from "./user-config.js";
import { GPTMCP_VERSION } from "./version.js";

export interface GPTMCPHealth {
  ok: true;
  name: "gptmcp";
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
}

export interface GPTMCPRuntimeStatus extends GPTMCPHealth {
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

export function createHealthStatus(): GPTMCPHealth {
  return {
    ok: true,
    name: "gptmcp",
    version: GPTMCP_VERSION,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function createRuntimeStatus(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): GPTMCPRuntimeStatus {
  return {
    ...createHealthStatus(),
    pid: process.pid,
    cwd: process.cwd(),
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: process.argv.slice(1),
    entry: process.argv[1] ?? "",
    configDir: devspaceConfigDir(env),
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
  status: GPTMCPRuntimeStatus,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GPTMCP_CONFIG_DIR: status.configDir,
    HOST: status.host,
    PORT: String(status.port),
    GPTMCP_PUBLIC_BASE_URL: status.publicBaseUrl,
    GPTMCP_ALLOWED_ROOTS: status.allowedRoots.join(","),
    GPTMCP_ALLOWED_HOSTS: status.allowedHosts.join(","),
    GPTMCP_TOOL_MODE: status.toolMode,
    GPTMCP_WIDGETS: status.widgets,
    GPTMCP_STATE_DIR: status.stateDir,
    GPTMCP_WORKTREE_ROOT: status.worktreeRoot,
    GPTMCP_ARTIFACTS: status.artifactsEnabled ? "1" : "0",
    GPTMCP_ARTIFACT_MAX_FILE_BYTES: String(status.artifactMaxFileBytes),
    GPTMCP_SKILLS: status.skillsEnabled ? "1" : "0",
    GPTMCP_SKILL_PATHS: status.skillPaths.join(","),
    GPTMCP_AGENT_DIR: status.agentDir,
    GPTMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: String(status.oauth.accessTokenTtlSeconds),
    GPTMCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: String(status.oauth.refreshTokenTtlSeconds),
    GPTMCP_OAUTH_SCOPES: status.oauth.scopes.join(","),
    GPTMCP_OAUTH_ALLOWED_REDIRECT_HOSTS: status.oauth.allowedRedirectHosts.join(","),
    GPTMCP_LOG_LEVEL: status.logging.level,
    GPTMCP_LOG_FORMAT: status.logging.format,
    GPTMCP_LOG_REQUESTS: status.logging.requests ? "1" : "0",
    GPTMCP_LOG_ASSETS: status.logging.assets ? "1" : "0",
    GPTMCP_LOG_TOOL_CALLS: status.logging.toolCalls ? "1" : "0",
    GPTMCP_LOG_SHELL_COMMANDS: status.logging.shellCommands ? "1" : "0",
    GPTMCP_TRUST_PROXY: status.logging.trustProxy ? "1" : "0",
  };
}

export function localServerUrl(host: string, port: number, pathname: string): URL {
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = localHost.includes(":") && !localHost.startsWith("[")
    ? `[${localHost}]`
    : localHost;
  return new URL(`http://${formattedHost}:${port}${pathname}`);
}

import type { ServerConfig } from "./config.js";
import { devspaceConfigDir } from "./user-config.js";
import { DEVSPACE_VERSION } from "./version.js";

export interface DevSpaceHealth {
  ok: true;
  name: "devspace";
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
}

export interface DevSpaceRuntimeStatus extends DevSpaceHealth {
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
  subagents: boolean;
  agentDir: string;
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
  };
  logging: ServerConfig["logging"];
}

export function createHealthStatus(): DevSpaceHealth {
  return {
    ok: true,
    name: "devspace",
    version: DEVSPACE_VERSION,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function createRuntimeStatus(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): DevSpaceRuntimeStatus {
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
    subagents: config.subagents,
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
  status: DevSpaceRuntimeStatus,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DEVSPACE_CONFIG_DIR: status.configDir,
    HOST: status.host,
    PORT: String(status.port),
    DEVSPACE_PUBLIC_BASE_URL: status.publicBaseUrl,
    DEVSPACE_ALLOWED_ROOTS: status.allowedRoots.join(","),
    DEVSPACE_ALLOWED_HOSTS: status.allowedHosts.join(","),
    DEVSPACE_TOOL_MODE: status.toolMode,
    DEVSPACE_WIDGETS: status.widgets,
    DEVSPACE_STATE_DIR: status.stateDir,
    DEVSPACE_WORKTREE_ROOT: status.worktreeRoot,
    DEVSPACE_ARTIFACTS: status.artifactsEnabled ? "1" : "0",
    DEVSPACE_ARTIFACT_MAX_FILE_BYTES: String(status.artifactMaxFileBytes),
    DEVSPACE_SKILLS: status.skillsEnabled ? "1" : "0",
    DEVSPACE_SKILL_PATHS: status.skillPaths.join(","),
    DEVSPACE_SUBAGENTS: status.subagents ? "1" : "0",
    DEVSPACE_AGENT_DIR: status.agentDir,
    DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: String(status.oauth.accessTokenTtlSeconds),
    DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: String(status.oauth.refreshTokenTtlSeconds),
    DEVSPACE_OAUTH_SCOPES: status.oauth.scopes.join(","),
    DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: status.oauth.allowedRedirectHosts.join(","),
    DEVSPACE_LOG_LEVEL: status.logging.level,
    DEVSPACE_LOG_FORMAT: status.logging.format,
    DEVSPACE_LOG_REQUESTS: status.logging.requests ? "1" : "0",
    DEVSPACE_LOG_ASSETS: status.logging.assets ? "1" : "0",
    DEVSPACE_LOG_TOOL_CALLS: status.logging.toolCalls ? "1" : "0",
    DEVSPACE_LOG_SHELL_COMMANDS: status.logging.shellCommands ? "1" : "0",
    DEVSPACE_TRUST_PROXY: status.logging.trustProxy ? "1" : "0",
  };
}

export function localServerUrl(host: string, port: number, pathname: string): URL {
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = localHost.includes(":") && !localHost.startsWith("[")
    ? `[${localHost}]`
    : localHost;
  return new URL(`http://${formattedHost}:${port}${pathname}`);
}

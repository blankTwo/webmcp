import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface ToolsPolicy {
  gitStatus?: boolean;
  gitDiff?: boolean;
  gitLog?: boolean;
  gitAdd?: boolean;
  gitCommit?: boolean;
  gitPull?: boolean;
  gitPush?: boolean;
  checkpoint?: boolean;
  historySearch?: boolean;
  runBuildAndTest?: boolean;
}

export interface WebmcpUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  artifactsEnabled?: boolean;
  artifactMaxFileBytes?: number;
  agentDir?: string;
  toolsPolicy?: ToolsPolicy;
}

export interface WebmcpAuthConfig {
  ownerToken?: string;
}

export interface WebmcpFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: WebmcpUserConfig;
  auth: WebmcpAuthConfig;
  legacy: boolean;
}

export function webmcpConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WEBMCP_CONFIG_DIR;
  if (configured) return resolve(expandHomePath(configured));
  return join(homedir(), ".webmcp");
}

export function webmcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(webmcpConfigDir(env), "config.json");
}

export function webmcpAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(webmcpConfigDir(env), "auth.json");
}

export function webmcpSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(webmcpConfigDir(env), "skills");
}

export function loadWebmcpFiles(env: NodeJS.ProcessEnv = process.env): WebmcpFiles {
  const dir = webmcpConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<WebmcpUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<WebmcpAuthConfig>(authPath) : {},
    legacy: dir === join(homedir(), ".webmcp"),
  };
}

export function writeWebmcpConfig(
  config: WebmcpUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = webmcpConfigPath(env);
  mkdirSync(webmcpConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeWebmcpAuth(
  auth: WebmcpAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = webmcpAuthPath(env);
  mkdirSync(webmcpConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}

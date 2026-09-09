import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export interface SkillItemInfo {
  name: string;
  description: string;
  version?: string;
  source: "bundled" | "workspace" | "global";
  baseDir: string;
  filePath: string;
  content: string;
  appliedToWorkspace: boolean;
  installedGlobally: boolean;
}

export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string; version?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter = match[1];
  const result: { name?: string; description?: string; version?: string } = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key === "name") result.name = val;
      if (key === "description") result.description = val;
      if (key === "version") result.version = val;
    }
  }
  return result;
}

function scanSkillsFromDirectory(dir: string, source: "bundled" | "workspace" | "global"): Map<string, SkillItemInfo> {
  const map = new Map<string, SkillItemInfo>();
  if (!existsSync(dir)) return map;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (entry.name === "_shared") continue;

      const skillDirPath = join(dir, entry.name);
      const skillMdPath = join(skillDirPath, "SKILL.md");
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf8");
          const fm = parseSkillFrontmatter(content);
          const name = fm.name || entry.name;
          const description = fm.description || "自定义扩展技能";
          map.set(name, {
            name,
            description,
            version: fm.version,
            source,
            baseDir: skillDirPath,
            filePath: skillMdPath,
            content,
            appliedToWorkspace: source === "workspace",
            installedGlobally: source === "global",
          });
        } catch {
          // ignore read error
        }
      }
    }
  } catch {
    // ignore scan error
  }
  return map;
}

export function listAllSkillsInfo(config: ServerConfig, workspaceRoot?: string): {
  skills: SkillItemInfo[];
  bundledDir: string;
  workspaceDir?: string;
  globalDir: string;
} {
  const bundled = bundledSkillsDir();
  const globalDir = config.webmcpSkillsDir || join(homedir(), ".webmcp", "skills");
  const workspaceDir = workspaceRoot ? resolve(workspaceRoot, ".agents", "skills") : undefined;

  const bundledMap = scanSkillsFromDirectory(bundled, "bundled");
  const globalMap = scanSkillsFromDirectory(globalDir, "global");
  const altGlobalMap = scanSkillsFromDirectory(join(homedir(), ".agents", "skills"), "global");
  const workspaceMap = workspaceDir ? scanSkillsFromDirectory(workspaceDir, "workspace") : new Map<string, SkillItemInfo>();

  const merged = new Map<string, SkillItemInfo>();

  // 1. Add all bundled skills as base library
  for (const [name, info] of bundledMap) {
    const inWorkspace = workspaceMap.has(name);
    const inGlobal = globalMap.has(name) || altGlobalMap.has(name);
    merged.set(name, {
      ...info,
      appliedToWorkspace: inWorkspace,
      installedGlobally: inGlobal,
    });
  }

  // 2. Add global skills
  for (const [name, info] of globalMap) {
    if (!merged.has(name)) {
      merged.set(name, {
        ...info,
        appliedToWorkspace: workspaceMap.has(name),
        installedGlobally: true,
      });
    }
  }
  for (const [name, info] of altGlobalMap) {
    if (!merged.has(name)) {
      merged.set(name, {
        ...info,
        appliedToWorkspace: workspaceMap.has(name),
        installedGlobally: true,
      });
    }
  }

  // 3. Add workspace-specific skills
  for (const [name, info] of workspaceMap) {
    if (!merged.has(name)) {
      merged.set(name, {
        ...info,
        appliedToWorkspace: true,
        installedGlobally: false,
      });
    }
  }

  return {
    skills: Array.from(merged.values()),
    bundledDir: bundled,
    workspaceDir,
    globalDir,
  };
}

export function applySkillToTarget(
  skillName: string,
  target: "workspace" | "global",
  workspaceRoot?: string,
): { ok: boolean; targetDir: string; message: string } {
  const bundledDir = bundledSkillsDir();
  const srcSkillDir = join(bundledDir, skillName);

  if (!existsSync(srcSkillDir)) {
    throw new Error(`内置技能库中不存在技能: ${skillName}`);
  }

  let destBaseDir = "";
  if (target === "workspace") {
    if (!workspaceRoot) throw new Error("未指定工作区路径");
    destBaseDir = resolve(workspaceRoot, ".agents", "skills");
  } else {
    destBaseDir = join(homedir(), ".webmcp", "skills");
  }

  mkdirSync(destBaseDir, { recursive: true });
  const destSkillDir = join(destBaseDir, skillName);
  cpSync(srcSkillDir, destSkillDir, { recursive: true, force: true });

  // If _shared exists in bundled skills, also copy _shared
  const sharedSrc = join(bundledDir, "_shared");
  if (existsSync(sharedSrc)) {
    const sharedDest = join(destBaseDir, "_shared");
    if (!existsSync(sharedDest)) {
      cpSync(sharedSrc, sharedDest, { recursive: true, force: true });
    }
  }

  return {
    ok: true,
    targetDir: destSkillDir,
    message: `技能 ${skillName} 已成功应用至 ${target === "workspace" ? "当前工作区" : "全局技能目录"}`,
  };
}

export function removeSkillFromTarget(
  skillName: string,
  target: "workspace" | "global",
  workspaceRoot?: string,
): { ok: boolean; message: string } {
  let targetSkillDir = "";
  if (target === "workspace") {
    if (!workspaceRoot) throw new Error("未指定工作区路径");
    targetSkillDir = resolve(workspaceRoot, ".agents", "skills", skillName);
  } else {
    targetSkillDir = join(homedir(), ".webmcp", "skills", skillName);
  }

  if (existsSync(targetSkillDir)) {
    rmSync(targetSkillDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    message: `技能 ${skillName} 已从 ${target === "workspace" ? "工作区" : "全局"} 移除`,
  };
}

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const bundledSkills = bundledSkillsDir();
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    config.webmcpSkillsDir,
    join(config.agentDir, "skills"),
    bundledSkills,
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  return result;
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}

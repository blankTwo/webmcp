import { lstat, realpath, rename } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { isPathInsideRoot, resolveAllowedPath } from "./roots.js";

export interface MoveWorkspacePathResult {
  source: string;
  destination: string;
}

export async function moveWorkspacePath(
  workspaceRoot: string,
  sourcePath: string,
  destinationPath: string,
): Promise<MoveWorkspacePathResult> {
  const source = resolveAllowedPath(sourcePath, workspaceRoot, [workspaceRoot]);
  const destination = resolveAllowedPath(destinationPath, workspaceRoot, [workspaceRoot]);
  if (source === destination) {
    throw new Error("Source and destination must be different paths.");
  }

  const canonicalRoot = await realpath(workspaceRoot);
  const [sourceParent, destinationParent] = await Promise.all([
    realpath(dirname(source)),
    realpath(dirname(destination)),
  ]);
  if (!isPathInsideRoot(sourceParent, canonicalRoot)) {
    throw new Error(`Source parent escapes the workspace root: ${sourcePath}`);
  }
  if (!isPathInsideRoot(destinationParent, canonicalRoot)) {
    throw new Error(`Destination parent escapes the workspace root: ${destinationPath}`);
  }

  await lstat(source);
  try {
    await lstat(destination);
    throw new Error(`Destination already exists: ${destinationPath}`);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  await rename(source, destination);
  return {
    source: workspaceRelativePath(workspaceRoot, source),
    destination: workspaceRelativePath(workspaceRoot, destination),
  };
}

function workspaceRelativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  return value.split(sep).join("/");
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    typeof error === "object"
      && error
      && "code" in error
      && ((error as NodeJS.ErrnoException).code === "ENOENT"
        || (error as NodeJS.ErrnoException).code === "ENOTDIR"),
  );
}

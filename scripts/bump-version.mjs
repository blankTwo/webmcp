import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = resolve(repoRoot, "package.json");

const content = readFileSync(packageJsonPath, "utf8");
const pkg = JSON.parse(content);

const oldVersion = pkg.version;
const parts = String(oldVersion).split(".");
if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
  parts[2] = String(Number(parts[2]) + 1);
  pkg.version = parts.join(".");
} else {
  console.warn(`[bump-version] Non-standard version '${oldVersion}', skipping auto-increment.`);
  process.exit(0);
}

writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(`[bump-version] Bumped package version from ${oldVersion} to ${pkg.version}`);

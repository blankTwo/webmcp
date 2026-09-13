import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = resolve(repoRoot, "package.json");
const consolePackageJsonPath = resolve(repoRoot, "devspace-console", "package.json");
const tauriConfPath = resolve(repoRoot, "devspace-console", "src-tauri", "tauri.conf.json");
const cargoTomlPath = resolve(repoRoot, "devspace-console", "src-tauri", "Cargo.toml");

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

// Sync devspace-console package.json
try {
  const consoleContent = readFileSync(consolePackageJsonPath, "utf8");
  const consolePkg = JSON.parse(consoleContent);
  consolePkg.version = pkg.version;
  writeFileSync(consolePackageJsonPath, JSON.stringify(consolePkg, null, 2) + "\n", "utf8");
  console.log(`[bump-version] Synced devspace-console/package.json -> ${pkg.version}`);
} catch (err) {
  console.warn(`[bump-version] Could not sync devspace-console/package.json: ${err.message}`);
}

// Sync tauri.conf.json
try {
  const tauriContent = readFileSync(tauriConfPath, "utf8");
  const tauriConf = JSON.parse(tauriContent);
  tauriConf.version = pkg.version;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");
  console.log(`[bump-version] Synced tauri.conf.json -> ${pkg.version}`);
} catch (err) {
  console.warn(`[bump-version] Could not sync tauri.conf.json: ${err.message}`);
}

// Sync Cargo.toml
try {
  let cargoContent = readFileSync(cargoTomlPath, "utf8");
  cargoContent = cargoContent.replace(/version\s*=\s*"[^"]+"/, `version = "${pkg.version}"`);
  writeFileSync(cargoTomlPath, cargoContent, "utf8");
  console.log(`[bump-version] Synced Cargo.toml -> ${pkg.version}`);
} catch (err) {
  console.warn(`[bump-version] Could not sync Cargo.toml: ${err.message}`);
}

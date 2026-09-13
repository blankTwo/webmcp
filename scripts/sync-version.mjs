import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = resolve(repoRoot, "package.json");
const consolePackageJsonPath = resolve(repoRoot, "devspace-console", "package.json");
const tauriConfPath = resolve(repoRoot, "devspace-console", "src-tauri", "tauri.conf.json");
const cargoTomlPath = resolve(repoRoot, "devspace-console", "src-tauri", "Cargo.toml");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = pkg.version;

// sync devspace-console package.json
try {
  const cPkg = JSON.parse(readFileSync(consolePackageJsonPath, "utf8"));
  cPkg.version = version;
  writeFileSync(consolePackageJsonPath, JSON.stringify(cPkg, null, 2) + "\n", "utf8");
} catch (e) {
  console.warn("[sync-version] Could not sync console package.json: " + e.message);
}

// sync tauri.conf.json
try {
  const tConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  tConf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(tConf, null, 2) + "\n", "utf8");
} catch (e) {
  console.warn("[sync-version] Could not sync tauri.conf.json: " + e.message);
}

// sync Cargo.toml
try {
  let cargo = readFileSync(cargoTomlPath, "utf8");
  cargo = cargo.replace(/version\s*=\s*"[^"]+"/, "version = \"" + version + "\"");
  writeFileSync(cargoTomlPath, cargo, "utf8");
} catch (e) {
  console.warn("[sync-version] Could not sync Cargo.toml: " + e.message);
}

console.log("[sync-version] Synced all version numbers to " + version);

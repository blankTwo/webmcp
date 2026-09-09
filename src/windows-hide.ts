import childProcess from "node:child_process";

/**
 * On Windows, child processes spawned without `windowsHide: true` (such as fd.exe, rg.exe, git, etc.)
 * cause brief black console / CMD windows to flash or stay open on the desktop.
 *
 * In Node.js:
 * 1. Third-party ESM modules (like `@earendil-works/pi-coding-agent`) do `import { spawn } from "child_process"`.
 *    ESM named exports are bound at module initialization and cannot be intercepted merely by modifying
 *    `childProcess.spawn`.
 * 2. However, ALL asynchronous spawns in Node.js (whether from `spawn`, `exec`, `execFile`, or named imports)
 *    ultimately pass through `ChildProcess.prototype.spawn(options)`.
 * 3. All synchronous spawns (`spawnSync`, `execSync`, `execFileSync`) ultimately pass through
 *    `process.binding("spawn_sync").spawn(options)`.
 *
 * By hooking at these root levels, 100% of child processes across the entire Node.js runtime—including
 * third-party packages with named ESM imports—are guaranteed to have `windowsHide = true`.
 */
export function ensureWindowsHide(): void {
  if (process.platform !== "win32") return;

  const cp = childProcess as any;
  if (cp.__windowsHidePatched) return;
  cp.__windowsHidePatched = true;

  // 1. Hook ChildProcess.prototype.spawn (covers all async spawns across CJS and ESM)
  try {
    const ChildProcessClass = cp.ChildProcess;
    if (ChildProcessClass?.prototype?.spawn) {
      const origSpawn = ChildProcessClass.prototype.spawn;
      ChildProcessClass.prototype.spawn = function (options: any) {
        if (options && typeof options === "object") {
          options.windowsHide = true;
        }
        return origSpawn.call(this, options);
      };
    }
  } catch {
    // ignore
  }

  // 2. Hook native spawn_sync (covers all sync spawns across CJS and ESM)
  try {
    const binding = (process as any).binding?.("spawn_sync");
    if (binding && typeof binding.spawn === "function") {
      const origSyncSpawn = binding.spawn;
      binding.spawn = function (options: any) {
        if (options && typeof options === "object") {
          options.windowsHide = true;
        }
        return origSyncSpawn.call(this, options);
      };
    }
  } catch {
    // ignore
  }

  // 3. Also patch childProcess module methods for completeness
  const originalSpawn = cp.spawn;
  if (originalSpawn) {
    cp.spawn = function (command: any, args: any, options: any) {
      if (typeof args === "object" && !Array.isArray(args) && options === undefined) {
        options = args;
        args = [];
      }
      const safeOptions = { windowsHide: true, ...options };
      return originalSpawn.call(this, command, args, safeOptions);
    };
  }

  const originalSpawnSync = cp.spawnSync;
  if (originalSpawnSync) {
    cp.spawnSync = function (command: any, args: any, options: any) {
      if (typeof args === "object" && !Array.isArray(args) && options === undefined) {
        options = args;
        args = [];
      }
      const safeOptions = { windowsHide: true, ...options };
      return originalSpawnSync.call(this, command, args, safeOptions);
    };
  }

  const originalExecFile = cp.execFile;
  if (originalExecFile) {
    cp.execFile = function (file: any, args: any, options: any, callback: any) {
      if (typeof args === "function") {
        callback = args;
        args = [];
        options = {};
      } else if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const safeOptions = { windowsHide: true, ...options };
      return originalExecFile.call(this, file, args, safeOptions, callback);
    };
  }

  const originalExec = cp.exec;
  if (originalExec) {
    cp.exec = function (command: any, options: any, callback: any) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const safeOptions = { windowsHide: true, ...options };
      return originalExec.call(this, command, safeOptions, callback);
    };
  }
}

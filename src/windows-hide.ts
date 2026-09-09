import childProcess from "node:child_process";

/**
 * On Windows, child processes spawned without `windowsHide: true` (such as fd.exe, rg.exe, git, etc.)
 * can cause annoying black console / CMD windows to briefly flash or stay open on the desktop.
 * This helper monkey-patches Node's child_process methods (`spawn`, `spawnSync`, `exec`, `execFile`, `execSync`, `execFileSync`)
 * to always default `windowsHide` to `true` on Windows platform.
 */
export function ensureWindowsHide(): void {
  if (process.platform !== "win32") return;

  const cp = childProcess as any;
  if (cp.__windowsHidePatched) return;
  cp.__windowsHidePatched = true;

  const originalSpawn = cp.spawn;
  cp.spawn = function (command: any, args: any, options: any) {
    if (typeof args === "object" && !Array.isArray(args) && options === undefined) {
      options = args;
      args = [];
    }
    const safeOptions = { windowsHide: true, ...options };
    return originalSpawn.call(this, command, args, safeOptions);
  };

  const originalSpawnSync = cp.spawnSync;
  cp.spawnSync = function (command: any, args: any, options: any) {
    if (typeof args === "object" && !Array.isArray(args) && options === undefined) {
      options = args;
      args = [];
    }
    const safeOptions = { windowsHide: true, ...options };
    return originalSpawnSync.call(this, command, args, safeOptions);
  };

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

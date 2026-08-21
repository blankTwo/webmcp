import assert from "node:assert/strict";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid, force) => (windowsCalls.push(`tree:${pid}:${String(force)}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42:true"]);

const windowsForceCalls: string[] = [];
terminateProcessTree(
  { pid: 45, kill: (signal) => (windowsForceCalls.push(`child:${signal}`), true) },
  "SIGKILL",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid, force) => (windowsForceCalls.push(`tree:${pid}:${String(force)}`), true),
  },
);
assert.deepEqual(windowsForceCalls, ["tree:45:true"]);

const windowsGracefulFailureCalls: string[] = [];
terminateProcessTree(
  { pid: 46, kill: (signal) => (windowsGracefulFailureCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid, force) => (windowsGracefulFailureCalls.push(`tree:${pid}:${String(force)}`), false),
  },
);
assert.deepEqual(windowsGracefulFailureCalls, ["tree:46:true", "child:SIGTERM"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);

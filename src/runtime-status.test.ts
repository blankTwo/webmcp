import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  createRuntimeStatus,
  localServerUrl,
  restartEnvironment,
} from "./runtime-status.js";
import { DEVSPACE_VERSION } from "./version.js";

const OWNER_TOKEN = "test-owner-token-that-is-long-enough";

test("runtime status reports effective non-secret configuration", () => {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: "C:\\tmp\\devspace-config",
    DEVSPACE_ALLOWED_ROOTS: "D:\\work,D:\\other",
    DEVSPACE_ALLOWED_HOSTS: "localhost,devspace.example.com",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: "D:\\state",
    DEVSPACE_WORKTREE_ROOT: "D:\\worktrees",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "changes",
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_ARTIFACTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    HOST: "127.0.0.1",
    PORT: "7676",
  });

  const status = createRuntimeStatus(config, {
    DEVSPACE_CONFIG_DIR: "C:\\tmp\\devspace-config",
  });
  assert.equal(status.version, DEVSPACE_VERSION);
  assert.equal(status.pid, process.pid);
  assert.equal(status.execPath, process.execPath);
  assert.deepEqual(status.allowedRoots, config.allowedRoots);
  assert.equal(status.toolMode, "codex");
  assert.equal(status.widgets, "off");
  assert.equal(status.subagents, true);
  assert.equal("ownerToken" in status.oauth, false);

  const env = restartEnvironment(status, { PATH: "test-path" });
  assert.equal(env.PATH, "test-path");
  assert.equal(env.DEVSPACE_CONFIG_DIR, status.configDir);
  assert.equal(env.DEVSPACE_ALLOWED_ROOTS, status.allowedRoots.join(","));
  assert.equal(env.DEVSPACE_TOOL_MODE, "codex");
  assert.equal(env.DEVSPACE_WIDGETS, "off");
  assert.equal(env.DEVSPACE_SUBAGENTS, "1");
  assert.equal(env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
});

test("local server URLs normalize wildcard and IPv6 hosts", () => {
  assert.equal(localServerUrl("0.0.0.0", 7676, "/statusz").toString(), "http://127.0.0.1:7676/statusz");
  assert.equal(localServerUrl("::", 7676, "/healthz").toString(), "http://127.0.0.1:7676/healthz");
  assert.equal(localServerUrl("::1", 7676, "/mcp").toString(), "http://[::1]:7676/mcp");
});

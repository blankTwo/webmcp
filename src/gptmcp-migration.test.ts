import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createRuntimeStatus, restartEnvironment } from "./runtime-status.js";

const ownerToken = "test-owner-token-that-is-long-enough";

test("GPTMCP environment variables take precedence over legacy DevSpace aliases", () => {
  const configDir = mkdtempSync(join(tmpdir(), "gptmcp-config-"));
  const config = loadConfig({
    GPTMCP_CONFIG_DIR: configDir,
    GPTMCP_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_OAUTH_OWNER_TOKEN: "legacy-owner-token-that-is-long-enough",
    GPTMCP_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_ALLOWED_ROOTS: tmpdir(),
    GPTMCP_PUBLIC_BASE_URL: "https://gptmcp.example.com",
    DEVSPACE_PUBLIC_BASE_URL: "https://legacy.example.com",
  });

  assert.equal(config.oauth.ownerToken, ownerToken);
  assert.deepEqual(config.allowedRoots, [process.cwd()]);
  assert.equal(config.publicBaseUrl, "https://gptmcp.example.com");
  assert.deepEqual(config.oauth.scopes, ["gptmcp"]);
});

test("legacy DevSpace environment variables remain readable", () => {
  const configDir = mkdtempSync(join(tmpdir(), "gptmcp-legacy-config-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  });
  assert.equal(config.oauth.ownerToken, ownerToken);
  assert.deepEqual(config.allowedRoots, [process.cwd()]);
});

test("runtime identity and restart environment use GPTMCP names", () => {
  const configDir = mkdtempSync(join(tmpdir(), "gptmcp-status-"));
  const config = loadConfig({
    GPTMCP_CONFIG_DIR: configDir,
    GPTMCP_OAUTH_OWNER_TOKEN: ownerToken,
    GPTMCP_ALLOWED_ROOTS: process.cwd(),
  });
  const status = createRuntimeStatus(config, { GPTMCP_CONFIG_DIR: configDir });
  const environment = restartEnvironment(status, {});
  assert.equal(status.name, "gptmcp");
  assert.equal(environment.GPTMCP_CONFIG_DIR, configDir);
  assert.equal(environment.GPTMCP_ALLOWED_ROOTS, process.cwd());
  assert.equal(environment.DEVSPACE_CONFIG_DIR, undefined);
});

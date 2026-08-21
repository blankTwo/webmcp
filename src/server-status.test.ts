import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { DEVSPACE_VERSION } from "./version.js";

const OWNER_TOKEN = "test-owner-token-that-is-long-enough";

test("healthz is public and statusz requires the owner token", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-status-test-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const runtime = createServer(config);
  const httpServer = runtime.app.listen(0, "127.0.0.1");

  try {
    await once(httpServer, "listening");
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${origin}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.name, "devspace");
    assert.equal(health.version, DEVSPACE_VERSION);
    assert.equal(typeof health.nodeVersion, "string");
    assert.equal(typeof health.uptimeSeconds, "number");
    assert.equal("allowedRoots" in health, false);
    assert.equal("cwd" in health, false);
    assert.equal("pid" in health, false);

    const unauthorized = await fetch(`${origin}/statusz`);
    assert.equal(unauthorized.status, 401);

    const unauthorizedConsole = await fetch(`${origin}/console/snapshot`);
    assert.equal(unauthorizedConsole.status, 401);
    const unauthorizedHistory = await fetch(`${origin}/console/history?workspaceRoot=${encodeURIComponent(root)}`);
    assert.equal(unauthorizedHistory.status, 401);

    const consoleResponse = await fetch(`${origin}/console/snapshot`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(consoleResponse.status, 200);
    assert.equal(consoleResponse.headers.get("cache-control"), "no-store");
    const consoleSnapshot = await consoleResponse.json() as Record<string, unknown>;
    assert.equal(Array.isArray(consoleSnapshot.workspaces), true);
    assert.equal(Array.isArray(consoleSnapshot.events), true);
    assert.equal(consoleSnapshot.streamSubscribers, 0);
    const initialConsoleSettings = consoleSnapshot.settings as Record<string, unknown>;
    assert.equal(initialConsoleSettings.retentionDays, 7);
    assert.equal(initialConsoleSettings.storedEvents, 0);
    assert.equal(typeof initialConsoleSettings.databasePath, "string");
    assert.equal(typeof initialConsoleSettings.databaseBytes, "number");

    const unauthorizedWorkspace = await fetch(`${origin}/console/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(unauthorizedWorkspace.status, 401);

    const missingWorkspacePath = await fetch(`${origin}/console/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missingWorkspacePath.status, 400);

    const addWorkspaceResponse = await fetch(`${origin}/console/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(addWorkspaceResponse.status, 201);
    const addedWorkspace = await addWorkspaceResponse.json() as { workspace?: { root?: string }; reused?: boolean };
    assert.equal(addedWorkspace.workspace?.root, root);
    assert.equal(addedWorkspace.reused, false);

    const reuseWorkspaceResponse = await fetch(`${origin}/console/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(reuseWorkspaceResponse.status, 200);
    const reusedWorkspace = await reuseWorkspaceResponse.json() as { reused?: boolean };
    assert.equal(reusedWorkspace.reused, true);

    const unauthorizedProcesses = await fetch(`${origin}/console/processes?workspaceRoot=${encodeURIComponent(root)}`);
    assert.equal(unauthorizedProcesses.status, 401);

    const processListResponse = await fetch(`${origin}/console/processes?workspaceRoot=${encodeURIComponent(root)}`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(processListResponse.status, 200);
    const processList = await processListResponse.json() as { processes?: unknown[] };
    assert.deepEqual(processList.processes, []);

    const missingProcessOutput = await fetch(`${origin}/console/processes/1/output?workspaceId=missing`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(missingProcessOutput.status, 404);

    const missingProcessTerminate = await fetch(`${origin}/console/processes/1/terminate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({ workspaceId: "missing" }),
    });
    assert.equal(missingProcessTerminate.status, 404);

    const missingHistoryRoot = await fetch(`${origin}/console/history`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(missingHistoryRoot.status, 400);

    const historyResponse = await fetch(`${origin}/console/history?workspaceRoot=${encodeURIComponent(root)}&limit=25`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as Record<string, unknown>;
    assert.equal(history.ok, true);
    assert.equal(Array.isArray(history.events), true);
    assert.equal(typeof history.hasMore, "boolean");
    assert.equal(typeof history.total, "number");

    const unauthorizedFavorite = await fetch(`${origin}/console/events/missing/favorite`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(unauthorizedFavorite.status, 401);

    const missingFavorite = await fetch(`${origin}/console/events/missing/favorite`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(missingFavorite.status, 404);

    const unauthorizedSettings = await fetch(`${origin}/console/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retentionDays: 30 }),
    });
    assert.equal(unauthorizedSettings.status, 401);

    const settingsResponse = await fetch(`${origin}/console/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-devspace-owner-token": OWNER_TOKEN,
      },
      body: JSON.stringify({ retentionDays: 30 }),
    });
    assert.equal(settingsResponse.status, 200);
    const settingsResult = await settingsResponse.json() as {
      ok?: boolean;
      settings?: { retentionDays?: number };
    };
    assert.equal(settingsResult.ok, true);
    assert.equal(settingsResult.settings?.retentionDays, 30);

    const unauthorizedCleanup = await fetch(`${origin}/console/cleanup`, { method: "POST" });
    assert.equal(unauthorizedCleanup.status, 401);
    const cleanupResponse = await fetch(`${origin}/console/cleanup`, {
      method: "POST",
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(cleanupResponse.status, 200);

    const unauthorizedClear = await fetch(`${origin}/console/events`, { method: "DELETE" });
    assert.equal(unauthorizedClear.status, 401);
    const clearResponse = await fetch(`${origin}/console/events`, {
      method: "DELETE",
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(clearResponse.status, 200);
    const clearResult = await clearResponse.json() as { settings?: { storedEvents?: number } };
    assert.equal(clearResult.settings?.storedEvents, 0);

    const statusResponse = await fetch(`${origin}/statusz`, {
      headers: { "x-devspace-owner-token": OWNER_TOKEN },
    });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("cache-control"), "no-store");
    const status = await statusResponse.json() as Record<string, unknown>;
    assert.equal(status.ok, true);
    assert.equal(status.version, DEVSPACE_VERSION);
    assert.equal(status.pid, process.pid);
    assert.equal(status.cwd, process.cwd());
    assert.deepEqual(status.allowedRoots, config.allowedRoots);
    assert.equal(status.toolMode, config.toolMode);
    assert.equal(status.widgets, config.widgets);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      httpServer.close((error) => error ? reject(error) : resolveClose());
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelLocalAgentSession,
  getLocalAgentSession,
  listLocalAgentSessions,
} from "./local-agent-service.js";
import { LocalAgentStore } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-service-test-"));
const store = new LocalAgentStore(root);
let child: ReturnType<typeof spawn> | undefined;

try {
  const record = store.create({
    workspaceId: "ws_a",
    workspaceRoot: join(root, "project-a"),
    profileName: "reviewer",
    provider: "codex",
  });

  assert.equal(
    getLocalAgentSession(store, "ws_a", join(root, "project-a"), record.id).id,
    record.id,
  );
  const legacy = store.create({
    workspaceRoot: join(root, "project-a"),
    profileName: "legacy-reviewer",
    provider: "codex",
  });
  assert.deepEqual(
    new Set(listLocalAgentSessions(store, "ws_a", join(root, "project-a")).map((agent) => agent.id)),
    new Set([record.id, legacy.id]),
  );
  assert.throws(
    () => getLocalAgentSession(store, "ws_b", join(root, "project-b"), record.id),
    /belongs to another workspace/,
  );

  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  child.unref();
  store.update(record.id, {
    status: "running",
    workerPid: child.pid,
  });

  assert.throws(
    () => cancelLocalAgentSession(store, "ws_b", join(root, "project-b"), record.id),
    /belongs to another workspace/,
  );
  const stopped = cancelLocalAgentSession(
    store,
    "ws_a",
    join(root, "project-a"),
    record.id,
  );
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.workerPid, undefined);
} finally {
  if (child?.pid) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // The cancellation path should already have terminated it.
    }
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
}

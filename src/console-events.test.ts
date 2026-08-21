import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConsoleEventStore,
  DEFAULT_CONSOLE_RETENTION_DAYS,
} from "./console-events.js";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("console event store retains recent tool events and notifies subscribers", () => {
  const store = new ConsoleEventStore(2);
  const seen: string[] = [];
  const unsubscribe = store.subscribe((event) => seen.push(event.tool));

  store.publish({ tool: "read", workspaceId: "ws_1", success: true, durationMs: 2, path: "src/a.ts" });
  store.publish({ tool: "edit", workspaceId: "ws_1", success: true, durationMs: 4, path: "src/a.ts" });
  store.publish({ tool: "exec_command", workspaceId: "ws_1", success: true, durationMs: 8, commandPreview: "npm test" });

  assert.deepEqual(seen, ["read", "edit", "exec_command"]);
  assert.equal(store.subscriberCount(), 1);
  assert.deepEqual(store.recent(10).map((event) => event.tool), ["edit", "exec_command"]);
  const memoryFavorite = store.setFavorite(store.recent(1)[0]!.id, true);
  assert.equal(memoryFavorite?.favorite, true);

  unsubscribe();
  assert.equal(store.subscriberCount(), 0);
});

test("console event store persists events and retention settings in SQLite", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-console-events-test-"));

  try {
    const workspaceStore = new SqliteWorkspaceStore(stateDir);
    workspaceStore.createSession({ id: "ws_sqlite", root: "D:\\project" });
    workspaceStore.createSession({ id: "ws_other", root: "D:\\other" });
    workspaceStore.close();

    const first = new ConsoleEventStore(2_000, stateDir);
    const initialSettings = first.settings();
    assert.equal(initialSettings.retentionDays, DEFAULT_CONSOLE_RETENTION_DAYS);
    assert.equal(initialSettings.storedEvents, 0);
    assert.equal(typeof initialSettings.databasePath, "string");
    assert.equal(typeof initialSettings.databaseBytes, "number");

    first.publish({
      tool: "read",
      workspaceId: "ws_sqlite",
      path: "src/server.ts",
      success: true,
      durationMs: 3,
      consoleUi: {
        resource: "tool/read",
        card: {
          workspaceId: "ws_sqlite",
          path: "src/server.ts",
          summary: { lines: 12, characters: 240 },
          payload: { content: [{ type: "text", text: "server source" }] },
        },
      },
    });
    first.publish({
      tool: "edit",
      workspaceId: "ws_sqlite",
      path: "src/server.ts",
      success: true,
      durationMs: 4,
    });
    first.publish({
      tool: "bash",
      workspaceId: "ws_other",
      commandPreview: "npm test",
      success: true,
      durationMs: 5,
    });
    assert.equal(first.settings().storedEvents, 3);

    const firstPage = first.history({ workspaceRoot: "D:\\project", limit: 1 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.events[0]?.tool, "edit");
    assert.equal(firstPage.hasMore, true);
    const favoriteEvent = first.setFavorite(firstPage.events[0]!.id, true);
    assert.equal(favoriteEvent?.favorite, true);
    assert.equal(first.history({ workspaceRoot: "D:\\project", limit: 1 }).events[0]?.favorite, true);
    assert.ok(firstPage.nextCursor);
    const secondPage = first.history({
      workspaceRoot: "D:\\project",
      limit: 1,
      before: firstPage.nextCursor,
    });
    assert.equal(secondPage.events[0]?.tool, "read");
    assert.equal(secondPage.events[0]?.consoleUi?.resource, "tool/read");
    assert.equal(secondPage.events[0]?.consoleUi?.card.path, "src/server.ts");
    assert.equal(secondPage.hasMore, false);

    const directDatabase = openDatabase(stateDir);
    directDatabase.sqlite.prepare(`
      insert into console_tool_events (
        id, timestamp, tool, workspace_id, success, duration_ms
      ) values (?, ?, ?, ?, ?, ?)
    `).run("old-event", "2000-01-01T00:00:00.000Z", "read", "ws_sqlite", 1, 1);
    directDatabase.close();
    assert.equal(first.settings().storedEvents, 4);
    for (const days of [1, 3, 7, 14, 30, 90]) {
      assert.equal(first.setRetentionDays(days).retentionDays, days);
    }
    assert.equal(first.settings().storedEvents, 3);
    first.close();

    const restored = new ConsoleEventStore(2_000, stateDir);
    assert.equal(restored.settings().retentionDays, 90);
    assert.equal(restored.settings().storedEvents, 3);
    assert.deepEqual(restored.recent(10).map((event) => event.tool), ["read", "edit", "bash"]);
    const restoredProjectEvents = restored.history({ workspaceRoot: "D:\\project", limit: 10 }).events;
    assert.equal(restoredProjectEvents[0]?.favorite, true);
    assert.equal(restoredProjectEvents.find((event) => event.tool === "read")?.consoleUi?.resource, "tool/read");
    assert.throws(() => restored.setRetentionDays(0), /retentionDays/);
    restored.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("console history pages 10,000 persisted events without loading them all", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-console-scale-test-"));

  try {
    const workspaceStore = new SqliteWorkspaceStore(stateDir);
    workspaceStore.createSession({ id: "ws_scale", root: "D:\\scale-project" });
    workspaceStore.close();

    const database = openDatabase(stateDir);
    const insert = database.sqlite.prepare(`
      insert into console_tool_events (
        id, timestamp, tool, workspace_id, success, duration_ms
      ) values (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = database.sqlite.transaction(() => {
      const base = Date.parse("2026-08-19T00:00:00.000Z");
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(
          `scale-${String(index).padStart(5, "0")}`,
          new Date(base + index).toISOString(),
          index % 2 === 0 ? "read" : "edit",
          "ws_scale",
          1,
          index % 13,
        );
      }
    });
    insertMany();
    database.close();

    const store = new ConsoleEventStore(2_000, stateDir);
    const firstPage = store.history({ workspaceRoot: "D:\\scale-project", limit: 100 });
    assert.equal(firstPage.events.length, 100);
    assert.equal(firstPage.total, 10_000);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);

    const secondPage = store.history({
      workspaceRoot: "D:\\scale-project",
      limit: 100,
      before: firstPage.nextCursor,
    });
    assert.equal(secondPage.events.length, 100);
    assert.equal(secondPage.total, 10_000);
    assert.equal(
      firstPage.events.some((event) => secondPage.events.some((next) => next.id === event.id)),
      false,
    );
    store.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

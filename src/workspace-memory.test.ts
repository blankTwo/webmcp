import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceContinuation,
  normalizeResumeState,
  type WorkspaceResumeRecord,
} from "./workspace-memory.js";

test("resume state is bounded and redacts common secret-shaped values", () => {
  const state = normalizeResumeState({
    goal: "Ship resume memory token=super-secret-token-value",
    currentTask: "Use Authorization:Bearer abcdefghijklmnopqrstuvwxyz safely",
    decisions: Array.from({ length: 20 }, (_, index) => `decision-${index}-${"x".repeat(300)}`),
    files: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`),
  });

  assert.match(state.goal, /token=\[redacted\]/i);
  assert.match(state.currentTask, /Authorization:\[redacted\]/i);
  assert.equal(state.decisions.length, 5);
  assert.equal(state.files.length, 10);
  assert.ok(state.decisions.every((item) => item.length <= 240));
});

test("continuation marks a checkpoint stale when Git HEAD changed", () => {
  const saved: WorkspaceResumeRecord = {
    workspaceKey: "checkout:/repo",
    root: "/repo",
    mode: "checkout",
    checkpointId: "checkpoint-1",
    updatedAt: "2026-08-20T00:00:00.000Z",
    state: normalizeResumeState({
      goal: "Keep work resumable",
      currentTask: "Implement continuation",
      next: ["Run tests"],
    }),
    facts: {
      capturedAt: "2026-08-20T00:00:00.000Z",
      gitBranch: "main",
      gitHead: "1111111111111111111111111111111111111111",
      changedFiles: [],
    },
  };

  const continuation = buildWorkspaceContinuation(saved, {
    capturedAt: "2026-08-20T01:00:00.000Z",
    gitBranch: "main",
    gitHead: "2222222222222222222222222222222222222222",
    changedFiles: ["src/server.ts"],
  });

  assert.equal(continuation.stale, true);
  assert.match(continuation.staleReason ?? "", /11111111.*22222222/);
  assert.match(continuation.text, /Current user instructions.*take precedence/);
  assert.ok(continuation.text.length <= 4_000);
});

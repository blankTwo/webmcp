import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { moveWorkspacePath } from "./move-file.js";

test("moveWorkspacePath moves a file without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-move-file-test-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dst"));
    await writeFile(join(root, "src", "a.txt"), "hello");

    const moved = await moveWorkspacePath(root, "src/a.txt", "dst/b.txt");
    assert.deepEqual(moved, { source: "src/a.txt", destination: "dst/b.txt" });
    assert.equal(await readFile(join(root, "dst", "b.txt"), "utf8"), "hello");
    await assert.rejects(readFile(join(root, "src", "a.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moveWorkspacePath refuses an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-move-file-test-"));
  try {
    await writeFile(join(root, "source.txt"), "source");
    await writeFile(join(root, "destination.txt"), "destination");

    await assert.rejects(
      moveWorkspacePath(root, "source.txt", "destination.txt"),
      /Destination already exists/,
    );
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "source");
    assert.equal(await readFile(join(root, "destination.txt"), "utf8"), "destination");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

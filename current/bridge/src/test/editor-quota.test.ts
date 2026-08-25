import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { editorForTest } from "../brokered-tool-host.js";
import { directoryAllocatedBytes } from "../resource-controls.js";
import type { TaskRecord } from "../types.js";

test("editor aggregate quota rejects growth and rolls create/replace back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-editor-quota-"));
  try {
    const existing = path.join(root, "existing.txt");
    await writeFile(existing, "before\n");
    const initialBytes = await directoryAllocatedBytes(root);
    const task = {
      worktreePath: root,
      harnessWritePaths: ["**"],
      resourceProfile: { worktreeMaxBytes: initialBytes + 4_096 },
    } as TaskRecord;
    await assert.rejects(editorForTest(task, {
      command: "create",
      path: "created.txt",
      file_text: "x".repeat(128 * 1024),
    }), /aggregate worktree quota/u);
    await assert.rejects(readFile(path.join(root, "created.txt"), "utf8"), /ENOENT/u);

    await assert.rejects(editorForTest(task, {
      command: "str_replace",
      path: "existing.txt",
      old_str: "before",
      new_str: "y".repeat(128 * 1024),
    }), /aggregate worktree quota/u);
    assert.equal(await readFile(existing, "utf8"), "before\n");
    assert.ok(await directoryAllocatedBytes(root) <= initialBytes + 4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

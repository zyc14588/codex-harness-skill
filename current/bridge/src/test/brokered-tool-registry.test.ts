import assert from "node:assert/strict";
import test from "node:test";
import { BrokeredToolProcessRegistry } from "../brokered-tool-registry.js";
import type { ProcessIdentity } from "../types.js";

const identity: ProcessIdentity = {
  schemaVersion: 1,
  pid: 12345,
  processGroupId: 12345,
  startTimeTicks: "999",
  executablePath: "/usr/bin/node",
  executableSha256: "a".repeat(64),
  capturedAt: "2026-08-25T00:00:00.000Z",
};

test("brokered tool registry binds task/attempt/process identity and cancels idempotently", async () => {
  const registry = new BrokeredToolProcessRegistry();
  const request = new AbortController();
  const lease = registry.open("task-1", "attempt-1", request.signal);
  lease.bindProcess(identity);
  assert.deepEqual(registry.snapshot().map((entry) => ({
    taskId: entry.taskId,
    attemptId: entry.attemptId,
    processIdentity: entry.processIdentity,
  })), [{ taskId: "task-1", attemptId: "attempt-1", processIdentity: identity }]);
  assert.equal(registry.abortAttemptMismatch("task-1", "attempt-2"), 1);
  assert.equal(lease.signal.aborted, true);
  assert.equal(registry.abortAttemptMismatch("task-1", "attempt-2"), 0);
  assert.equal(registry.abortTask("task-1"), 0);
  lease.close();
  lease.close();
  assert.equal(await registry.waitForEmpty(50), true);
});

test("brokered tool registry propagates request abort and shutdown leaves no entries", async () => {
  const registry = new BrokeredToolProcessRegistry();
  const firstRequest = new AbortController();
  const first = registry.open("task-1", "attempt-1", firstRequest.signal);
  firstRequest.abort("client closed");
  assert.equal(first.signal.aborted, true);
  const second = registry.open("task-2", "attempt-2", new AbortController().signal);
  assert.equal(registry.abortAll("SIGTERM"), 1);
  assert.equal(second.signal.aborted, true);
  first.close();
  second.close();
  assert.equal(registry.snapshot().length, 0);
  assert.equal(await registry.waitForEmpty(50), true);
});

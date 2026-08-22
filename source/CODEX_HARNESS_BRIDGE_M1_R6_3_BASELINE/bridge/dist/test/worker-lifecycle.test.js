import test from "node:test";
import assert from "node:assert/strict";
import { decideWorkerLiveness } from "../worker-lifecycle.js";
test("worker orphaning requires a second dead observation after the grace interval", () => {
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    assert.equal(decideWorkerLiveness(true, false, undefined, now, 2_000), "observe-dead");
    assert.equal(decideWorkerLiveness(true, false, "2026-08-20T23:59:59.000Z", now, 2_000), "none");
    assert.equal(decideWorkerLiveness(true, false, "2026-08-20T23:59:58.000Z", now, 2_000), "orphan");
});
test("a live worker clears a stale dead observation and terminal tasks are ignored", () => {
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    assert.equal(decideWorkerLiveness(true, true, "2026-08-20T23:59:50.000Z", now, 2_000), "clear-dead-observation");
    assert.equal(decideWorkerLiveness(false, false, "2026-08-20T23:59:50.000Z", now, 2_000), "none");
    assert.equal(decideWorkerLiveness(true, false, "not-a-date", now, 2_000), "observe-dead");
});
//# sourceMappingURL=worker-lifecycle.test.js.map
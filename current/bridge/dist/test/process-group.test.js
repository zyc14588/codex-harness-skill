import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runProcess, sleep } from "../util.js";
async function linuxProcessState(pid) {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        return end >= 0 ? stat.slice(end + 2).split(" ", 1)[0] : undefined;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
test("process-group execution kills background descendants after command exit", { skip: process.platform !== "linux" }, async () => {
    const result = await runProcess("bash", ["--noprofile", "--norc", "-lc", "sleep 30 >/dev/null 2>&1 & echo $!"], {
        timeoutMs: 5_000,
        killProcessGroup: true,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `invalid child pid: ${result.stdout}`);
    await sleep(100);
    const state = await linuxProcessState(pid);
    assert.ok(state === undefined || state === "Z", `background descendant remained live with state ${state}`);
});
test("timed-out execution keeps a verified group leader until TERM-resistant descendants are removed", { skip: process.platform !== "linux" }, async () => {
    const result = await runProcess("bash", ["--noprofile", "--norc", "-lc", "trap 'exit 0' TERM; (trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $!; wait"], {
        timeoutMs: 100,
        killProcessGroup: true,
    });
    assert.equal(result.timedOut, true);
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `invalid timeout descendant pid: ${result.stdout}`);
    await sleep(100);
    const state = await linuxProcessState(pid);
    assert.ok(state === undefined || state === "Z", `TERM-resistant descendant remained live with state ${state}`);
});
test("AbortSignal terminates and reaps a verified process group idempotently", { skip: process.platform !== "linux" }, async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess("bash", ["--noprofile", "--norc", "-lc", "(trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $!; wait"], {
        timeoutMs: 30_000,
        killProcessGroup: true,
        signal: controller.signal,
        abortGraceMs: 250,
    });
    await sleep(150);
    controller.abort("test cancellation");
    controller.abort("duplicate cancellation");
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 3_000, "aborted group was not reaped promptly");
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `invalid aborted descendant pid: ${result.stdout}`);
    await sleep(100);
    const state = await linuxProcessState(pid);
    assert.ok(state === undefined || state === "Z", `aborted descendant remained live with state ${state}`);
});
//# sourceMappingURL=process-group.test.js.map
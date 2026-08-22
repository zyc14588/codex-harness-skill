import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runProcess, sleep } from "../util.js";

async function linuxProcessState(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    return end >= 0 ? stat.slice(end + 2).split(" ", 1)[0] : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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

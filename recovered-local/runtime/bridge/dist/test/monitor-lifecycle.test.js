import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stopMonitor } from "../monitor.js";
import { processAlive } from "../util.js";
import { testConfig } from "./test-config.js";
test("a legacy stale monitor PID record never authorizes killing an unrelated live process", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-monitor-pid-reuse-"));
    const config = testConfig(root, {
        monitor: {
            ...testConfig(root).monitor,
            enabled: true,
            port: 65_321,
        },
    });
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    assert.ok(child.pid);
    const pid = child.pid;
    try {
        const monitorDir = path.join(root, "monitor");
        await mkdir(monitorDir, { recursive: true });
        await writeFile(path.join(monitorDir, "monitor.pid.json"), `${JSON.stringify({
            pid,
            startedAt: new Date().toISOString(),
            configPath: path.join(root, "config.json"),
            baseUrl: `http://127.0.0.1:${config.monitor.port}`,
        }, null, 2)}\n`);
        const result = await stopMonitor(config);
        assert.equal(result.stopped, false);
        assert.equal(processAlive(pid), true);
    }
    finally {
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch { /* gone */ }
        }
    }
});
//# sourceMappingURL=monitor-lifecycle.test.js.map
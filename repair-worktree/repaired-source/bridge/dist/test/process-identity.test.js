import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { captureProcessIdentity, captureSettledProcessIdentity, processIdentityMatches, signalVerifiedProcessGroup } from "../process-identity.js";
import { sleep } from "../util.js";
test("signals require exact PID lifetime, executable hash, and process-group leadership", { skip: process.platform !== "linux" }, async () => {
    const child = spawn("/usr/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
    assert.ok(child.pid);
    const identity = await captureProcessIdentity(child.pid);
    try {
        assert.equal(identity.processGroupId, identity.pid);
        assert.equal(await processIdentityMatches(identity), true);
        assert.equal(await signalVerifiedProcessGroup({ ...identity, startTimeTicks: `${identity.startTimeTicks}0` }, "SIGTERM"), false);
        assert.equal(await signalVerifiedProcessGroup({ ...identity, executableSha256: "0".repeat(64) }, "SIGTERM"), false);
        await assert.rejects(signalVerifiedProcessGroup({ ...identity, processGroupId: identity.processGroupId + 1 }, "SIGTERM"), /non-leader process group/);
        assert.equal(await processIdentityMatches(identity), true, "forged identities signalled the live process");
        assert.equal(await signalVerifiedProcessGroup(identity, "SIGTERM"), true);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && await processIdentityMatches(identity))
            await sleep(20);
        assert.equal(await processIdentityMatches(identity), false);
    }
    finally {
        if (await processIdentityMatches(identity))
            await signalVerifiedProcessGroup(identity, "SIGKILL");
    }
});
test("spawn identity waits through a script interpreter exec transition", { skip: process.platform !== "linux" }, async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 0.03; exec /usr/bin/sleep 30"], { detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
    assert.ok(child.pid);
    const identity = await captureSettledProcessIdentity(child.pid);
    try {
        assert.equal(identity.processGroupId, identity.pid);
        assert.match(identity.executablePath, /\/sleep$/u);
        assert.equal(await processIdentityMatches(identity), true);
    }
    finally {
        await signalVerifiedProcessGroup(identity, "SIGKILL");
    }
});
//# sourceMappingURL=process-identity.test.js.map
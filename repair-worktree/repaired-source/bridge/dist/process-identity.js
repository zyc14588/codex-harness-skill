import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
const executableDigestCache = new Map();
async function sha256File(target) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(target))
        hash.update(chunk);
    return hash.digest("hex");
}
function digestMetadata(info) {
    return [info.dev, info.ino, info.size, info.mode, info.uid, info.gid, info.mtimeMs, info.ctimeMs].join(":");
}
async function sha256StableExecutable(target) {
    const before = await stat(target);
    const metadata = digestMetadata(before);
    const cached = executableDigestCache.get(target);
    if (cached?.metadata === metadata)
        return cached.sha256;
    const sha256 = await sha256File(target);
    const after = await stat(target);
    if (digestMetadata(after) !== metadata)
        throw new Error(`executable changed while hashing: ${target}`);
    executableDigestCache.set(target, { metadata, sha256 });
    return sha256;
}
function parseProcStat(text) {
    const close = text.lastIndexOf(")");
    if (close < 0)
        throw new Error("/proc stat has no closing command delimiter");
    // The tail starts at field 3 (state). pgrp is field 5 and starttime is field 22.
    const fields = text.slice(close + 2).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const startTimeTicks = fields[19];
    if (!Number.isInteger(processGroupId) || processGroupId <= 0 || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
        throw new Error("/proc stat is missing pgrp or starttime identity fields");
    }
    return { processGroupId, startTimeTicks };
}
/** Capture an identity which remains safe across PID reuse. Linux is mandatory. */
export async function captureProcessIdentity(pid) {
    if (process.platform !== "linux")
        throw new Error("strong process identity requires Linux /proc");
    if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(`invalid process PID: ${pid}`);
    const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    const executablePath = await realpath(`/proc/${pid}/exe`);
    const executableSha256 = await sha256StableExecutable(executablePath);
    // Close the capture race: the lifetime must still be identical after hashing the executable.
    const after = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (after.startTimeTicks !== stat.startTimeTicks || after.processGroupId !== stat.processGroupId) {
        throw new Error(`process ${pid} changed identity while it was being captured`);
    }
    if (await realpath(`/proc/${pid}/exe`) !== executablePath) {
        throw new Error(`process ${pid} executed a different binary while its identity was being captured`);
    }
    return {
        schemaVersion: 1,
        pid,
        processGroupId: stat.processGroupId,
        startTimeTicks: stat.startTimeTicks,
        executablePath,
        executableSha256,
        capturedAt: new Date().toISOString(),
    };
}
/**
 * Capture a newly spawned process only after its interpreter/launcher exec
 * transition has settled. The identity must remain exact for the stability
 * window; any later exec still invalidates ordinary identity checks.
 */
export async function captureSettledProcessIdentity(pid, timeoutMs = 2_000, stableMs = 75) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const identity = await captureProcessIdentity(pid);
            await new Promise((resolve) => setTimeout(resolve, stableMs));
            if (await processIdentityMatches(identity))
                return identity;
        }
        catch (error) {
            lastError = error;
        }
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`process ${pid} did not reach a stable executable identity within ${timeoutMs}ms${detail}`);
}
export async function processIdentityMatches(identity) {
    if (!identity || process.platform !== "linux")
        return false;
    try {
        const current = await captureProcessIdentity(identity.pid);
        return current.pid === identity.pid
            && current.processGroupId === identity.processGroupId
            && current.startTimeTicks === identity.startTimeTicks
            && current.executablePath === identity.executablePath
            && current.executableSha256 === identity.executableSha256;
    }
    catch {
        return false;
    }
}
export async function assertProcessIdentity(identity, label) {
    if (!await processIdentityMatches(identity)) {
        throw new Error(`${label} process identity no longer matches PID ${identity.pid}; refusing process control`);
    }
}
/**
 * Signal only a verified process lifetime. The process group is accepted only
 * when it is led by the recorded PID, preventing a forged/stale PGID from
 * becoming signal authority.
 */
export async function signalVerifiedProcessGroup(identity, signal) {
    if (identity.processGroupId !== identity.pid) {
        throw new Error(`refusing to signal non-leader process group ${identity.processGroupId} for PID ${identity.pid}`);
    }
    if (!await processIdentityMatches(identity))
        return false;
    try {
        process.kill(-identity.processGroupId, signal);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "ESRCH")
            return false;
        throw error;
    }
}
export async function sha256Executable(target) {
    const canonical = await realpath(target);
    const info = await stat(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0)
        throw new Error(`allowlisted executable must be an executable regular file: ${canonical}`);
    if ((info.mode & 0o022) !== 0)
        throw new Error(`allowlisted executable must not be group/world writable: ${canonical}`);
    if (typeof process.getuid === "function" && info.uid !== 0 && info.uid !== process.getuid()) {
        throw new Error(`allowlisted executable must be owned by root or uid ${process.getuid()}: ${canonical}`);
    }
    return { realpath: canonical, sha256: await sha256StableExecutable(canonical) };
}
//# sourceMappingURL=process-identity.js.map
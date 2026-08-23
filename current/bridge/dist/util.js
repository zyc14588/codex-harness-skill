import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, readFileSync } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, readlink, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessIdentity, signalVerifiedProcessGroup } from "./process-identity.js";
const MAX_CAPTURE_CHARS = 1_000_000;
export function nowIso() {
    return new Date().toISOString();
}
export function expandHome(input) {
    if (input === "~")
        return os.homedir();
    if (input.startsWith("~/"))
        return path.join(os.homedir(), input.slice(2));
    return input;
}
export async function pathExists(target) {
    try {
        await access(target, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function ensureDir(target) {
    await mkdir(target, { recursive: true, mode: 0o700 });
}
export async function readJson(target) {
    return JSON.parse(await readFile(target, "utf8"));
}
export async function atomicWriteJson(target, value) {
    await ensureDir(path.dirname(target));
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
}
export function safeTaskId(input) {
    if (input) {
        const cleaned = input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.length > 80) {
            throw new Error("taskId must resolve to 1-80 safe non-traversal characters");
        }
        return cleaned;
    }
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const random = Math.random().toString(16).slice(2, 10);
    return `chb-${stamp}-${random}`;
}
export function normalizeRepoRelative(input) {
    const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized === "." || normalized === ".." ||
        normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) {
        throw new Error(`invalid repository-relative path: ${input}`);
    }
    return normalized.replace(/\/$/, "");
}
export function validateLeasePattern(input) {
    const normalized = normalizeRepoRelative(input);
    if (normalized === ".git" || normalized.startsWith(".git/")) {
        throw new Error(`Git administrative paths cannot be leased: ${input}`);
    }
    if (normalized === "**")
        return normalized;
    if (normalized.endsWith("/**")) {
        const prefix = normalized.slice(0, -3);
        if (!prefix || prefix.includes("*") || prefix.includes("?"))
            throw new Error(`invalid directory lease: ${input}`);
        return `${prefix}/**`;
    }
    if (normalized.includes("*") || normalized.includes("?")) {
        throw new Error(`lease patterns support only exact files, directory/**, or **: ${input}`);
    }
    return normalized;
}
export function leaseMatches(lease, filePath) {
    const file = normalizeRepoRelative(filePath);
    if (lease === "**")
        return true;
    if (lease.endsWith("/**")) {
        const prefix = lease.slice(0, -3).replace(/\/$/, "");
        return file === prefix || file.startsWith(`${prefix}/`);
    }
    return file === lease;
}
function leaseRoot(lease) {
    if (lease === "**")
        return "";
    return lease.endsWith("/**") ? lease.slice(0, -3).replace(/\/$/, "") : lease;
}
export function leasesOverlap(a, b) {
    if (a === "**" || b === "**")
        return true;
    const aDir = a.endsWith("/**");
    const bDir = b.endsWith("/**");
    const ar = leaseRoot(a);
    const br = leaseRoot(b);
    if (!aDir && !bDir)
        return ar === br;
    if (aDir && bDir)
        return ar === br || ar.startsWith(`${br}/`) || br.startsWith(`${ar}/`);
    if (aDir)
        return br === ar || br.startsWith(`${ar}/`);
    return ar === br || ar.startsWith(`${br}/`);
}
export function assertDisjointLeases(harness, codex) {
    for (const h of harness) {
        for (const c of codex) {
            if (leasesOverlap(h, c))
                throw new Error(`write-scope overlap is forbidden: Harness '${h}' vs Codex '${c}'`);
        }
    }
}
export function isWithin(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function processAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        // kill(pid, 0) also succeeds for a zombie. Detached bridge daemons can
        // briefly remain as zombies when the surrounding environment has a slow
        // or minimal init/reaper. Treat that state as terminated so lifecycle
        // gates never wait on a process that cannot execute any more code.
        if (process.platform === "linux") {
            try {
                const procStat = readFileSync(`/proc/${pid}/stat`, "utf8");
                const closeParen = procStat.lastIndexOf(")");
                const state = closeParen >= 0 ? procStat.slice(closeParen + 2, closeParen + 3) : "";
                if (state === "Z" || state === "X")
                    return false;
            }
            catch {
                // /proc may be unavailable or the process may have disappeared after
                // kill(pid, 0). In the latter case the second probe below resolves it.
                try {
                    process.kill(pid, 0);
                }
                catch {
                    return false;
                }
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
export async function tailText(target, maxChars) {
    if (!(await pathExists(target)))
        return "";
    const boundedChars = Math.max(0, Math.min(maxChars, 1_000_000));
    if (boundedChars === 0)
        return "";
    const info = await stat(target);
    const readBytes = Math.min(info.size, boundedChars * 4);
    const handle = await open(target, "r");
    try {
        const buffer = Buffer.alloc(readBytes);
        await handle.read(buffer, 0, readBytes, Math.max(0, info.size - readBytes));
        const text = buffer.toString("utf8");
        return text.length <= boundedChars ? text : text.slice(-boundedChars);
    }
    finally {
        await handle.close();
    }
}
export function boundedText(value, field, maxChars) {
    const trimmed = value.trim();
    if (!trimmed)
        throw new Error(`${field} must not be empty`);
    if (trimmed.includes("\0"))
        throw new Error(`${field} must not contain NUL characters`);
    if (trimmed.length > maxChars)
        throw new Error(`${field} exceeds ${maxChars} characters`);
    return trimmed;
}
export function boundedStringList(values, field, maxItems, maxCharsPerItem) {
    if (values.length > maxItems)
        throw new Error(`${field} exceeds ${maxItems} items`);
    return values.map((value, index) => boundedText(value, `${field}[${index}]`, maxCharsPerItem));
}
async function updateHashWithFile(hash, target) {
    for await (const chunk of createReadStream(target))
        hash.update(chunk);
}
export async function sha256PathTree(target) {
    const root = path.resolve(target);
    const hash = createHash("sha256");
    const visit = async (absolute, relative) => {
        const info = await lstat(absolute);
        const mode = (info.mode & 0o7777).toString(8);
        if (info.isDirectory()) {
            hash.update(`D\0${relative}\0${mode}\0`);
            const entries = (await readdir(absolute)).sort((a, b) => a.localeCompare(b));
            for (const entry of entries) {
                await visit(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry);
            }
            return;
        }
        if (info.isSymbolicLink()) {
            hash.update(`L\0${relative}\0${mode}\0${await readlink(absolute)}\0`);
            return;
        }
        if (!info.isFile())
            throw new Error(`unsupported file type in hashed artifact tree: ${absolute}`);
        hash.update(`F\0${relative}\0${mode}\0${info.size}\0`);
        await updateHashWithFile(hash, absolute);
        hash.update("\0");
    };
    await visit(root, "");
    return hash.digest("hex");
}
export async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
export async function runProcess(command, args, options = {}) {
    const maxChars = options.maxCaptureChars ?? MAX_CAPTURE_CHARS;
    return await new Promise((resolve, reject) => {
        const useProcessGroup = options.killProcessGroup === true && process.platform !== "win32";
        const supervisorPath = fileURLToPath(new URL("./run-process-supervisor.js", import.meta.url));
        const spawnOptions = {
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            detached: useProcessGroup,
        };
        if (useProcessGroup) {
            spawnOptions.stdio = ["ignore", "pipe", "pipe", "ipc"];
            spawnOptions.env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" };
        }
        else {
            if (options.cwd !== undefined)
                spawnOptions.cwd = options.cwd;
            if (options.env !== undefined)
                spawnOptions.env = options.env;
        }
        const child = spawn(useProcessGroup ? process.execPath : command, useProcessGroup ? [supervisorPath] : args, spawnOptions);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timer;
        let escalationTimer;
        let reportedCode;
        let reportedSignal;
        let settled = false;
        const identityPromise = useProcessGroup
            ? new Promise((identityResolve, identityReject) => {
                child.once("spawn", () => {
                    if (!child.pid)
                        return identityReject(new Error("process supervisor spawned without a PID"));
                    void captureProcessIdentity(child.pid).then((identity) => {
                        if (identity.processGroupId !== identity.pid)
                            throw new Error("process supervisor did not become its process-group leader");
                        child.send?.({ type: "start", command, args, cwd: options.cwd, env: options.env, input: options.input });
                        identityResolve(identity);
                    }).catch(identityReject);
                });
            })
            : undefined;
        const append = (current, chunk, markTruncated) => {
            const next = current + chunk.toString("utf8");
            if (next.length <= maxChars)
                return next;
            markTruncated();
            return next.slice(-maxChars);
        };
        child.stdout?.on("data", (chunk) => {
            stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
        });
        child.stderr?.on("data", (chunk) => {
            stderr = append(stderr, chunk, () => { stderrTruncated = true; });
        });
        const signalProcess = async (signal) => {
            try {
                if (useProcessGroup && identityPromise)
                    await signalVerifiedProcessGroup(await identityPromise, signal);
                else
                    child.kill(signal);
            }
            catch { /* process already exited or lost its verified identity */ }
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (escalationTimer)
                clearTimeout(escalationTimer);
            reject(error);
        };
        child.once("error", fail);
        identityPromise?.catch((error) => {
            try {
                child.kill("SIGKILL");
            }
            catch { /* failed supervisor is already gone */ }
            fail(error);
        });
        if (useProcessGroup) {
            child.on("message", (raw) => {
                const message = raw;
                if (message?.type === "command-error") {
                    void signalProcess("SIGKILL");
                    fail(new Error(message.error ?? "supervised command failed to spawn"));
                }
                else if (message?.type === "command-result") {
                    reportedCode = message.code ?? null;
                    reportedSignal = message.signal ?? null;
                    void signalProcess("SIGKILL");
                }
            });
        }
        child.once("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (escalationTimer)
                clearTimeout(escalationTimer);
            resolve({
                code: reportedCode !== undefined ? reportedCode : code,
                stdout,
                stderr,
                timedOut,
                signal: reportedSignal !== undefined ? reportedSignal : signal,
                stdoutTruncated,
                stderrTruncated,
            });
        });
        if (!useProcessGroup && options.input !== undefined)
            child.stdin?.end(options.input);
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                void signalProcess("SIGTERM");
                escalationTimer = setTimeout(() => { void signalProcess("SIGKILL"); }, 5_000);
                escalationTimer.unref();
            }, options.timeoutMs);
            timer.unref();
        }
    });
}
export function jsonToolResult(value, isError = false) {
    const result = {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
    if (isError)
        result.isError = true;
    return result;
}
//# sourceMappingURL=util.js.map
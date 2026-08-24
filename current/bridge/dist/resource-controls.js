import { randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256Executable } from "./process-identity.js";
import { runProcess } from "./util.js";
async function trustedLauncherEnvironment(requireUserBus) {
    const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" };
    if (!requireUserBus)
        return env;
    if (typeof process.getuid !== "function")
        throw new Error("user-systemd resource enforcement requires a numeric Linux uid");
    const uid = process.getuid();
    const runtime = `/run/user/${uid}`;
    const runtimeInfo = await lstat(runtime);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || runtimeInfo.uid !== uid || (runtimeInfo.mode & 0o077) !== 0) {
        throw new Error(`untrusted user runtime directory: ${runtime}`);
    }
    const bus = path.join(runtime, "bus");
    const busInfo = await lstat(bus);
    if (!busInfo.isSocket() || busInfo.isSymbolicLink() || busInfo.uid !== uid)
        throw new Error(`untrusted user-systemd bus: ${bus}`);
    env.XDG_RUNTIME_DIR = runtime;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
    return env;
}
/** Pin the host limit launchers and return the conservative release defaults. */
export async function createPinnedHostResourceProfile(enforcement) {
    const [systemdRun, prlimit] = await Promise.all([
        sha256Executable("/usr/bin/systemd-run"),
        sha256Executable("/usr/bin/prlimit"),
    ]);
    return {
        enforcement,
        systemdRunBinary: systemdRun.realpath,
        systemdRunSha256: systemdRun.sha256,
        prlimitBinary: prlimit.realpath,
        prlimitSha256: prlimit.sha256,
        memoryMaxBytes: 4_294_967_296,
        cpuQuotaPercent: 200,
        tasksMax: 256,
        ioWeight: 100,
        worktreeMaxBytes: 4_294_967_296,
        rlimitNoFile: 4_096,
        rlimitNproc: 4_096,
        rlimitFsizeBytes: 1_073_741_824,
        commandTimeoutSeconds: 1_800,
    };
}
function safeLabel(label) {
    const selected = label.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
    return selected || "process";
}
async function verifiedExecutable(target, expected, label) {
    const identity = await sha256Executable(target);
    if (identity.sha256 !== expected)
        throw new Error(`${label} SHA-256 mismatch for ${identity.realpath}`);
    return identity.realpath;
}
export async function resourceWrappedCommand(config, label, command, args) {
    const profile = config.harnessIsolation.resourceProfile;
    const prlimit = await verifiedExecutable(profile.prlimitBinary, profile.prlimitSha256, "prlimit");
    const limitedArgs = [
        `--nofile=${profile.rlimitNoFile}:${profile.rlimitNoFile}`,
        `--nproc=${profile.rlimitNproc}:${profile.rlimitNproc}`,
        `--fsize=${profile.rlimitFsizeBytes}:${profile.rlimitFsizeBytes}`,
        "--",
        command,
        ...args,
    ];
    if (profile.enforcement === "audit_only") {
        return {
            command: prlimit,
            args: limitedArgs,
            env: await trustedLauncherEnvironment(false),
            cgroupEnforced: false,
            rlimitsEnforced: true,
        };
    }
    const systemdRun = await verifiedExecutable(profile.systemdRunBinary, profile.systemdRunSha256, "systemd-run");
    const unit = `codex-harness-${safeLabel(label)}-${process.pid}-${randomBytes(5).toString("hex")}.scope`;
    return {
        command: systemdRun,
        env: await trustedLauncherEnvironment(true),
        args: [
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            `--unit=${unit}`,
            `--property=MemoryMax=${profile.memoryMaxBytes}`,
            `--property=CPUQuota=${profile.cpuQuotaPercent}%`,
            `--property=TasksMax=${profile.tasksMax}`,
            `--property=IOWeight=${profile.ioWeight}`,
            `--property=RuntimeMaxSec=${profile.commandTimeoutSeconds}s`,
            "--",
            prlimit,
            ...limitedArgs,
        ],
        cgroupEnforced: true,
        rlimitsEnforced: true,
        unit,
    };
}
function limitValue(limits, label) {
    const line = limits.split("\n").find((candidate) => candidate.startsWith(label));
    if (!line)
        return undefined;
    return line.slice(label.length).trim().split(/\s+/u)[0];
}
function cpuQuotaMatches(value, expectedPercent) {
    const [quotaText, periodText] = value.trim().split(/\s+/u);
    const quota = Number(quotaText);
    const period = Number(periodText);
    return Number.isFinite(quota) && Number.isFinite(period) && period > 0
        && Math.abs((quota / period) * 100 - expectedPercent) < 0.01;
}
export async function probeHostResourceProfile(config) {
    const profile = config.harnessIsolation.resourceProfile;
    try {
        const script = [
            "const fs=require('node:fs');const path=require('node:path');",
            "const line=fs.readFileSync('/proc/self/cgroup','utf8').split('\\n').find(v=>v.startsWith('0::'));",
            "if(!line)throw new Error('not cgroup v2');const rel=line.slice(3);const root=path.join('/sys/fs/cgroup',rel);",
            "const get=n=>{try{return fs.readFileSync(path.join(root,n),'utf8').trim()}catch{return ''}};",
            "process.stdout.write(JSON.stringify({cgroup:rel,memoryMax:get('memory.max'),cpuMax:get('cpu.max'),pidsMax:get('pids.max'),ioWeight:get('io.weight'),limits:fs.readFileSync('/proc/self/limits','utf8')}));",
        ].join("");
        const wrapped = await resourceWrappedCommand(config, "doctor-resource-probe", process.execPath, ["-e", script]);
        const result = await runProcess(wrapped.command, wrapped.args, {
            env: wrapped.env,
            timeoutMs: 20_000,
            maxCaptureChars: 100_000,
            killProcessGroup: true,
        });
        if (result.code !== 0)
            throw new Error(result.stderr.trim() || `resource probe exited ${String(result.code)}`);
        const value = JSON.parse(result.stdout);
        const limits = value.limits ?? "";
        const observed = {
            cgroup: value.cgroup ?? "",
            memoryMax: value.memoryMax ?? "",
            cpuMax: value.cpuMax ?? "",
            pidsMax: value.pidsMax ?? "",
            ioWeight: value.ioWeight ?? "",
            rlimitNoFile: limitValue(limits, "Max open files") ?? "",
            rlimitNproc: limitValue(limits, "Max processes") ?? "",
            rlimitFsize: limitValue(limits, "Max file size") ?? "",
        };
        const checks = {
            cgroupV2: observed.cgroup.startsWith("/"),
            memoryMax: observed.memoryMax === String(profile.memoryMaxBytes),
            cpuQuota: cpuQuotaMatches(observed.cpuMax, profile.cpuQuotaPercent),
            tasksMax: observed.pidsMax === String(profile.tasksMax),
            ioWeight: observed.ioWeight.split(/\s+/u).includes(String(profile.ioWeight)),
            rlimitNoFile: observed.rlimitNoFile === String(profile.rlimitNoFile),
            rlimitNproc: observed.rlimitNproc === String(profile.rlimitNproc),
            rlimitFsize: observed.rlimitFsize === String(profile.rlimitFsizeBytes),
        };
        const ok = profile.enforcement === "required" && Object.values(checks).every(Boolean);
        return { ok, controlledUseAllowed: ok, enforcement: profile.enforcement, ...checks, observed };
    }
    catch (error) {
        return {
            ok: false,
            controlledUseAllowed: false,
            enforcement: profile.enforcement,
            cgroupV2: false,
            memoryMax: false,
            cpuQuota: false,
            tasksMax: false,
            ioWeight: false,
            rlimitNoFile: false,
            rlimitNproc: false,
            rlimitFsize: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
let cachedProbe;
export async function assertControlledResourceProfile(config) {
    const profile = config.harnessIsolation.resourceProfile;
    if (profile.enforcement === "audit_only")
        return;
    const key = JSON.stringify(profile);
    if (!cachedProbe || cachedProbe.key !== key || Date.now() - cachedProbe.at > 30_000) {
        cachedProbe = { key, at: Date.now(), value: await probeHostResourceProfile(config) };
    }
    if (!cachedProbe.value.ok) {
        throw new Error(`controlled Harness execution requires verified cgroup v2 and RLIMIT controls: ${cachedProbe.value.error ?? JSON.stringify(cachedProbe.value)}`);
    }
}
export async function directoryAllocatedBytes(root) {
    let total = 0;
    const visit = async (target) => {
        let info;
        try {
            info = await lstat(target);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        if (info.isSymbolicLink()) {
            total += info.size;
            return;
        }
        if (info.isFile()) {
            total += Math.max(info.size, info.blocks * 512);
            return;
        }
        if (!info.isDirectory())
            return;
        let entries;
        try {
            entries = await readdir(target);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        for (const entry of entries)
            await visit(path.join(target, entry));
    };
    await visit(root);
    return total;
}
//# sourceMappingURL=resource-controls.js.map
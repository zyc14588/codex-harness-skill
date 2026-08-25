import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  BridgeConfig,
  FrozenHostResourceProfile,
  HostResourceLimits,
  HostResourceProfile,
  ResourceProfileId,
  TaskComplexity,
  WorkerExecutor,
} from "./types.js";
import { sha256Executable } from "./process-identity.js";
import { runProcess } from "./util.js";

export interface ResourceWrappedCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cgroupEnforced: boolean;
  rlimitsEnforced: true;
  unit?: string;
}

export const RESOURCE_PROFILE_IDS: ResourceProfileId[] = [
  "local_or_flash_trivial_small",
  "flash_medium",
  "pro_large",
  "authoritative_verification",
];

/** Exact, non-tunable Owner-approved DEC-003 limits. */
export const OWNER_RESOURCE_LIMITS: Readonly<Record<ResourceProfileId, Readonly<HostResourceLimits>>> = Object.freeze({
  local_or_flash_trivial_small: Object.freeze({
    memoryMaxBytes: 2_147_483_648,
    cpuQuotaPercent: 100,
    tasksMax: 128,
    ioWeight: 100,
    worktreeMaxBytes: 2_147_483_648,
    rlimitNoFile: 2_048,
    rlimitNproc: 2_048,
    rlimitFsizeBytes: 536_870_912,
    commandTimeoutSeconds: 900,
  }),
  flash_medium: Object.freeze({
    memoryMaxBytes: 4_294_967_296,
    cpuQuotaPercent: 200,
    tasksMax: 256,
    ioWeight: 100,
    worktreeMaxBytes: 4_294_967_296,
    rlimitNoFile: 4_096,
    rlimitNproc: 4_096,
    rlimitFsizeBytes: 1_073_741_824,
    commandTimeoutSeconds: 1_800,
  }),
  pro_large: Object.freeze({
    memoryMaxBytes: 8_589_934_592,
    cpuQuotaPercent: 400,
    tasksMax: 512,
    ioWeight: 100,
    worktreeMaxBytes: 8_589_934_592,
    rlimitNoFile: 8_192,
    rlimitNproc: 8_192,
    rlimitFsizeBytes: 2_147_483_648,
    commandTimeoutSeconds: 3_600,
  }),
  authoritative_verification: Object.freeze({
    memoryMaxBytes: 4_294_967_296,
    cpuQuotaPercent: 200,
    tasksMax: 256,
    ioWeight: 100,
    worktreeMaxBytes: 4_294_967_296,
    rlimitNoFile: 4_096,
    rlimitNproc: 4_096,
    rlimitFsizeBytes: 1_073_741_824,
    commandTimeoutSeconds: 1_800,
  }),
});

export function ownerResourceProfileMatrix(): Record<ResourceProfileId, HostResourceLimits> {
  return {
    local_or_flash_trivial_small: { ...OWNER_RESOURCE_LIMITS.local_or_flash_trivial_small },
    flash_medium: { ...OWNER_RESOURCE_LIMITS.flash_medium },
    pro_large: { ...OWNER_RESOURCE_LIMITS.pro_large },
    authoritative_verification: { ...OWNER_RESOURCE_LIMITS.authoritative_verification },
  };
}

const LIMIT_KEYS: Array<keyof HostResourceLimits> = [
  "memoryMaxBytes", "cpuQuotaPercent", "tasksMax", "ioWeight", "worktreeMaxBytes",
  "rlimitNoFile", "rlimitNproc", "rlimitFsizeBytes", "commandTimeoutSeconds",
];

export function resourceProfileHash(id: ResourceProfileId, limits: HostResourceLimits): string {
  const canonical: Record<string, string | number> = {
    policyVersion: "owner-tiered-resource-profiles-v1",
    resourceProfileId: id,
  };
  for (const key of LIMIT_KEYS) canonical[key] = limits[key];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function exactOwnerResourceLimits(id: ResourceProfileId, candidate: HostResourceLimits): void {
  const expected = OWNER_RESOURCE_LIMITS[id];
  for (const key of LIMIT_KEYS) {
    if (candidate[key] !== expected[key]) {
      throw new Error(`resource profile ${id}.${key} must equal Owner-approved value ${expected[key]}`);
    }
  }
}

export function freezeHostResourceProfile(config: BridgeConfig, id: ResourceProfileId): FrozenHostResourceProfile {
  const limits = config.harnessIsolation.resourceProfiles[id];
  exactOwnerResourceLimits(id, limits);
  const control = config.harnessIsolation.resourceProfile;
  return {
    enforcement: control.enforcement,
    systemdRunBinary: control.systemdRunBinary,
    systemdRunSha256: control.systemdRunSha256,
    prlimitBinary: control.prlimitBinary,
    prlimitSha256: control.prlimitSha256,
    ...limits,
    resourceProfileId: id,
    resourceProfileHash: resourceProfileHash(id, limits),
    policyVersion: "owner-tiered-resource-profiles-v1",
  };
}

export function selectResourceProfileId(
  executor: WorkerExecutor,
  model: string | undefined,
  complexity: TaskComplexity,
): ResourceProfileId {
  if (executor === "llama_cpp") {
    if (complexity !== "trivial" && complexity !== "small") throw new Error("llama.cpp resource routing accepts only trivial/small leaves");
    return "local_or_flash_trivial_small";
  }
  if (model === "deepseek-v4-flash") {
    if (complexity === "trivial" || complexity === "small") return "local_or_flash_trivial_small";
    if (complexity === "medium") return "flash_medium";
    throw new Error("Flash resource routing does not accept large leaves");
  }
  if (model === "deepseek-v4-pro" && complexity === "large") return "pro_large";
  throw new Error("unsupported model/complexity resource route; Pro is reserved for large leaves and Flash for trivial/small/medium leaves");
}

function assertFrozenProfileIntegrity(profile: HostResourceProfile): void {
  const frozen = profile as Partial<FrozenHostResourceProfile>;
  if (frozen.resourceProfileId === undefined) return;
  if (!RESOURCE_PROFILE_IDS.includes(frozen.resourceProfileId)) throw new Error("unknown frozen resource profile id");
  exactOwnerResourceLimits(frozen.resourceProfileId, profile);
  const expected = resourceProfileHash(frozen.resourceProfileId, profile);
  if (frozen.policyVersion !== "owner-tiered-resource-profiles-v1" || frozen.resourceProfileHash !== expected) {
    throw new Error(`frozen resource profile integrity mismatch for ${frozen.resourceProfileId}`);
  }
}

async function trustedLauncherEnvironment(requireUserBus: boolean): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" };
  if (!requireUserBus) return env;
  if (typeof process.getuid !== "function") throw new Error("user-systemd resource enforcement requires a numeric Linux uid");
  const uid = process.getuid();
  const runtime = `/run/user/${uid}`;
  const runtimeInfo = await lstat(runtime);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || runtimeInfo.uid !== uid || (runtimeInfo.mode & 0o077) !== 0) {
    throw new Error(`untrusted user runtime directory: ${runtime}`);
  }
  const bus = path.join(runtime, "bus");
  const busInfo = await lstat(bus);
  if (!busInfo.isSocket() || busInfo.isSymbolicLink() || busInfo.uid !== uid) throw new Error(`untrusted user-systemd bus: ${bus}`);
  env.XDG_RUNTIME_DIR = runtime;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  return env;
}

export interface HostResourceProbe {
  ok: boolean;
  controlledUseAllowed: boolean;
  enforcement: HostResourceProfile["enforcement"];
  resourceProfileId?: ResourceProfileId;
  resourceProfileHash?: string;
  cgroupV2: boolean;
  memoryMax: boolean;
  cpuQuota: boolean;
  tasksMax: boolean;
  ioWeight: boolean;
  rlimitNoFile: boolean;
  rlimitNproc: boolean;
  rlimitFsize: boolean;
  observed?: Record<string, string>;
  error?: string;
}

/** Pin the host limit launchers and return the conservative release defaults. */
export async function createPinnedHostResourceProfile(
  enforcement: HostResourceProfile["enforcement"],
): Promise<HostResourceProfile> {
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
    ...OWNER_RESOURCE_LIMITS.authoritative_verification,
  };
}

function safeLabel(label: string): string {
  const selected = label.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return selected || "process";
}

async function verifiedExecutable(target: string, expected: string, label: string): Promise<string> {
  const identity = await sha256Executable(target);
  if (identity.sha256 !== expected) throw new Error(`${label} SHA-256 mismatch for ${identity.realpath}`);
  return identity.realpath;
}

export async function resourceWrappedCommand(
  config: BridgeConfig,
  label: string,
  command: string,
  args: string[],
  selectedProfile?: HostResourceProfile,
): Promise<ResourceWrappedCommand> {
  const profile = selectedProfile ?? config.harnessIsolation.resourceProfile;
  assertFrozenProfileIntegrity(profile);
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

function limitValue(limits: string, label: string): string | undefined {
  const line = limits.split("\n").find((candidate) => candidate.startsWith(label));
  if (!line) return undefined;
  return line.slice(label.length).trim().split(/\s+/u)[0];
}

function cpuQuotaMatches(value: string, expectedPercent: number): boolean {
  const [quotaText, periodText] = value.trim().split(/\s+/u);
  const quota = Number(quotaText);
  const period = Number(periodText);
  return Number.isFinite(quota) && Number.isFinite(period) && period > 0
    && Math.abs((quota / period) * 100 - expectedPercent) < 0.01;
}

export async function probeHostResourceProfile(config: BridgeConfig, selectedProfile?: HostResourceProfile): Promise<HostResourceProbe> {
  const profile = selectedProfile ?? config.harnessIsolation.resourceProfile;
  assertFrozenProfileIntegrity(profile);
  const frozen = profile as Partial<FrozenHostResourceProfile>;
  try {
    const script = [
      "const fs=require('node:fs');const path=require('node:path');",
      "const line=fs.readFileSync('/proc/self/cgroup','utf8').split('\\n').find(v=>v.startsWith('0::'));",
      "if(!line)throw new Error('not cgroup v2');const rel=line.slice(3);const root=path.join('/sys/fs/cgroup',rel);",
      "const get=n=>{try{return fs.readFileSync(path.join(root,n),'utf8').trim()}catch{return ''}};",
      "process.stdout.write(JSON.stringify({cgroup:rel,memoryMax:get('memory.max'),cpuMax:get('cpu.max'),pidsMax:get('pids.max'),ioWeight:get('io.weight'),limits:fs.readFileSync('/proc/self/limits','utf8')}));",
    ].join("");
    const wrapped = await resourceWrappedCommand(config, `doctor-resource-probe-${frozen.resourceProfileId ?? "legacy"}`, process.execPath, ["-e", script], profile);
    const result = await runProcess(wrapped.command, wrapped.args, {
      env: wrapped.env,
      timeoutMs: 20_000,
      maxCaptureChars: 100_000,
      killProcessGroup: true,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `resource probe exited ${String(result.code)}`);
    const value = JSON.parse(result.stdout) as { cgroup?: string; memoryMax?: string; cpuMax?: string; pidsMax?: string; ioWeight?: string; limits?: string };
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
    return {
      ok,
      controlledUseAllowed: ok,
      enforcement: profile.enforcement,
      ...(frozen.resourceProfileId ? { resourceProfileId: frozen.resourceProfileId } : {}),
      ...(frozen.resourceProfileHash ? { resourceProfileHash: frozen.resourceProfileHash } : {}),
      ...checks,
      observed,
    };
  } catch (error) {
    return {
      ok: false,
      controlledUseAllowed: false,
      enforcement: profile.enforcement,
      ...(frozen.resourceProfileId ? { resourceProfileId: frozen.resourceProfileId } : {}),
      ...(frozen.resourceProfileHash ? { resourceProfileHash: frozen.resourceProfileHash } : {}),
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

let cachedProbe: { key: string; at: number; value: HostResourceProbe } | undefined;

export async function assertControlledResourceProfile(config: BridgeConfig, selectedProfile?: HostResourceProfile): Promise<void> {
  const profile = selectedProfile ?? config.harnessIsolation.resourceProfile;
  assertFrozenProfileIntegrity(profile);
  if (profile.enforcement === "audit_only") return;
  const key = JSON.stringify(profile);
  if (!cachedProbe || cachedProbe.key !== key || Date.now() - cachedProbe.at > 30_000) {
    cachedProbe = { key, at: Date.now(), value: await probeHostResourceProfile(config, profile) };
  }
  if (!cachedProbe.value.ok) {
    throw new Error(`controlled Harness execution requires verified cgroup v2 and RLIMIT controls: ${cachedProbe.value.error ?? JSON.stringify(cachedProbe.value)}`);
  }
}

export async function directoryAllocatedBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (target: string): Promise<void> => {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
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
    if (!info.isDirectory()) return;
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) await visit(path.join(target, entry));
  };
  await visit(root);
  return total;
}

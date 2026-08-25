#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createPinnedHostResourceProfile,
  freezeHostResourceProfile,
  ownerResourceProfileMatrix,
  probeHostResourceProfile,
  RESOURCE_PROFILE_IDS,
} from "../current/bridge/dist/resource-controls.js";

const repositoryRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  let output = path.join(repositoryRoot, "HOST_RESOURCE_QUALIFICATION.json");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--output" || !argv[index + 1]) {
      throw new Error("Usage: qualify-host-resources.mjs [--output PATH_INSIDE_REPOSITORY]");
    }
    output = path.resolve(argv[index + 1]);
    index += 1;
  }
  const relative = path.relative(repositoryRoot, output);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("host qualification output must remain inside the repository");
  }
  return output;
}

async function optionalText(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return "";
  }
}

function controllerList(value) {
  return [...new Set(value.trim().split(/\s+/u).filter(Boolean))].sort();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function cgroupFacts() {
  const filesystems = await optionalText("/proc/filesystems");
  const mountinfo = await optionalText("/proc/self/mountinfo");
  const selfCgroup = await optionalText("/proc/self/cgroup");
  const unified = selfCgroup.split("\n").find((line) => line.startsWith("0::"));
  const relative = unified?.slice(3).trim() ?? "";
  const components = relative.split("/").filter(Boolean);
  const userManagerIndex = components.findIndex((component) => /^user@\d+\.service$/u.test(component));
  const appSliceIndex = components.findIndex((component) => component === "app.slice");
  const targetFor = (count) => path.join("/sys/fs/cgroup", ...components.slice(0, count));
  const current = targetFor(components.length);
  const userManager = userManagerIndex >= 0 ? targetFor(userManagerIndex + 1) : "";
  const appSlice = appSliceIndex >= 0 ? targetFor(appSliceIndex + 1) : "";
  const currentControllers = controllerList(await optionalText(path.join(current, "cgroup.controllers")));
  const currentSubtree = controllerList(await optionalText(path.join(current, "cgroup.subtree_control")));
  const managerControllers = userManager ? controllerList(await optionalText(path.join(userManager, "cgroup.controllers"))) : [];
  const managerSubtree = userManager ? controllerList(await optionalText(path.join(userManager, "cgroup.subtree_control"))) : [];
  const appControllers = appSlice ? controllerList(await optionalText(path.join(appSlice, "cgroup.controllers"))) : [];
  const appSubtree = appSlice ? controllerList(await optionalText(path.join(appSlice, "cgroup.subtree_control"))) : [];
  return {
    kernelCgroupV2Presence: {
      kernelSupportsCgroup2: /(?:^|\n)nodev\s+cgroup2(?:\n|$)/u.test(filesystems),
      cgroup2Mounted: / - cgroup2 cgroup2 /u.test(mountinfo),
      processUsesUnifiedHierarchy: Boolean(unified),
    },
    delegatedControllers: {
      userManagerAvailable: managerControllers,
      userManagerEnabledForChildren: managerSubtree,
      appSliceAvailable: appControllers,
      appSliceEnabledForChildren: appSubtree,
      currentScopeAvailable: currentControllers,
      currentScopeEnabledForChildren: currentSubtree,
    },
  };
}

function resourceValue(expected, observed, enforced) {
  return { expected, observed: observed || null, enforced };
}

const outputPath = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();
const cgroup = await cgroupFacts();
const control = await createPinnedHostResourceProfile("required");
const config = {
  harnessIsolation: {
    resourceProfile: control,
    resourceProfiles: ownerResourceProfileMatrix(),
  },
};
const profiles = {};
for (const id of RESOURCE_PROFILE_IDS) {
  const profile = freezeHostResourceProfile(config, id);
  const probe = await probeHostResourceProfile(config, profile);
  const observed = probe.observed ?? {};
  const failedChecks = [
    ["cgroupV2", probe.cgroupV2],
    ["MemoryMax", probe.memoryMax],
    ["CPUQuota", probe.cpuQuota],
    ["TasksMax", probe.tasksMax],
    ["IOWeight", probe.ioWeight],
    ["RLIMIT_NOFILE", probe.rlimitNoFile],
    ["RLIMIT_NPROC", probe.rlimitNproc],
    ["RLIMIT_FSIZE", probe.rlimitFsize],
  ].filter(([, passed]) => passed !== true).map(([name]) => name);
  const systemdUserScopeAvailable = Boolean(observed.cgroup)
    && probe.memoryMax === true && probe.cpuQuota === true && probe.tasksMax === true;
  const ioDelegated = probe.ioWeight === true
    && cgroup.delegatedControllers.appSliceAvailable.includes("io");
  const failureReason = probe.controlledUseAllowed
    ? null
    : systemdUserScopeAvailable && !ioDelegated
      ? "BLOCKED_CONTROLLED_HOST_CGROUP_IO"
      : "BLOCKED_CONTROLLED_HOST_RESOURCE_PROFILE";
  profiles[id] = {
    result: probe.controlledUseAllowed ? "PASS" : failureReason,
    MemoryMax: resourceValue(profile.memoryMaxBytes, observed.memoryMax, probe.memoryMax),
    CPUQuota: resourceValue(`${profile.cpuQuotaPercent}%`, observed.cpuMax, probe.cpuQuota),
    TasksMax: resourceValue(profile.tasksMax, observed.pidsMax, probe.tasksMax),
    IOWeight: resourceValue(profile.ioWeight, observed.ioWeight, probe.ioWeight),
    WorktreeMaxBytes: profile.worktreeMaxBytes,
    RLIMIT_NOFILE: resourceValue(profile.rlimitNoFile, observed.rlimitNoFile, probe.rlimitNoFile),
    RLIMIT_NPROC: resourceValue(profile.rlimitNproc, observed.rlimitNproc, probe.rlimitNproc),
    RLIMIT_FSIZE: resourceValue(profile.rlimitFsizeBytes, observed.rlimitFsize, probe.rlimitFsize),
    RuntimeMaxSec: profile.commandTimeoutSeconds,
    resourceProfileHash: profile.resourceProfileHash,
    controlledUseAllowed: probe.controlledUseAllowed === true,
    failedChecks,
    failureReason,
    probeError: probe.error ? "REDACTED_HOST_PROBE_ERROR_PRESENT" : null,
  };
}
const controlledUseAllowed = RESOURCE_PROFILE_IDS.every((id) => profiles[id].controlledUseAllowed === true);
const blockedForIo = RESOURCE_PROFILE_IDS.every((id) => profiles[id].failureReason === "BLOCKED_CONTROLLED_HOST_CGROUP_IO");
const failureReason = controlledUseAllowed
  ? null
  : blockedForIo ? "BLOCKED_CONTROLLED_HOST_CGROUP_IO" : "BLOCKED_CONTROLLED_HOST_RESOURCE_PROFILE";
const result = controlledUseAllowed ? "PASS" : failureReason;

const report = {
  schemaVersion: 2,
  result,
  generatedAt,
  probeContract: "owner-tiered-required-cgroup-v2-and-rlimit-before-provider-io-v1",
  providerRequestsSent: 0,
  networkOperationsPerformed: false,
  kernelCgroupV2Presence: cgroup.kernelCgroupV2Presence,
  delegatedControllers: cgroup.delegatedControllers,
  resourceProfileMatrixHash: {
    algorithm: "sha256-canonical-json-v1",
    sha256: sha256Json(Object.fromEntries(RESOURCE_PROFILE_IDS.map((id) => [id, profiles[id].resourceProfileHash]))),
  },
  launcherIdentities: {
    systemdRunBinary: control.systemdRunBinary,
    systemdRunSha256: control.systemdRunSha256,
    prlimitBinary: control.prlimitBinary,
    prlimitSha256: control.prlimitSha256,
  },
  profiles,
  controlledUseAllowed,
  failureReason,
  qualifiedHostRequirements: [
    "Linux kernel with a mounted unified cgroup v2 hierarchy",
    "trusted per-user systemd manager and user scope creation",
    "delegated memory, cpu, pids, and io controllers in the user app slice",
    "observable MemoryMax, CPUQuota, TasksMax, and IOWeight values equal to the approved profile",
    "prlimit enforcement for RLIMIT_NOFILE, RLIMIT_NPROC, and RLIMIT_FSIZE equal to the approved profile",
    "pinned systemd-run and prlimit executable identities matching the runtime profile",
  ],
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!controlledUseAllowed) process.exitCode = 2;

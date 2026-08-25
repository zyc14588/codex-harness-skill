import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertControlledResourceProfile,
  createPinnedHostResourceProfile,
  directoryAllocatedBytes,
  freezeHostResourceProfile,
  OWNER_RESOURCE_LIMITS,
  probeHostResourceProfile,
  RESOURCE_PROFILE_IDS,
  resourceWrappedCommand,
  selectResourceProfileId,
} from "../resource-controls.js";
import { runProcess } from "../util.js";
import { testConfig } from "./test-config.js";

test("Owner tiered profiles route deterministically and freeze exact hashes", () => {
  const config = testConfig(os.tmpdir());
  assert.equal(selectResourceProfileId("llama_cpp", undefined, "trivial"), "local_or_flash_trivial_small");
  assert.equal(selectResourceProfileId("harness", "deepseek-v4-flash", "small"), "local_or_flash_trivial_small");
  assert.equal(selectResourceProfileId("harness", "deepseek-v4-flash", "medium"), "flash_medium");
  assert.equal(selectResourceProfileId("harness", "deepseek-v4-pro", "large"), "pro_large");
  assert.throws(() => selectResourceProfileId("harness", "deepseek-v4-flash", "large"), /does not accept large/u);
  assert.throws(() => selectResourceProfileId("harness", "deepseek-v4-pro", "medium"), /unsupported model\/complexity/u);
  const hashes = new Set<string>();
  for (const id of RESOURCE_PROFILE_IDS) {
    const frozen = freezeHostResourceProfile(config, id);
    assert.equal(frozen.resourceProfileId, id);
    assert.deepEqual(
      Object.fromEntries(Object.keys(OWNER_RESOURCE_LIMITS[id]).map((key) => [key, frozen[key as keyof typeof frozen]])),
      OWNER_RESOURCE_LIMITS[id],
    );
    assert.match(frozen.resourceProfileHash, /^[0-9a-f]{64}$/u);
    hashes.add(frozen.resourceProfileHash);
  }
  assert.equal(hashes.size, RESOURCE_PROFILE_IDS.length);
});

test("Owner profile tampering fails before a process can launch", async () => {
  const config = testConfig(os.tmpdir());
  config.harnessIsolation.resourceProfiles.flash_medium.memoryMaxBytes += 1;
  assert.throws(() => freezeHostResourceProfile(config, "flash_medium"), /Owner-approved value/u);
});

test("audit-only resource wrapper pins and dynamically enforces RLIMIT values", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-audit-"));
  try {
    const profile = {
      ...await createPinnedHostResourceProfile("audit_only"),
      rlimitNoFile: 128,
      rlimitNproc: 4_096,
      rlimitFsizeBytes: 1_048_576,
    };
    const config = testConfig(root, { harnessIsolation: { ...testConfig(root).harnessIsolation, resourceProfile: profile } });
    const wrapped = await resourceWrappedCommand(config, "rlimit-probe", process.execPath, ["-e", [
      "const fs=require('node:fs');",
      "const v=fs.readFileSync('/proc/self/limits','utf8');",
      "process.stdout.write(v);",
    ].join("")]);
    assert.equal(wrapped.command, profile.prlimitBinary);
    assert.equal(wrapped.cgroupEnforced, false);
    const result = await runProcess(wrapped.command, wrapped.args, { env: wrapped.env, timeoutMs: 5_000, killProcessGroup: true });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Max open files\s+128\s+128\s+/mu);
    assert.match(result.stdout, /^Max processes\s+4096\s+4096\s+/mu);
    assert.match(result.stdout, /^Max file size\s+1048576\s+1048576\s+/mu);
    const probe = await probeHostResourceProfile(config);
    assert.equal(probe.controlledUseAllowed, false);
    assert.equal(probe.enforcement, "audit_only");
    assert.equal(probe.rlimitNoFile, true);
    assert.equal(probe.rlimitNproc, true);
    assert.equal(probe.rlimitFsize, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Owner tier is dynamically routed through its exact audit-only RLIMIT wrapper", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-tiers-"));
  try {
    const base = testConfig(root);
    base.harnessIsolation.resourceProfile = await createPinnedHostResourceProfile("audit_only");
    for (const id of RESOURCE_PROFILE_IDS) {
      const profile = freezeHostResourceProfile(base, id);
      const wrapped = await resourceWrappedCommand(base, `tier-${id}`, process.execPath, ["-e", [
        "const fs=require('node:fs');",
        "process.stdout.write(fs.readFileSync('/proc/self/limits','utf8'));",
      ].join("")], profile);
      assert.equal(wrapped.cgroupEnforced, false);
      const result = await runProcess(wrapped.command, wrapped.args, { env: wrapped.env, timeoutMs: 5_000, killProcessGroup: true });
      assert.equal(result.code, 0, `${id}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^Max open files\\s+${profile.rlimitNoFile}\\s+${profile.rlimitNoFile}\\s+`, "mu"));
      assert.match(result.stdout, new RegExp(`^Max processes\\s+${profile.rlimitNproc}\\s+${profile.rlimitNproc}\\s+`, "mu"));
      assert.match(result.stdout, new RegExp(`^Max file size\\s+${profile.rlimitFsizeBytes}\\s+${profile.rlimitFsizeBytes}\\s+`, "mu"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Owner tier encodes its exact required cgroup and runtime ceilings", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-required-tiers-"));
  try {
    const config = testConfig(root);
    config.harnessIsolation.resourceProfile = await createPinnedHostResourceProfile("required");
    for (const id of RESOURCE_PROFILE_IDS) {
      const profile = freezeHostResourceProfile(config, id);
      const wrapped = await resourceWrappedCommand(config, `required-${id}`, "/usr/bin/true", [], profile);
      assert.equal(wrapped.cgroupEnforced, true);
      for (const expected of [
        `--property=MemoryMax=${profile.memoryMaxBytes}`,
        `--property=CPUQuota=${profile.cpuQuotaPercent}%`,
        `--property=TasksMax=${profile.tasksMax}`,
        `--property=IOWeight=${profile.ioWeight}`,
        `--property=RuntimeMaxSec=${profile.commandTimeoutSeconds}s`,
        `--nofile=${profile.rlimitNoFile}:${profile.rlimitNoFile}`,
        `--nproc=${profile.rlimitNproc}:${profile.rlimitNproc}`,
        `--fsize=${profile.rlimitFsizeBytes}:${profile.rlimitFsizeBytes}`,
      ]) assert.ok(wrapped.args.includes(expected), `${id} missing ${expected}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a frozen attempt profile cannot be changed after its hash is issued", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-frozen-tamper-"));
  try {
    const config = testConfig(root);
    config.harnessIsolation.resourceProfile = await createPinnedHostResourceProfile("audit_only");
    const frozen = freezeHostResourceProfile(config, "flash_medium");
    const tampered = { ...frozen, cpuQuotaPercent: frozen.cpuQuotaPercent + 1 };
    await assert.rejects(resourceWrappedCommand(config, "tampered", "/usr/bin/true", [], tampered), /Owner-approved value|integrity mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allocated-byte accounting detects ordinary and sparse worktree growth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-disk-"));
  try {
    await writeFile(path.join(root, "ordinary.bin"), Buffer.alloc(64 * 1024));
    await writeFile(path.join(root, "sparse.bin"), Buffer.alloc(2 * 1024 * 1024));
    const bytes = await directoryAllocatedBytes(root);
    assert.ok(bytes >= 2 * 1024 * 1024, `unexpected allocated-byte count ${bytes}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required wrapper proves cgroup fork, memory, disk, and runtime ceilings", { skip: process.platform !== "linux", timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-required-"));
  try {
    const profile = {
      ...await createPinnedHostResourceProfile("required"),
      memoryMaxBytes: 134_217_728,
      cpuQuotaPercent: 50,
      tasksMax: 24,
      worktreeMaxBytes: 16_777_216,
      rlimitNoFile: 128,
      rlimitNproc: 4_096,
      rlimitFsizeBytes: 8_388_608,
      commandTimeoutSeconds: 1,
    };
    const base = testConfig(root);
    const config = testConfig(root, { harnessIsolation: { ...base.harnessIsolation, resourceProfile: profile } });
    const probe = await probeHostResourceProfile(config);
    const negativeTestControlsAvailable = probe.cgroupV2 && probe.memoryMax && probe.cpuQuota && probe.tasksMax
      && probe.rlimitNoFile && probe.rlimitNproc && probe.rlimitFsize;
    if (!negativeTestControlsAvailable) {
      context.skip(`host lacks the safe cgroup controls needed for negative tests: ${probe.error ?? JSON.stringify(probe.observed)}`);
      return;
    }
    assert.deepEqual({
      memoryMax: probe.memoryMax,
      cpuQuota: probe.cpuQuota,
      tasksMax: probe.tasksMax,
      rlimitNoFile: probe.rlimitNoFile,
      rlimitNproc: probe.rlimitNproc,
      rlimitFsize: probe.rlimitFsize,
    }, {
      memoryMax: true,
      cpuQuota: true,
      tasksMax: true,
      rlimitNoFile: true,
      rlimitNproc: true,
      rlimitFsize: true,
    });

    const forkScript = [
      "const {spawn}=require('node:child_process');let started=0,failed=0;const children=[];",
      "for(let i=0;i<80;i++){const c=spawn('/usr/bin/sleep',['20']);children.push(c);c.once('spawn',()=>started++);c.once('error',()=>failed++);}",
      "setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.stdout.write(JSON.stringify({started,failed}));setTimeout(()=>process.exit(0),100)},600);",
    ].join("");
    const forkWrapped = await resourceWrappedCommand(config, "fork-negative", process.execPath, ["-e", forkScript]);
    const fork = await runProcess(forkWrapped.command, forkWrapped.args, { env: forkWrapped.env, timeoutMs: 5_000, killProcessGroup: true });
    assert.equal(fork.code, 0, fork.stderr);
    const forkResult = JSON.parse(fork.stdout) as { started: number; failed: number };
    assert.ok(forkResult.failed > 0 && forkResult.started < 80, JSON.stringify(forkResult));

    const memoryScript = "const held=[];for(let i=0;i<96;i++){const b=Buffer.alloc(8*1024*1024,1);held.push(b)};console.log('UNEXPECTED_MEMORY_SUCCESS')";
    const memoryWrapped = await resourceWrappedCommand(config, "memory-negative", process.execPath, ["-e", memoryScript]);
    const memory = await runProcess(memoryWrapped.command, memoryWrapped.args, { env: memoryWrapped.env, timeoutMs: 8_000, killProcessGroup: true });
    assert.notEqual(memory.code, 0, "MemoryMax did not terminate an allocation above the verified ceiling");
    assert.doesNotMatch(memory.stdout, /UNEXPECTED_MEMORY_SUCCESS/u);

    const output = path.join(root, "fsize-negative.bin");
    const diskScript = `require('node:fs').writeFileSync(${JSON.stringify(output)},Buffer.alloc(32*1024*1024,1));console.log('UNEXPECTED_DISK_SUCCESS')`;
    const diskWrapped = await resourceWrappedCommand(config, "disk-negative", process.execPath, ["-e", diskScript]);
    const disk = await runProcess(diskWrapped.command, diskWrapped.args, { env: diskWrapped.env, timeoutMs: 8_000, killProcessGroup: true });
    assert.notEqual(disk.code, 0, "RLIMIT_FSIZE did not reject a file above the verified ceiling");
    assert.doesNotMatch(disk.stdout, /UNEXPECTED_DISK_SUCCESS/u);
    assert.ok((await stat(output)).size <= profile.rlimitFsizeBytes);

    const timeoutWrapped = await resourceWrappedCommand(config, "runtime-negative", "/usr/bin/sleep", ["10"]);
    const startedAt = Date.now();
    const timeout = await runProcess(timeoutWrapped.command, timeoutWrapped.args, { env: timeoutWrapped.env, timeoutMs: 8_000, killProcessGroup: true });
    assert.notEqual(timeout.code, 0, "RuntimeMaxSec did not terminate the scope");
    assert.ok(Date.now() - startedAt < 5_000, "host runtime ceiling was not enforced promptly");
    context.diagnostic(`verified negative resource evidence; controlled=${String(probe.controlledUseAllowed)} ioWeight=${String(probe.ioWeight)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled use fails closed unless every cgroup and RLIMIT control is dynamically verified", { skip: process.platform !== "linux" }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-resource-controlled-"));
  try {
    const profile = await createPinnedHostResourceProfile("required");
    const base = testConfig(root);
    const config = testConfig(root, { harnessIsolation: { ...base.harnessIsolation, resourceProfile: profile } });
    const probe = await probeHostResourceProfile(config);
    if (!probe.controlledUseAllowed) {
      await assert.rejects(assertControlledResourceProfile(config), /requires verified cgroup v2 and RLIMIT controls/u);
      if (process.env.CODEX_HARNESS_REQUIRE_CONTROLLED_RESOURCES === "1") {
        assert.fail(`controlled host resource profile unavailable: ${JSON.stringify(probe)}`);
      }
      context.skip(`controlled use unavailable by design: ${probe.error ?? JSON.stringify(probe.observed)}`);
      return;
    }
    await assert.doesNotReject(assertControlledResourceProfile(config));
    assert.equal(probe.ioWeight, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

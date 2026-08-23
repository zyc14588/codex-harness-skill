import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig, TaskRecord } from "./types.js";
import { taskDirectory } from "./store.js";
import { atomicWriteJson, isWithin, pathExists, runProcess } from "./util.js";
import { sha256Executable } from "./process-identity.js";

export interface HarnessLauncherIdentity {
  command: string;
  prefixArgs: string[];
  source: string;
}

export interface PreparedHarnessSandbox {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxRoot: string;
  evidencePath: string;
}

const SANDBOX_PATH = "/sandbox";
const INTERNAL_SOCKET_DIRECTORY = "/run/codex-harness-bridge";
const INTERNAL_SOCKET_PATH = `${INTERNAL_SOCKET_DIRECTORY}/monitor.sock`;
const PROFILE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

async function gitCommonDirectory(worktree: string): Promise<string> {
  const result = await runProcess("/usr/bin/git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeoutMs: 10_000,
    maxCaptureChars: 16_000,
  });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`cannot resolve task Git common directory: ${result.stderr.trim()}`);
  return await realpath(result.stdout.trim());
}

async function copyManagedDirectory(source: string, target: string, trustedRoot: string, label: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory: ${source}`);
  const canonicalRoot = await realpath(trustedRoot);
  const canonical = await realpath(source);
  if (!isWithin(canonical, canonicalRoot)) throw new Error(`${label} resolves outside its trusted root: ${canonical}`);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory: ${canonical}`);
  await cp(canonical, target, { recursive: true, dereference: false, force: false, errorOnExist: true });
}

function shellQuotedYaml(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("unsafe path in secure startup patch");
  return `'${value.replaceAll("'", "''")}'`;
}

function destinationDirectories(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const item of paths) {
    let current = path.resolve(item);
    while (current !== "/") {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function setEnvironment(args: string[], values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) args.push("--setenv", name, value);
  }
}

function sanitizedShadowTask(task: TaskRecord): TaskRecord {
  const copy = structuredClone(task);
  delete copy.proxyToken;
  delete copy.upstreamBaseUrl;
  delete copy.workerIdentity;
  delete copy.harnessIdentity;
  delete copy.workerPid;
  delete copy.harnessPid;
  copy.promptPath = `${SANDBOX_PATH}/input/prompt.md`;
  copy.stdoutPath = `${SANDBOX_PATH}/logs/worker.stdout.log`;
  copy.stderrPath = `${SANDBOX_PATH}/logs/worker.stderr.log`;
  copy.usagePath = `${SANDBOX_PATH}/logs/usage.ndjson`;
  return copy;
}

export async function prepareHarnessSandbox(
  config: BridgeConfig,
  task: TaskRecord,
  launcher: HarnessLauncherIdentity,
  profile: string,
  selectedModel: string | undefined,
): Promise<PreparedHarnessSandbox> {
  if (process.platform !== "linux") throw new Error("Harness execution requires Linux Bubblewrap isolation");
  if (!task.proxyToken || !/^[a-f0-9]{48}$/.test(task.proxyToken)) throw new Error("Harness task has no valid one-task proxy credential");
  if (!PROFILE_NAME.test(profile)) throw new Error(`unsafe Harness profile name: ${profile}`);

  const bwrap = await sha256Executable(config.harnessIsolation.bubblewrapBinary);
  if (bwrap.sha256 !== config.harnessIsolation.bubblewrapSha256) {
    throw new Error(`Bubblewrap SHA-256 mismatch for ${bwrap.realpath}`);
  }
  const canonicalHarnessRoot = await realpath(config.harnessRoot);
  const canonicalLauncherSource = await realpath(launcher.source);
  if (!isWithin(canonicalLauncherSource, canonicalHarnessRoot)) throw new Error("Harness launcher resolves outside the pinned Harness root");
  const canonicalWorktree = await realpath(task.worktreePath);
  const gitCommon = await gitCommonDirectory(canonicalWorktree);
  if (isWithin(gitCommon, canonicalWorktree)) throw new Error("Harness requires a linked worktree whose Git common directory can be mounted read-only");

  const hostDshHome = await realpath(config.dshHome ?? path.join(os.homedir(), ".dsh"));
  const profileSource = path.join(hostDshHome, "profiles", profile);
  const profileModulesCandidate = path.join(hostDshHome, "profiles", "node_modules");
  if (!await pathExists(profileModulesCandidate)) throw new Error(`Harness profile node_modules is unavailable: ${profileModulesCandidate}`);
  const profileModulesInfo = await lstat(profileModulesCandidate);
  if (!profileModulesInfo.isDirectory() || profileModulesInfo.isSymbolicLink()) {
    throw new Error(`Harness profile node_modules must be a non-symlink directory: ${profileModulesCandidate}`);
  }
  const profileModules = await realpath(profileModulesCandidate);
  const canonicalProfilesRoot = await realpath(path.join(hostDshHome, "profiles"));
  if (!isWithin(profileModules, canonicalProfilesRoot)) throw new Error(`Harness profile node_modules resolves outside its trusted root: ${profileModules}`);

  const sandboxRoot = path.join(taskDirectory(config, task.id), "harness-sandbox");
  await rm(sandboxRoot, { recursive: true, force: true });
  for (const relative of [
    "home", "input", "logs", "secret", "state/tasks", "dsh/profiles", "dsh/.agent-presets", "dsh/sessions", "dsh/storages",
    "xdg/config", "xdg/data", "xdg/state",
  ]) await mkdir(path.join(sandboxRoot, relative), { recursive: true, mode: 0o700 });

  await copyManagedDirectory(profileSource, path.join(sandboxRoot, "dsh", "profiles", profile), path.join(hostDshHome, "profiles"), "Harness profile");
  if (task.harnessMode === "minimal") {
    const presetSource = path.join(hostDshHome, ".agent-presets", "codex-bridge-minimal");
    await copyManagedDirectory(presetSource, path.join(sandboxRoot, "dsh", ".agent-presets", "codex-bridge-minimal"), path.join(hostDshHome, ".agent-presets"), "Harness minimal preset");
  }

  const prompt = await readFile(task.promptPath);
  if (prompt.length === 0 || prompt.length > 256_000) throw new Error("Harness prompt must contain 1-256000 bytes");
  await writeFile(path.join(sandboxRoot, "input", "prompt.md"), prompt, { mode: 0o600, flag: "wx" });
  await writeFile(path.join(sandboxRoot, "secret", "proxy.token"), `${task.proxyToken}\n`, { mode: 0o600, flag: "wx" });

  const bridgeDist = path.dirname(fileURLToPath(new URL("./harness-sandbox-entry.js", import.meta.url)));
  const secureStartup = path.join(bridgeDist, "secure-headless-startup.js");
  const securePatch = [
    "- id: headless-startup",
    "  disabled: true",
    "- insert:",
    "    - id: codex-bridge-secure-headless-startup",
    `      name: ${shellQuotedYaml(secureStartup)}`,
    "",
  ].join("\n");
  await writeFile(path.join(sandboxRoot, "secure-startup.patch.yml"), securePatch, { mode: 0o600, flag: "wx" });

  const launcherCommand = await realpath(launcher.command);
  const launchSpec = {
    schemaVersion: 1,
    command: launcherCommand,
    args: [...launcher.prefixArgs, "--profile", profile, "--patch", `${SANDBOX_PATH}/secure-startup.patch.yml`],
    cwd: canonicalWorktree,
  } as const;
  await writeFile(path.join(sandboxRoot, "launch.json"), `${JSON.stringify(launchSpec, null, 2)}\n`, { mode: 0o600, flag: "wx" });

  const shadowStateRoot = `${SANDBOX_PATH}/state`;
  const shadowConfig: BridgeConfig = {
    ...structuredClone(config),
    stateRoot: shadowStateRoot,
    allowedRepoRoots: [canonicalWorktree],
    passEnvironment: [],
    dshHome: `${SANDBOX_PATH}/dsh`,
    monitor: { ...config.monitor, enabled: false, autoStart: false },
    provider: { baseUrl: "https://invalid.example", apiKeyFile: `${SANDBOX_PATH}/unavailable-provider.key` },
    llamaCpp: { ...config.llamaCpp, enabled: false, fallbackEnabled: false },
  };
  await writeFile(path.join(sandboxRoot, "config.json"), `${JSON.stringify(shadowConfig, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const shadowTaskDir = path.join(sandboxRoot, "state", "tasks", task.id);
  await mkdir(shadowTaskDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(shadowTaskDir, "task.json"), `${JSON.stringify(sanitizedShadowTask(task), null, 2)}\n`, { mode: 0o600, flag: "wx" });

  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = path.dirname(path.dirname(nodeExecutable));
  const socketSourceDirectory = path.join(config.stateRoot, "monitor-internal");
  const socketSource = path.join(socketSourceDirectory, "monitor.sock");
  if (!await pathExists(socketSource)) throw new Error(`internal monitor socket is unavailable: ${socketSource}`);
  const socketInfo = await lstat(socketSource);
  if (!socketInfo.isSocket() || socketInfo.isSymbolicLink()) throw new Error("internal monitor endpoint must be a Unix socket");

  const bindDestinations = [
    "/usr", canonicalHarnessRoot, nodeRoot, bridgeDist, canonicalWorktree, gitCommon,
    SANDBOX_PATH, INTERNAL_SOCKET_DIRECTORY, `${SANDBOX_PATH}/dsh/profiles/node_modules`,
  ];
  const args: string[] = [
    "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    "--cap-drop", "ALL", "--clearenv", "--hostname", "codex-harness",
  ];
  for (const directory of destinationDirectories(bindDestinations)) args.push("--dir", directory);
  args.push(
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", sandboxRoot, SANDBOX_PATH,
    "--ro-bind", canonicalHarnessRoot, canonicalHarnessRoot,
    "--ro-bind", nodeRoot, nodeRoot,
    "--ro-bind", bridgeDist, bridgeDist,
    "--bind", canonicalWorktree, canonicalWorktree,
    "--ro-bind", gitCommon, gitCommon,
    "--ro-bind", profileModules, `${SANDBOX_PATH}/dsh/profiles/node_modules`,
    "--ro-bind", socketSourceDirectory, INTERNAL_SOCKET_DIRECTORY,
  );
  setEnvironment(args, {
    PATH: `${path.dirname(nodeExecutable)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: `${SANDBOX_PATH}/home`,
    USER: "codex-harness",
    LOGNAME: "codex-harness",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: `${SANDBOX_PATH}/xdg/config`,
    XDG_DATA_HOME: `${SANDBOX_PATH}/xdg/data`,
    XDG_STATE_HOME: `${SANDBOX_PATH}/xdg/state`,
    DSH_HOME: `${SANDBOX_PATH}/dsh`,
    DSH_MODEL: selectedModel,
    // Bubblewrap is the attempt's mandatory outer security boundary. Asking
    // Harness to create a second user-namespace sandbox here is both redundant
    // and impossible because nested user namespaces are deliberately disabled.
    // "danger-full-access" therefore means full access only *inside* this
    // already-confined mount/PID/network namespace, never to the host.
    DSH_PERMISSION_MODE: "danger-full-access",
    DSH_TELEMETRY_DISABLED: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    CODEX_HARNESS_CONFIG: `${SANDBOX_PATH}/config.json`,
    CODEX_HARNESS_TASK_ID: task.id,
    CODEX_HARNESS_TOOL_CAPABILITIES: JSON.stringify(task.toolCapabilities),
    CODEX_HARNESS_EXECUTION_MODE: task.harnessMode,
    CODEX_HARNESS_REQUEST_STATE_MODULE: task.harnessMode === "minimal"
      ? path.join(bridgeDist, "minimal-request-state-client.js")
      : undefined,
    CODEX_HARNESS_ATTEMPT_ID: task.executionAttempts?.at(-1)?.id,
    CODEX_HARNESS_ATTEMPT_MODEL: selectedModel,
    CODEX_HARNESS_REASONING_EFFORT: task.executionAttempts?.at(-1)?.thinkingPolicy?.reasoningEffort,
    CODEX_HARNESS_SANDBOX_ROOT: SANDBOX_PATH,
    CODEX_HARNESS_PROMPT_FILE: `${SANDBOX_PATH}/input/prompt.md`,
    CODEX_HARNESS_MONITOR_SOCKET: INTERNAL_SOCKET_PATH,
    CODEX_HARNESS_RELAY_PORT: String(config.harnessIsolation.relayPort),
    CODEX_HARNESS_LAUNCH_SPEC: `${SANDBOX_PATH}/launch.json`,
    CODEX_HARNESS_PROXY_TOKEN_FILE: `${SANDBOX_PATH}/secret/proxy.token`,
  });
  args.push("--chdir", canonicalWorktree, "--", nodeExecutable, path.join(bridgeDist, "harness-sandbox-entry.js"));

  const evidencePath = path.join(taskDirectory(config, task.id), "harness-isolation.json");
  await atomicWriteJson(evidencePath, {
    schemaVersion: 1,
    taskId: task.id,
    isolation: {
      userNamespace: true,
      pidNamespace: true,
      networkNamespace: true,
      ipcNamespace: true,
      utsNamespace: true,
      cgroupNamespace: true,
      nestedUserNamespacesDisabled: true,
      capabilitiesDropped: "ALL",
      providerCredentialBrokered: true,
      realProviderCredentialMounted: false,
      hostDshHomeMounted: false,
      privateProcessView: true,
      readOnlyGitCommonDirectory: true,
    },
    bubblewrap: bwrap,
    mounts: {
      writable: [canonicalWorktree, SANDBOX_PATH],
      readOnly: [canonicalHarnessRoot, nodeRoot, bridgeDist, gitCommon, profileModules, INTERNAL_SOCKET_DIRECTORY, "/usr"],
    },
    promptTransport: "0600_sandbox_file",
    proxyCredential: "one_task_48_hex_bearer",
    harnessInnerPermissionMode: "danger_full_access_within_mandatory_outer_bubblewrap_boundary",
  });
  return { command: bwrap.realpath, args, env: {}, sandboxRoot, evidencePath };
}

export async function cleanupHarnessSandbox(sandboxRoot: string): Promise<void> {
  await rm(sandboxRoot, { recursive: true, force: true });
}

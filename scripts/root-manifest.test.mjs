#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseRootManifest,
  ROOT_MANIFEST_PATH,
  updateRootManifest,
  validateSafePathBytes,
  verifyRootManifest,
} from "./root-manifest-lib.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function put(root, relative, content, mode = 0o644) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode });
  await chmod(target, mode);
}

async function repository(t, files = { "tracked.txt": "baseline\n" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "root-manifest-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "root-manifest@example.invalid"]);
  git(root, ["config", "user.name", "Root Manifest Test"]);
  await put(root, ROOT_MANIFEST_PATH, "placeholder\n");
  for (const [relative, value] of Object.entries(files)) await put(root, relative, value);
  git(root, ["add", "--all"]);
  await updateRootManifest(root);
  assert.equal((await verifyRootManifest(root)).result, "PASS");
  return root;
}

test("tracked file content drift fails verification", async (t) => {
  const root = await repository(t);
  await put(root, "tracked.txt", "changed\n");
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.deepEqual(result.mismatches, ["tracked.txt"]);
});

test("new tracked path without regeneration fails as missing", async (t) => {
  const root = await repository(t);
  await put(root, "new-tracked.txt", "new\n");
  git(root, ["add", "--", "new-tracked.txt"]);
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.deepEqual(result.missing, ["new-tracked.txt"]);
});

test("nonexistent path in the Manifest fails as extra", async (t) => {
  const root = await repository(t);
  await appendFile(path.join(root, ROOT_MANIFEST_PATH), `${"0".repeat(64)}  100644  zzz-does-not-exist\n`);
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.deepEqual(result.extra, ["zzz-does-not-exist"]);
});

test("duplicate Manifest path fails closed", async (t) => {
  const root = await repository(t);
  const manifest = await readFile(path.join(root, ROOT_MANIFEST_PATH), "utf8");
  await appendFile(path.join(root, ROOT_MANIFEST_PATH), manifest.split("\n")[0] + "\n");
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.equal(result.duplicateCount, 1);
});

test("worktree executable-bit drift fails verification", async (t) => {
  const root = await repository(t);
  await chmod(path.join(root, "tracked.txt"), 0o755);
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.deepEqual(result.modeMismatches, ["tracked.txt"]);
});

test("tracked symlink is rejected before generation", async (t) => {
  const root = await repository(t);
  await symlink("tracked.txt", path.join(root, "tracked-link"));
  git(root, ["add", "--", "tracked-link"]);
  await assert.rejects(updateRootManifest(root), /tracked symlink is forbidden/u);
});

test("tracked gitlink is rejected before generation", async (t) => {
  const root = await repository(t);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`]);
  await assert.rejects(updateRootManifest(root), /tracked gitlink\/submodule is forbidden/u);
});

test("unsafe filename and NUL/control bytes are rejected", async (t) => {
  const root = await repository(t);
  const unsafe = "unsafe\nname";
  await writeFile(path.join(root, unsafe), "unsafe\n");
  git(root, ["add", "--", unsafe]);
  await assert.rejects(updateRootManifest(root), /control or formatting character/u);
  assert.throws(() => validateSafePathBytes(Buffer.from([0x61, 0x00, 0x62])), /contains NUL/u);
});

test("root Manifest self-reference fails verification", async (t) => {
  const root = await repository(t, { "zzz.txt": "baseline\n" });
  const initialManifest = await readFile(path.join(root, ROOT_MANIFEST_PATH));
  const manifestSha256 = createHash("sha256").update(initialManifest).digest("hex");
  await put(root, "zzz.txt", `${manifestSha256}\n`);
  const reverseReference = await verifyRootManifest(root);
  assert.equal(reverseReference.result, "FAIL");
  assert.deepEqual(reverseReference.reverseReferences, ["zzz.txt"]);
  await put(root, "zzz.txt", "baseline\n");
  await updateRootManifest(root);
  await appendFile(
    path.join(root, ROOT_MANIFEST_PATH),
    `${"0".repeat(64)}  100644  ${ROOT_MANIFEST_PATH}\n`,
  );
  const result = await verifyRootManifest(root);
  assert.equal(result.result, "FAIL");
  assert.equal(result.selfReferenceCount, 1);
});

test("two independent generations are byte-for-byte identical", async (t) => {
  const root = await repository(t, { "alpha.txt": "alpha\n", "bin/run.sh": "#!/bin/sh\nexit 0\n" });
  await chmod(path.join(root, "bin/run.sh"), 0o755);
  git(root, ["update-index", "--chmod=+x", "--", "bin/run.sh"]);
  await updateRootManifest(root);
  const first = await readFile(path.join(root, ROOT_MANIFEST_PATH));
  await updateRootManifest(root);
  const second = await readFile(path.join(root, ROOT_MANIFEST_PATH));
  assert.deepEqual(second, first);
});

test("current and root Manifest authority boundaries are non-conflicting", async (t) => {
  const payload = Buffer.from("current payload\n");
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const currentManifest = `${payloadSha256}  payload.txt\n`;
  const root = await repository(t, {
    "current/payload.txt": payload,
    "current/MANIFEST_SHA256.txt": currentManifest,
    "root-governance.txt": "root only\n",
  });
  const parsed = parseRootManifest(await readFile(path.join(root, ROOT_MANIFEST_PATH)));
  assert.ok(parsed.firstByPath.has("current/MANIFEST_SHA256.txt"));
  assert.ok(parsed.firstByPath.has("current/payload.txt"));
  assert.ok(!parsed.firstByPath.has(ROOT_MANIFEST_PATH));
  const inner = await readFile(path.join(root, "current/MANIFEST_SHA256.txt"), "utf8");
  assert.equal(inner, currentManifest);
  assert.doesNotMatch(inner, /(?:^|\/)MANIFEST_SHA256\.txt/u);
  assert.equal((await verifyRootManifest(root)).result, "PASS");
});

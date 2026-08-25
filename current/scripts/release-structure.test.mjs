import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditActiveSourceStructure, auditArchiveManifestEntries, auditPackageStructure } from "./release-structure.mjs";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-structure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Structure Fixture"]);
  git(root, ["config", "user.email", "release-structure@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "fixture\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  return root;
}

test("active source containing a mode-160000 gitlink fails closed", async (t) => {
  const root = await repository(t);
  const commit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`]);
  await assert.rejects(auditActiveSourceStructure(root), /mode-160000 gitlink/u);
});

test("package staging containing a mode-160000 gitlink fails closed", async (t) => {
  const root = await repository(t);
  const commit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},staging/module`]);
  await assert.rejects(auditPackageStructure(root), /mode-160000 gitlink/u);
});

test("archive manifest containing a gitlink fails closed", () => {
  assert.throws(() => auditArchiveManifestEntries([
    { path: "release/vendor/module", mode: "160000", type: "gitlink" },
  ]), /archive manifest contains forbidden gitlink/u);
});

test("final ZIP carrying a mode-160000 entry fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-archive-structure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "fixture.zip");
  const created = spawnSync("python3", ["-c", [
    "import sys,zipfile",
    "z=zipfile.ZipFile(sys.argv[1],'w')",
    "i=zipfile.ZipInfo('release/vendor/module')",
    "i.create_system=3",
    "i.external_attr=0o160000<<16",
    "z.writestr(i,b'opaque')",
    "z.close()",
  ].join(";"), archive], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const verifier = spawnSync("python3", [new URL("verify-release-archive.py", import.meta.url).pathname, archive], { encoding: "utf8" });
  assert.notEqual(verifier.status, 0);
  assert.match(verifier.stderr, /mode-160000 gitlink/u);
});

test(".gitmodules anywhere in active or package scope fails closed", async (t) => {
  const active = await repository(t);
  await writeFile(path.join(active, ".gitmodules"), "[submodule \"fixture\"]\n");
  await assert.rejects(auditActiveSourceStructure(active), /\.gitmodules is forbidden/u);

  const staging = await mkdtemp(path.join(os.tmpdir(), "release-package-structure-"));
  t.after(() => rm(staging, { recursive: true, force: true }));
  await mkdir(path.join(staging, "nested"));
  await writeFile(path.join(staging, "nested", ".gitmodules"), "[submodule \"fixture\"]\n");
  await assert.rejects(auditPackageStructure(staging), /\.gitmodules is forbidden/u);
});

test("accepted historical gitlink does not fail the clean current source gate", async (t) => {
  const root = await repository(t);
  const commit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},historical/module`]);
  git(root, ["commit", "-qm", "historical gitlink fixture"]);
  git(root, ["update-index", "--force-remove", "historical/module"]);
  git(root, ["commit", "-qm", "remove gitlink from active source"]);
  const result = await auditActiveSourceStructure(root);
  assert.equal(result.result, "PASS");
  assert.equal(result.gitlinkCount, 0);
});

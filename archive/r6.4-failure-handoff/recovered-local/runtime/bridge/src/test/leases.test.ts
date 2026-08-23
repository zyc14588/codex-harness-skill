import assert from "node:assert/strict";
import test from "node:test";
import { findLeaseSymlinkIntersections } from "../git.js";
import { assertDisjointLeases, leaseMatches, leasesOverlap, validateLeasePattern } from "../util.js";

test("valid lease syntax", () => {
  assert.equal(validateLeasePattern("src/service/**"), "src/service/**");
  assert.equal(validateLeasePattern("README.md"), "README.md");
  assert.equal(validateLeasePattern("**"), "**");
  assert.throws(() => validateLeasePattern("src/*.ts"));
  assert.throws(() => validateLeasePattern("../secret"));
});

test("lease matching", () => {
  assert.equal(leaseMatches("src/service/**", "src/service/a.ts"), true);
  assert.equal(leaseMatches("src/service/**", "src/other/a.ts"), false);
  assert.equal(leaseMatches("README.md", "README.md"), true);
});

test("overlap detection", () => {
  assert.equal(leasesOverlap("src/a/**", "src/b/**"), false);
  assert.equal(leasesOverlap("src/**", "src/a/file.ts"), true);
  assert.equal(leasesOverlap("README.md", "README.md"), true);
  assert.doesNotThrow(() => assertDisjointLeases(["src/a/**"], ["src/b/**"]));
  assert.throws(() => assertDisjointLeases(["src/**"], ["src/b/**"]));
});


test("tracked symlink intersection detection", () => {
  assert.deepEqual(findLeaseSymlinkIntersections(["src/link", "docs/ref"], ["src/**"]), ["src/link"]);
  assert.deepEqual(findLeaseSymlinkIntersections(["src/link"], ["src/link/output/**"]), ["src/link"]);
  assert.deepEqual(findLeaseSymlinkIntersections(["src/link"], ["tests/**"]), []);
});


test("Git administrative paths are forbidden leases", () => {
  assert.throws(() => validateLeasePattern(".git"), /administrative/);
  assert.throws(() => validateLeasePattern(".git/**"), /administrative/);
  assert.throws(() => validateLeasePattern(".git/config"), /administrative/);
});

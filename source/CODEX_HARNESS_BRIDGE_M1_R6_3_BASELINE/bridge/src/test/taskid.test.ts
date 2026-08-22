import assert from "node:assert/strict";
import test from "node:test";
import { boundedText, safeTaskId } from "../util.js";

test("task id is sanitized", () => {
  assert.equal(safeTaskId("Feature ABC 01"), "feature-abc-01");
  assert.throws(() => safeTaskId("***"));
});


test("task id rejects dot traversal identifiers", () => {
  assert.throws(() => safeTaskId("."), /non-traversal/);
  assert.throws(() => safeTaskId(".."), /non-traversal/);
});


test("bounded text rejects NUL", () => {
  assert.throws(() => boundedText("bad\0value", "field", 100), /NUL/);
});

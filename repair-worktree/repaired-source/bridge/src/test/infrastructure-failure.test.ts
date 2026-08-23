import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMinimalToolPlaneFailure,
  failureAttribution,
  infrastructureAnomalyLabels,
} from "../infrastructure-failure.js";

const minimalHarness = { executor: "harness", harnessMode: "minimal" } as const;

test("classifies DSH managed MCP startup synchronization failure before Provider I/O", () => {
  const details = 'dsh: agent-presets: preset "codex-bridge-minimal" failed to mount: '
    + "failed to apply loader entry bridge-progressive-tools (@deepseek-ai/dsh-mcp-client): "
    + "mcp-client(bridge): initial connection or tool synchronization failed";
  assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, details), "minimal_tool_plane_composition");
});

test("classifies Bridge markers while rejecting unrelated execution errors", () => {
  assert.equal(
    classifyMinimalToolPlaneFailure(minimalHarness, "MINIMAL_TOOL_SERIALIZATION_MISMATCH: tools differ"),
    "minimal_tool_serialization_mismatch",
  );
  assert.equal(
    classifyMinimalToolPlaneFailure(minimalHarness, "MINIMAL_TOOL_PLANE_COMPOSITION: preset Node does not match the Bridge runtime"),
    "minimal_tool_plane_composition",
  );
  assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, "ordinary verification failed"), undefined);
  assert.equal(
    classifyMinimalToolPlaneFailure({ executor: "harness", harnessMode: "standard" }, "MINIMAL_TOOL_PLANE: fixture"),
    undefined,
  );
});

test("no-effect remains diagnostic infrastructure evidence and cannot shrink split memory", () => {
  assert.equal(failureAttribution("no_effect"), "infrastructure");
  assert.deepEqual(infrastructureAnomalyLabels({ infrastructureFailureKind: "no_effect" }), ["no_effect"]);
});

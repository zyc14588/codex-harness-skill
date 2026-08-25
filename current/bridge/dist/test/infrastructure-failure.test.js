import assert from "node:assert/strict";
import test from "node:test";
import { classifyMinimalToolPlaneFailure, classifyResourceControlFailure, failureAttribution, infrastructureAnomalyLabels, } from "../infrastructure-failure.js";
const minimalHarness = { executor: "harness", harnessMode: "minimal" };
test("classifies managed broker plugin startup failure before Provider I/O", () => {
    const details = 'dsh: agent-presets: preset "codex-bridge-minimal" failed to mount: '
        + "failed to apply loader entry bridge-brokered-tools (codex-bridge-brokered-tools): "
        + "brokered tool capability is unavailable";
    assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, details), "minimal_tool_plane_composition");
});
test("classifies resource controller and aggregate quota failures", () => {
    assert.equal(classifyResourceControlFailure("controlled Harness execution requires verified cgroup v2 and RLIMIT controls"), "resource_control");
    assert.equal(classifyResourceControlFailure("editor mutation would exceed aggregate worktree quota 4096"), "resource_control");
    assert.equal(classifyResourceControlFailure("ordinary unit assertion failed"), undefined);
    assert.equal(failureAttribution("resource_control"), "infrastructure");
});
test("classifies Bridge markers while rejecting unrelated execution errors", () => {
    assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, "MINIMAL_TOOL_SERIALIZATION_MISMATCH: tools differ"), "minimal_tool_serialization_mismatch");
    assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, "MINIMAL_TOOL_PLANE_COMPOSITION: preset differs from the release-bundled trusted template"), "minimal_tool_plane_composition");
    assert.equal(classifyMinimalToolPlaneFailure(minimalHarness, "ordinary verification failed"), undefined);
    assert.equal(classifyMinimalToolPlaneFailure({ executor: "harness", harnessMode: "standard" }, "MINIMAL_TOOL_PLANE: fixture"), undefined);
});
test("no-effect remains diagnostic infrastructure evidence and cannot shrink split memory", () => {
    assert.equal(failureAttribution("no_effect"), "infrastructure");
    assert.deepEqual(infrastructureAnomalyLabels({ infrastructureFailureKind: "no_effect" }), ["no_effect"]);
});
//# sourceMappingURL=infrastructure-failure.test.js.map
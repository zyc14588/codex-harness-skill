import assert from "node:assert/strict";
import test from "node:test";
import { governedHarnessMode } from "../service.js";
test("0.6.6 rejects every new Harness standard-mode request", () => {
    assert.throws(() => governedHarnessMode("harness", "standard", "unit leaf"), /standard mode is disabled/u);
    assert.equal(governedHarnessMode("harness", "minimal", "unit leaf"), "minimal");
    assert.equal(governedHarnessMode("harness", undefined, "unit leaf"), "minimal");
    assert.equal(governedHarnessMode("llama_cpp", undefined, "local leaf"), "standard");
});
//# sourceMappingURL=standard-mode.test.js.map
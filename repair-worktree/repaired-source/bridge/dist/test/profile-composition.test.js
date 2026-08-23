import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectMinimalPresetNodeCommand } from "../harness-isolation.js";
import { inspectMinimalProfileComposition } from "../service.js";
const repairedDump = `# effective profile
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-llm'
  disabled: true
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: codex-bridge-minimal
- id: headless-runner
  name: '@deepseek-ai/dsh-headless'
  disabled: true
- id: codex-bridge-headless-runner
  name: ./bridge-headless-runner.mjs
  inject:
    - tools
`;
test("accepts only the effective managed minimal runner composition", () => {
    const result = inspectMinimalProfileComposition(repairedDump, "");
    assert.deepEqual(result, {
        ok: true,
        stockRunnerDisabled: true,
        bridgeRunnerMounted: true,
        sessionTitleDisabled: true,
        minimalPresetSelected: true,
        patchWarningFree: true,
        errors: [],
    });
});
test("rejects the R6.4 skipped name-replacement composition", () => {
    const brokenDump = repairedDump
        .replace("  disabled: true\n- id: codex-bridge-headless-runner\n  name: ./bridge-headless-runner.mjs\n  inject:\n    - tools\n", "")
        .replace("- id: headless-runner\n  name: '@deepseek-ai/dsh-headless'\n", "- id: headless-runner\n  name: '@deepseek-ai/dsh-headless'\n");
    const result = inspectMinimalProfileComposition(brokenDump, 'patch: name mismatch for "headless-runner"; skipping');
    assert.equal(result.ok, false);
    assert.equal(result.stockRunnerDisabled, false);
    assert.equal(result.bridgeRunnerMounted, false);
    assert.equal(result.patchWarningFree, false);
    assert.ok(result.errors.length >= 3);
});
function minimalPreset(command) {
    return `- id: bridge-progressive-tools\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    command: ${JSON.stringify(command)}\n`;
}
test("managed minimal preset must use the exact Node binary mounted by Bubblewrap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-minimal-preset-node-"));
    const preset = path.join(root, "preset");
    const wrapper = path.join(root, "node-wrapper");
    try {
        await mkdir(preset);
        await writeFile(path.join(preset, "agent.cordis.yml"), minimalPreset(process.execPath));
        const valid = await inspectMinimalPresetNodeCommand(preset);
        assert.equal(valid.ok, true, JSON.stringify(valid));
        await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`, { mode: 0o700 });
        await writeFile(path.join(preset, "agent.cordis.yml"), minimalPreset(wrapper));
        const invalid = await inspectMinimalPresetNodeCommand(preset);
        assert.equal(invalid.ok, false);
        assert.ok(invalid.errors.some((item) => item.includes("does not match the Bridge runtime")));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=profile-composition.test.js.map
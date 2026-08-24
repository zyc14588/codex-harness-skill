import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectMinimalPresetBrokerComposition } from "../harness-isolation.js";
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
test("managed minimal preset must exactly match the in-process Bridge broker composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-minimal-preset-broker-"));
    const preset = path.join(root, "preset");
    const trusted = path.join(root, "trusted.yml.in");
    const template = `- id: bridge-brokered-tools\n  name: '{{CODEX_HARNESS_BROKER_PLUGIN}}'\n  config: {}\n`;
    const composition = template.replace("{{CODEX_HARNESS_BROKER_PLUGIN}}", "/sandbox/dsh/profiles/codex-minimal-headless/bridge-brokered-tools.mjs");
    try {
        await mkdir(preset);
        await writeFile(trusted, template);
        await writeFile(path.join(preset, "agent.cordis.yml"), composition);
        const valid = await inspectMinimalPresetBrokerComposition(preset, trusted);
        assert.equal(valid.ok, true, JSON.stringify(valid));
        await writeFile(path.join(preset, "agent.cordis.yml"), `- id: bridge-brokered-tools\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    command: /sandbox/tool-sandbox-entry.sh\n`);
        const invalid = await inspectMinimalPresetBrokerComposition(preset, trusted);
        assert.equal(invalid.ok, false);
        assert.ok(invalid.errors.some((item) => item.includes("forbidden local subprocess/MCP")));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("managed broker tools propagate Harness execution cancellation into fetch", async () => {
    const source = await readFile(fileURLToPath(new URL("../../../harness/minimal/profile/bridge-brokered-tools.mjs", import.meta.url)), "utf8");
    assert.match(source, /async execute\(args, exec\)/u);
    assert.match(source, /AbortSignal\.any\(\[signal, timeout\]\)/u);
    assert.match(source, /execute\(args, exec\?\.signal\)/u);
});
//# sourceMappingURL=profile-composition.test.js.map
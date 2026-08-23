import assert from "node:assert/strict";
import test from "node:test";
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
  const result = inspectMinimalProfileComposition(
    brokenDump,
    'patch: name mismatch for "headless-runner"; skipping',
  );
  assert.equal(result.ok, false);
  assert.equal(result.stockRunnerDisabled, false);
  assert.equal(result.bridgeRunnerMounted, false);
  assert.equal(result.patchWarningFree, false);
  assert.ok(result.errors.length >= 3);
});

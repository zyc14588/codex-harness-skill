import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MODEL_VISIBLE_ESTIMATED_TOKEN_MAX, MODEL_VISIBLE_TEXT_MAX_BYTES, modelVisibleTextPage, } from "../brokered-tool-host.js";
test("model-visible pages are byte-bounded, UTF-8 safe, token-estimated, and resumable", () => {
    const source = `${"四".repeat(40_000)}\n${"x".repeat(80_000)}`;
    const pages = [];
    let offset = 0;
    for (let index = 0; index < 100; index += 1) {
        const page = modelVisibleTextPage(source, offset, 4_097);
        assert.ok(Buffer.byteLength(page.text, "utf8") <= 4_097);
        assert.doesNotMatch(page.text, /�/u);
        assert.equal(page.truncation.returnedBytes, Buffer.byteLength(page.text, "utf8"));
        assert.equal(page.truncation.estimatedTokens, Math.ceil(page.truncation.returnedBytes / 4));
        pages.push(page.text);
        if (page.truncation.nextOffsetBytes === null)
            break;
        assert.ok(page.truncation.nextOffsetBytes > offset);
        offset = page.truncation.nextOffsetBytes;
    }
    assert.equal(pages.join(""), source);
});
test("model-visible output refuses oversized pages and publishes a fixed token ceiling", () => {
    const page = modelVisibleTextPage("a".repeat(MODEL_VISIBLE_TEXT_MAX_BYTES + 10));
    assert.equal(Buffer.byteLength(page.text), MODEL_VISIBLE_TEXT_MAX_BYTES);
    assert.equal(page.truncation.maxEstimatedTokens, MODEL_VISIBLE_ESTIMATED_TOKEN_MAX);
    assert.equal(page.truncation.truncated, true);
    assert.equal(page.truncation.nextOffsetBytes, MODEL_VISIBLE_TEXT_MAX_BYTES);
    assert.throws(() => modelVisibleTextPage("x", 0, MODEL_VISIBLE_TEXT_MAX_BYTES + 1), /max_bytes/u);
});
test("managed tool schemas expose byte pagination for repository and editor reads", async () => {
    const plugin = await readFile(fileURLToPath(new URL("../../../harness/minimal/profile/bridge-brokered-tools.mjs", import.meta.url)), "utf8");
    assert.match(plugin, /repo_read_file:[\s\S]*offset_bytes:[\s\S]*max_bytes:/u);
    assert.match(plugin, /register\('str_replace_editor'[\s\S]*offset_bytes:[\s\S]*max_bytes:/u);
});
//# sourceMappingURL=model-visible-output.test.js.map
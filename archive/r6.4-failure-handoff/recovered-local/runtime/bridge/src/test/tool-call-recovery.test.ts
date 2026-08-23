import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedToolNamesFromRequest,
  parseDsmlToolCalls,
  parseMarkdownShellToolCall,
  parseTextualToolCallEnvelope,
  transformProviderToolCalls,
} from "../tool-call-recovery.js";

const request = {
  model: "deepseek-v4-flash",
  stream: true,
  tools: [
    { type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } },
    { type: "function", function: { name: "str_replace_editor", description: "edit", parameters: { type: "object" } } },
  ],
};

const boundedContract = `# CODEX-HARNESS BOUNDED LEAF CONTRACT

Task ID: markdown-probe
Mode: implementation

## Objective
Create probe.json

## Harness exclusive write leases
- probe.json

## Acceptance criteria
- probe.json exists
`;

const boundedRequest = {
  ...request,
  messages: [{ role: "user", content: boundedContract }],
};

function sse(...payloads: unknown[]): Buffer {
  return Buffer.from(`${payloads.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`);
}

function events(body: Buffer): Array<Record<string, unknown>> {
  return body.toString("utf8").split(/\n\n+/).flatMap((event) => {
    const line = event.split("\n").find((item) => item.startsWith("data:"));
    if (!line) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

function toolCalls(body: Buffer): Array<Record<string, unknown>> {
  return events(body).flatMap((event) => {
    const choices = event.choices;
    if (!Array.isArray(choices)) return [];
    return choices.flatMap((rawChoice) => {
      if (!rawChoice || typeof rawChoice !== "object") return [];
      const delta = (rawChoice as Record<string, unknown>).delta;
      if (!delta || typeof delta !== "object") return [];
      const calls = (delta as Record<string, unknown>).tool_calls;
      return Array.isArray(calls) ? calls as Array<Record<string, unknown>> : [];
    });
  });
}

test("recovers canonical full-width DSML content into native streamed tool calls", () => {
  const dsml = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">printf '{"ok":true}\\n' &gt; probe.json</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
  const original = sse(
    { id: "chatcmpl-1", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { content: dsml }, finish_reason: "stop" }] },
    { id: "chatcmpl-1", model: "deepseek-v4-flash", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  );
  const transformed = transformProviderToolCalls("text/event-stream", original, request);
  assert.equal(transformed.failure, undefined);
  assert.equal(transformed.changed, true);
  assert.deepEqual(transformed.recoveryKinds, ["dsml_content_to_tool_calls"]);
  const calls = toolCalls(transformed.body);
  assert.equal(calls.length, 1);
  const fn = calls[0]?.function as Record<string, unknown>;
  assert.equal(fn.name, "bash");
  assert.deepEqual(JSON.parse(String(fn.arguments)), { command: `printf '{"ok":true}\\n' > probe.json` });
  assert.match(transformed.body.toString("utf8"), /"finish_reason":"tool_calls"/);
  assert.match(transformed.body.toString("utf8"), /"prompt_tokens":100/);
});

test("recovers an invoke when the DSML outer start marker is missing", () => {
  const content = `<｜DSML｜invoke name="str_replace_editor"><｜DSML｜parameter name="path" string="true">/tmp/a.txt</｜DSML｜parameter><｜DSML｜parameter name="dry_run" string="false">false</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
  const parsed = parseDsmlToolCalls(content, allowedToolNamesFromRequest(request));
  assert.equal(parsed.failure, undefined);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0]?.name, "str_replace_editor");
  assert.deepEqual(JSON.parse(parsed.calls[0]?.arguments ?? "{}"), { path: "/tmp/a.txt", dry_run: false });
});

test("does not execute DSML examples inside fenced code blocks", () => {
  const content = "Example only:\n```xml\n<｜DSML｜tool_calls><｜DSML｜invoke name=\"bash\"><｜DSML｜parameter name=\"command\" string=\"true\">rm -rf /</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>\n```";
  const parsed = parseDsmlToolCalls(content, allowedToolNamesFromRequest(request));
  assert.equal(parsed.markerFound, false);
  assert.equal(parsed.calls.length, 0);
});

test("fails closed when DSML names a tool not present in the request catalog", () => {
  const content = `<｜DSML｜tool_calls><｜DSML｜invoke name="delete_everything"><｜DSML｜parameter name="path" string="true">/</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
  const parsed = parseDsmlToolCalls(content, allowedToolNamesFromRequest(request));
  assert.match(parsed.failure ?? "", /undisclosed tool/);
});

test("normalizes null continuation fields in structured streamed tool calls", () => {
  const original = sse(
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-real", type: "function", function: { name: "bash", arguments: "{\"command\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: "\"echo ok\"}" } }] }, finish_reason: "tool_calls" }] },
  );
  const transformed = transformProviderToolCalls("text/event-stream", original, request);
  assert.equal(transformed.failure, undefined);
  assert.deepEqual(transformed.recoveryKinds, ["structured_tool_call_delta_normalized"]);
  assert.equal(transformed.nativeToolCallCount, 1);
  const calls = toolCalls(transformed.body);
  assert.equal(calls[0]?.id, "call-real");
  const fn = calls[0]?.function as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(fn.arguments)), { command: "echo ok" });
});

test("recovers DSML from a non-stream JSON completion", () => {
  const original = Buffer.from(JSON.stringify({
    id: "chatcmpl-json",
    choices: [{
      index: 0,
      message: { role: "assistant", content: `<|DSML|tool_calls><|DSML|invoke name="bash"><|DSML|parameter name="command" string="true">touch ok</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>` },
      finish_reason: "stop",
    }],
  }));
  const transformed = transformProviderToolCalls("application/json", original, { ...request, stream: false });
  assert.equal(transformed.failure, undefined);
  const root = JSON.parse(transformed.body.toString("utf8")) as { choices: Array<{ message: { tool_calls: unknown[] }; finish_reason: string }> };
  assert.equal(root.choices[0]?.finish_reason, "tool_calls");
  assert.equal(root.choices[0]?.message.tool_calls.length, 1);
});

test("returns a protocol failure instead of leaking malformed executable DSML", () => {
  const original = sse({ choices: [{ index: 0, delta: { content: `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">incomplete` }, finish_reason: "stop" }] });
  const transformed = transformProviderToolCalls("text/event-stream", original, request);
  assert.equal(transformed.changed, false);
  assert.match(transformed.failure ?? "", /no complete executable invoke/);
});

test("passes through valid structured calls and records native evidence", () => {
  const original = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-valid", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo ok\"}" } }] }, finish_reason: "tool_calls" }] });
  const transformed = transformProviderToolCalls("text/event-stream", original, request);
  assert.equal(transformed.changed, false);
  assert.deepEqual(transformed.recoveryKinds, []);
  assert.equal(transformed.nativeToolCallCount, 1);
  assert.deepEqual(transformed.nativeToolNames, ["bash"]);
  assert.deepEqual(transformed.body, original);
});

test("recovers a standalone Markdown bash fence for a mutating bounded leaf", () => {
  const original = sse({ choices: [{ index: 0, delta: { content: "```bash\nprintf '{\"status\":\"PASS\"}\\n' > probe.json\n```" }, finish_reason: "stop" }] });
  const transformed = transformProviderToolCalls("text/event-stream", original, boundedRequest);
  assert.equal(transformed.failure, undefined);
  assert.equal(transformed.changed, true);
  assert.deepEqual(transformed.recoveryKinds, ["markdown_shell_fence_to_tool_calls"]);
  const calls = toolCalls(transformed.body);
  assert.equal(calls.length, 1);
  const fn = calls[0]?.function as Record<string, unknown>;
  assert.equal(fn.name, "bash");
  assert.match(String(JSON.parse(String(fn.arguments)).command), /probe\.json/u);
});

test("recovers another exact Markdown fence after earlier tool history", () => {
  const withHistory = {
    ...boundedRequest,
    messages: [
      ...boundedRequest.messages,
      { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{\"command\":\"pwd\"}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "/tmp/repo" },
    ],
  };
  const parsed = parseMarkdownShellToolCall("```sh\nprintf done > probe.json\n```", allowedToolNamesFromRequest(withHistory), withHistory);
  assert.equal(parsed.failure, undefined);
  assert.equal(parsed.calls[0]?.name, "bash");
});

test("fails closed on prose-wrapped executable Markdown", () => {
  const original = sse({ choices: [{ index: 0, delta: { content: "Run this:\n```bash\ntouch probe.json\n```" }, finish_reason: "stop" }] });
  const transformed = transformProviderToolCalls("text/event-stream", original, boundedRequest);
  assert.equal(transformed.changed, false);
  assert.match(transformed.failure ?? "", /single standalone fenced block/u);
});

test("does not recover shell Markdown outside a mutating bounded contract", () => {
  const analysisRequest = {
    ...boundedRequest,
    messages: [{ role: "user", content: boundedContract.replace("Mode: implementation", "Mode: analysis") }],
  };
  const original = sse({ choices: [{ index: 0, delta: { content: "```bash\ntouch probe.json\n```" }, finish_reason: "stop" }] });
  const transformed = transformProviderToolCalls("text/event-stream", original, analysisRequest);
  assert.equal(transformed.changed, false);
  assert.equal(transformed.failure, undefined);
});

test("does not recover a mutating fence when the write lease is empty", () => {
  const noLease = {
    ...boundedRequest,
    messages: [{ role: "user", content: boundedContract.replace("- probe.json", "- （无）") }],
  };
  const parsed = parseMarkdownShellToolCall("```bash\ntouch probe.json\n```", allowedToolNamesFromRequest(noLease), noLease);
  assert.equal(parsed.markerFound, false);
});

test("recovers a standalone PowerShell fence only when pwsh is disclosed", () => {
  const requestWithPwsh = {
    ...boundedRequest,
    stream: false,
    tools: [
      ...boundedRequest.tools,
      { type: "function", function: { name: "pwsh", description: "run PowerShell", parameters: { type: "object" } } },
    ],
  };
  const original = Buffer.from(JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "```powershell\nSet-Content -Path probe.json -Value '{}'\n```" }, finish_reason: "stop" }],
  }));
  const transformed = transformProviderToolCalls("application/json", original, requestWithPwsh);
  assert.equal(transformed.failure, undefined);
  const root = JSON.parse(transformed.body.toString("utf8")) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> };
  assert.equal(root.choices[0]?.message.tool_calls[0]?.function.name, "pwsh");
});


test("recovers an exact named textual bash tool-call envelope", () => {
  const text = `bash tool-call:\n{"command":"printf '{\\"status\\":\\"PASS\\"}\\n' > probe.json"}`;
  const parsed = parseTextualToolCallEnvelope(text, allowedToolNamesFromRequest(boundedRequest), boundedRequest);
  assert.equal(parsed.failure, undefined);
  assert.equal(parsed.markerFound, true);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0]?.name, "bash");
  assert.match(String(JSON.parse(parsed.calls[0]?.arguments ?? "{}").command), /probe\.json/u);
});

test("recovers exact XML and bracket textual tool-call envelopes", () => {
  const allowed = allowedToolNamesFromRequest(boundedRequest);
  const xml = parseTextualToolCallEnvelope(
    `<tool_call name="bash">{"command":"touch probe.json"}</tool_call>`,
    allowed,
    boundedRequest,
  );
  assert.equal(xml.failure, undefined);
  assert.equal(xml.calls[0]?.name, "bash");

  const bracket = parseTextualToolCallEnvelope(
    `[Calling tool: bash with arguments: {"command":"touch probe.json"}]`,
    allowed,
    boundedRequest,
  );
  assert.equal(bracket.failure, undefined);
  assert.equal(bracket.calls[0]?.name, "bash");
});

test("converts a textual tool-call envelope in streamed provider content", () => {
  const original = sse({
    choices: [{
      index: 0,
      delta: { content: `bash\n{"command":"printf ok > probe.json"}` },
      finish_reason: "stop",
    }],
  });
  const transformed = transformProviderToolCalls("text/event-stream", original, boundedRequest);
  assert.equal(transformed.failure, undefined);
  assert.equal(transformed.changed, true);
  assert.deepEqual(transformed.recoveryKinds, ["text_tool_call_envelope_to_tool_calls"]);
  const calls = toolCalls(transformed.body);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]?.function as Record<string, unknown>).name, "bash");
});

test("does not treat ordinary target JSON as executable tool-call JSON", () => {
  const parsed = parseTextualToolCallEnvelope(
    `{"status":"PASS","executor":"harness"}`,
    allowedToolNamesFromRequest(boundedRequest),
    boundedRequest,
  );
  assert.equal(parsed.markerFound, false);
  assert.equal(parsed.calls.length, 0);
});

test("fails closed on prose-wrapped textual tool-call markup", () => {
  const parsed = parseTextualToolCallEnvelope(
    `I will run this now:\n<tool_call name="bash">{"command":"touch probe.json"}</tool_call>`,
    allowedToolNamesFromRequest(boundedRequest),
    boundedRequest,
  );
  assert.equal(parsed.markerFound, true);
  assert.match(parsed.failure ?? "", /exact supported envelope/u);
});

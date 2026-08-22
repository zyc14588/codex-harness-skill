#!/usr/bin/env node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.argv.includes("--version")) {
  console.log("fake-dsh 0.6.3");
  process.exit(0);
}
if (process.argv.includes("--dump-config") || process.argv.includes("--dump-default-config")) {
  console.log("- id: fake-headless\n  name: fake-headless-profile\n");
  process.exit(0);
}

const prompt = process.argv.at(-1) ?? "";

async function exerciseControlledNetwork() {
  const base = process.env.DEEPSEEK_BASE_URL?.replace(/\/+$/, "");
  if (!base || prompt.includes("NO_MODEL_CALL")) return;
  const count = ["TOKEN_GATE_TASK", "DYNAMIC_TOKEN_TASK", "REFERENCE_ONLY_TASK", "PRO_COMPLEX_TASK"].some((marker) => prompt.includes(marker)) ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    if (prompt.includes("DYNAMIC_TOKEN_TASK") && index === 1) await new Promise((resolve) => setTimeout(resolve, 1800));
    const toolRecoveryProbe = prompt.includes("DSML_RECOVERY_TASK")
      || prompt.includes("DSML_MALFORMED_TASK")
      || prompt.includes("MARKDOWN_SHELL_RECOVERY_TASK")
      || prompt.includes("TEXTUAL_TOOL_CALL_RECOVERY_TASK")
      || prompt.includes("REQUIRED_TOOL_CHOICE_VIOLATION_TASK")
      || prompt.includes("NATIVE_TOOL_CALL_TASK");
    const probeMarker = prompt.includes("DSML_MALFORMED_TASK")
      ? "DSML_MALFORMED_PROBE"
      : prompt.includes("MARKDOWN_SHELL_RECOVERY_TASK")
        ? "MARKDOWN_SHELL_RECOVERY_PROBE"
        : prompt.includes("TEXTUAL_TOOL_CALL_RECOVERY_TASK")
          ? "TEXTUAL_TOOL_CALL_RECOVERY_PROBE"
        : prompt.includes("REQUIRED_TOOL_CHOICE_VIOLATION_TASK")
          ? "REQUIRED_TOOL_CHOICE_VIOLATION_PROBE"
        : prompt.includes("NATIVE_TOOL_CALL_TASK")
          ? "NATIVE_TOOL_CALL_PROBE"
        : prompt.includes("DSML_RECOVERY_TASK")
          ? "DSML_RECOVERY_PROBE"
          : `bounded fake Harness request ${index + 1}`;
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-acceptance-key" },
      body: JSON.stringify({
        model: process.env.DSH_MODEL ?? "deepseek-v4-flash",
        messages: [{ role: "user", content: toolRecoveryProbe ? `${prompt}\n\n${probeMarker}` : probeMarker }],
        ...(toolRecoveryProbe ? {
          tools: [{ type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
          tool_choice: "auto",
        } : {}),
        max_tokens: 256,
        stream: toolRecoveryProbe || prompt.includes("STREAM_MODEL_TASK"),
      }),
    });
    if (!response.ok) throw new Error(`controlled model proxy returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (toolRecoveryProbe) {
      const text = await response.text();
      if (text.includes("<｜DSML｜") || text.includes("<|DSML|")) throw new Error("raw DSML leaked through the bridge proxy");
      if (text.includes("```bash") || text.includes("```sh")) throw new Error("raw executable Markdown shell block leaked through the bridge proxy");
      if (text.includes("bash tool-call:") || text.includes("<tool_call")) throw new Error("raw textual tool-call envelope leaked through the bridge proxy");
      let toolName;
      let argumentsText = "";
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        for (const choice of event.choices ?? []) {
          for (const call of choice.delta?.tool_calls ?? []) {
            if (typeof call.function?.name === "string" && call.function.name) toolName = call.function.name;
            if (typeof call.function?.arguments === "string") argumentsText += call.function.arguments;
          }
        }
      }
      if (toolName !== "bash") throw new Error(`expected recovered bash tool call, got ${String(toolName)}`);
      const args = JSON.parse(argumentsText || "{}");
      if (typeof args.command !== "string") throw new Error("recovered bash call omitted command");
      execFileSync("bash", ["-lc", args.command], { cwd: process.cwd(), stdio: "inherit" });
    } else {
      await response.arrayBuffer();
    }
  }
  const search = process.env.DEEPSEEK_SEARCH_BASE_URL?.replace(/\/+$/, "");
  if (search) {
    const response = await fetch(`${search}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (response.status !== 403) throw new Error(`search gate expected 403, got ${response.status}`);
  }
}

if (prompt.includes("FAIL_TASK")) {
  console.error("intentional fake Harness failure");
  process.exit(7);
}
if (prompt.includes("LOG_LIMIT_TASK")) {
  process.stdout.write("x".repeat(20_000_100));
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}
if (prompt.includes("SLOW_TASK")) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  console.log("RESULT: slow task completed unexpectedly");
  process.exit(0);
}
if (prompt.includes("SCOPE_VIOLATION")) {
  await writeFile(path.join(process.cwd(), "outside.txt"), "out-of-scope\n", "utf8");
  console.log("RESULT: intentionally wrote outside scope");
  process.exit(0);
}
if (prompt.includes("NEW_SYMLINK_TASK")) {
  await mkdir(path.join(process.cwd(), "src/harness"), { recursive: true });
  await symlink("/tmp", path.join(process.cwd(), "src/harness/new-link"), "dir");
  console.log("RESULT: intentionally created a changed symlink");
  process.exit(0);
}
if (prompt.includes("NEW_GITLINK_TASK")) {
  await mkdir(path.join(process.cwd(), "src/harness"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${head},src/harness/new-submodule`], { cwd: process.cwd(), stdio: "ignore" });
  await writeFile(path.join(process.cwd(), ".gitmodules"), "[submodule \"src/harness/new-submodule\"]\n\tpath = src/harness/new-submodule\n\turl = ../local\n", "utf8");
  console.log("RESULT: intentionally created gitlink/submodule metadata");
  process.exit(0);
}
if (prompt.includes("STAGED_TASK")) {
  await mkdir(path.join(process.cwd(), "src/harness"), { recursive: true });
  await writeFile(path.join(process.cwd(), "src/harness/staged.txt"), "unauthorized stage\n", "utf8");
  execFileSync("git", ["add", "src/harness/staged.txt"], { cwd: process.cwd(), stdio: "ignore" });
  console.log("RESULT: intentionally changed Git index");
  process.exit(0);
}
if (prompt.includes("COMMIT_TASK")) {
  await mkdir(path.join(process.cwd(), "src/harness"), { recursive: true });
  await writeFile(path.join(process.cwd(), "src/harness/committed.txt"), "unauthorized commit\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: process.cwd(), stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "unauthorized Harness commit"], { cwd: process.cwd(), stdio: "ignore" });
  console.log("RESULT: intentionally changed Git HEAD");
  process.exit(0);
}

await exerciseControlledNetwork();
if (prompt.includes("DSML_RECOVERY_TASK")) {
  console.log("RESULT: PASS\nCHANGED_PATHS: src/harness/dsml-recovered.json\nTESTS: DSML recovery produced and executed a native bash tool call\nRISKS: none\nHANDOFF_TO_CODEX: review diff");
  process.exit(0);
}
if (prompt.includes("MARKDOWN_SHELL_RECOVERY_TASK")) {
  console.log("RESULT: PASS\nCHANGED_PATHS: src/harness/markdown-recovered.json\nTESTS: Markdown shell recovery produced and executed a native bash tool call\nRISKS: none\nHANDOFF_TO_CODEX: review diff");
  process.exit(0);
}
if (prompt.includes("NATIVE_TOOL_CALL_TASK")) {
  console.log("RESULT: PASS\nCHANGED_PATHS: src/harness/native-tool-call.json\nTESTS: Provider native structured bash tool call executed\nRISKS: none\nHANDOFF_TO_CODEX: review diff");
  process.exit(0);
}
if (prompt.includes("TEXTUAL_TOOL_CALL_RECOVERY_TASK")) {
  console.log("RESULT: PASS\nCHANGED_PATHS: src/harness/textual-tool-call.json\nTESTS: Textual bash tool-call envelope was normalized and executed\nRISKS: none\nHANDOFF_TO_CODEX: review diff");
  process.exit(0);
}
if (prompt.includes("COMPLETED_NO_CHANGES_TASK")) {
  console.log("RESULT: PASS\nCHANGED_PATHS: none\nTESTS: intentionally produced no diff\nRISKS: required output missing\nHANDOFF_TO_CODEX: reject empty diff");
  process.exit(0);
}
if (prompt.includes("PARALLEL_DELAY_TASK")) await new Promise((resolve) => setTimeout(resolve, 1800));
const repair = prompt.includes("Mandatory Codex repair feedback");
const explicitTarget = /TARGET_PATH:\s*([^\s]+)/.exec(prompt)?.[1];
let relativeTarget = repair ? "src/harness/repair.txt" : (explicitTarget ?? "src/harness/result.txt");
let targetContent = repair ? "repaired\n" : "implemented\n";
if (prompt.includes("LLAMA_FALLBACK_TASK")) {
  relativeTarget = "src/local/fallback.txt";
  targetContent = `generated by Harness ${process.env.DSH_MODEL ?? "unknown-model"} fallback\n`;
} else if (prompt.includes("LLAMA_OMIT_OUTPUT")) {
  relativeTarget = "src/local/omitted.txt";
  targetContent = `generated by Harness ${process.env.DSH_MODEL ?? "unknown-model"} fallback after invalid local output\n`;
} else if (prompt.includes("LLAMA_TIMEOUT_TASK")) {
  relativeTarget = "src/local/timeout.txt";
  targetContent = `generated by Harness ${process.env.DSH_MODEL ?? "unknown-model"} fallback after local timeout\n`;
} else if (prompt.includes("DYNAMIC_TOKEN_TASK")) {
  relativeTarget = "src/harness/dynamic-token.txt";
  targetContent = "completed after live token gate expansion\n";
} else if (prompt.includes("PRO_COMPLEX_TASK")) {
  relativeTarget = "src/pro/complex.txt";
  targetContent = `completed by Harness ${process.env.DSH_MODEL ?? "unknown-model"} complex leaf\n`;
}
const target = path.join(process.cwd(), relativeTarget);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, targetContent, "utf8");
console.log(`RESULT: PASS\nCHANGED_PATHS: ${path.relative(process.cwd(), target)}\nTESTS: fake deterministic worker\nRISKS: none\nHANDOFF_TO_CODEX: review diff`);

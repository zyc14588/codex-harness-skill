import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTask, taskDirectory } from "../store.js";
import { parseToolPayload, StdioMcpClient } from "../stdio-client.js";
import { runProcess } from "../util.js";
import { testConfig } from "./test-config.js";
function toolNames(value) {
    const tools = value.tools ?? [];
    return tools.map((tool) => tool.name ?? "").filter(Boolean).sort();
}
test("minimal MCP progressively discloses only contract-authorized read tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-minimal-tools-"));
    const state = path.join(root, "state");
    const repo = path.join(root, "repo");
    try {
        await runProcess("git", ["init", "-q", repo]);
        await runProcess("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
        await runProcess("git", ["config", "user.name", "Test"], { cwd: repo });
        await writeFile(path.join(repo, "fixture.txt"), "alpha\nbeta\ngamma\n", "utf8");
        await runProcess("git", ["add", "fixture.txt"], { cwd: repo });
        await runProcess("git", ["commit", "-qm", "fixture"], { cwd: repo });
        const config = testConfig(state);
        config.allowedRepoRoots = [root];
        const configPath = path.join(root, "config.json");
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        const id = "minimal-tools-task";
        const dir = taskDirectory(config, id);
        const task = {
            schemaVersion: 6,
            id,
            planId: "plan-minimal",
            leafId: "leaf-minimal",
            budgetGroupId: "group-minimal",
            requestedExecutor: "harness",
            executor: "harness",
            effectiveExecutor: "harness",
            complexity: "small",
            harnessMode: "minimal",
            dependsOn: [],
            toolCapabilities: ["repository_read", "git_inspect"],
            taskFamily: "minimal-tool-test",
            splitDecision: {
                memorySchemaVersion: 3,
                memoryKey: "minimal",
                taskFamily: "minimal-tool-test",
                memoryRevision: 0,
                sampleCount: 0,
                ignoredLegacySampleCount: 0,
                confidence: 0,
                recommendedLeafScale: 1,
                recommendedComplexity: "small",
                recommendedMaxInputTokens: 1000,
                recommendedMaxOutputTokens: 1000,
                anomalyRate: 0,
                rationale: ["fixture"],
                chosenComplexity: "small",
                chosenMaxInputTokens: 1000,
                chosenMaxOutputTokens: 1000,
            },
            mode: "implementation",
            objective: "fixture",
            repoRoot: repo,
            baseRef: "HEAD",
            baseCommit: "0".repeat(40),
            startingHeadCommit: "0".repeat(40),
            branchName: "agent/minimal",
            worktreePath: repo,
            harnessWritePaths: ["generated.txt"],
            codexWritePaths: [],
            acceptanceCriteria: ["fixture"],
            contextFiles: [],
            verificationCommands: ["test -f fixture.txt"],
            budget: config.controller.defaultHarnessBudget,
            status: "running",
            createdAt: "2026-08-21T00:00:00.000Z",
            runtimeSeconds: 60,
            promptPath: path.join(dir, "prompt.txt"),
            stdoutPath: path.join(dir, "stdout.log"),
            stderrPath: path.join(dir, "stderr.log"),
            usagePath: path.join(dir, "usage.jsonl"),
            changedPaths: [],
            outOfScopePaths: [],
        };
        await createTask(config, task);
        const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../minimal-tools-server.js");
        const client = await StdioMcpClient.connect(process.execPath, [serverPath], {
            ...process.env,
            CODEX_HARNESS_CONFIG: configPath,
            CODEX_HARNESS_TASK_ID: id,
        });
        try {
            assert.deepEqual(toolNames(await client.listTools()), ["capability_catalog", "capability_enable"]);
            const denied = parseToolPayload(await client.callTool("capability_enable", { capability: "verification", reason: "attempt escalation" }), true);
            assert.match(String(denied.error), /not authorized/);
            assert.deepEqual(toolNames(await client.listTools()), ["capability_catalog", "capability_enable"]);
            const enabled = parseToolPayload(await client.callTool("capability_enable", { capability: "repository_read", reason: "inspect fixture" }));
            assert.equal(enabled.changed, true);
            assert.deepEqual(toolNames(await client.listTools()), ["capability_catalog", "capability_enable", "repo_read_file", "repo_search"]);
            const read = parseToolPayload(await client.callTool("repo_read_file", { filePath: "fixture.txt", startLine: 2, endLine: 3 }));
            assert.equal(read.text, "beta\ngamma");
            await assert.rejects(() => client.callTool("git_status", {}), /not currently disclosed/);
            parseToolPayload(await client.callTool("capability_enable", { capability: "git_inspect", reason: "inspect diff" }));
            assert.ok(toolNames(await client.listTools()).includes("git_status"));
            const audit = await readFile(path.join(dir, "progressive-tools-audit.ndjson"), "utf8");
            assert.match(audit, /"result":"denied"/);
            assert.match(audit, /"result":"enabled"/);
            assert.match(audit, /"tool":"repo_read_file"/);
        }
        finally {
            await client.close();
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=minimal-tools.test.js.map
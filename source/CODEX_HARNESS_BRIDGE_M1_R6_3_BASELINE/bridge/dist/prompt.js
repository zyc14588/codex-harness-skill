export function buildHarnessPrompt(task, repairFeedback) {
    const list = (items) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- （无）";
    return `# CODEX-HARNESS BOUNDED LEAF CONTRACT\n\n` +
        `Task ID: ${task.id}\n` +
        `Controller plan: ${task.planId}\n` +
        `Leaf: ${task.leafId}\n` +
        `Mode: ${task.mode}\n` +
        `Complexity: ${task.complexity}\n` +
        `Repository worktree: ${task.worktreePath}\n` +
        `Base commit: ${task.baseCommit}\n\n` +
        `## Objective\n${task.objective}\n\n` +
        `## Harness exclusive write leases\n${list(task.harnessWritePaths)}\n\n` +
        `Only modify files covered by those leases. Reading other repository files is allowed only when needed for this bounded leaf. ` +
        `Do not modify Codex-owned paths, governance files, dependency locks, CI, or generated artifacts unless explicitly leased.\n\n` +
        `## Codex concurrent write leases (read-only to you)\n${list(task.codexWritePaths)}\n\n` +
        `## Acceptance criteria\n${list(task.acceptanceCriteria)}\n\n` +
        `## Controller-selected context files to inspect first\n${list(task.contextFiles)}\n\n` +
        `## Cumulative resource contract shared with all repairs\n` +
        `Execution gates (hard):\n` +
        `- Input tokens: ${task.budget.maxInputTokens}\n` +
        `- Output tokens: ${task.budget.maxOutputTokens}\n` +
        `Reference thresholds only (never authorize or terminate execution):\n` +
        `- API calls: ${task.budget.maxApiCalls}\n` +
        `- 配置价格估算参考值（人民币）: CN¥${task.budget.maxCostCny}\n\n` +
        (repairFeedback ? `## Mandatory Codex repair feedback\n${repairFeedback}\n\n` : "") +
        `## Execution rules\n` +
        `1. Complete only this leaf. Do not expand the objective, redesign unrelated code, or recursively delegate.\n` +
        `2. Do not use web_search, web_fetch, curl, wget, or external research. Required research and context must come from Codex.\n` +
        `3. Inspect existing conventions before editing and prefer the smallest coherent change.\n` +
        `4. Stay inside the exclusive write leases. If an out-of-scope change is required, do not make it; report the blocker.\n` +
        `5. Run only focused checks needed for this leaf. Avoid broad exploratory test loops and repeated retries.\n` +
        `6. Do not stage, commit, merge, rebase, cherry-pick, push, tag, or modify another worktree. Leave the Git index and HEAD unchanged.\n` +
        `7. Do not ask the human to relay messages. Codex is the controller and will review every changed file.\n` +
        `8. Invoke model-visible tools directly. Never print DSML/XML markers or a Markdown shell code block as a substitute for a tool call. For a required mutation, use bash/pwsh/str_replace_editor, then verify the leased file exists before claiming completion.\n` +
        `9. Final response must contain RESULT, CHANGED_PATHS, TESTS, RISKS, and HANDOFF_TO_CODEX. Keep it factual and concise.\n`;
}
//# sourceMappingURL=prompt.js.map
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_POLICY, OFFICIAL_DEEPSEEK_BASE_URL, probeOfficialDeepSeekCredential, readProtectedProviderCredential, waitForCredentialRevocation, } from "./provider-credential.js";
function requiredEnvironment(name) {
    const value = process.env[name];
    assert.ok(value, `${name} is required`);
    return value;
}
function git(repositoryRoot, args) {
    const result = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}
async function main() {
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const repositoryRoot = path.dirname(packageRoot);
    const credentialPath = path.resolve(requiredEnvironment("CODEX_REAL_SMOKE_CREDENTIALS"));
    const smokeEvidencePath = path.resolve(requiredEnvironment("CODEX_REAL_SMOKE_EVIDENCE_PATH"));
    const revocationEvidencePath = path.resolve(requiredEnvironment("CODEX_CREDENTIAL_REVOCATION_EVIDENCE_PATH"));
    const repository = requiredEnvironment("GITHUB_REPOSITORY");
    const headSha = requiredEnvironment("GITHUB_SHA");
    const runId = Number(requiredEnvironment("GITHUB_RUN_ID"));
    const runAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT"));
    assert.equal(repository, "zyc14588/codex-harness-skill", "credential revocation proof repository is invalid");
    assert.match(headSha, /^[0-9a-f]{40,64}$/u);
    assert.equal(git(repositoryRoot, ["rev-parse", "HEAD"]), headSha, "credential revocation proof requires the exact checked-out head");
    const headTree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const credential = await readProtectedProviderCredential(credentialPath);
    const smoke = JSON.parse(await readFile(smokeEvidencePath, "utf8"));
    assert.equal(smoke.result, "PASS", "credential revocation proof requires a successful Provider smoke");
    assert.equal(smoke.sourceCommit, headSha, "Provider smoke and credential revocation head mismatch");
    assert.equal(smoke.credentialPolicy, CREDENTIAL_POLICY, "Provider smoke credential policy mismatch");
    assert.equal(smoke.credentialFingerprintSha256, credential.fingerprintSha256, "Provider smoke and revocation credential fingerprint mismatch");
    assert.equal(smoke.providerEndpoint, OFFICIAL_DEEPSEEK_BASE_URL, "Provider smoke did not use the official DeepSeek endpoint");
    assert.equal(smoke.runnerEphemeral, true, "Provider smoke did not bind the ephemeral runner contract");
    const evidence = await waitForCredentialRevocation({
        credentialFingerprintSha256: credential.fingerprintSha256,
        repository,
        headSha,
        headTree,
        runId,
        runAttempt,
        probe: async (timeoutMs) => await probeOfficialDeepSeekCredential(credential.value, timeoutMs),
        onAttempt: ({ httpStatus, attempt, timestamp }) => {
            process.stdout.write(`httpStatus=${httpStatus} attempt=${attempt} timestamp=${timestamp}\n`);
        },
    });
    assert.equal(evidence.credentialFingerprintSha256, smoke.credentialFingerprintSha256);
    await mkdir(path.dirname(revocationEvidencePath), { recursive: true });
    await writeFile(revocationEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    await chmod(revocationEvidencePath, 0o600);
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=credential-revocation.js.map
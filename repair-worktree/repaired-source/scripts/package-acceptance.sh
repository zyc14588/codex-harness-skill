#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="0.6.5"
for bin in node git python3 sha256sum timeout stat; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Missing required command: $bin" >&2; exit 1; }
done
[[ -f "$SOURCE_ROOT/MANIFEST_SHA256.txt" ]] || { echo "Package manifest missing" >&2; exit 1; }
(cd "$SOURCE_ROOT" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)

TEMP_ROOT="$(mktemp -d)"
HOME_DIR="$TEMP_ROOT/home"
FAKE_BIN="$TEMP_ROOT/bin"
HARNESS_ROOT="$TEMP_ROOT/deepseek-harness"
DSH_HOME_DIR="$HOME_DIR/.dsh"
MINIMAL_PROFILE_DIR="$DSH_HOME_DIR/profiles/codex-minimal-headless"
MINIMAL_PRESET_DIR="$DSH_HOME_DIR/.agent-presets/codex-bridge-minimal"
INSTALL_ROOT="$TEMP_ROOT/xdg-data/codex-harness-bridge/$VERSION"
CONFIG_PATH="$TEMP_ROOT/xdg-config/codex-harness-bridge/config.json"
CODEX_HOME_DIR="$HOME_DIR/.codex"
PROVIDER_KEY_FILE="$TEMP_ROOT/provider.key"
MONITOR_PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()
PY
)"

cleanup() {
  set +e
  if [[ -f "$INSTALL_ROOT/bridge/dist/monitor-client.js" && -f "$CONFIG_PATH" ]]; then
    CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
  fi
  if [[ -n "${PREVIOUS_RUNTIME:-}" && -f "${PREVIOUS_RUNTIME}/bridge/dist/monitor-client.js" && -f "$CONFIG_PATH" ]]; then
    CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "${PREVIOUS_RUNTIME}/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$HOME_DIR" "$FAKE_BIN" "$HARNESS_ROOT/apps/cli/lib" "$CODEX_HOME_DIR"
printf '%s\n' 'package-acceptance-provider-key-not-real-000000000000' > "$PROVIDER_KEY_FILE"
chmod 600 "$PROVIDER_KEY_FILE"
cp "$SOURCE_ROOT/scripts/fake-dsh.mjs" "$HARNESS_ROOT/apps/cli/lib/bin.js"
cat > "$HARNESS_ROOT/package.json" <<'JSON'
{"private":true,"type":"module"}
JSON
(
  cd "$HARNESS_ROOT"
  git init -q
  git config user.email package-acceptance@example.invalid
  git config user.name "Package Acceptance"
  git add -A
  git commit -q -m fixture
)

cat > "$FAKE_BIN/codex" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, sys

def cfg_path():
    root=pathlib.Path(os.environ.get("CODEX_HOME", pathlib.Path.home()/".codex"))
    root.mkdir(parents=True, exist_ok=True)
    return root/"config.toml"
def header(name): return f"[mcp_servers.{name}]"
def prefix(name): return f"[mcp_servers.{name}."
def read():
    p=cfg_path(); return p.read_text(encoding="utf-8").splitlines() if p.exists() else []
def remove(lines,name):
    out=[]; skipping=False
    for line in lines:
        stripped=line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            skipping = stripped==header(name) or stripped.startswith(prefix(name))
        if not skipping: out.append(line)
    while out and not out[-1].strip(): out.pop()
    return out
def write(lines):
    p=cfg_path(); p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(("\n".join(lines)+"\n") if lines else "",encoding="utf-8")
args=sys.argv[1:]
if args in (["--version"],["-V"]): print("codex-fake 0.6.5"); raise SystemExit(0)
if len(args)<2 or args[0]!="mcp": raise SystemExit(2)
cmd=args[1]
if cmd=="get" and len(args)==3:
    if header(args[2]) not in [x.strip() for x in read()]: raise SystemExit(1)
    print(json.dumps({"name":args[2],"transport":"stdio"})); raise SystemExit(0)
if cmd=="list":
    for line in read():
        x=line.strip()
        if x.startswith("[mcp_servers.") and x.endswith("]") and x.count(".")==1: print(x[len("[mcp_servers."):-1])
    raise SystemExit(0)
if cmd=="remove" and len(args)==3: write(remove(read(),args[2])); raise SystemExit(0)
if cmd=="add" and len(args)>=5:
    name=args[2]; env={}; i=3
    while i<len(args) and args[i]!="--":
        if args[i]!="--env" or i+1>=len(args): raise SystemExit(2)
        key,sep,value=args[i+1].partition("=")
        if not sep or not key: raise SystemExit(2)
        env[key]=value; i+=2
    if i>=len(args) or args[i]!="--" or i+1>=len(args): raise SystemExit(2)
    if os.environ.get("FAKE_CODEX_FAIL_ADD")=="1":
        print("intentional fake codex add failure",file=sys.stderr); raise SystemExit(9)
    argv=args[i+1:]; lines=remove(read(),name)
    if lines: lines.append("")
    lines += [header(name),f"command = {json.dumps(argv[0])}",f"args = [{', '.join(json.dumps(x) for x in argv[1:])}]"]
    if env:
        lines += ["",f"[mcp_servers.{name}.env]"]
        for key in sorted(env): lines.append(f"{key} = {json.dumps(env[key])}")
    write(lines); print(f"Added global MCP server '{name}'."); raise SystemExit(0)
raise SystemExit(2)
PY
chmod +x "$FAKE_BIN/codex"
cat > "$CODEX_HOME_DIR/config.toml" <<'TOML'
[general]
package_acceptance_sentinel = true
TOML

export HOME="$HOME_DIR"
export XDG_CONFIG_HOME="$TEMP_ROOT/xdg-config"
export XDG_DATA_HOME="$TEMP_ROOT/xdg-data"
export XDG_STATE_HOME="$TEMP_ROOT/xdg-state"
export CODEX_HOME="$CODEX_HOME_DIR"
export PATH="$FAKE_BIN:$PATH"
export GIT_CONFIG_NOSYSTEM=1
export CODEX_HARNESS_INSTALL_ROOT="$INSTALL_ROOT"
export CODEX_HARNESS_CONFIG="$CONFIG_PATH"

INSTALL_ARGS=(
  --harness-root "$HARNESS_ROOT"
  --allowed-root "$TEMP_ROOT"
  --install-root "$INSTALL_ROOT"
  --config "$CONFIG_PATH"
  --monitor-port "$MONITOR_PORT"
  --dsh-home "$DSH_HOME_DIR"
  --provider-key-file "$PROVIDER_KEY_FILE"
  --no-build-harness
  --disable-llama-cpp
)

RELEASE_STATUS="$(python3 - "$SOURCE_ROOT/release-status.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding='utf-8'))['releaseStatus'])
PY
)"
INSTALL_RELEASE_ARGS=()
if [[ "$RELEASE_STATUS" == "candidate" ]]; then
  INSTALL_RELEASE_ARGS=(--audit-candidate --skip-self-tests)
elif [[ "$RELEASE_STATUS" != "stable" ]]; then
  echo "Package acceptance refuses releaseStatus=$RELEASE_STATUS" >&2
  exit 1
fi

tree_hash() { node "$SOURCE_ROOT/scripts/hash-tree.mjs" "$1"; }

assert_r7_config() {
  python3 - "$CONFIG_PATH" <<'PY'
import json,sys
c=json.load(open(sys.argv[1],encoding="utf-8"))
assert c["schemaVersion"]==7
assert c["harnessMinimalProfile"]=="codex-minimal-headless"
ctl=c["controller"]
assert ctl["requirePlan"] is True
assert ctl["preferMinimalHarness"] is True
assert ctl["maxConcurrentHarnessGlobal"]>=2
assert ctl["maxConcurrentHarnessPerRepo"]>=2
assert ctl["splitMemory"]["enabled"] is True
for name in ("defaultHarnessBudget","maximumHarnessBudget","defaultProComplexBudget"):
    b=ctl[name]
    assert b["gatePolicy"]=="input_output_tokens"
    assert b["enforcement"]=="hard"
    assert b["maxInputTokens"]>0 and b["maxOutputTokens"]>0
assert ctl["defaultHarnessBudget"]["ceilingPolicy"]=="operator_bounded"
assert ctl["maximumHarnessBudget"]["ceilingPolicy"]=="operator_bounded"
assert ctl["defaultProComplexBudget"]["ceilingPolicy"]=="unbounded"
assert c["monitor"]["currency"]["primary"]=="CNY"
assert c["monitor"]["currency"]["showUsd"] is False
assert c["provider"]["baseUrl"].startswith("https://")
assert c["provider"]["apiKeyFile"].endswith("/secrets/provider.key")
assert c["harnessIsolation"]["rejectEnvFiles"] is True
assert len(c["harnessIsolation"]["bubblewrapSha256"])==64
assert c["passEnvironment"]==["PATH","LANG","LC_ALL","TERM","COLORTERM","NO_COLOR","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]
assert "{{PROMPT_FILE}}" in c["llamaCpp"]["cliArgs"]
assert all("{{PROMPT}}" not in value for value in c["llamaCpp"]["cliArgs"])
assert c["llamaCpp"]["enabled"] is False
assert c["llamaCpp"]["fallbackModel"]=="deepseek-v4-flash"
PY
}

echo "[package 1/9] Fresh transactional installation"
"$SOURCE_ROOT/scripts/install.sh" "${INSTALL_ARGS[@]}" "${INSTALL_RELEASE_ARGS[@]}"
[[ -f "$INSTALL_ROOT/bridge/dist/index.js" ]]
[[ ! -e "$INSTALL_ROOT/bridge/node_modules" ]]
[[ -f "$CODEX_HOME_DIR/skills/codex-harness/SKILL.md" ]]
[[ "$(stat -c '%a' "$CONFIG_PATH")" == "600" ]]
[[ -f "$MINIMAL_PROFILE_DIR/.codex-harness-bridge-managed.json" ]]
[[ -f "$MINIMAL_PROFILE_DIR/bridge-headless-runner.mjs" ]]
[[ -f "$MINIMAL_PRESET_DIR/.codex-harness-bridge-managed.json" ]]
[[ -f "$MINIMAL_PRESET_DIR/agent.cordis.yml" ]]
grep -F "minimal-tools-server.js" "$MINIMAL_PRESET_DIR/agent.cordis.yml" >/dev/null
EXPECTED_NODE_RUNTIME="$(node -p 'process.execPath')"
python3 - "$MINIMAL_PRESET_DIR/agent.cordis.yml" "$EXPECTED_NODE_RUNTIME" <<'PY_NODE_RUNTIME'
import json,sys
source=open(sys.argv[1],encoding="utf-8").read()
expected=f"    command: {json.dumps(sys.argv[2])}\n"
assert expected in source, (expected, source)
PY_NODE_RUNTIME
grep -A1 -F -- "- id: session-title-llm" "$MINIMAL_PROFILE_DIR/cordis.patch.yml" | grep -F "disabled: true" >/dev/null
(cd "$INSTALL_ROOT" && sha256sum -c MANIFEST_SHA256.txt >/dev/null)
codex mcp get codex_harness >/dev/null
assert_r7_config
python3 - "$CONFIG_PATH" <<'PY_DEFAULTS'
import json,sys
c=json.load(open(sys.argv[1],encoding="utf-8")); ctl=c["controller"]
assert ctl["defaultHarnessBudget"]["maxInputTokens"]==180000
assert ctl["defaultHarnessBudget"]["maxOutputTokens"]==24000
assert ctl["defaultProComplexBudget"]["maxInputTokens"]==4000000
assert ctl["defaultProComplexBudget"]["maxOutputTokens"]==512000
PY_DEFAULTS

echo "[package 2/9] Installed doctor and minimal profile/preset provenance"
"$INSTALL_ROOT/scripts/doctor.sh"

echo "[package 3/9] Release process E2E plus installed acceptance"
# The process E2E owns a separate temporary config and monitor. Stop the
# freshly installed daemon first so release acceptance has one supervisor tree
# and cannot inherit unrelated keep-alive/socket state.
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null 2>&1 || true
if [[ "${CODEX_HARNESS_PACKAGE_SKIP_PROCESS_E2E:-0}" == "1" ]]; then
  echo "SKIP: direct process E2E was executed by an isolated release-runner invocation"
else
  timeout --foreground --kill-after=10s 480s node "$SOURCE_ROOT/bridge/dist/direct-acceptance.js"
fi
CODEX_HARNESS_ACCEPTANCE_ISOLATE_MONITOR=1 CODEX_HARNESS_ACCEPTANCE_SKIP_PROCESS_E2E=1 \
  timeout --foreground --kill-after=10s 360s "$INSTALL_ROOT/scripts/acceptance.sh"

echo "[package 4/9] Schema v4 to v7 migration preserves safe values and installs security policy"
mkdir -p "$TEMP_ROOT/xdg-state/codex-harness-bridge/controls"
echo '{"sentinel":"preserve-runtime-controls"}' > "$TEMP_ROOT/xdg-state/codex-harness-bridge/controls/preserve.json"
python3 - "$CONFIG_PATH" <<'PY'
import json,os,sys
p=sys.argv[1]; c=json.load(open(p,encoding="utf-8"))
c["schemaVersion"]=4
c.pop("harnessMinimalProfile",None); c.pop("dshHome",None)
c.pop("provider",None); c.pop("harnessIsolation",None)
ctl=c["controller"]
ctl["maxLeavesPerPlan"]=17
ctl.pop("maxConcurrentHarnessGlobal",None); ctl.pop("maxConcurrentHarnessPerRepo",None)
ctl.pop("preferMinimalHarness",None); ctl.pop("splitMemory",None)
ctl["defaultHarnessBudget"]["maxInputTokens"]=222222
ctl["defaultHarnessBudget"]["maxOutputTokens"]=33333
ctl["defaultHarnessBudget"].pop("gatePolicy",None); ctl["defaultHarnessBudget"].pop("ceilingPolicy",None)
ctl["defaultHarnessBudget"]["enforcement"]="hard"
ctl["defaultHarnessBudget"].pop("maxCostCny",None); ctl["defaultHarnessBudget"]["maxCostUsd"]=0.42
ctl["maximumHarnessBudget"]["maxInputTokens"]=2000000
ctl["maximumHarnessBudget"]["maxOutputTokens"]=200000
ctl["maximumHarnessBudget"].pop("gatePolicy",None); ctl["maximumHarnessBudget"].pop("ceilingPolicy",None)
ctl["defaultProComplexBudget"]["maxInputTokens"]=5000000
ctl["defaultProComplexBudget"]["maxOutputTokens"]=600000
ctl["defaultProComplexBudget"]["enforcement"]="advisory"
ctl["defaultProComplexBudget"].pop("gatePolicy",None); ctl["defaultProComplexBudget"].pop("ceilingPolicy",None)
c["monitor"]["pricingAsOf"]="custom migration pricing"
c["llamaCpp"].update({"enabled":True,"baseUrl":"http://127.0.0.1:18081/v1","model":"custom-local-model","requestTimeoutSeconds":321,"serverBinary":"/opt/custom/llama-server","cliBinary":"/opt/custom/llama-cli"})
t=p+".tmp"; json.dump(c,open(t,"w",encoding="utf-8"),indent=2); open(t,"a").write("\n"); os.chmod(t,0o600); os.replace(t,p)
PY
"$SOURCE_ROOT/scripts/install.sh" "${INSTALL_ARGS[@]}" "${INSTALL_RELEASE_ARGS[@]}"
python3 - "$CONFIG_PATH" "$TEMP_ROOT/xdg-state/codex-harness-bridge/controls/preserve.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1],encoding="utf-8")); ctl=c["controller"]
assert c["schemaVersion"]==7
assert c["harnessMinimalProfile"]=="codex-minimal-headless"
assert ctl["maxLeavesPerPlan"]==17
assert ctl["defaultHarnessBudget"]["maxInputTokens"]==222222
assert ctl["defaultHarnessBudget"]["maxOutputTokens"]==33333
assert abs(ctl["defaultHarnessBudget"]["maxCostCny"]-3.024)<1e-12
assert ctl["maximumHarnessBudget"]["maxInputTokens"]==2000000
assert ctl["defaultProComplexBudget"]["maxInputTokens"]==5000000
assert ctl["defaultProComplexBudget"]["maxOutputTokens"]==600000
for name in ("defaultHarnessBudget","maximumHarnessBudget","defaultProComplexBudget"):
    assert ctl[name]["gatePolicy"]=="input_output_tokens" and ctl[name]["enforcement"]=="hard"
assert ctl["defaultProComplexBudget"]["ceilingPolicy"]=="unbounded"
assert ctl["maxConcurrentHarnessGlobal"]==4 and ctl["maxConcurrentHarnessPerRepo"]==3
assert ctl["preferMinimalHarness"] is True and ctl["splitMemory"]["enabled"] is True
assert c["provider"]["apiKeyFile"].endswith("/secrets/provider.key")
assert c["harnessIsolation"]["rejectEnvFiles"] is True
assert len(c["harnessIsolation"]["bubblewrapSha256"])==64
assert "DEEPSEEK_API_KEY" not in c["passEnvironment"]
l=c["llamaCpp"]
assert l["enabled"] is False  # explicit install flag wins
assert l["baseUrl"]=="http://127.0.0.1:18081/v1" and l["model"]=="custom-local-model" and l["requestTimeoutSeconds"]==321
assert l["serverBinary"]=="/opt/custom/llama-server" and l["cliBinary"]=="/opt/custom/llama-cli"
assert "{{PROMPT_FILE}}" in l["cliArgs"] and all("{{PROMPT}}" not in x for x in l["cliArgs"])
assert json.load(open(sys.argv[2]))["sentinel"]=="preserve-runtime-controls"
PY

PROFILE_HASH="$(tree_hash "$MINIMAL_PROFILE_DIR")"
PRESET_HASH="$(tree_hash "$MINIMAL_PRESET_DIR")"

echo "[package 5/9] Same-version forced registration rollback restores all managed surfaces"
CONFIG_SHA="$(sha256sum "$CONFIG_PATH"|awk '{print $1}')"
CODEX_SHA="$(sha256sum "$CODEX_HOME_DIR/config.toml"|awk '{print $1}')"
SKILL_SHA="$(sha256sum "$CODEX_HOME_DIR/skills/codex-harness/SKILL.md"|awk '{print $1}')"
RUNTIME_SHA="$(sha256sum "$INSTALL_ROOT/MANIFEST_SHA256.txt"|awk '{print $1}')"
set +e
FAKE_CODEX_FAIL_ADD=1 "$SOURCE_ROOT/scripts/install.sh" "${INSTALL_ARGS[@]}" "${INSTALL_RELEASE_ARGS[@]}" >"$TEMP_ROOT/same-rollback.log" 2>&1
RC=$?
set -e
cat "$TEMP_ROOT/same-rollback.log"
((RC==9))
[[ "$CONFIG_SHA" == "$(sha256sum "$CONFIG_PATH"|awk '{print $1}')" ]]
[[ "$CODEX_SHA" == "$(sha256sum "$CODEX_HOME_DIR/config.toml"|awk '{print $1}')" ]]
[[ "$SKILL_SHA" == "$(sha256sum "$CODEX_HOME_DIR/skills/codex-harness/SKILL.md"|awk '{print $1}')" ]]
[[ "$RUNTIME_SHA" == "$(sha256sum "$INSTALL_ROOT/MANIFEST_SHA256.txt"|awk '{print $1}')" ]]
[[ "$PROFILE_HASH" == "$(tree_hash "$MINIMAL_PROFILE_DIR")" ]]
[[ "$PRESET_HASH" == "$(tree_hash "$MINIMAL_PRESET_DIR")" ]]
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" status >/dev/null

echo "[package 6/9] Cross-version failure restores previous runtime, monitor, profile and preset"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" stop >/dev/null
PREVIOUS_RUNTIME="$TEMP_ROOT/previous-runtime/0.6.2"
mkdir -p "$PREVIOUS_RUNTIME/bridge/dist"
cp -a "$INSTALL_ROOT/bridge/dist/." "$PREVIOUS_RUNTIME/bridge/dist/"
python3 - "$CODEX_HOME_DIR/config.toml" "$CONFIG_PATH" "$PREVIOUS_RUNTIME/bridge/dist/index.js" <<'PY'
import json,sys
p=sys.argv[1]
open(p,"w",encoding="utf-8").write('[general]\npackage_acceptance_sentinel = true\n\n[mcp_servers.codex_harness]\nstartup_timeout_sec = 30\ntool_timeout_sec = 7200\nrequired = true\ncommand = "node"\nargs = ['+json.dumps(sys.argv[3])+']\n\n[mcp_servers.codex_harness.env]\nCODEX_HARNESS_CONFIG = '+json.dumps(sys.argv[2])+'\n')
PY
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$PREVIOUS_RUNTIME/bridge/dist/monitor-client.js" start >/dev/null
PROFILE_HASH="$(tree_hash "$MINIMAL_PROFILE_DIR")"; PRESET_HASH="$(tree_hash "$MINIMAL_PRESET_DIR")"
rm -rf "$INSTALL_ROOT"
set +e
FAKE_CODEX_FAIL_ADD=1 "$SOURCE_ROOT/scripts/install.sh" "${INSTALL_ARGS[@]}" "${INSTALL_RELEASE_ARGS[@]}" >"$TEMP_ROOT/cross-rollback.log" 2>&1
RC=$?
set -e
cat "$TEMP_ROOT/cross-rollback.log"
((RC==9))
grep -F "$PREVIOUS_RUNTIME/bridge/dist/index.js" "$CODEX_HOME_DIR/config.toml" >/dev/null
[[ ! -e "$INSTALL_ROOT" ]]
[[ "$PROFILE_HASH" == "$(tree_hash "$MINIMAL_PROFILE_DIR")" ]]
[[ "$PRESET_HASH" == "$(tree_hash "$MINIMAL_PRESET_DIR")" ]]
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$PREVIOUS_RUNTIME/bridge/dist/monitor-client.js" status >/dev/null

echo "[package 7/9] Reinstall accepted 0.6.5 after rollback"
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$PREVIOUS_RUNTIME/bridge/dist/monitor-client.js" stop >/dev/null
"$SOURCE_ROOT/scripts/install.sh" "${INSTALL_ARGS[@]}" "${INSTALL_RELEASE_ARGS[@]}"
assert_r7_config

echo "[package 8/9] Uninstall preserves evidence/runtime and removes active integration"
"$INSTALL_ROOT/scripts/uninstall.sh"
[[ -d "$INSTALL_ROOT" ]]
[[ -f "$CONFIG_PATH" ]]
[[ ! -e "$CODEX_HOME_DIR/skills/codex-harness" ]]
[[ ! -e "$MINIMAL_PROFILE_DIR" ]]
[[ ! -e "$MINIMAL_PRESET_DIR" ]]
! codex mcp get codex_harness >/dev/null 2>&1
set +e
CODEX_HARNESS_CONFIG="$CONFIG_PATH" node "$INSTALL_ROOT/bridge/dist/monitor-client.js" status >/dev/null 2>&1
RC=$?
set -e
((RC!=0))

echo "[package 9/9] Source package hygiene and schemas"
[[ ! -e "$SOURCE_ROOT/bridge/node_modules" ]]
[[ -f "$SOURCE_ROOT/bridge/package-lock.json" ]]
find "$SOURCE_ROOT" -type l -print -quit | grep -q . && { echo "Package contains symlink" >&2; exit 1; } || true
python3 - "$SOURCE_ROOT" <<'PY'
import hashlib,json,os,sys
root=sys.argv[1]
for rel in [
  'bridge/package.json','.codex-plugin/plugin.json','config/config.example.json',
  'schemas/bridge-config.schema.json','schemas/task-envelope.schema.json',
  'harness/minimal/profile/package.json','harness/minimal/MANAGED_MARKER.json',
  'release-status.json','SOURCE_PROVENANCE.json',
  'evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json',
  'evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json',
  'evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json',
  'evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json',
  'evidence/07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json',
  'evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json',
  'evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json',
]:
    json.load(open(os.path.join(root,rel),encoding='utf-8'))
task_schema=json.load(open(os.path.join(root,'schemas/task-envelope.schema.json'),encoding='utf-8'))
assert task_schema['$defs']['splitDecision']['properties']['memorySchemaVersion']['const']==5
for rel in [
  'docs/08_ROOT_CAUSE_AND_REPAIR_ZH.md','docs/09_TEST_REPORT_ZH.md',
  'docs/10_REAL_DEEPSEEK_SMOKE_ZH.md','docs/11_THINKING_POLICY_DESIGN_ZH.md',
  'docs/12_SPLIT_MEMORY_SCHEMA4_MIGRATION_ZH.md','docs/13_STRICT_ACCEPTANCE_PROMPT_ZH.md',
  'docs/14_FINAL_READ_ONLY_AUDIT_PROMPT_ZH.md','docs/15_SOURCE_PROVENANCE_ZH.md',
  'docs/18_RUNTIME_HOTFIX_R2_REAL_SMOKE_ZH.md',
  'docs/19_DASHBOARD_AUTH_BUDGET_UX_HOTFIX_ZH.md',
  'docs/20_OPERATOR_PASSWORD_MINIMUM_R4_ZH.md',
  'CANDIDATE_VALIDATION_REPORT_ZH.md',
]:
    assert os.path.isfile(os.path.join(root,rel)), rel
release=json.load(open(os.path.join(root,'release-status.json'),encoding='utf-8'))
assert release['version']=='0.6.5'
candidate_evidence=release['candidateValidationEvidence']
candidate_path=os.path.join(root,candidate_evidence['path'])
assert hashlib.sha256(open(candidate_path,'rb').read()).hexdigest()==candidate_evidence['sha256']
real_evidence=release['realProviderValidationEvidence']
real_path=os.path.join(root,real_evidence['path'])
assert hashlib.sha256(open(real_path,'rb').read()).hexdigest()==real_evidence['sha256']
if release['releaseStatus']=='stable':
    assert release['controlledUseAllowed'] is True
    assert release['deliverableStatus']=='DELIVERABLE_PASS'
    assert all(value=='PASS' for value in release['gates'].values())
    bindings=release['artifactBindings']
    for rel,expected in bindings['requiredEvidenceSha256'].items():
        assert not os.path.isabs(rel) and '..' not in rel.replace('\\','/').split('/'), rel
        actual=hashlib.sha256(open(os.path.join(root,rel),'rb').read()).hexdigest()
        assert actual==expected, rel
else:
    assert release['releaseStatus']=='candidate'
    assert release['controlledUseAllowed'] is False
    assert release['deliverableStatus']!='DELIVERABLE_PASS'
print(json.dumps({
  "result":"PASS","version":"0.6.5","freshInstall":True,"installedAcceptance":True,
  "schema4To7Migration":True,"adaptiveSplitMemory":True,"tokenOnlyGates":True,
  "parallelMinimalHarness":True,"progressiveTools":True,"dsmlToolCallRecovery":True,
  "markdownShellToolCallRecovery":True,"nativeStructuredToolEvidence":True,"auxiliaryTitleIsolationBeforeMutation":True,"requiredChangeNoEffectIsolation":True,
  "splitMemoryInfrastructureIsolation":True,
  "sameVersionRollback":True,"crossVersionRollback":True,"uninstall":True,
  "releaseMetadataValidated":True,"releaseStatus":release['releaseStatus'],"realProviderEvidencePresent":True,
  "failureInjectionEvidencePresent":True,"auditorPromptsPresent":True
},indent=2))
PY

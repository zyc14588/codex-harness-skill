# 0.6.6 候选安装与运维

当前是 audit candidate，不是可交付 stable。`release-status.json` 的 `controlledUseAllowed=false` 与 `AUDIT_REPAIR_IN_PROGRESS` 是权威状态。

## 本地候选检查

```bash
cd current/bridge
npm ci
npm run build
npm test
cd ..
node scripts/verify-release-gate.mjs --root . --audit-candidate
```

只有审计/测试环境可向安装器传 `--audit-candidate`。普通安装必须拒绝 candidate；禁止 `--skip-self-tests` 绕过 stable 门禁。版本化 runtime 路径为：

```text
~/.local/share/codex-harness-bridge/0.6.6
```

安装器事务式更新 runtime、schema-v7 config、skill、MCP 与 managed profile/preset；失败必须恢复旧版本。profile 中的 broker plugin 与 preset 必须和包内模板一致，不存在 MCP/local subprocess tool plane。

## 凭据

- Provider key：operator-owned、regular non-symlink、0600、至少 24 bytes；
- operator token：首次安装生成 32 random bytes（64 hex）；
- 人工 operator password：NFC、至少 12 Unicode characters、至多 16384 UTF-8 bytes，无 whitespace/Cc/Cf/bidi/zero-width；
- 认证失败：per-client exponential backoff、`Retry-After` 与 0600 credential-free audit。

匿名 Dashboard、日志、snapshot、task evidence 与归档不得含凭据。弱 6 字符兼容模式未启用。

## 运行与清理

安装后常用入口：

```text
<runtime>/scripts/doctor.sh
<runtime>/scripts/acceptance.sh
<runtime>/scripts/monitor.sh status|snapshot|stop
```

卸载只移除活动注册并停止 monitor；版本化 runtime、config/state 与证据默认保留。彻底删除需要操作员另行明确授权。

## stable 晋级前

必须完成 fresh install、schema migration、same/cross-version rollback、reinstall/uninstall、确定性 ZIP 双构建、解包 manifest/build/test/install 重验、当前 Flash/Pro/negative smoke、根 GitHub Actions 实际 PASS 与 branch protection required checks。任一缺失继续保持 candidate。

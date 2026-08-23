# 0.6.6 严格验收清单

任何未通过项均为 `STRICT_ACCEPTANCE_FAIL`，不得使用 `PASS_WITH_CONDITIONS`。

## 发布权威

- [ ] 根入口与所有命令唯一指向 `current/`；历史全部位于 `archive/`。
- [ ] package/plugin/MCP/Dashboard/installer/profile/archive root 为同一版本。
- [ ] release gate 绑定 implementation commit/tree、package-lock、Harness commit/build、critical paths、当前 smoke 与 archive sidecar。
- [ ] 最终 archive 实际存在且双构建字节相同；解包后复验通过。

## Provider 与工具隔离

- [ ] shell env/argv/files/`/proc` 无 key、bearer 或 secret-bearing URL。
- [ ] shell 不能访问 Monitor socket、Relay 或 direct Provider，尝试后 upstream count=0。
- [ ] Provider/Adapter/tool bearer 不可互换；route 只接受精确 POST/JSON/schema。
- [ ] 正常当前 revision Flash/Pro 多轮仍通过。

## Clean verification

- [ ] review 封存 canonical patch 与 fingerprint。
- [ ] verification 从 base commit 新建、`git clean -ffdx`、只应用 reviewed patch。
- [ ] ignored false-pass poison 在 clean tree 正确失败。
- [ ] current/reviewed/verified fingerprint、HEAD/index/lease/symlink/gitlink 与 cleanup 一致。

## 协议与真实 smoke

- [ ] Flash 同 attempt ≥4 requests、全部 disabled/off、≥2 native tool calls、exact lease diff、review/verify/commit/cleanup PASS。
- [ ] Pro 同 attempt ≥3 requests、全部 enabled/high、无 tool_choice、replay 0/1/2… 完整，其余门禁 PASS。
- [ ] replay omission 在 Provider 前失败、Token 0/0、split memory 不变。

## Operator

- [ ] 初始 256-bit random token；失败 rate limit/backoff/audit 生效。
- [ ] NFC ≥12；Cc/Cf/bidi/zero-width 拒绝；密码不出现在 HTML/log/snapshot/evidence。

## CI、安装与供应链

- [ ] 根 workflow、full-SHA actions、build/test/direct/security/package/skill/drift/negative/poison 全通过。
- [ ] 目标 commit 的实际 GitHub Actions run PASS，branch protection required checks 已配置。
- [ ] fresh install、migration、same/cross rollback、reinstall、uninstall 全通过。
- [ ] ZIP 无 `.git`、node_modules、symlink、PID、临时状态或凭据；解包后全部重验。

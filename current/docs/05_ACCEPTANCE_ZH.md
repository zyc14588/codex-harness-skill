# 0.6.6 严格验收清单

任何未通过项均为 `STRICT_ACCEPTANCE_FAIL`，不得使用 `PASS_WITH_CONDITIONS`。

## 发布权威

- [ ] 根入口与所有命令唯一指向 `current/`；历史全部位于 `archive/`。
- [ ] package/plugin/MCP/Dashboard/installer/profile/archive root 为同一版本。
- [ ] release gate 绑定 implementation commit/tree、package-lock、Harness commit/build、critical paths、当前 smoke 与 archive sidecar。
- [ ] canonical `seal-ready` checkout 完全干净，qualification 后只有白名单 seal metadata；`releaseTarget.sealCommit/sealTree` 为 `null`，release gate 从当前 Git checkout 推导非循环 seal 身份；`package-origin.json` 只在隔离 staging 生成。
- [ ] 最终 archive 实际存在且双构建字节相同；解包后复验通过。

## Provider 与工具隔离

- [ ] shell env/argv/files/`/proc` 无 key、bearer 或 secret-bearing URL。
- [ ] shell 不能访问 Monitor socket、Relay 或 direct Provider，尝试后 upstream count=0。
- [ ] Provider/Adapter/tool bearer 不可互换；route 只接受精确 POST/JSON/schema。
- [ ] 正常当前 revision Flash/Pro 多轮仍通过。
- [ ] attempt rollover/cancel/timeout/Monitor SIGTERM 撤销 broker lease、终止完整进程组，且取消后无延迟写入。
- [ ] editor/目录/repository read 每页最多 49,152 UTF-8 bytes，分页可无损重组且 schema 暴露边界。

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
- [ ] 认证洪泛按来源聚合；审计最多四段/总计 1 MiB/30 天保留，0600 且不含 bearer。

## 宿主资源

- [ ] Harness、relay 和每个 broker sibling 都使用同一 `required` profile；launcher realpath/SHA-256 受 pin。
- [ ] 动态探针精确证明 cgroup v2 memory/CPU/tasks/I/O/runtime 与 RLIMIT；任何 controller 缺失时 controlled use fail closed。
- [ ] fork、内存、文件大小、worktree allocated bytes 与 runtime 耗尽负测全部被限制，无遗留进程或迟发写入。

## CI、安装与供应链

- [x] 隔离的 origin public heads/tags 审计保留两组 Owner-accepted 标识与三个 opaque gitlink findings；email/home occurrences 为 60/91，分别不超过批准上限 64/136；confirmed secrets/新增个人信息/ZIP traversal/LFS/分发许可证未闭合项为 0，六个唯一 ZIP 共 1,776 个去重成员。
- [x] active source、package staging、archive manifest/final ZIP 零 gitlink/`.gitmodules` 门禁及负向测试通过；历史 accepted gitlink 不误伤当前门禁。
- [x] DEC-002 完整仓库/history 读取披露、仓库边界、credential/state/socket 隔离与输出分页已实现验证。
- [ ] 根 workflow、full-SHA actions、build/test/direct/security/package/skill/drift/negative/poison 全通过。
- [ ] 目标 commit 的实际 GitHub Actions run PASS，branch protection required checks 已配置。
- [ ] protected Provider artifact digest 与 GitHub attestation、run ID/attempt、workflow path/hash、精确 qualification head/tree 一致。
- [ ] 专用 disposable key 的 smoke/revocation fingerprint 一致；官方 `/models` 端点在 900 秒内实际返回 401/403，response body 未捕获，最终 attested subject 同时包含 smoke、run binding 与 revocation proof。
- [ ] Owner 已删除 `deepseek-provider-smoke` environment 中的 `DEEPSEEK_API_KEY`，独立只读治理证据证明名称不存在；ephemeral runner 也已注销并不再 online。
- [ ] DEC-001…DEC-004 与 CRED-EPHEMERAL-001 均由可归属 owner 明确批准，选择值与实现/资源/credential policy 一致。
- [ ] fresh install、migration、same/cross rollback、reinstall、uninstall 全通过。
- [ ] ZIP 无 `.git`、node_modules、symlink、PID、临时状态或凭据；解包后全部重验。

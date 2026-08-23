# 最终只读审计提示词

```text
对当前解压后的 codex-harness-skill 0.6.5 做最终只读审计。禁止编辑、安装、启动 monitor、访问 Provider、创建提交或重新打包。

只执行以下工作：
- 校验外部 ZIP SHA-256 sidecar 与归档字节一致；
- 在全新临时目录解压，拒绝绝对路径、..、symlink、gitlink 和重复路径；
- 运行 sha256sum -c MANIFEST_SHA256.txt；
- 解析 release-status.json、所有 package/plugin/managed-marker JSON 和 schemas；
- 检查所有发布版本字段严格等于 0.6.5；历史 rc.1 只能出现在明确标为 FAILED/WITHDRAWN 的历史证据中；
- 确认 release-status 为 stable、controlledUseAllowed=true、deliverableStatus=DELIVERABLE_PASS；
- 确认 bridge/src 与对应 dist/sourcemap 齐全，`bridge/package-lock.json` 存在且与 stable artifact binding 一致；不存在 bridge/node_modules、凭据、API key、reasoning_content 正文或临时 smoke 根目录；
- 对照当前修订 evidence/08、09 与 docs/09、11、12、18，核对真实 Flash、真实 Pro、失败注入、package acceptance 和 skill validation 的数值一致；历史 evidence/03–07 只能作为旧 seal 证据；
- 检查安装器不会自动 merge、push、tag 或创建 GitHub Release，harness_commit 只产生隔离本地提交；
- 检查 MANIFEST 不包含自身且覆盖归档内除此文件外的所有普通文件。

不得因为文档声明 PASS 就推断通过；每个结论必须来自归档内容、哈希或机器证据。最终只输出 PASS/FAIL、发现列表和核验过的 ZIP SHA-256。
```

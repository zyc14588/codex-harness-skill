# 源码恢复与来源治理

## 1. 为什么本包包含 0.6.3 基线

当前会话容器中可以核验的最后完整工程树是 0.6.3。它包含 TypeScript source、prebuilt dist 和 source maps、minimal profile/preset templates、installer/migration/rollback/doctor/acceptance scripts，以及 58 项已执行通过的单元测试。

它足以帮助 Codex理解架构，并定位与 R6.4 遥测同形的 preliminary policy 逻辑。

## 2. 为什么不能直接在该基线上发布修复

用户真实机器运行的是 0.6.4。R6.4 声称增加的辅助隔离和 title LLM 关闭不在本包可核验源码中。若不先回收 installed runtime，Codex 可能重复实现已经存在但没有部署的代码、修改错误的控制流版本、忽略 profile/preset migration 问题，或让 source/dist 和 installed runtime 再次分叉。

## 3. 回收步骤

运行：

```bash
./scripts/capture-installed-r6-4.sh \
  --task-id plan-1787365388387-r6-4-minimal-aux-isolation-smoke
```

脚本会只读复制 installed runtime、managed profile/preset，生成脱敏 config，搜索并复制指定 task evidence，并生成逐文件 SHA-256。脚本不会复制 credentials 或 `.env`。

## 4. Codex 的合并基线

建议建立新的 Git 仓库：

```text
repair-worktree/
  baseline-0.6.3/
  recovered-installed-0.6.4/
  repaired-source/
```

Codex 应先生成 `0.6.3 source/dist` 与 `0.6.4 installed runtime/profile/preset` 的差异报告，再选择 authoritative source reconstruction。不得直接修改用户正在运行的 installed runtime。

## 5. 版本一致性门禁

下一版安装包必须保证以下值一致：

```text
bridge/package.json version
.codex-plugin/plugin.json version
renderer VERSION
managed markers
README/version report
runtime directory name
MCP serverVersion
Dashboard version
```

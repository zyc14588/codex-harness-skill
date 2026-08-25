# Owner Decision 执行简报（DEC-001 至 DEC-004）

## 使用边界

本简报只提供影响分析和非约束性建议，不代表 owner 决策。当前 `current/docs/OWNER_DECISIONS.json` 中四项均为 `status=PENDING_OWNER`、`selected=null`；Codex 未把任何一项改为 `APPROVED`。

现有 release policy 要求任何 owner approval 写入新的 implementation commit 并重新资格化。由于 `docs/OWNER_DECISIONS.json` 位于 canonical source scope，哪怕选择与当前实现一致，也会改变 source tree/provenance；所以 DEC-001 至 DEC-004 的任一正式选择都会使旧 qualification evidence 对新 implementation commit 失效。选择需要代码变化的选项还会扩大失效范围，但不会改变“必须全量重跑”的结论。

## DEC-001：GitHub private branch protection

当前状态：未选择。可选项：

- `A_PRIVATE_PLAN_WITH_BRANCH_PROTECTION`
- `B_PUBLIC_AFTER_FULL_REPOSITORY_AND_HISTORY_AUDIT`
- `C_SIGNED_TAG_TWO_PERSON_APPROVAL_IMMUTABLE_ATTESTATION_CONTRACT`

| 选项 | 代码影响 | 部署/治理影响 | 成本与发布时间 |
| --- | --- | --- | --- |
| A | Bridge 核心无需变化；保留现有 release-gate 对 HTTP 200 branch protection/ruleset evidence 和 required checks 的验证 | 需要升级或选择支持 private repository branch protection/rulesets 的 GitHub 方案，并配置 strict-local-gates 与 protected-real-provider-smoke 为 required | 有持续 GitHub 方案成本；实现工作最少，通常最短发布路径 |
| B | Bridge 核心可不变，但必须新增全历史 secret/PII/license/二进制审计、公开前阻断报告与可复核清理流程 | 仓库及历史公开是不可逆或难完全收回的披露；公开后再配置 required checks | 方案成本可能下降，但审计人力和披露风险最高，发布时间不应早于完整历史审计结束 |
| C | 必须修改 `verify-release-gate.mjs`、外部 evidence schema/测试和 CI：验证签名 tag、两名独立批准者、不可变 attestation subject/digest，并定义替代 branch protection 的等价合同 | 需要受控签名密钥、两人审批职责分离、不可变 attestation 存储和失钥/轮换流程 | 工程与运维成本高，发布时间最长；可避免依赖特定 GitHub plan，但不能把旧 403 写成 PASS |

建议：`A_PRIVATE_PLAN_WITH_BRANCH_PROTECTION`。理由是它与当前 fail-closed release gate 完全一致，代码改动和新攻击面最少；代价是明确的 GitHub 方案费用。建议不等于批准。

选择其他选项所需新增代码：B 至少需要 repository/history disclosure scanner、secret allowlist/denylist、license/PII 报告与公开前 machine gate；C 需要签名验证、two-person identity/approval 验证、attestation digest/issuer/subject 验证、撤销与密钥轮换策略及完整负向测试。

旧 evidence：A、B、C 都会因 owner decision implementation commit 改变而失效；B/C 还会改变治理或验证实现，绝不能沿用旧 external/qualification evidence。

## DEC-002：Repository and Git history read boundary

当前状态：未选择，`implementationVerified=false`。可选项：

- `A_ACCEPT_REPOSITORY_AND_HISTORY_READ_BOUNDARY`
- `B_REQUIRE_FILTERED_WORKSPACE_AND_SHALLOW_SANITIZED_HISTORY`

| 选项 | 代码影响 | 部署影响 | 成本与发布时间 |
| --- | --- | --- | --- |
| A | 当前 Git worktree/diff/review/rollback 架构可保持；需把已接受的 residual read boundary、operator trust boundary 和 `implementationVerified=true` 的验证依据写清楚 | 只允许在 owner 已授权、已清理 secrets 的 repository 上运行；宿主仍需隔离 Provider、工具和日志 | 工程成本低、发布更快，但 owner 明确承担 Bridge 可读取授权仓库及所需历史对象的残余风险 |
| B | 需新增 filtered workspace materializer、ref/object/path 过滤、shallow sanitized history provenance、禁止回退到原 `.git` 的 enforcement，并重写依赖 worktree/history 的 review、commit、rollback 与 migration 路径 | 每次任务前要构造并验证隔离副本；需要容量、缓存、清理和失败恢复策略 | 实现、存储和运行时成本显著上升，发布至少延后一个完整安全设计与资格化周期；最小化读取面更强 |

建议：在当前发布周期选择 `A_ACCEPT_REPOSITORY_AND_HISTORY_READ_BOUNDARY`，前提是 owner 明确认可 repository 本身属于 Bridge trust boundary，且部署只接收已授权仓库。理由是当前核心流程真实依赖 Git history/worktree 语义；B 是架构项目，不是配置开关。建议不等于批准。

选择其他选项 B 所需新增代码：sanitized clone/export builder、object/ref/path policy、provenance binding、原仓库访问阻断、shallow-history 不足时的 fail-closed 行为、容量清理、migration/rollback 适配及针对 object leakage、alternate、submodule、LFS 的负向测试。

旧 evidence：A 也必须因正式 approval commit 全量重跑；B 会改变核心 repository I/O 和 Git 行为，所有 process E2E、security、install/migration/rollback 和 Provider evidence 均失效。

## DEC-003：Controlled-use host resource defaults

当前状态：未选择。可选项：

- `A_APPROVE_PROPOSED_PROFILE`
- `B_SUPPLY_REVISED_BOUNDED_PROFILE`

当前 proposed profile：MemoryMax 4 GiB、CPUQuota 200%、TasksMax 256、IOWeight 100、worktree 4 GiB、RLIMIT_NOFILE 4096、RLIMIT_NPROC 4096、RLIMIT_FSIZE 1 GiB、command timeout 1800 秒；enforcement 必须继续为 `required`。

| 选项 | 代码/配置影响 | 部署影响 | 成本与发布时间 |
| --- | --- | --- | --- |
| A | 当前 schema、config、resource wrapper 和 gate 已实现这些数值；approval 时必须写入完全相等的 `approvedProfile` | 合格主机必须给 user systemd app slice 委派 memory/cpu/pids/io，并动态观察所有 cgroup 与 RLIMIT 值 | 无新增算法成本，但需要具备 I/O controller 委派的主机；当前主机不合格，发布时间受 qualified host 获取影响 |
| B | 必须把 owner 给出的每个 bounded 数值同步到 config/schema/examples、runtime profile、tests、installer/doctor、release gate 和容量说明；不得把 enforcement 改为 audit_only 或删除 IOWeight | 需要按新上限重新做容量规划；更高上限增加主机成本，更低上限可能导致 build/test/Provider task 失败 | 取决于新 profile；需重新压测资源耗尽、超时和正常任务，至少增加一个实现与资格化周期 |

建议：`A_APPROVE_PROPOSED_PROFILE`。它是当前代码和负向测试已实现的保守上限，并保持 IOWeight fail-closed；当前主机的正确处理是更换/配置合格主机，不是降低合同。建议不等于批准。

选择其他选项 B 所需新增代码：经 owner 明确给出的 bounded profile、schema/config/type 更新、approvedProfile 精确比对、每项 cgroup/RLIMIT 正负测试、容量/超时测试和部署预检更新。若 owner 只给出文字目标而没有九个明确数值，仍不能实施或批准。

旧 evidence：A/B 均需对新 approval commit 重跑；B 改变运行时限制，所有资源、process E2E、managed fixture、Provider smoke 和 package lifecycle evidence 必须视为失效。

## DEC-004：Candidate audit installation path

当前状态：未选择。可选项：

- `A_USE_COMMIT_SUFFIXED_CANDIDATE_PATH`
- `B_SUPPLY_ALTERNATIVE_NON_STABLE_PATH_POLICY`

当前已实现建议为 `0.6.6-candidate-<implementation-commit-prefix>`。

| 选项 | 代码影响 | 部署影响 | 成本与发布时间 |
| --- | --- | --- | --- |
| A | 当前 installer/package acceptance 可保持；commit suffix 防止 candidate 覆盖 stable 或不同 implementation | audit candidate 使用独立非 stable runtime path，卸载/回滚可按 exact implementation 定位 | 最低成本、最短路径；会产生多个按 commit 隔离的审计目录，需要正常清理 |
| B | 必须新增 owner 指定的 path derivation/validation、冲突检测、atomic install、migration、same/cross-version rollback、reinstall/uninstall 和 stable-path 防覆盖规则 | 运维脚本、运行目录发现和清理策略都要适配；任何能与 stable 路径碰撞的方案必须拒绝 | 工程和迁移成本增加，发布时间取决于替代策略是否仍能唯一绑定 implementation |

建议：`A_USE_COMMIT_SUFFIXED_CANDIDATE_PATH`。它已实现、可审计、不会把 candidate 伪装成 stable，也能避免不同 implementation 相互覆盖。建议不等于批准。

选择其他选项 B 所需新增代码：严格 path policy schema、canonicalization/escape 防护、stable collision blocker、transaction journal、旧 candidate migration、rollback/reinstall/uninstall 适配和故障注入测试。

旧 evidence：A/B 均需对 approval implementation commit 重跑；B 会直接改变 candidate install/migration/rollback/reinstall/uninstall 语义，旧 package acceptance evidence 完全失效。

## Owner 批准后才可执行的动作

owner 必须对每项提供 exact selected value、可归属的 `decidedBy` 和时间。之后才可写入 `status=APPROVED`、`selected`、`decidedBy`、`decidedAt`；DEC-002 还需实现验证后置 `implementationVerified=true`，DEC-003 必须写入与 runtime 完全一致的 `approvedProfile`。如选择需改代码的选项，先实现再创建新的 implementation commit。随后旧 evidence 失效，并按任务指定矩阵重新资格化；在此之前保持 `releaseStatus=candidate`、`controlledUseAllowed=false`、`finalArchive=null`。

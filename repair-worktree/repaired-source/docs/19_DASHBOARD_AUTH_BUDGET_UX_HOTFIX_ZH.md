# 0.6.5 runtime hotfix R3：Dashboard 认证、预算与密码设置

日期：2026-08-23。状态：stable 发布门禁的一部分。

## 用户可见问题与根因

旧 Dashboard 只在认证快照返回后动态生成预算输入框，但未认证的费用页没有解释这一条件。因此首次打开页面时，全局预算和任务预算区域看起来像“调整框不见了”。认证又依赖浏览器原生 `prompt`，页面内没有可发现的登录表单，也没有轮换安装器随机 operator token 的设置入口。

这不是预算数据丢失：认证后旧页面仍会生成预算字段；缺陷在于认证和空状态的交互设计，以及缺少 operator credential rotation 能力。

## 修复

- 移除原生 `window.prompt`，改用页面顶部的内嵌“操作员认证”表单；凭据只保存在当前标签页的 `sessionStorage`。
- 未认证的费用页明确显示“认证后将显示全局预算调整框”和任务预算说明，并禁用需要身份的变更操作。
- 认证后显示全局预算输入框；没有历史或活动 budget group 时显示明确空状态，不再留下空白区域。
- 新增“设置 → 操作员认证”。已认证操作员可把安装器随机 token 更换为至少 24 个 UTF-8 字节、至多 16384 字节、且不含空白的自定义长密码。
- 密码轮换要求当前 Bearer、同源 Origin 和 CSRF；使用命名锁串行化并原子替换 mode-0600 `operator.token`。响应不回显密码，旧密码立即失效，并发的陈旧请求 fail closed。
- 匿名 HTML 不嵌入凭据；`/favicon.ico` 返回 204，避免无意义的浏览器控制台 404。

## 浏览器与安全验证

候选运行时使用系统 Chrome 和 Playwright 在独立临时 HOME/state 上验证：

- 1440×1000 桌面和 390×844 移动视口均可见内嵌认证与费用说明；移动端无横向溢出；
- 页面不再产生原生 dialog，控制台无 error；
- 登录后出现 12 个全局预算字段；无任务时显示任务预算空状态；
- 设置页双密码输入可完成轮换，字段随后清空；旧密码返回 401，新密码立即可认证；
- 匿名 HTML、API 响应和截图均不包含 operator password；
- 单元测试覆盖密码边界与私有原子持久化；direct acceptance 覆盖生成 HTML 转义、认证、轮换、旧/新密码与并发失败闭锁。

当前组件测试总数为 89。strict build、direct acceptance、security acceptance、skill validation 和 transactional package acceptance 均必须通过；最终 ZIP 还必须通过确定性双构建、解包 manifest/release gate 和解包态 package acceptance。

## 继承证据边界

R3 只修改 Dashboard、operator credential rotation 及其测试/文档，没有改变 Provider 请求构造、Harness profile、Bubblewrap、模型策略或 Broker 数据路径。因此本轮没有再次产生真实 Provider 调用或费用；`evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json` 是未修改 Provider 路径的 R2 有界真实 DeepSeek 证据，作为继承回归证据保留，并未冒充为 R3 当日重新调用。R3 自身的本地、浏览器、安全和包装资格记录在 evidence/08 与最终归档 sidecar。

## 操作方式

首次登录仍使用安装器生成并保存在 state secret 目录的 operator token。登录成功后打开“设置”，在“操作员认证”中输入并确认自定义长密码。升级安装保留现有 token；安装过程不会替用户选择或覆盖密码。

# 0.6.5 runtime hotfix R4：操作员密码最小长度

日期：2026-08-23。状态：stable 发布门禁的一部分。

## 变更

Dashboard“设置 → 操作员认证”的新密码最小长度从 R3 的 24 UTF-8 字节调整为至少 6 个 Unicode 字符。服务端和浏览器端使用相同边界：

- 至少 6 个 Unicode 字符；
- 至多 16384 个 UTF-8 字节；
- 不允许任何空白字符或 NUL；
- 两次输入必须完全一致。

`12345` 会被拒绝，`123456` 与 6 个中文字符均被接受。页面输入框使用 `minlength=6`，JavaScript 按 Unicode code point 计数；服务端是最终权威校验。

## 安全边界

这是操作员明确要求的强度放宽。以下控制保持不变：Dashboard 仅监听 loopback、每个 API 请求仍要求 Bearer、mutation 仍校验同源 Origin 与 CSRF、密码不进入匿名 HTML/URL/日志/证据、`operator.token` 仍为 operator-owned mode-0600 普通文件、轮换仍使用命名锁和原子替换、旧密码立即失效。

Provider API key 没有随之放宽，运行时仍要求至少 24 字节。实现把 operator password 与通用私密 secret 的下限分离，并增加回归测试证明 6 字符 Provider key 仍被拒绝。

## 升级与验证

升级不会自动把现有 operator token 改成某个 6 位密码，也不会回显当前 token。安装完成后，操作员使用现有凭据登录，再到“设置 → 操作员认证”自行设置 6 位或更长密码。

发布资格要求 strict build、90 项组件测试、direct/security/skill/package acceptance、确定性双 ZIP、解包重验，以及隔离浏览器中的 5 字符拒绝、6 位轮换、旧密码失效、新密码立即登录、桌面和移动布局验证。

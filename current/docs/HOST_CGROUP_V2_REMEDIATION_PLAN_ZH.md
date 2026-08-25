# HOST-QUAL-001：cgroup v2 I/O 委派整改计划

状态：`HOST_CGROUP_RECONFIGURATION_PLAN_READY`。本轮只执行了只读诊断；未运行 `sudo`，未修改 `/etc` 或 systemd unit，未 restart/logout/reboot，Provider 请求数为 0。

## 诊断结论

主机是 Ubuntu 26.04 LTS、kernel `7.0.0-30-generic`、systemd 259、统一 cgroup v2。根 hierarchy 与 `user.slice` 的 `cgroup.controllers` 都包含 `io`，但 `user.slice/cgroup.subtree_control` 只有 `cpu memory pids`；因此下层 `user-1000.slice`、`user@1000.service` 和 app scopes 都看不到 `io`，也没有 `io.weight`。

vendor `/usr/lib/systemd/system/user@.service` 的 SHA-256 为 `3e64dd11e1f9f5b39e31b689adecebf6f2e79153d271acd4c55172002e468236`，当前配置是 `Delegate=pids memory cpu`，缺少 `io`。既有四档动态资格化中 MemoryMax、CPUQuota、TasksMax 与全部 RLIMIT 均通过，唯一失败项是 IOWeight；权威 evidence 为根目录 `HOST_RESOURCE_QUALIFICATION.json`（SHA-256 `4836e9fcf3c31992516ab7d9fc67c24193e1587e104e3732e59ef6dee1dcceb3`）。

systemd 259 本机 man page `systemd.resource-control(5)` 明确说明：`Delegate=` 可接受 controller 列表，被委派 controller 会在父级层次自动启用；user manager 会在自己的子树继续按资源配置启用 controller。因此最小修复是保留 vendor 已委派的 `pids memory cpu` 并追加 `io`，不修改 vendor 文件。

## 唯一拟新增文件

目标：`/etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf`

基线状态：不存在，故 original SHA-256 为 `null`。拟写入完整内容：

```ini
[Service]
Delegate=pids memory cpu io
```

拟写入字节的 SHA-256：`43502dffd2236d66d7ba7c84d13b0120e02579cd1c67ba6a02635056dadf4940`。

备份目录：`/var/backups/codex-harness-host-qual-20260826T093621+1000/`。因为目标当前不存在，计划创建 `90-codex-harness-io-delegation.conf.ABSENT` marker；若执行时发现目标已出现，必须停止并重新审计，不得覆盖。

## 待单独批准的精确特权命令

以下命令本轮**未执行**。批准后仍须先复核目标保持 absent、vendor SHA 保持不变：

```bash
test "$(sha256sum /usr/lib/systemd/system/user@.service | awk '{print $1}')" = "3e64dd11e1f9f5b39e31b689adecebf6f2e79153d271acd4c55172002e468236"
test ! -e /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf
sudo install -d -o root -g root -m 0755 /etc/systemd/system/user@.service.d
sudo install -d -o root -g root -m 0700 /var/backups/codex-harness-host-qual-20260826T093621+1000
sudo touch /var/backups/codex-harness-host-qual-20260826T093621+1000/90-codex-harness-io-delegation.conf.ABSENT
printf '%s\n' '[Service]' 'Delegate=pids memory cpu io' | sudo tee /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf >/dev/null
sudo chown root:root /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf
sudo chmod 0644 /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf
test "$(sha256sum /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf | awk '{print $1}')" = "43502dffd2236d66d7ba7c84d13b0120e02579cd1c67ba6a02635056dadf4940"
sudo systemd-analyze verify user@.service
sudo systemctl daemon-reload
sudo systemctl reboot
```

`reboot` 是计划的一部分：活跃的 `user@1000.service` 与图形/终端会话必须重新创建，才能保证新的 Delegate controller 从 system manager 一路传播。执行前必须保存工作、关闭应用并确认可接受全机中断；不建议在当前会话中直接 restart `user@1000.service`，因为会终止该用户的桌面与所有 user services。若运营方选择完全 logout/login 而非 reboot，必须确保 `user@1000.service` 真正停止后再登录，并重新取证，不能假定配置已生效。

## 执行后验证（仍需单独批准后进行）

重启并登录后先做只读验证：

```bash
cat /sys/fs/cgroup/user.slice/cgroup.subtree_control
cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers
cat /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers
systemctl show user@1000.service -p Delegate -p ControlGroup
node scripts/qualify-host-resources.mjs --output HOST_RESOURCE_QUALIFICATION.json
```

必须看到 `io` 传播到 user manager/app slice，并由四个 Owner profile 的动态 probe 分别观察到精确 `IOWeight=100`；否则保持 `controlledUseAllowed=false`，不得进行 Provider I/O。

## 影响与回滚

影响限于 systemd user manager 的 controller delegation；它不会修改 Bridge 配置、Provider credentials 或 Git。启用 `io` 会让该 user subtree 的 I/O controller 生效，并允许 user manager 对其子 scope 应用 IOWeight。重启会中断整机上的所有会话和工作负载。

回滚同样需要单独批准、root 权限与再次重启：

```bash
sudo cp -a /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf /var/backups/codex-harness-host-qual-20260826T093621+1000/90-codex-harness-io-delegation.conf.rollback-copy
sudo rm /etc/systemd/system/user@.service.d/90-codex-harness-io-delegation.conf
sudo systemctl daemon-reload
sudo systemctl reboot
```

回滚后再次运行 host qualification；预期恢复到 `BLOCKED_CONTROLLED_HOST_CGROUP_IO`。任何执行时基线、目标存在性、vendor SHA 或 controller chain 与本计划不同，都必须停止并重新生成计划。

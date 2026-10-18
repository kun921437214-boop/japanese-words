# 2026-10 整理交付与部署确认

状态：仅在隔离副本准备，生产和当前定时任务未变。本方案不创建状态网站，以既有检查日志和飞书通知呈现结果。复用草稿 PR #66 的周窗口与 systemd 检查骨架，但未合并 PR，未复制其激活脚本。

## 本阶段可交付范围

- 生产规则与任务提示补丁：统一 4/2/1/2/1、明确 ready 和视觉通过的差别、允许有记录的未来资产定向修复、复用同一断点。提示及名称尚未应用，schedule/status 不变。
- 腾讯服务的 00:10 当日快照异常/恢复、17:15 次日草稿异常/恢复采用飞书消息格式。既有服务内调度不改时间。
- 新周验收是服务器 systemd oneshot，检查下周 7 日各 10/10/10、零错误/警告、跨日去重、存储图片实际可解码；成功后本周跳过扫描。发首次成功、失败/恢复通知；失败有可重试的通知记录。它不负责生成内容或修图。
- 官方导入 oneshot 使用现有服务器凭证，只请求本机导入接口，预览后凭 revision 和确定性 operationId 提交，随后内部读回 FileKV。现有 /favorites 权限不放宽。官方文件仍需用户经获准通道送达服务器；不假定已有无人值守下载或安全上传。

## 待确认的生产变更清单

1. 用审核通过的确切 commit 部署本分支代码到 `/opt/japanese-words/app`，先核实 main 仍为原基线、工作区干净、其他服务 PID、备份和回滚副本。没有 push/merge 授权前先保留本地 patch，不可直接部署未版本化目录。
2. 把 `server/systemd/japanese-words-ops-alert.conf` 安装到 `/etc/systemd/system/japanese-words.service.d/ops-alert.conf`（root:root 0644）。原 `/etc/japanese-words.env` 不读取、不改写。
3. 用户本人运行隐藏输入脚本，新建 `/etc/japanese-words-ops-alert.env`，root:root 0600。变量 `OPS_ALERT_WEBHOOK_URL`；仅机器人启用签名时配置 `OPS_ALERT_SIGNING_SECRET`。不复制秘密到对话、命令参数、任务提示或 Git；不输出文件内容。无现成安全终端时先解决接入，不能让用户把值发来。
4. `daemon-reload` 后只重启 `japanese-words.service`。可能出现短暂 API 不可用；nginx、xray、feishu-score-bot 不重启。重启会执行既有 catch-up，因此操作前核对当天已有成功标记和未来草稿，避开 00:00 发布窗口。
5. 安装新周检查 service/timer 至 `/etc/systemd/system/`（root:root 0644），经一次受控验收及通知确认后启用。新时间为 **Asia/Shanghai 周二至周日 14:40**，Persistent=true；机器重启或首次启用时可能立即补跑。其运行目录由 systemd 创建，写入仅 operations-health 记录，不生成/上传/晋升内容。
6. 可安装 `japanese-words-published-import@.service`（root:root 0644），不启用新 timer。新建 `/var/lib/japanese-words/published-import-inbox`（japanese-words:japanese-words 0700），每批 JSON 0600；实例名仅字母、数字、下划线、连字符。`systemctl start japanese-words-published-import@<批次>.service` 会实际提交，必须单独确认该批次。payload 与草稿是生产私有数据，不入 Git。

新增每日汇总已准备，拟安装 operations-report service/timer，上海时间每天15:10（备份15:00之后）发送，Persistent=true；尚未启用。当天官方数据未成功导入会报明确缺口，不把preview算成功。汇总只保存计数/结果，不展示笔记或秘密。

不在本次激活范围：云内容生产任务、XHS 自动下载/上传通道、暂停任何本地任务、修改 Cloudflare/GitHub 调度、合并 #66/#67/#73。不能因为启用服务器周检查就称“内容已迁云”或直接删除本地修复职责。

## 用户秘密输入交接

脚本部署完成后，在用户本人控制的服务器交互终端运行：

```bash
sudo /opt/japanese-words/runtime/node-current/bin/node /opt/japanese-words/app/server/configure-ops-alert.mjs
```

用户粘贴 Webhook 并回车，屏幕无内容回显。若已启用机器人签名，在同一命令末尾加 `--signing`，第二次隐藏输入签名密钥。出现保存成功后仅核对 owner/mode，不 cat 文件，不读取进程环境，不要求用户发送值。该命令不重启服务、不发测试消息。确认关键词应包含 `[japanese-words]`；IP 白名单需核实腾讯机器实际出口 IP，不能只猜为公网实例 IP。IP/关键词/签名设置尚未核实，不在后台擅自更改。

## 切换与恢复

首次服务器验收和飞书发送确认前保留旧任务。周验收转移后，本地周验收仍有修复职责，应改成按失败单修复再关闭重复检查；不能一刀切停用。每日本地快照监控仍是13:20，新汇总是15:10，覆盖时间有差别；是否接受该时间替代需单独确认。在批准停用前继续保留。

恢复时先 stop/disable 新周 timer（不删数据），保留待查通知记录和导入批次；恢复原 commit 和 systemd 单元/drop-in，daemon-reload 后只重启应用。通知配置可保留 root600 供排障，取消引用即可停用通知；删除秘密文件或更换凭证需用户决定。已提交的官方指标属于生产数据，回滚代码不回滚它；若确需恢复数据，使用经验证的备份并单独批准。恢复旧本地任务使用保存的原提示和调度，Cloudflare 仍不恢复 cron。

## 云生产可行性边界

[官方定时文档](https://learn.chatgpt.com/docs/automations?surface=app)说明本地项目调度需要电脑开机和应用运行；web 任务不能直接使用本机目录，运行间不应假定本地工作区持久。需要服务端保存 plan/progress/draft/QA，并能安全读写。

[官方生图文档](https://learn.chatgpt.com/docs/image-generation)支持交互生图，但不足以证明此账号的无人值守云任务拥有同样工具和 70 张批量额度。须获准用一个隔离目标日期测试：实际 imagegen、跨两次运行恢复断点、窄权限上传及草稿读回、不触发晋升，证明后才停用本地生产。选择服务器/API 方案会涉及 API 支出与安全凭证设置，需单独决定。旧 Codex Cloud 环境 [secrets 仅在 setup 阶段提供](https://learn.chatgpt.com/docs/environments/cloud-environment)，不能把“配置了 secret”直接当作 agent 运行期上传可用。

## 检查与日志

本地测试包括 `npm run test:operations`、既有全套 `npm test`、lint、typecheck、build。生产激活后另需核实 Node22、systemd unit/timer、日历时区、图片检查成本、备份及其他服务 PID。飞书业务返回失败在记录中标为失败，不能凭 HTTP200 称成功；实际首次通知测试须获准。用 `journalctl -u japanese-words.service`、`-u japanese-words-weekly-check.service`、`-u japanese-words-published-import@<批次>.service` 查明确阶段与错误码，不能打印环境配置。

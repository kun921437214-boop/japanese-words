# Codex 周内容流水线

## 目标

每周一北京时间 14:30 在固定的 Codex 任务中准备下周周一至周日的内容：先规划 7 天 × 10 词，再按日期连续完成词卡、参考图、验证、上传和草稿提交。腾讯云运行时每天 00:00 把对应日期已通过质量门的草稿晋升为正式 `todaySnapshot`；草稿缺失或不合格时，才调用现有 DeepSeek 日更作为保底。

当前运营自动化：

- `japanese-words`：每天 13:20 同步小红书官方已发布数据，为周一 14:30 的选词、词卡和图片生成提供最新反馈。
- `japanese-words-2`：每天 13:20 只读检查当天 `todaySnapshot`，确认 00:00 晋升结果为当天恰好 10 词。
- `japanese-words-codex`：每周一 14:30 生成并上传下周整周内容。
- `japanese-words-production`：周二至周日 14:40 验收下周整周内容；有问题时从断点修复，任意一天全周通过后写 `verification.json`，本周后续触发只读本地标记并退出。

周一生成任务和周二起的验收任务必须复用同一组周计划、进度与单日断点，不能按日期创建彼此孤立的任务。

## 数据流

1. 周一 13:20 已发布数据同步完成后，Codex 为下周 7 天逐日请求 `/codex-daily?date=<目标日期>&view=context`，取得账号定位、收藏/反馈、候选池、已发布表现和近 30 天快照。
2. Codex 先生成 70 词周计划，完成跨日去重与语义簇审计，再按日期连续生成每天 10 个词的完整词卡，并用 image generation 为每个词准备一张参考图。
   - 目标日期从 `2026-08-10` 起，context 中的发布表现按 topic / cover / content 三路分流：分别只服务选词、视觉 Brief 和词卡结构；不做数值排名加权，不改变 `aiCard` 结构。
   - `collecting` 与 `insufficient` 保持中性，`early` 仅作半权重定性提示，`final` 才作完整定性 guidance；至少需要 2 篇同方向成熟信号，封面或内容偏弱不得惩罚词本身。
3. 图片通过 `PUT /codex-image` 写入独立的 `REFERENCE_IMAGES_KV`；返回的同源 URL 保存到 `aiCard.referenceImage`。若未来开通 R2，接口仍可优先使用 `REFERENCE_IMAGES` R2 binding。
4. `npm run codex:daily -- validate` 在本地执行同一套质量门。
5. Codex 使用独立的 `CODEX_AUTOMATION_SECRET` 提交草稿。该凭证不能发布草稿，不能调用 `/favorites`、`/daily-refresh` 或 `/ai-cards`。
6. 北京时间 00:00，腾讯云内部调度器使用现有 `AUTO_REFRESH_SECRET` 调用 `POST /codex-daily` 的 `promote` 动作。
7. 只有有效草稿会晋升；否则腾讯云运行时继续调用现有 `/daily-refresh`。后续 aiCard 定时任务仅在仍有缺卡时调用 DeepSeek。
8. 周二 14:40 起，验收任务逐日检查下周 7 天是否全部达到 10 词、10 张 ready 词卡、10 张 Production ready 图片、`validation.valid=true`、零 error、零 warning。未通过时只修复缺失项；整周通过后本周停止 Production 检查。

## 发布门

- 恰好 10 个不重复词。
- 每个词包含日语、读音、中文语感和完整词卡。
- 完整词卡必须覆盖 `summary`、`explanation`、`usageScenes`、`examples`、`suggestedTitles`、`coverSuggestion`、`contentAngles`、`targetAudience`、`referenceDirection`、`riskWarning`、`wrongUsage`、`similarWords`、`interactionPrompts`。
- 内容数量与 DeepSeek 词卡规则对齐：例句 2-4 条、推荐标题 3-6 条、内容角度 3-6 条、互动引导 2-4 条；相近词至少 1 个，并说明语感差异。
- 例句必须包含自然日语、假名、罗马音、中文和简短语境说明，不能只给直译。
- 同一周 70 词不能重复或用同义改写凑数。
- 近 30 天不能重复。
- 同日语义簇不能重复。
- 美妆品类最多 1 个，基础寒暄/教材礼貌词最多 1 个。
- S 级最多 6 个，人工质量估分至少 75。
- 高风险、低置信或待复核词不能自动发布。
- 下周草稿提交和整周验收要求参考图片全部为 Production ready；图片缺失产生的 warning 必须在提交前消除。

## 周计划与断点

```text
exports/codex-weekly/<本周周一>/plan.json
exports/codex-weekly/<本周周一>/progress.json
exports/codex-weekly/<本周周一>/complete.json
exports/codex-weekly/<本周周一>/verification.json
exports/codex-daily/<目标日期>/context.json
exports/codex-daily/<目标日期>/draft.json
exports/codex-daily/<目标日期>/validation.json
exports/codex-daily/<目标日期>/images/
exports/codex-daily/<目标日期>/image-uploads.json
```

`progress.json` 记录 `completedDays`、`reservedWords`、`nextTargetDate` 和逐日阶段。每完成一天立即落盘，再继续下一天；中断后从最早未完成日期恢复，不重做已 valid 日期、ready 词卡或 ready 图片。

`complete.json` 表示周一生成与上传已完成；`verification.json` 表示周二起的独立 Production 整周验收已通过。验收标记必须包含本周周一、下周日期范围、7 天逐日计数和检查时间；旧周标记不得复用。

## 本地命令

所有联网命令都要求设置站点和独立凭证，且写入命令还要求 `--confirm-submit`。固定 Codex 任务默认从项目根目录的 `.env.codex-daily` 读取这两个值；该文件已被 Git 忽略，并应保持仅当前用户可读。也可以通过环境变量覆盖它。

```bash
# .env.codex-daily（不要提交）
CODEX_SITE_URL=https://bijinihaitan.cn
CODEX_AUTOMATION_SECRET=replace-locally

npm run codex:daily -- context --date 2026-07-14
npm run codex:daily -- draft --date 2026-07-14
npm run codex:daily -- validate --date 2026-07-14 --draft exports/codex-daily/2026-07-14/draft.json
npm run codex:daily -- upload-images --date 2026-07-14 --draft exports/codex-daily/2026-07-14/draft.json --images-dir exports/codex-daily/2026-07-14/images --manifest exports/codex-daily/2026-07-14/image-uploads.json --require-storage kv --confirm-submit
npm run codex:daily -- upload-image --date 2026-07-14 --word モヤる --file /absolute/path/moyaru.webp --confirm-submit
npm run codex:daily -- submit --date 2026-07-14 --draft exports/codex-daily/2026-07-14/draft.json --confirm-submit
npm run codex:daily -- status --date 2026-07-14
```

`upload-images` 会按 `01-` 至 `20-` 文件名前缀匹配草稿词序，优先使用 WebP，并跳过已经 `ready` 的图片。每上传成功一张就立即写回 `draft.json` 与 `image-uploads.json`；瞬时网络错误和 5xx 会有限重试，鉴权失败或存储未配置则停止，下一次运行从缺失项继续。`upload-image` 仅用于单张人工修复。

KV 模式下单张图片不能超过 800 KiB，批量命令会在联网前完成本地预检。优先生成 WebP；若原图过大，可在本机缩放并压缩为 JPEG 后再上传。`exports/` 已被 git 忽略。不要把上下文、生成图片、草稿或 secret 提交到仓库。

## 腾讯云 Production 前置项

代码合并后仍不会自动启用。正式激活需要单独批准并完成：

1. 在 `/etc/japanese-words.env` 配置独立 secret `CODEX_AUTOMATION_SECRET`，不要复用 `AUTO_REFRESH_SECRET`。
2. 确认腾讯云 FileKV 和参考图片目录可写、备份定时器已启用，并保持数据与图片分区存放。
3. 部署腾讯云运行时后，先用只读 status 和 Production smoke 验证。
4. 启用周一 14:30 的下周整周生成任务，以及周二至周日 14:40 的整周验收与断点修复任务。
5. 如有可用的告警接收端，在 `/etc/japanese-words.env` 配置 `OPS_ALERT_WEBHOOK_URL`；不配置时健康结果仍写入 FileKV 和 systemd 日志。

Cloudflare Pages、Worker、KV 和协调器只作为回滚资源保留；其 Worker cron 已停用，避免与腾讯云内部调度重复运行。图片只能通过带 Codex 专用凭证的 `/codex-image` 写入正式站存储。

## 回滚

该改造没有修改 workflow schema 版本，也没有迁移或清理旧 KV。Codex 草稿使用独立的 `codex-draft:<scope>:<date>` key，旧版本会自然忽略；图片也独立存放。

代码回滚基线：

- 分支：`backup/pre-codex-pipeline-2026-07-13`
- tag：`pre-codex-pipeline-2026-07-13`
- commit：`1e7cf901c07c9e6dd9c4b1d00a75ceb1e2292de0`
- 离线 bundle：`/Users/kun/Documents/Codex/japanese-words-backups/japanese-words-pre-codex-pipeline-2026-07-13.bundle`

回滚时部署上述 tag 对应的 Pages 与 Worker，并重新启用旧 Worker cron；不要清 KV、图片 KV 或 R2。暂停腾讯云调度并把 Codex heartbeat 的站点地址切回旧站后，旧 Worker 才能恢复午夜 DeepSeek 流程。

## 固定任务行为

每天 13:20 已发布数据同步：只使用小红书创作者平台官方导出，preview 无歧义后才提交，提供最新 topic、cover 和 content 表现反馈。

每天 13:20 当日快照监控：只读检查 `/healthz` 与 `/favorites`，确认 00:00 晋升后的日期和 10 词，不生成或修复内容。

周一 14:30 主任务：读取下周 7 天上下文，统一规划 70 词并按日期连续完成 10 词、10 卡、10 图、上传、验证和草稿提交；不发布、不调用 DeepSeek、不部署。

周二至周日 14:40 验收与修复：检查下周整周 7 天是否全部为 10/10/10、valid、零 error、零 warning。发现问题时从同一周进度修复；整周通过后写 `verification.json`，本周后续触发不再访问 Production。

每天 00:00 腾讯云发布：Codex 草稿不可用时同步执行 DeepSeek 兜底。只有最终完成才写成功标记；排队中、HTTP 失败或生成失败都会保持可重试。

腾讯云运行时代码仍保留 00:10 当日快照和 17:15 次日草稿内部健康记录，作为服务端安全网。它们与上述 Codex 运营监控分层运行；调整运营自动化不能被误写成已经修改运行时 cron。

# Codex 每日内容流水线

## 目标

每天北京时间 14:00 在固定的 Codex 对话中准备次日 10 个词、完整词卡和参考图片。腾讯云运行时在午夜把已通过质量门的草稿晋升为正式 `todaySnapshot`；草稿缺失或不合格时，才调用现有 DeepSeek 日更作为保底。

固定 Codex 任务：`019f5c0e-3d15-75b2-92b1-5f6cb05610aa`。14:00 主任务和 17:00 补漏任务都必须唤醒这一条任务，不能每天创建新任务。

## 数据流

1. Codex 只读请求 `/codex-daily?date=明日&view=context`，取得账号定位、收藏/反馈、候选池和近 30 天快照。
2. Codex 在本地生成 10 个词和完整词卡，并用 image generation 为每个词准备一张参考图。
3. 图片通过 `PUT /codex-image` 写入独立的 `REFERENCE_IMAGES_KV`；返回的同源 URL 保存到 `aiCard.referenceImage`。若未来开通 R2，接口仍可优先使用 `REFERENCE_IMAGES` R2 binding。
4. `npm run codex:daily -- validate` 在本地执行同一套质量门。
5. Codex 使用独立的 `CODEX_AUTOMATION_SECRET` 提交草稿。该凭证不能发布草稿，不能调用 `/favorites`、`/daily-refresh` 或 `/ai-cards`。
6. 北京时间 00:00，腾讯云内部调度器使用现有 `AUTO_REFRESH_SECRET` 调用 `POST /codex-daily` 的 `promote` 动作。
7. 只有有效草稿会晋升；否则腾讯云运行时继续调用现有 `/daily-refresh`。后续 aiCard 定时任务仅在仍有缺卡时调用 DeepSeek。

## 发布门

- 恰好 10 个不重复词。
- 每个词包含日语、读音、中文语感和完整词卡。
- 完整词卡必须覆盖 `summary`、`explanation`、`usageScenes`、`examples`、`suggestedTitles`、`coverSuggestion`、`contentAngles`、`targetAudience`、`referenceDirection`、`riskWarning`、`wrongUsage`、`similarWords`、`interactionPrompts`。
- 内容数量与 DeepSeek 词卡规则对齐：例句 2-4 条、推荐标题 3-6 条、内容角度 3-6 条、互动引导 2-4 条；相近词至少 1 个，并说明语感差异。
- 例句必须包含自然日语、假名、罗马音、中文和简短语境说明，不能只给直译。
- 近 30 天不能重复。
- 同日语义簇不能重复。
- 美妆品类最多 1 个，基础寒暄/教材礼貌词最多 1 个。
- S 级最多 12 个，人工质量估分至少 75。
- 高风险、低置信或待复核词不能自动发布。
- 参考图片缺失会产生 warning，但不会阻断文字卡片，页面使用原有兜底图。

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
4. 再启用固定 Codex 任务的 14:00、16:00 和 17:00 三个 heartbeat。

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

14:00 主任务：读取明日上下文，生成并验证 10 个词/卡片/图片，只提交草稿，不发布、不调用 DeepSeek、不部署。

16:00 恢复检查：读取同一日期的现有草稿；如果 14:00 因网络或审批链路中断，使用同一个 `upload-images` 命令从缺失图片继续，不重做 ready 内容。

17:00 最终补漏：再次只补未完成词卡或图片。若草稿仍不合格，应在同一 Codex 任务中报告错误并保留 DeepSeek 午夜兜底。

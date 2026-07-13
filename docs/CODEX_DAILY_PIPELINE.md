# Codex 每日内容流水线

## 目标

每天北京时间 14:00 在固定的 Codex 对话中准备次日 20 个词、完整词卡和参考图片。午夜 Worker 只负责把已通过质量门的草稿晋升为正式 `todaySnapshot`；草稿缺失或不合格时，才调用现有 DeepSeek 日更作为保底。

固定 Codex 任务：`019f5c0e-3d15-75b2-92b1-5f6cb05610aa`。14:00 主任务和 17:30 补漏任务都必须唤醒这一条任务，不能每天创建新任务。

## 数据流

1. Codex 只读请求 `/codex-daily?date=明日&view=context`，取得账号定位、收藏/反馈、候选池和近 30 天快照。
2. Codex 在本地生成 20 个词和完整词卡，并用 image generation 为每个词准备一张参考图。
3. 图片通过 `PUT /codex-image` 写入可选 R2；返回的同源 URL 保存到 `aiCard.referenceImage`。
4. `npm run codex:daily -- validate` 在本地执行同一套质量门。
5. Codex 使用独立的 `CODEX_AUTOMATION_SECRET` 提交草稿。该凭证不能发布草稿，不能调用 `/favorites`、`/daily-refresh` 或 `/ai-cards`。
6. 北京时间 00:00，Worker 使用现有 `AUTO_REFRESH_SECRET` 调用 `POST /codex-daily` 的 `promote` 动作。
7. 只有有效草稿会晋升；否则 Worker 继续调用现有 `/daily-refresh`。后续 aiCard cron 仅在仍有缺卡时调用 DeepSeek。

## 发布门

- 恰好 20 个不重复词。
- 每个词包含日语、读音、中文语感和完整词卡。
- 近 30 天不能重复。
- 同日语义簇不能重复。
- 美妆品类最多 1 个，基础寒暄/教材礼貌词最多 1 个。
- S 级最多 12 个，人工质量估分至少 75。
- 高风险、低置信或待复核词不能自动发布。
- 参考图片缺失会产生 warning，但不会阻断文字卡片，页面使用原有兜底图。

## 本地命令

所有联网命令都要求显式设置站点和独立凭证，且写入命令还要求 `--confirm-submit`。

```bash
export CODEX_SITE_URL=https://jiyimianbao.pages.dev
export CODEX_AUTOMATION_SECRET=replace-locally

npm run codex:daily -- context --date 2026-07-14
npm run codex:daily -- draft --date 2026-07-14
npm run codex:daily -- validate --date 2026-07-14 --draft exports/codex-daily/2026-07-14/draft.json
npm run codex:daily -- upload-image --date 2026-07-14 --word モヤる --file /absolute/path/moyaru.webp --confirm-submit
npm run codex:daily -- submit --date 2026-07-14 --draft exports/codex-daily/2026-07-14/draft.json --confirm-submit
npm run codex:daily -- status --date 2026-07-14
```

`exports/` 已被 git 忽略。不要把上下文、生成图片、草稿或 secret 提交到仓库。

## Cloudflare 激活前置项

代码合并后仍不会自动启用。正式激活需要单独批准并完成：

1. 为 Pages 配置独立 secret `CODEX_AUTOMATION_SECRET`，不要复用 `AUTO_REFRESH_SECRET`。
2. 可选：创建私有 R2 bucket，并以 `REFERENCE_IMAGES` 绑定到 Pages Functions。未配置时，图片上传返回 503，文字草稿仍可工作。
3. 部署 Pages 和 Worker 后，先用 Preview/只读 status 验证。
4. 再启用固定 Codex 任务的 14:00 和 17:30 两个 heartbeat。

本 PR 不创建 bucket、不修改 Cloudflare 变量/secret、不写 Production KV、不触发日更、不部署。

## 回滚

该改造没有修改 workflow schema 版本，也没有迁移或清理旧 KV。Codex 草稿使用独立的 `codex-draft:<scope>:<date>` key，旧版本会自然忽略；图片也独立存放。

代码回滚基线：

- 分支：`backup/pre-codex-pipeline-2026-07-13`
- tag：`pre-codex-pipeline-2026-07-13`
- commit：`1e7cf901c07c9e6dd9c4b1d00a75ceb1e2292de0`
- 离线 bundle：`/Users/kun/Documents/Codex/japanese-words-backups/japanese-words-pre-codex-pipeline-2026-07-13.bundle`

回滚时部署上述 tag 对应的 Pages 与 Worker 即可，不要清 KV 或 R2。暂停两个 Codex heartbeat 后，旧 Worker 会恢复为午夜直接调用 DeepSeek 的流程。

## 固定任务行为

14:00 主任务：读取明日上下文，生成并验证 20 个词/卡片/图片，只提交草稿，不发布、不调用 DeepSeek、不部署。

17:30 补漏任务：读取同一日期的现有草稿，只补未完成词卡或图片；已有内容不重做。若草稿仍不合格，应在同一 Codex 任务中报告错误并保留 DeepSeek 午夜兜底。

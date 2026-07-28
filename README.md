# japanese-words

小红书日语选题后台，用来发现、筛选、收藏、生成词卡并复盘日语内容选题。

这个项目不是通用日语词典，也不是最终发布系统。核心流程是：

1. DeepSeek 生成或审核候选词。
2. 每日热门展示系统推荐。
3. 人工收藏后进入团队选题池。
4. 从收藏中筛选待发布词。
5. 发布后记录数据和复盘。
6. 发布反馈反哺后续推荐。

## 技术栈

- 原生静态前端：`index.html`、`styles.css`、`app.js`
- 腾讯云 Production：Nginx、Node.js 22 runtime、FileKV、systemd scheduler
- 复用 Pages Function 接口实现：`functions/`
- Cloudflare Pages / Worker / KV：仅保留为备用回滚环境
- DeepSeek API：候选词、旧词审核、词卡生成
- Codex 自动化：次日选词、完整词卡和参考图片草稿
- Node.js 脚本：词库构建、部署、数据检查

## 目录

- `index.html`：页面入口
- `styles.css`：全局样式
- `app.js`：主要前端逻辑
- `functions/`：Cloudflare Pages Functions
- `shared/`：服务端/脚本共享逻辑
- `data/`：历史种子数据和审核记录
- `scripts/`：构建、部署、测试脚本
- `account-intelligence/`：账号学习报告
- `docs/`：交接、部署、测试、数据规则文档
- `sample_data/`：脱敏测试样本
- `src/`：未来模块化代码预留目录

## 安装

```bash
npm install
```

CI 和发布环境使用 Node.js 22.23.1 与锁文件安装：`npm ci`。

## 本地运行

静态页面可直接打开 `index.html`，也可以用任意静态服务器运行项目根目录。

修改历史种子数据后，运行：

```bash
npm run build:words
```

## 常用命令

```bash
npm run build:words
npm run build
npm run lint
npm run typecheck
npm test
npm run backup:workflow
npm run restore:workflow -- <backup-file>
npm run test:workflow
npm run test:e2e
npm run deploy:tencent -- --dry-run
```

`npm run deploy:coordinator`、`npm run deploy`、`npm run deploy:worker` 只用于经过明确批准的 Cloudflare 回滚，不能作为日常 Production 部署命令。

## 环境变量

生产环境变量配置在腾讯云 `/etc/japanese-words.env`，不要写入前端或 GitHub：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`
- `AUTO_REFRESH_SECRET`
- `ADMIN_API_TOKEN`
- `OPS_ALERT_WEBHOOK_URL`（可选，每日内容异常/恢复通知）
- `TEAM_ACCESS_EMAILS`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `ALLOWED_ORIGINS`
- `SITE_URL`

本地参考 `.env.example`。

## Production 与 GitHub

- 正式网站：`https://bijinihaitan.cn`
- GitHub `main` 是合并后的代码唯一可信来源。
- 所有修改使用 `codex/*` 分支和 PR。
- 推送、开 PR 或合并代码都不代表允许部署。
- Production 部署必须先通过测试、构建、备份和预检，并得到明确授权。

## 使用方式

1. 打开每日热门，查看系统推荐词。
2. 收藏适合做小红书内容的词，进入团队选题池。
3. 在收藏页生成或查看 DeepSeek 词卡。
4. 标记待发布/已发布。
5. 在已发布页记录链接、数据和复盘。
6. 后续推荐会参考收藏、跳过、发布表现等反馈。

## 常见问题

### 为什么没有 DeepSeek 词卡时详情页内容很少？

正式单词卡只认 `aiCard.cardStatus = "ready"`。没有生成词卡时，只显示基础信息，避免用本地模板冒充正式内容。

### 为什么生成每日热门时会跳过一些高分词？

每日热门有硬排除规则：已收藏、已发布、当天跳过、近 30 天出现过、高风险、需复核、证据未知等词不会直接进入首页。

### 为什么不要上传 `.env` 或真实数据？

API Key、团队数据、真实报名/隐私数据都不能进入 GitHub。仓库只保留代码、文档、历史种子数据和脱敏样本。

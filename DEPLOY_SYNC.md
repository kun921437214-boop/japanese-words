# 团队工作流同步部署说明

生产前端和 API 部署在 Cloudflare Pages，团队工作流使用 Cloudflare KV。写入与读取接口均需要经过 Cloudflare Access 或独立管理令牌认证，不是公共收藏服务。

## 当前状态

Cloudflare Pages 已创建，建议优先使用这个地址访问网页和同步接口：

```text
https://jiyimianbao.pages.dev
```

定时 Worker 负责触发日更和词卡任务：

```text
https://japanese-words-sync.kun921437214.workers.dev
```

前端配置文件 `sync-config.js` 使用 Cloudflare Pages 地址。Worker 的旧 HTTP 数据接口默认关闭，浏览器不应改为直连 Worker。

## 重新部署 Worker 时需要的配置

1. 注册或登录 Cloudflare。
2. 进入 Workers & Pages，创建一个 KV namespace，名字可以叫 `japanese_words_favorites`。
3. 把 KV namespace 的 ID 复制到 `wrangler.worker.toml`。
4. 先配置 `AUTO_REFRESH_SECRET`，并确保 Pages 与 Worker 的值一致。
5. 在项目根目录完成质量门后运行固定版本 Wrangler 的部署脚本：

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx wrangler login
npm run deploy:worker
```

5. Cloudflare 会给你一个 Worker 地址，例如：

```text
https://japanese-words-sync.your-name.workers.dev
```

6. 保持 `ENABLE_LEGACY_WORKER_API=false`。`/healthz` 可用于确认 Worker 存活，但不读取团队数据。

## 重新部署 Cloudflare Pages

项目根目录运行：

```bash
npm run deploy
```

该命令只上传 `dist/` 白名单产物，不要直接执行 `wrangler pages deploy .`。

部署前必须先配置 `TEAM_ACCESS_EMAILS`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`ADMIN_API_TOKEN`、`ALLOWED_ORIGINS`、`SITE_URL` 和 DeepSeek/自动任务所需变量。完整顺序、备份和回滚方式见 `docs/SYSTEM_HARDENING.md`。

## 团队同步

1. 通过 Cloudflare Access 登录的允许账号会读取同一份团队工作流。
2. 每次写入携带 operation ID 和 revision，重复请求会被去重，过期版本返回 409。
3. 前端会在网络失败时保留本地缓存并明确提示团队同步失败。

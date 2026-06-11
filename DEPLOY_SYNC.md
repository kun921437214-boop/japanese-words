# 云端收藏同步部署说明

这个项目可以部署在 GitHub Pages 或 Cloudflare Pages 上，公共收藏使用 Cloudflare KV。

## 当前状态

Cloudflare Pages 已创建，建议优先使用这个地址访问网页和同步接口：

```text
https://jiyimianbao.pages.dev
```

备用 Worker 也已部署：

```text
https://japanese-words-sync.kun921437214.workers.dev
```

前端配置文件 `sync-config.js` 已经填入 Cloudflare Pages 地址。现在使用公共收藏，不再需要同步码。

## 重新部署 Worker 时需要的配置

1. 注册或登录 Cloudflare。
2. 进入 Workers & Pages，创建一个 KV namespace，名字可以叫 `japanese_words_favorites`。
3. 把 KV namespace 的 ID 复制到 `wrangler.worker.toml`。
4. 在项目根目录运行：

```bash
npx wrangler login
npx wrangler deploy --config wrangler.worker.toml
```

5. Cloudflare 会给你一个 Worker 地址，例如：

```text
https://japanese-words-sync.your-name.workers.dev
```

6. 如果你决定改用 Worker 地址，把新地址填进 `sync-config.js`：

```js
window.KOTOBA_SYNC_API_URL = 'https://japanese-words-sync.your-name.workers.dev';
```

7. 提交并推送到 GitHub。

## 重新部署 Cloudflare Pages

项目根目录运行：

```bash
npx wrangler pages deploy . --project-name jiyimianbao --branch main
```

## 公共收藏怎么同步

1. 任何设备打开网站后，都会自动读取同一份公共收藏。
2. 任何人点击 ♡ 收藏，都会自动上传到云端。
3. 所有人刷新或打开网站时，都会看到这份公共收藏。

公共收藏是所有人共享的，不适合保存私密内容。

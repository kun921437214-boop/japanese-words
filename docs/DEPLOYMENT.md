# Deployment

## Local Setup

```bash
npm install
npm run build:words
```

The app is a static frontend. You can open `index.html` directly or serve the project root with a static HTTP server.

## Production

Production is deployed to Cloudflare Pages:

- Site: `https://jiyimianbao.pages.dev`
- Pages Functions: `functions/`
- KV binding: `FAVORITES`

Deploy the Pages project:

```bash
npm run deploy
```

Deploy the scheduled Worker:

```bash
npm run deploy:worker
```

## Environment Variables

Configure these in Cloudflare, not in source code:

- `DEEPSEEK_API_KEY`：DeepSeek API key.
- `DEEPSEEK_MODEL`：optional, default is `deepseek-v4-flash`.
- `AUTO_REFRESH_SECRET`：secret for protected daily refresh endpoint.
- `SITE_URL`：production site URL, usually `https://jiyimianbao.pages.dev`.

Use `.env.example` only as a reference template.

## Cloudflare KV

Workflow data is stored in the `FAVORITES` KV namespace.

Important workflow fields:

- `words`
- `statuses`
- `feedback`
- `publishedRecords`
- `candidatePool`
- `aiBatches`
- `todaySnapshot`

Any server write must preserve all major fields, even if the current endpoint only edits one of them.

## Daily Refresh

The protected endpoint is:

```text
POST /daily-refresh
Authorization: Bearer <AUTO_REFRESH_SECRET>
```

The scheduled Worker calls this endpoint. Cloudflare cron uses UTC time. Check `wrangler.worker.toml` for the current schedule.

## Common Deployment Problems

### Wrangler authentication fails

Run:

```bash
npx -y wrangler login
```

Then retry deployment.

### Pages deploy succeeds but UI looks old

Hard refresh the browser. Cloudflare Pages may also need a short moment before the production alias serves the newest deployment.

### DeepSeek generation fails

Check that `DEEPSEEK_API_KEY` exists in the Pages project environment and not only in the Worker environment.

### Daily refresh is unauthorized

Make sure the Worker and Pages project use the same `AUTO_REFRESH_SECRET`.

### Workflow fields disappear

Inspect `/favorites` and verify the response still includes `candidatePool`, `aiBatches`, `todaySnapshot`, and `publishedRecords`.

# Deployment

## Local Setup

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The production static artifact is written to `dist/`. It contains an explicit allowlist of public files, so source data, scripts, and operational documentation are not uploaded with the site.

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
- `ADMIN_API_TOKEN`：separate token for backup, restore, and emergency administration.
- `TEAM_ACCESS_EMAILS`：comma-separated team emails allowed after Access verification.
- `CF_ACCESS_TEAM_DOMAIN`：Cloudflare Access team domain.
- `CF_ACCESS_AUD`：Cloudflare Access application audience tag.
- `ALLOWED_ORIGINS`：allowed browser origins; do not use `*`.
- `SITE_URL`：production site URL, usually `https://jiyimianbao.pages.dev`.
- `ENABLE_LEGACY_WORKER_API`：leave `false` unless a reviewed legacy HTTP migration requires it.

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

Run the pinned local Wrangler through the project scripts:

```bash
npx wrangler login
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

## Health And Recovery

- `GET /healthz` checks whether required bindings are present without reading workflow data.
- `npm run backup:workflow` creates a validated mode-`0600` backup and performs no write.
- `npm run restore:workflow -- <file>` is a dry run. A write additionally requires `--apply --confirm=RESTORE` and an up-to-date workflow revision.
- See `docs/SYSTEM_HARDENING.md` for deployment order, rollback, and the remaining Cloudflare KV concurrency limitation.

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

## Current Tencent Cloud Production

Production is deployed to Tencent Cloud Lighthouse:

- Site: `https://bijinihaitan.cn`
- Static frontend: Nginx serving `dist/`
- API runtime and scheduler: `japanese-words.service`
- Workflow storage: FileKV under `/var/lib/japanese-words`
- Daily backup: `japanese-words-backup.timer`

The full install, guarded import, zero-downtime cutover, deployment, and rollback procedure is documented in `docs/TENCENT_CLOUD_MIGRATION.md`. Run the read-only smoke check after deployment:

```bash
SITE_URL=https://bijinihaitan.cn npm run smoke:production
```

### Routine Production deployment

GitHub remains the source of truth, but merging or pushing code does not automatically change Production. After the reviewed branch has passed its pull-request checks, connect to the Tencent host and run:

```bash
cd /opt/japanese-words/app
npm run deploy:tencent -- --dry-run
npm run deploy:tencent -- --confirm=DEPLOY
```

The deploy command only accepts a clean working tree and a fast-forward update from `codex/fix-daily-automation-assets`. It first checks the lightweight remote branch advertisement, which avoids downloading a Git pack when Production is already current. For a real update it tries the normal Git transport, an HTTP/1.1 path, and a conservative low-bandwidth path. If Git smart HTTP is still unavailable, it downloads and verifies the official bundle published by this repository's `Publish Tencent Deploy Bundle` workflow. It then rejects dependency-lock changes, builds and runs all quality checks outside the live directory, creates a complete workflow/image backup, swaps the built static artifact, restarts the runtime, and rolls back if the local health check fails. It does not use a third-party proxy, create a deploy key, or schedule future deployments.

The official bundle is a transport fallback only. GitHub remains the source of truth, and the same fast-forward, test, backup, confirmation, health-check, and rollback gates still apply. If both GitHub paths are unavailable, transfer a bundle created from the reviewed branch through the trusted Tencent console and pin its full commit explicitly:

```bash
bash server/deploy-production.sh \
  --bundle=/path/to/japanese-words-production.bundle \
  --expected-commit=<full-40-character-git-hash> \
  --confirm=DEPLOY
```

After it succeeds, run the read-only smoke check from a trusted workstation and visually check the affected desktop and mobile workflows. A GitHub push is never sufficient authorization to run this command.

## Cloudflare Rollback Stack

Cloudflare Pages, Worker, KV, and the workflow coordinator remain available only as rollback infrastructure. The scheduled Worker has an empty cron list so it cannot compete with the Tencent scheduler.

If rollback is explicitly approved, first disable Tencent scheduling, compare workflow revisions, restore DNS, and then deploy the Cloudflare components in this order:

```bash
npm run deploy:coordinator
npm run deploy
npm run deploy:worker
```

Smoke-test the rollback origin explicitly:

```bash
SITE_URL=https://jiyimianbao.pages.dev npm run smoke:production
```

Do not remove the Cloudflare site, Worker, coordinator, or KV namespaces during the migration rollback window.

The smoke check is read-only. It verifies the current Daily Hot snapshot, card/image readiness, compact app response size, and continuity between the current revision and latest mutation audit record.

## Environment Variables

Configure these in `/etc/japanese-words.env` on Tencent Production, never in source code:

- `DEEPSEEK_API_KEY`：DeepSeek API key.
- `DEEPSEEK_MODEL`：optional, default is `deepseek-v4-flash`.
- `AUTO_REFRESH_SECRET`：secret for protected daily refresh endpoint.
- `ADMIN_API_TOKEN`：separate token for backup, restore, and emergency administration.
- `TEAM_ACCESS_EMAILS`：comma-separated team emails allowed after Access verification.
- `CF_ACCESS_TEAM_DOMAIN`：Cloudflare Access team domain.
- `CF_ACCESS_AUD`：Cloudflare Access application audience tag.
- `ALLOWED_ORIGINS`：allowed browser origins; do not use `*`.
- `SITE_URL`：production site URL, `https://bijinihaitan.cn`.
- `ENABLE_LEGACY_WORKER_API`：leave `false` unless a reviewed legacy HTTP migration requires it.

Use `.env.example` only as a reference template.

## Workflow Data And Cloudflare Rollback

Tencent Production stores workflow data in FileKV. The Cloudflare `FAVORITES` KV namespace is retained as rollback data and must not receive routine Production writes while Tencent is active.

Important workflow fields:

- `words`
- `statuses`
- `feedback`
- `publishedRecords`
- `candidatePool`
- `aiBatches`
- `todaySnapshot`
- active `codex-draft:*` records and their reference images

Any server write must preserve all major fields, even if the current endpoint only edits one of them. Tencent writes are serialized by `LocalWorkflowCoordinator`; the retained Cloudflare stack uses the external `WORKFLOW_COORDINATOR` Durable Object when explicitly restored.

## Daily Refresh

The protected endpoint is:

```text
POST /daily-refresh
Authorization: Bearer <AUTO_REFRESH_SECRET>
```

The Tencent runtime calls this endpoint through its internal scheduler. Cloudflare cron is intentionally empty while Tencent is Production; any rollback schedule must be reviewed and enabled only after Tencent scheduling is disabled.

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
- See `docs/SYSTEM_HARDENING.md` for deployment order, coordinator verification, and rollback.

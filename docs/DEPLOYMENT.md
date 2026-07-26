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

The deploy command only accepts a clean working tree and a fast-forward update from reviewed GitHub `main`. It first checks the lightweight remote branch advertisement, which avoids downloading a Git pack when Production is already current. For a real update it tries the normal Git transport, an HTTP/1.1 path, and a conservative low-bandwidth path. If Git smart HTTP is still unavailable, it downloads and verifies the official bundle published by this repository's `Publish Tencent Deploy Bundle` workflow. It then rejects dependency-lock changes, builds and runs all quality checks outside the live directory, creates a complete workflow/image backup, swaps the built static artifact, restarts the runtime, and rolls back if the local health check fails. It does not use a third-party proxy, create a deploy key, or schedule future deployments.

The one-time transition from the former Production integration branch to `main` must be separately reviewed. On the first approved deployment after the reconciliation PR is merged, run the dry run with `--branch=main` explicitly and confirm the advertised full commit before applying. Subsequent versions of the deploy script default to `main`.

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
- `OPS_ALERT_WEBHOOK_URL`：optional HTTPS JSON webhook for daily-content failure and recovery alerts.
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

The daily path has two completion checks:

- 00:00 Asia/Shanghai promotion first tries the valid Codex draft, then runs DeepSeek inline as fallback. A queued or failed fallback is not success and leaves the scheduler marker retryable.
- 00:10 checks the current `todaySnapshot`; 17:15 checks the next-day Codex draft. Results are stored as `operations-health:daily:*` records, reported in `/healthz`, and sent to `OPS_ALERT_WEBHOOK_URL` when configured.

## Common Deployment Problems

### Wrangler authentication fails

Run the pinned local Wrangler through the project scripts:

```bash
npx wrangler login
```

Then retry deployment.

### Tencent deploy succeeds but UI looks old

Confirm Nginx is serving the new `dist/`, compare the deployed Git commit with the approved GitHub `main` commit, then hard refresh the browser. Browser JS and CSS are configured for revalidation.

### DeepSeek generation fails

Check that `DEEPSEEK_API_KEY` exists in `/etc/japanese-words.env`, then inspect the protected `/daily-refresh` run state and `journalctl -u japanese-words.service`.

### Daily refresh is unauthorized

Make sure `/etc/japanese-words.env` contains the same `AUTO_REFRESH_SECRET` used by the internal Tencent scheduler.

### Workflow fields disappear

Inspect `/favorites` and verify the response still includes `candidatePool`, `aiBatches`, `todaySnapshot`, and `publishedRecords`.

## Health And Recovery

- `GET /healthz` checks required bindings and exposes non-sensitive today-snapshot / tomorrow-draft monitor status.
- `npm run backup:workflow` creates a validated mode-`0600` backup and performs no write.
- `npm run restore:workflow -- <file>` is a dry run. A write additionally requires `--apply --confirm=RESTORE` and an up-to-date workflow revision.
- `node server/tencent-backup.mjs` creates a full workflow-key and reference-image state bundle. Restore bundles only to an isolated `--data-dir` during rehearsals.
- See `docs/SYSTEM_HARDENING.md` for deployment order, coordinator verification, and rollback.

# Tencent Cloud Migration

## Target Architecture

Production uses the existing Tencent Cloud Lighthouse instance in Beijing:

- Nginx serves the unchanged static build from `dist/`.
- The Node runtime in `server/tencent-runtime.mjs` dispatches the existing API paths to the existing Pages Function handlers.
- `FileKV` replaces Cloudflare KV with atomic, mode-`0600` files under `/var/lib/japanese-words`.
- `LocalWorkflowCoordinator` serializes workflow writes in the same process, preserving the existing revision, idempotency, and audit behavior.
- The same process runs the current Worker schedule and records daily run markers. Daily promotion and the 14:30 published refresh have restart catch-up protection.
- A systemd timer writes a validated workflow backup every day at 15:00 Asia/Shanghai.
- Cloudflare Pages, Worker, KV, and the coordinator remain unchanged during the rollback window.

The public API paths and browser storage keys do not change.

## Server Layout

```text
/opt/japanese-words/app             checked-out application
/etc/japanese-words.env             mode-0600 runtime configuration
/var/lib/japanese-words             workflow and reference-image storage
/var/backups/japanese-words         validated daily workflow backups
/etc/nginx/conf.d/japanese-words.conf
```

## First Install

Install Node.js 20 or newer, Git, and Nginx from the OpenCloudOS package repositories. Clone the reviewed branch to `/opt/japanese-words/app`, then run:

```bash
cd /opt/japanese-words/app
bash server/install-runtime.sh
```

The installer does not start the application. Replace every placeholder in `/etc/japanese-words.env` before enabling the service.

## Import Rehearsal And Apply

The importer is dry-run by default and refuses a write without both safeguards:

```bash
node server/import-cloudflare-backup.mjs /path/to/workflow.json \
  --copy-images \
  --images-origin=https://jiyimianbao.pages.dev

node server/import-cloudflare-backup.mjs /path/to/workflow.json \
  --copy-images \
  --images-origin=https://jiyimianbao.pages.dev \
  --apply --confirm=IMPORT
```

The workflow is written only after every requested reference image has copied successfully. Existing image keys are skipped, so repeating the import is safe.
When the production data directory is imported as `root`, the importer automatically restores ownership to the `japanese-words` service account before it exits. Use `--owner=<service-user>` only when a non-default service account is intentional.

## Pre-Cutover Validation

Keep `DISABLE_SCHEDULER=true` until the staging copy has passed all checks.

```bash
systemctl enable --now japanese-words.service
systemctl enable --now nginx
curl -H 'Host: bijinihaitan.cn' http://127.0.0.1/healthz
SITE_URL=http://127.0.0.1 npm run smoke:production
```

Before DNS changes:

1. Verify `/healthz`, `/favorites`, `/today-snapshot`, `/ai-cards`, and one `/codex-image` URL.
2. Verify the Daily Hot, Favorites, Candidate Pool, and Published pages on desktop and mobile.
3. Test one favorite add/remove cycle against the staging copy and confirm the revision increments once.
4. Restore the final Cloudflare backup into Tencent after the write test.
5. Confirm the Tencent workflow revision and counts match the final Cloudflare backup.

## Cutover

1. Point `@` and `www` at the Lighthouse public IPv4 address with a low TTL.
2. Issue one certificate for `bijinihaitan.cn` and `www.bijinihaitan.cn` through the dedicated ACME webroot, then switch Nginx to `server/nginx/japanese-words-https.conf`. Keep the ACME location active so renewals do not depend on application routes.
3. Set `DISABLE_SCHEDULER=false`, `SITE_URL=https://bijinihaitan.cn`, and the matching allowed origins.
4. Update `.env.codex-daily` so the 14:00/16:00/17:00 Codex task submits to `https://bijinihaitan.cn`.
5. Restart the application and run `SITE_URL=https://bijinihaitan.cn npm run smoke:production`.
6. Keep the Cloudflare Worker enabled only until the Tencent scheduler is confirmed. Do not let both schedulers run beyond the observation window.

## Rollback

1. Restore the previous DNS records or direct the domain to the Cloudflare Pages origin.
2. Set `DISABLE_SCHEDULER=true` on Tencent and restart the service.
3. Point `.env.codex-daily` back to `https://jiyimianbao.pages.dev`.
4. Keep all Tencent data files and backups; do not delete them during rollback.
5. Compare revisions before deciding whether a guarded data restore is needed.

Cloudflare resources must remain intact until the Tencent site has completed at least seven daily cycles.

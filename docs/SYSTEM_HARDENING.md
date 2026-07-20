# System Hardening Runbook

## Scope

This hardening keeps the static frontend, Pages Functions, scheduled Worker, existing API paths, and KV workflow model. It does not trigger production generation or migrate production data by itself.

## Required Configuration Before Deploy

The production site can run in one of two explicit modes:

- Public app mode: set `ALLOW_PUBLIC_APP=true`. Requests do not require team authentication, while cross-site browser writes remain blocked.
- Team mode: leave `ALLOW_PUBLIC_APP` unset/false and complete the Cloudflare Access configuration below.

1. For team mode, put the site or management routes behind Cloudflare Access.
2. Set `TEAM_ACCESS_EMAILS` in Pages to the comma-separated emails allowed by Access.
3. Set `CF_ACCESS_TEAM_DOMAIN` (for example `team.cloudflareaccess.com`) and the Access application's `CF_ACCESS_AUD`. Access assertions are rejected unless their signature, issuer, audience, expiry, and email all verify.
4. Set a separate `ADMIN_API_TOKEN` for CLI backup and emergency administration. Never expose it in frontend code.
5. Keep `AUTO_REFRESH_SECRET` identical in Pages and the scheduled Worker.
6. Set `ALLOWED_ORIGINS` and `SITE_URL` to the production Pages origin.
7. Leave `ENABLE_LEGACY_WORKER_API=false`. Scheduled cron does not need the legacy Worker HTTP API.

Without one of the accepted team credentials, protected endpoints fail closed with HTTP 401. Configure authentication before deploying the protected Functions.

`ALLOW_INSECURE_LOCAL_DEV=true` is accepted only for `localhost`, `127.0.0.1`, and `::1`. Never set it in preview or production.

## Schema Migration

Workflow schema version 2 adds:

- `revision`: optimistic concurrency version.
- `auditLog`: the latest 100 mutation events, including actor, time, action, revision, and non-sensitive before/after count summaries.

Reading a version 1 workflow supplies `revision=0` and an empty audit log. The first authenticated mutation writes version 2. Core workflow fields are unchanged and no standalone KV migration command is required.

Rollback to version 1 code preserves core data, but the next old-code save may drop `revision` and `auditLog`. Export a backup before rollback and avoid writes until the rollback decision is complete.

## Backup

Use an explicit endpoint and token:

```bash
WORKFLOW_ENDPOINT=https://example.pages.dev/favorites \
ADMIN_API_TOKEN=... \
npm run backup:workflow
```

Backups are written with mode `0600` under the gitignored `exports/workflow-backups` directory and include a SHA-256 digest in the command output.

When Production is intentionally running with `ALLOW_PUBLIC_APP=true`, a read-only backup may omit the token only with the explicit flag:

```bash
WORKFLOW_ENDPOINT=https://example.pages.dev/favorites npm run backup:workflow -- --public-read
```

This flag changes only the GET authentication header; it does not enable restore or any write.

## Restore

Restore is dry-run by default:

```bash
WORKFLOW_ENDPOINT=https://example.pages.dev/favorites \
ADMIN_API_TOKEN=... \
npm run restore:workflow -- exports/workflow-backups/workflow-example.json
```

After reviewing counts, apply with both safeguards:

```bash
npm run restore:workflow -- exports/workflow-backups/workflow-example.json --apply --confirm=RESTORE
```

The restore sends the current revision and a unique operation ID. A concurrent update returns HTTP 409 instead of being overwritten.

## Deployment Order

1. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
2. Export and inspect a workflow backup.
3. Configure Cloudflare Access and Pages variables before deploying code.
4. Deploy the coordinator with `npm run deploy:coordinator` and verify the exported `WorkflowCoordinator` binding exists.
5. Deploy Pages and verify `/healthz` reports `workflowCoordinatorConfigured=true`, then check authenticated `/favorites` and a read-only `/ai-cards` request.
6. Deploy the Worker and verify `/healthz` reports `scheduledOnly=true`.
7. Observe request errors and cron results before approving any generation call.

## Rollback

1. Roll Pages back to the previous successful deployment.
2. Roll the Worker back to its previous version if Worker code was deployed.
3. Keep the coordinator deployed while either Pages or Worker still references it; roll it back only after both callers have been rolled back.
4. Do not clear KV.
5. Compare current workflow counts and revision with the pre-deployment backup.
6. Use the guarded restore only when data actually differs and the restore preview is correct.

## Serialized Workflow Writes

Pages Functions and the scheduled Worker route workflow mutations through one Durable Object instance per workflow key. The coordinator queues each read/validate/write cycle, so two requests with the same expected revision cannot both commit. KV remains the source of truth and no workflow migration or KV cleanup is required. If the binding is absent in local tests, the shared mutation helper keeps a direct fallback; production `/healthz` and the smoke test fail when the binding is missing.

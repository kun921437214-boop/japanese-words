# Frontend Refactor Plan

## Goal

Reduce `app.js` risk through small, behavior-preserving extractions. Keep the static frontend, Cloudflare Pages Functions, existing API routes, localStorage keys, and KV workflow schema compatible throughout the migration.

## Completed: Phase 1 — Sync Safety Foundation

- `frontend/api-client.mjs` owns request timeout, cancellation, workflow mutation headers, API errors, and duplicate UI-operation locks.
- `frontend/workflow-sync.mjs` owns workflow read retries and favorite mutation reconciliation after revision conflicts.
- `frontend/workflow-cache.mjs` owns compact local cache writes and quota-error containment.
- Daily and historical snapshot cleaning/merging uses `shared/workflow-schema.mjs` as the browser/server source of truth.
- `app.js` is now an ES module. Existing inline handlers remain available through one temporary `window` compatibility facade.
- `scripts/test-frontend-modules.mjs` executes the extracted infrastructure instead of relying only on source-string checks.

## Completed: Phase 2 — Workflow Store

- `frontend/workflow-store.mjs` owns workflow revision and audit-log metadata.
- Scoped page loads use one registry for loaded state and concurrent-request deduplication.
- Remote scoped responses are revision-gated and merge partial candidate/history data in one place.
- Local-cache and cloud-save payloads are built through one stable field allowlist.
- Favorite command responses update revision and audit metadata through the store.

## Next: Phase 3 — Page Modules

Extract one page at a time:

1. Favorites / Topic Pool;
2. Published Records;
3. Daily Recommendations and history;
4. shared word-card rendering.

Remove inline HTML handlers only after the corresponding page module has executable interaction tests.

## Required Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Also verify Daily Recommendations, Favorites, and Published Records in a real browser before deployment.

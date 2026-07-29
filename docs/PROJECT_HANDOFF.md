# Project Handoff

## Project Goal

`japanese-words` is a Xiaohongshu Japanese topic-selection backend. It helps operators discover useful Japanese expressions, collect human-approved ideas, generate DeepSeek word cards, and use published-performance feedback to improve future recommendations.

The project is intentionally not a general dictionary. It prioritizes words that can become Xiaohongshu posts: high context value, clear visual angle, natural title potential, and good save/share potential.

## Current Completion Status

Completed:

- Static frontend with Daily Hot, Favorites / Topic Pool, AI Candidate Pool, Published Records, and Settings.
- Tencent Cloud Production runtime serving the existing API paths through Nginx, Node, FileKV, and `LocalWorkflowCoordinator`.
- Cloudflare Pages, Worker, KV, and coordinator retained as an inactive rollback stack.
- DeepSeek candidate generation and word-card generation.
- Codex weekly planning, per-day draft/card/image checkpoints, next-week verification, and midnight-promotion pipeline.
- Candidate Pool with AI metadata, buckets, risks, confidence, review state, and `aiCard`.
- Team workflow schema and merge rules through `shared/workflow-schema.mjs`.
- Daily snapshot workflow for stable daily recommendations.
- Recent-history dedupe for Daily Hot generation.
- Account-learning context through `account-intelligence/xhs-account-learning-report.md`.
- Manual word add into Favorites with candidatePool persistence.
- Guarded Tencent deployment with test, build, backup, health check, rollback, and verified GitHub bundle fallback.
- Playwright browser E2E plus workflow, frontend, hardening, Codex, and Tencent runtime tests.
- Complete Tencent state bundles containing workflow keys, Codex drafts, and reference images.

## Current Unfinished Work

- Full two-browser team sync should still be manually regression-tested after major changes.
- DeepSeek output quality still needs periodic prompt tuning based on published performance.
- `app.js` remains large; continue behavior-preserving extraction in small changes backed by browser E2E.
- Configure `OPS_ALERT_WEBHOOK_URL` on Production if an external daily-content alert destination is available.
- Perform and record periodic isolated restore drills; a healthy backup timer alone is not restore proof.
- Keep the account-learning report synchronized with mature Published performance signals.

## Core Business Logic

1. DeepSeek and ranking logic discover candidates.
2. Daily Hot is a system recommendation surface, not the final publishing list.
3. Human favorite action moves a word into Favorites / Topic Pool.
4. Pending / Published states represent publishing workflow.
5. Published Records capture performance and review notes.
6. Feedback should improve future recommendations.
7. Formal word-card content must come from DeepSeek `aiCard`, not local templates.

## Key Files

- `index.html`：static page shell.
- `styles.css`：application styles.
- `app.js`：frontend state, rendering, team workflow actions.
- `functions/favorites.js`：workflow read/write handler used by Tencent FileKV and the Cloudflare rollback stack.
- `functions/ai-candidates.js`：DeepSeek API gateway.
- `functions/today-snapshot.js`：server-side daily snapshot generation.
- `functions/daily-refresh.js`：protected daily refresh endpoint.
- `shared/workflow-schema.mjs`：workflow clean/merge schema.
- `shared/today-snapshot.mjs`：daily recommendation selection logic.
- `shared/account-learning.mjs`：account-learning helper.
- `scripts/build-words-data.mjs`：historical seed data build.
- `scripts/test-workflow-schema.mjs`：workflow smoke tests.
- `worker/favorites-worker.js`：shared scheduled jobs, including daily promotion, fallback, cards, and daily operation health checks.
- `server/tencent-runtime.mjs`：Production API runtime and scheduler.
- `server/tencent-backup.mjs`：complete Production state-bundle backup.

## Current Run Method

Local:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Production deploys only from reviewed GitHub `main`, only after explicit approval:

```bash
cd /opt/japanese-words/app
npm run deploy:tencent -- --dry-run
npm run deploy:tencent -- --confirm=DEPLOY
```

Production site: `https://bijinihaitan.cn`.

## Known Bugs / Risks

- DeepSeek calls can timeout or return malformed JSON; the backend has retry/structured error handling but prompt size still matters.
- A midnight Codex miss falls back to DeepSeek; the fallback must complete before the scheduler records success.
- Daily health records are persisted in FileKV. External notification additionally requires `OPS_ALERT_WEBHOOK_URL`.
- Team workflow data is valuable; always avoid partial writes that drop `candidatePool`, `aiBatches`, `todaySnapshot`, `publishedRecords`, or `aiCard`.
- `app.js` is still large; continue extracting tested domain services in small increments and run browser E2E after frontend changes.

## Next Recommendations

P0:

- Keep the daily 13:20 published-data sync and current-snapshot monitor healthy so Monday generation can consume fresh feedback.
- Keep the Monday 14:30 next-week generation and Tuesday-to-Sunday 14:40 full-week verification/recovery tasks healthy. Once a week verifies successfully, later checks that week must stop at the local marker without touching Production.
- Keep the Tencent runtime's internal 00:10 current-snapshot and 17:15 next-day-draft health records healthy as a separate service-side safety net.
- Investigate every `scheduled_failure` or `operations-health:daily:*` unhealthy record; do not treat an accepted background request as completion.
- Keep the Playwright browser E2E fixture aligned with Daily Hot, Favorites, Published, backup, and conflict behavior.

P1:

- Split large frontend rendering functions gradually without changing behavior.
- Run an isolated restore drill after backup-format or storage changes.

P2:

- Add analytics around DeepSeek prompt versions and published performance.
- Add reviewed admin tools only when a concrete workflow need appears; do not expose destructive candidatePool cleanup casually.

## Areas Not To Modify Casually

- `shared/workflow-schema.mjs`
- `shared/today-snapshot.mjs`
- `functions/favorites.js`
- `functions/ai-candidates.js`
- `app.js` persistence and sync paths
- `data/words-data.json` without running `npm run build:words`

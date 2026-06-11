# Changelog

## Current Stable Snapshot

### Project handoff structure

- Added GitHub-ready documentation and sanitized sample-data structure.
- Added `.gitignore` and `.env.example` to avoid committing secrets, temp files, Wrangler logs, and private data.
- Reason: prepare the project for unified GitHub management.
- Remaining: connect repository to GitHub and maintain feature branches after this handoff.

### DeepSeek candidate workflow

- Added DeepSeek candidate generation, extraction, enrichment, rerank, and word-card actions.
- Main files: `functions/ai-candidates.js`, `app.js`, `shared/workflow-schema.mjs`.
- Reason: AI should generate candidates and formal word cards without exposing API keys in the browser.
- Remaining: continue prompt tuning based on account performance.

### Candidate Pool and Daily Hot

- Added candidatePool as the system candidate source.
- Added Daily Hot snapshots so daily recommendations stay fixed.
- Added recent-history dedupe and account-learning guidance.
- Main files: `app.js`, `shared/today-snapshot.mjs`, `functions/today-snapshot.js`.
- Reason: avoid unstable homepage changes and repeated old words.
- Remaining: keep monitoring quality and duplicate rates.

### Team workflow data safety

- Added shared workflow clean/merge logic to preserve fields such as `candidatePool`, `aiBatches`, `todaySnapshot`, and `publishedRecords`.
- Main files: `shared/workflow-schema.mjs`, `functions/favorites.js`, `worker/favorites-worker.js`, `scripts/test-workflow-schema.mjs`.
- Reason: prevent partial saves from losing AI cards or daily snapshots.
- Remaining: add browser-level regression tests.

### DeepSeek-only formal word cards

- Updated detail behavior so formal word-card content must come from `aiCard.ready`.
- Main files: `app.js`, `functions/ai-candidates.js`.
- Reason: avoid local template text being mistaken as real DeepSeek content.
- Remaining: add batch card generation progress UI if needed.

### Manual word add and favorite behavior

- Manual added words now persist in candidatePool and Favorites.
- Canceling favorite no longer deletes the candidatePool entry.
- Main files: `app.js`, `scripts/test-workflow-schema.mjs`.
- Reason: manual additions should survive refresh and remain available for DeepSeek card generation.
- Remaining: manual QA across two browser profiles.

### Cloudflare deployment and scheduled refresh

- Added deploy scripts and protected daily refresh flow.
- Main files: `scripts/deploy-pages.mjs`, `wrangler.worker.toml`, `worker/favorites-worker.js`, `functions/daily-refresh.js`.
- Reason: automate daily recommendations without opening the page manually.
- Remaining: verify cron logs after each environment change.

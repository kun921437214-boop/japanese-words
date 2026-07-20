# Project Handoff

## Project Goal

`japanese-words` is a Xiaohongshu Japanese topic-selection backend. It helps operators discover useful Japanese expressions, collect human-approved ideas, generate DeepSeek word cards, and use published-performance feedback to improve future recommendations.

The project is intentionally not a general dictionary. It prioritizes words that can become Xiaohongshu posts: high context value, clear visual angle, natural title potential, and good save/share potential.

## Current Completion Status

Completed:

- Static frontend with Daily Hot, Favorites / Topic Pool, AI Candidate Pool, Published Records, and Settings.
- Cloudflare Pages Functions for workflow sync, AI candidates, daily snapshot, ranking, and published refresh.
- DeepSeek candidate generation and word-card generation.
- Candidate Pool with AI metadata, buckets, risks, confidence, review state, and `aiCard`.
- Team workflow schema and merge rules through `shared/workflow-schema.mjs`.
- Daily snapshot workflow for stable daily recommendations.
- Recent-history dedupe for Daily Hot generation.
- Account-learning context through `account-intelligence/xhs-account-learning-report.md`.
- Manual word add into Favorites with candidatePool persistence.
- Deployment scripts for Cloudflare Pages and scheduled Worker.

## Current Unfinished Work

- Full two-browser team sync should still be manually regression-tested after major changes.
- DeepSeek output quality still needs periodic prompt tuning based on published performance.
- Some older compatibility functions remain in `app.js`; avoid large refactors until product behavior is stable.
- No full browser automation test suite exists yet.

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
- `functions/favorites.js`：Cloudflare KV workflow read/write.
- `functions/ai-candidates.js`：DeepSeek API gateway.
- `functions/today-snapshot.js`：server-side daily snapshot generation.
- `functions/daily-refresh.js`：protected daily refresh endpoint.
- `shared/workflow-schema.mjs`：workflow clean/merge schema.
- `shared/today-snapshot.mjs`：daily recommendation selection logic.
- `shared/account-learning.mjs`：account-learning helper.
- `scripts/build-words-data.mjs`：historical seed data build.
- `scripts/test-workflow-schema.mjs`：workflow smoke tests.
- `worker/favorites-worker.js`：scheduled refresh Worker.

## Current Run Method

Local:

```bash
npm install
npm run build:words
```

Open `index.html` directly or serve the project root with a static file server.

Production:

```bash
npm run deploy:coordinator
npm run deploy
npm run deploy:worker
```

Production site currently uses Cloudflare Pages at `https://jiyimianbao.pages.dev`.

## Known Bugs / Risks

- DeepSeek calls can timeout or return malformed JSON; the backend has retry/structured error handling but prompt size still matters.
- Cloudflare CLI deploy depends on local Wrangler authentication.
- Team workflow data is valuable; always avoid partial writes that drop `candidatePool`, `aiBatches`, `todaySnapshot`, `publishedRecords`, or `aiCard`.
- `app.js` is still large; continue extracting tested domain services in small increments and run browser E2E after frontend changes.

## Next Recommendations

P0:

- Keep validating team sync after favorites, manual add, card generation, and published-record updates.
- Keep the Playwright browser E2E fixture aligned with Daily Hot, Favorites, backup, and conflict behavior.

P1:

- Split large frontend rendering functions gradually without changing behavior.
- Add workflow backup import/restore UI.

P2:

- Add analytics around DeepSeek prompt versions and published performance.
- Add safer admin tools for cleaning candidatePool.

## Areas Not To Modify Casually

- `shared/workflow-schema.mjs`
- `shared/today-snapshot.mjs`
- `functions/favorites.js`
- `functions/ai-candidates.js`
- `app.js` persistence and sync paths
- `data/words-data.json` without running `npm run build:words`

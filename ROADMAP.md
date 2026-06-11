# Roadmap

## P0

### Strengthen team data safety

- What: add stronger backup/import UI for full workflow JSON.
- Why: team workflow is now the source of truth and must be recoverable.
- Files: `app.js`, `shared/workflow-schema.mjs`, `docs/DATA_RULES.md`.
- Acceptance: user can export and restore workflow without losing `aiCard`, `todaySnapshot`, or `publishedRecords`.

### Add browser smoke tests

- What: automate a few core UI checks.
- Why: large `app.js` changes can accidentally break Daily Hot or Favorites.
- Files: new test scripts, `package.json`.
- Acceptance: one command verifies Daily Hot renders, Favorites renders, and detail modal opens.

### Verify two-person team sync

- What: manual or automated test with two browser profiles.
- Why: the backend is now team shared.
- Files: `docs/TEST_REPORT.md`, possibly browser test scripts.
- Acceptance: A's favorite, card generation, and published record changes appear for B after refresh.

## P1

### Split frontend modules gradually

- What: move isolated helpers out of `app.js` without changing behavior.
- Why: reduce risk when editing rendering or workflow logic.
- Files: `app.js`, future `src/` modules.
- Acceptance: no UI behavior change and all smoke tests pass.

### Improve DeepSeek prompt version tracking

- What: persist prompt version and account-learning summary in aiBatches.
- Why: easier to debug recommendation quality.
- Files: `functions/ai-candidates.js`, `shared/account-learning.mjs`, `shared/workflow-schema.mjs`.
- Acceptance: every AI batch records prompt version, action, model, and summary.

### Candidate Pool admin cleanup

- What: add safer tools for duplicate cleanup and blocked/review management.
- Why: keep the candidate pool useful as it grows.
- Files: `app.js`, `styles.css`, `shared/workflow-schema.mjs`.
- Acceptance: admin can filter, review, hide, or keep candidates without data loss.

## P2

### Published performance analytics

- What: show save rate, engagement rate, and follow-up recommendation notes.
- Why: account learning should be based on saves and engagement, not only views.
- Files: `app.js`, `shared/published-refresh.mjs`, `docs/DATA_RULES.md`.
- Acceptance: each published record can influence future scoring transparently.

### Better historical snapshot reports

- What: compare Daily Hot snapshots by date and show repeat/selection rates.
- Why: reduce repeated and weak recommendations.
- Files: `app.js`, `shared/today-snapshot.mjs`.
- Acceptance: user can see what was recommended, favorited, skipped, and published per date.

## Later

### Optional API-backed auth

- What: add simple team login if the tool grows beyond a trusted private backend.
- Why: protect team workflow and DeepSeek usage.
- Files: Cloudflare Functions / Worker.
- Acceptance: unauthorized users cannot read or mutate workflow.

### Rich draft generation

- What: generate Xiaohongshu draft outlines from ready `aiCard`.
- Why: shorten production time after human topic selection.
- Files: `functions/ai-candidates.js`, `app.js`.
- Acceptance: generated drafts use only ready DeepSeek cards and never local templates.

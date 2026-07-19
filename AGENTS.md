# AGENTS.md

## Project Role

This project is a Xiaohongshu Japanese topic-selection backend.

It is not a general Japanese dictionary and not a final publishing system. Daily Recommendations discover possible topics; Favorites / Topic Pool are the human selection step; Published Records provide feedback for future ranking.

Before changing Daily Recommendations, Favorites / Topic Pool, AI Candidate Pool, manual word add, DeepSeek word cards, Xiaohongshu draft generation, Published Records / Review, account-learning reports, recommendation scoring, title generation, or cover suggestions, read:

- `account-intelligence/xhs-account-learning-report.md`
- `docs/DATA_RULES.md`
- `shared/workflow-schema.mjs`

## Current Structure

- `index.html`：static frontend entry
- `styles.css`：UI styles
- `app.js`：main browser logic
- `functions/`：Cloudflare Pages Functions
- `shared/`：shared schema, scoring, ranking, snapshot logic
- `worker/`：scheduled Cloudflare Worker
- `data/`：historical seed data and DeepSeek review records
- `scripts/`：build, deploy, audit, and smoke-test scripts
- `account-intelligence/`：account learning report
- `docs/`：handoff, deployment, test, and data rules
- `sample_data/`：sanitized examples only

## Commands

```bash
npm run build:words
npm run build
npm run test:workflow
npm run deploy
npm run deploy:worker
```

## Core Product Logic

1. Daily Recommendations are not the final publishing pool.
2. Favorites are the human filtering step.
3. Favorites / Topic Pool represent words the user may actually publish.
4. Published Records should feed back into future recommendation ranking.
5. Candidate Pool is a system-side potential topic pool, not the final human-approved publishing list.
6. Do not optimize only for views; save rate and engagement rate are stronger signals for this account.
7. DeepSeek word cards must serve Xiaohongshu content creation, not ordinary dictionary explanation.
8. Do not push words that are too basic, too textbook-like, too niche, hard to visualize, high risk, unstable, or generic topic labels into Daily Recommendations.
9. Do not change the existing `aiCard` structure when adding account-learning context.
10. Preserve localStorage and Cloudflare sync compatibility for major changes.

## Data Rules

- `data/words-data.json` is historical seed data, not the formal production word-card source.
- `candidatePool` is the current unified candidate pool.
- `candidatePool[kanji].aiCard` is the formal word-card content source.
- A word without `aiCard.cardStatus === "ready"` must not display local template content as a formal card.
- User actions such as favorite, pending, published, skip, manual keep, and review notes are team workflow data.
- Do not silently merge old local personal data into team workflow.

## Must Preserve

- Static frontend + Cloudflare Pages Functions architecture.
- Existing localStorage keys unless a migration is provided:
  - `kotoba_favorites`
  - `kotoba_favorite_statuses`
  - `kotoba_workflow_state_v2`
  - `kotoba_ai_preview_state`
- Existing API paths:
  - `/favorites`
  - `/published-refresh`
  - `/today-snapshot`
  - `/ai-candidates`
  - `/daily-refresh`
- `npm run build:words` must keep generating `words-data.js` and `shared/words-data.mjs`.

## Development Rules

- Prefer small, incremental changes.
- Do not rewrite the whole app unless explicitly requested.
- Do not modify unrelated files.
- Do not introduce React, Next.js, or a new frontend build system unless explicitly requested.
- Do not expose `DEEPSEEK_API_KEY` or `AUTO_REFRESH_SECRET` in frontend code.
- Do not bypass login, CAPTCHA, anti-bot systems, or platform restrictions.
- For Xiaohongshu, Douyin, Weibo, or similar platforms, prefer manual import, official APIs, or compliant third-party data providers.
- All automatically imported trend words should enter a reviewable pool first and should not be treated as final publishing choices.

## GitHub Workflow

- Treat GitHub as the primary source of truth and the local working copy as a backup.
- After each completed change passes the relevant validation, commit all intended project files and push them to GitHub automatically.
- Use a `codex/*` branch and a pull request by default; do not push unfinished or unverified work directly to `main`.
- Before uploading, compare the complete local branch and working tree with the latest remote state so that earlier unpushed changes are not omitted.
- Never commit secrets, local environment files, private exports, generated credentials, or production data that is intentionally excluded by `.gitignore`.
- A GitHub push does not authorize a production deployment; deploy only when the user explicitly requests it or the current task clearly includes deployment.

## Validation After Changes

At minimum, check:

1. Homepage / Daily Recommendations loads.
2. Favorites / Topic Pool still works.
3. Candidate Pool still works.
4. Published Records still works.
5. DeepSeek card generation path still returns compatible JSON.
6. Cloudflare workflow data does not lose `candidatePool`, `aiBatches`, `todaySnapshot`, or `aiCard`.
7. `npm run build:words` still succeeds.
8. `npm run test:workflow` still succeeds when schema logic is touched.

## Completion Standard

After each change, summarize:

- Modified files.
- What was changed.
- What was verified.
- Whether production was deployed.
- Any remaining risk or manual test step.

# AGENTS.md

## Project Role

This project is a Japanese word and content-idea discovery tool for Xiaohongshu operations.

It is not a general Japanese dictionary and not a final publishing system.

It is a Xiaohongshu Japanese topic-selection backend. Before changing Daily Recommendations, Favorites / Topic Pool, AI Candidate Pool, manual word add, DeepSeek word cards, Xiaohongshu draft generation, Published Records / Review, account-learning reports, recommendation scoring, title generation, or cover suggestions, read:

`account-intelligence/xhs-account-learning-report.md`

## Core Product Logic

- Daily Recommendations = system discovery of potentially useful hot Japanese words.
- Favorites / Topic Pool = human selection.
- Published Records = performance review and feedback.
- The user chooses Xiaohongshu topics from Favorites / Topic Pool, not directly from Daily Recommendations.

## Must Preserve

When modifying this project, preserve the following logic:

1. Daily Recommendations are not the final publishing pool.
2. Favorites are the human filtering step.
3. Favorites / Topic Pool represent words the user may actually publish.
4. Published Records should feed back into future recommendation ranking.
5. Candidate Pool is a system-side potential topic pool, not the final human-approved publishing list.
6. Do not optimize only for views; save rate and engagement rate are stronger signals for this account.
7. DeepSeek word cards must serve Xiaohongshu content creation, not ordinary dictionary explanation.
8. Do not push words that are too basic, too textbook-like, too niche, hard to visualize, high risk, or unstable into the homepage.
9. Do not change the existing aiCard structure when adding account-learning context; use the report only as context and scoring reference.
10. Preserve existing localStorage and Cloudflare sync compatibility for major changes.

## Development Rules

- Do not modify unrelated files.
- Do not rewrite the whole app unless explicitly requested.
- Keep the current static frontend + Cloudflare Pages Functions structure unless explicitly requested.
- Preserve existing localStorage keys and data formats unless a migration is provided.
- Preserve existing API response shapes unless a migration is provided.
- Do not break index.html, app.js, styles.css, words-data.js, shared/words-data.mjs, or functions compatibility.
- If adding a new data source, do not bypass login, CAPTCHA, anti-bot systems, or platform restrictions.
- For Xiaohongshu, Douyin, Weibo, or similar platforms, prefer manual import, official APIs, or compliant third-party data providers.
- All automatically imported trend words should enter a reviewable pool first and should not be treated as final publishing choices.
- Prefer small, incremental changes.
- After each change, summarize modified files and manual test steps.

## Preferred Next Architecture Direction

The word database should eventually become a single source of truth:

data/words-data.json
↓
scripts/build-words-data.mjs
↓
words-data.js
shared/words-data.mjs

Humans should only maintain data/words-data.json.

## Testing Expectations

After making changes, always check:

1. Homepage loads correctly.
2. Daily recommendations render.
3. Favorites still work.
4. Candidate pool still works.
5. Published records still work.
6. Cloudflare Functions still return compatible JSON.
7. Existing localStorage data does not disappear.

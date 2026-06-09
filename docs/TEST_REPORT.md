# Test Report

## Tested Commands

Run these after each meaningful change:

```bash
node --check app.js
node --check functions/ai-candidates.js
node --check shared/workflow-schema.mjs
npm run test:workflow
npm run build:words
```

## Tested Functional Areas

- Daily Hot page renders today and historical recommendations.
- Favorites / Topic Pool renders team-selected words.
- Manual word add persists through candidatePool and workflow sync.
- Candidate Pool keeps DeepSeek metadata and `aiCard`.
- Published Records preserve review and performance fields.
- Workflow clean/merge keeps `candidatePool`, `aiBatches`, `todaySnapshot`, and `aiCard`.
- `build:words` regenerates `words-data.js` and `shared/words-data.mjs`.

## Manual Test Steps

1. Open the production or local page.
2. Check Daily Hot loads.
3. Switch a historical date in Daily Hot.
4. Favorite a word and confirm it appears in Favorites.
5. Add a manual word in Favorites and refresh.
6. Generate a DeepSeek word card and refresh.
7. Mark a favorite as pending.
8. Add or edit a Published Record.
9. Refresh and verify data remains.
10. Open another browser profile and confirm team workflow consistency.

## Current Result

The project has lightweight Node smoke tests and build checks. Full browser automation is not yet implemented.

## Untested / Needs Manual Verification

- Live DeepSeek output quality for every prompt mode.
- Full two-person simultaneous editing conflict behavior.
- Cloudflare scheduled Worker execution at the configured cron time.
- Production KV backup/restore after large workflow changes.

## Known Failure Items

- Wrangler deployment fails if local Cloudflare authentication is expired.
- DeepSeek may timeout on large batch prompts; use smaller batches or retry queue logic.
- Browser cache can make the production page look stale; hard refresh when checking recently deployed UI.

## Reproduction Notes

If team data appears missing:

1. Check `/favorites` response first.
2. Confirm localStorage is only a cache, not the source of truth.
3. Export full workflow backup from Settings if available.
4. Compare `candidatePool`, `todaySnapshot`, `aiBatches`, and `publishedRecords`.

# Japanese Words PR #1 Handoff: Daily Hot Quality Gate

Updated: 2026-06-20

## Current PR

- Repository: `kun921437214-boop/japanese-words`
- PR: https://github.com/kun921437214-boop/japanese-words/pull/1
- Branch: `fix/daily-hot-quality-gate-pr`
- Base: `main`
- Latest branch commit at handoff: `cd71424 fix: improve DeepSeek candidate novelty for daily refresh`
- Status: PR is open and must not be merged yet.

Resume locally:

```bash
git clone git@github.com:kun921437214-boop/japanese-words.git
cd japanese-words
git fetch origin
git checkout fix/daily-hot-quality-gate-pr
git log --oneline -10
```

## Why This PR Exists

This PR fixes instability in Daily Hot recommendations and DeepSeek candidate supply.

The original audit found that the main issue was not simply "DeepSeek cannot find words". The bigger problems were:

- Backfill rules were too broad.
- Manual or protected words did not have an independent homepage admission gate.
- S/A recommendation levels were too loose.
- When candidates were insufficient, old or low-quality words were forced onto the homepage.

Examples of words that should not dominate Daily Hot as strong homepage recommendations:

```text
通勤、睡眠、免疫力、デート、入浴、グッズ、コスプレ
```

## Completed Fixes

Implemented on the PR branch:

- Tightened Daily Hot homepage admission.
- Tightened backfill rules so low-quality or generic topic words are not forced into Daily Hot.
- Required manual and protected words to pass homepage admission before appearing on the homepage.
- Tightened S/A recommendation grading.
- Kept Daily Hot `targetCount = 20`.
- When candidates are insufficient, DeepSeek top-up is used instead of hard-filling with weak old words.
- DeepSeek top-up results must pass the same homepage admission gate.
- `sync-config.js` now defaults to the current origin so Preview does not call the production domain.
- Preview Pages KV binding was separated from Production.
- `preview-test` mode max candidate count was raised to 50 for controlled Preview validation only.
- Added progress and stale-run handling for daily refresh.
- Made Preview daily refresh run inline so the flow is observable in Preview.
- Improved DeepSeek novelty prompt/exclusion context so generated candidates avoid:
  - recent 30-day history words
  - selected today words
  - current batch words
  - favorites / pending / published words
  - protected words
  - recent candidate-pool collision words
- Added or improved novelty audit metrics:
  - `generatedUniqueCount`
  - `importedUniqueCount`
  - `recentHistoryRejectedCount`
  - `favoriteProtectedRejectedCount`
  - `currentBatchDuplicateRejectedCount`
  - `reviewRejectedCount`
  - `duplicateRate`
  - `historyCollisionRate`
- Kept `aiCard` structure unchanged.
- Kept Cloudflare API paths unchanged.
- Kept localStorage keys unchanged.

## Latest Commit Chain

Important recent commits:

```text
cd71424 fix: improve DeepSeek candidate novelty for daily refresh
7ca4d22 test: allow larger preview daily refresh count
2a74362 fix: bind preview pages kv namespace
fcd227b fix: run preview daily refresh inline
4503462 fix: add daily refresh progress and stale-run handling
08d6975 fix: use current origin for sync config
822048a fix: tighten daily hot quality gate
54b02fa chore: prepare project handoff and github structure
```

## Local Validation Passed

The following validation passed after the latest code changes:

```bash
npm run test:workflow
npm run build:words
npm run build

node --check app.js
node --check functions/daily-refresh.js
node --check functions/today-snapshot.js
node --check functions/ai-candidates.js
node --check shared/today-snapshot.mjs
node --check shared/workflow-schema.mjs
node --check shared/deepseek-exclusion.mjs
node --check scripts/test-workflow-schema.mjs
git diff --check
```

## Preview Environment State

Cloudflare Pages project:

```text
jiyimianbao
```

Latest Preview deployment checked before handoff:

```text
https://7ee5e40b.jiyimianbao.pages.dev
```

Preview alias:

```text
https://fix-daily-hot-quality-gate-p.jiyimianbao.pages.dev
```

Preview branch and commit:

```text
fix/daily-hot-quality-gate-pr
cd71424
```

Preview KV binding was confirmed separate from Production earlier in the validation flow:

```text
Preview FAVORITES namespace: d4d4852d9be04115830789aaffbf4aca
Production FAVORITES namespace: 969904de6cf24fe6982d2b8ee01c9b1a
```

Latest safe Preview data state before handoff:

```text
Preview todaySnapshot: empty today words after clearing only the current-day snapshot state
Preview candidateCount: 378
Preview favoriteCount: 25
Preview publishedCount: 0
```

Current Preview blocker:

```text
GET /daily-refresh?date=2026-06-19 still returns 401 Unauthorized.
```

This means `AUTO_REFRESH_SECRET` authentication is not aligned between the request and the active Preview deployment. The workflow is not entered when this 401 occurs, so DeepSeek is not called.

Code-auth facts from `functions/daily-refresh.js`:

```text
Environment variable name: AUTO_REFRESH_SECRET
Required request header: Authorization
Required format: Bearer <secret>
Other auth headers: not supported
GET and POST both require the same auth gate
```

Cloudflare secret entry must contain only the raw secret value:

```text
Do not include "Bearer".
Do not add quotes.
Do not add leading/trailing spaces.
Do not add a newline.
Do not reuse the Production secret.
```

## Production Environment State

Production site:

```text
https://jiyimianbao.pages.dev
```

Production state checked during Preview validation:

```text
Production todaySnapshot dateKey: 2026-06-13
Production todayCount: 13
Production candidateCount: 370
Production favoriteCount: 25
Production publishedCount: 0
Production KV key count: 78
Production codex-preview* keys: 0
```

Production was not deployed during this work. Production KV was not intentionally written during the Preview tests.

## Current Blocker

Do not continue recommendation tuning yet.

The current blocker is:

```text
Preview AUTO_REFRESH_SECRET authentication still does not match.
```

The next safe action is to fix Preview auth before running another flow test.

Recommended next sequence:

```text
1. Rotate the Preview-only AUTO_REFRESH_SECRET in Cloudflare.
2. Store only the raw secret value in Cloudflare Preview environment variables.
3. Trigger a Preview-only redeploy for fix/daily-hot-quality-gate-pr.
4. Use hidden input or another non-logged method to provide the secret locally.
5. Run only GET https://<new-preview>/daily-refresh?date=2026-06-19 with Authorization: Bearer <secret>.
6. If GET returns 200, stop and record that auth is fixed.
7. Only after explicit approval, run one count=30 Preview test:
   POST /daily-refresh?mode=preview-test&count=30&skipCards=true&maxTopUpRounds=1
```

Do not POST `/daily-refresh` while GET auth is still 401.

## Preview Test History

Important results:

- Preview small-flow test eventually completed after inline Preview refresh fixes.
- Before the novelty fix, a medium `count=30` Preview test completed but still produced only 6 Daily Hot words.
- That medium test showed:
  - `generatedCandidates: 57`
  - `generatedUniqueCount: 37`
  - `importedCandidates: 47`
  - `importedUniqueCount: 31`
  - `todayCount: 6`
  - low-quality words: 0
  - generic topic words: 0
  - Production not polluted
- Diagnosis from that test:
  - Quality gate behaved correctly.
  - Candidate novelty was insufficient.
  - Many generated words collided with recent 30-day history, favorites, protected words, or review buckets.
- After this, commit `cd71424` improved DeepSeek novelty/exclusion prompts and audit metrics.
- The improved novelty code has not yet been validated in a successful `count=30` Preview POST because Preview auth is currently returning 401.

## Do Not Do These Without Explicit Approval

Do not:

- merge PR #1
- deploy Production
- run `npm run deploy`
- run `npm run deploy:worker`
- POST `/daily-refresh`
- call DeepSeek
- clear Production KV
- clear Preview KV beyond explicitly approved current-day state
- loosen homepage quality gates
- loosen 30-day dedup
- change `aiCard` structure
- change Cloudflare API paths
- change localStorage keys
- commit `.env`, `.env.local`, `.wrangler/`, `node_modules/`, `dist/`, `local-audit-reports/`, API keys, Cloudflare tokens, DeepSeek keys, or refresh secrets

## Merge Readiness Criteria

Only recommend merge after all are true:

- PR diff is clean and intentional.
- Local validation passes.
- Preview deploy for the latest commit succeeds.
- Preview KV and Production KV are isolated.
- Preview auth GET returns 200.
- A single controlled `count=30`, `skipCards=true`, `maxTopUpRounds=1` Preview test completes.
- `todayCount` is meaningfully higher than 6 and close enough to 20 for acceptance.
- Low-quality words are 0 or extremely low.
- Generic topic words are 0 or extremely low.
- Production remains unchanged.
- DeepSeek top-up is observable and does not hang in `running`.
- PR description reflects the final state.

Merge and Production deploy both require explicit user approval.

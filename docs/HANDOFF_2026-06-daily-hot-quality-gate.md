# Japanese Words PR #1 Handoff: Daily Hot Quality Gate

Updated: 2026-06-21

## Current PR

- Repository: `kun921437214-boop/japanese-words`
- PR: https://github.com/kun921437214-boop/japanese-words/pull/1
- Branch: `fix/daily-hot-quality-gate-pr`
- Base: `main`
- Latest branch commit at final audit: `af633ea fix: retry transient daily refresh AI calls`
- Status: PR is open, Preview validation passed, merge still requires explicit user approval.

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
af633ea fix: retry transient daily refresh AI calls
38cc420 docs: add daily hot quality gate handoff
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

Latest Preview deployment checked:

```text
https://61af0dc4.jiyimianbao.pages.dev
```

Preview alias:

```text
https://fix-daily-hot-quality-gate-p.jiyimianbao.pages.dev
```

Preview branch and commit:

```text
fix/daily-hot-quality-gate-pr
af633ea
```

Preview KV binding was confirmed separate from Production earlier in the validation flow:

```text
Preview FAVORITES namespace: d4d4852d9be04115830789aaffbf4aca
Production FAVORITES namespace: 969904de6cf24fe6982d2b8ee01c9b1a
```

Latest Preview validation result:

```text
GET /daily-refresh?date=2026-06-19: 200
POST /daily-refresh?mode=preview-test&count=30&skipCards=true&maxTopUpRounds=1: 200
status: completed
todayCount: 20
generatedCandidates: 60
generatedUniqueCount: 50
importedCandidates: 39
importedUniqueCount: 39
topUpTriggered: true
topUpRoundsUsed: 1
aiCallFailures: 0
aiRetryCount: 0
cardGenerationSkipped: true
```

Latest Preview todaySnapshot quality audit:

```text
words: お久しぶりです、お元気ですか、お邪魔します、お世話になります、お疲れ様、よろしくお願いします、空気を読む、気分転換、勉強法、タイパ、詰む、おうち時間、リラックス、現場、自担、盛る、時短、お疲れ気味、やりくり、手応え
low-quality words: 0
generic topic words: 0
high Chinese-transparency + low expression-value words: 0
S/A/B/C: S 18 / A 1 / B 1 / C 0
source summary: deepseek_new 8 / today_backfill 11 / candidate_pool 1
dedupRelaxed: 0
manual/protected selected words: 0
repeated 30-day words: 0
```

`today_backfill` is a balanced-fill audit marker after normal homepage admission, not a low-quality old-word bypass. It remains a follow-up signal that candidate diversity can improve, but it did not relax 30-day dedup or let low-quality/manual/protected words bypass admission.

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
Production codex-preview* keys: 0
Production preview-test* keys: 0
```

Production was not deployed during this work. Production KV was not intentionally written during the Preview tests.

## Current Blocker

No Preview validation blocker remains.

The previous Preview auth blocker is resolved:

```text
GET /daily-refresh?date=2026-06-19 returned 200 on Preview.
```

The previous transient top-up blocker is also resolved:

```text
POST preview-test returned 200 with todayCount: 20.
```

Do not run more Preview POSTs before merge unless explicitly approved.

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
- Commit `af633ea` added one controlled retry for transient `/ai-candidates` errors.
- Latest `count=30` Preview test on `https://61af0dc4.jiyimianbao.pages.dev` completed successfully with `todayCount: 20`.

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

Current status:

```text
All merge-readiness criteria are satisfied.
Recommendation: merge PR #1 after explicit owner approval.
```

Merge and Production deploy both require explicit user approval.

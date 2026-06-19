# Daily Hot Quality Gate Audit Summary

Updated: 2026-06-20

This is a sanitized summary of local Preview and recommendation audits for PR #1. It intentionally excludes secrets, tokens, API keys, and raw local audit artifacts.

## Initial Problem

Daily Hot recommendations were unstable. When strong candidates were insufficient, the system could overuse backfill and let weak or generic words reach the homepage.

Main findings before the fix:

- Backfill was too broad.
- Manual and protected words did not have a separate homepage admission gate.
- S/A recommendation levels were too loose.
- Candidate shortage could force low-quality old words into Daily Hot.

## Before Fix

Representative pre-fix audit:

```text
targetCount / actualCount: 20 / 20
backfill words: 8 / 20
low-quality words: 10 / 20
low-quality among backfill: 5 / 8
low-quality among manual/protected sources: 4 / 8
DeepSeek new non-backfill words: 4, including 1 low-quality word
```

Interpretation:

```text
The system could hit 20 words, but quality was not acceptable.
```

## After Local Quality Gate Fix

Local validation after tightening admission and backfill:

```text
targetCount / actualCount: 20 / 20
backfill words: 0
low-quality words: 0
generic topic words: 0
S/A/B/C: S 1 / A 18 / B 1 / C 0
topUp mock path: passed
```

Interpretation:

```text
Quality gate behavior is correct locally.
The system no longer hard-fills Daily Hot with weak generic words.
```

## Preview Flow Results

Preview isolation was established:

```text
Preview FAVORITES namespace: separate Preview KV
Production FAVORITES namespace: separate Production KV
Production KV key count observed: 78
Production codex-preview* keys observed: 0
Production todaySnapshot remained unchanged during Preview checks
```

Preview small-flow status:

```text
Preview small-flow completed after daily-refresh progress and inline Preview fixes.
DeepSeek generation path worked in Preview.
Production was not polluted.
```

Medium `count=30` Preview result before the novelty prompt fix:

```text
generatedCandidates: 57
generatedUniqueCount: 37
importedCandidates: 47
importedUniqueCount: 31
todayCount: 6
low-quality words: 0
generic topic words: 0
Production pollution: no
```

Diagnosis:

```text
The flow worked and the quality gate behaved correctly.
The remaining issue was DeepSeek candidate novelty: too many generated words collided with recent 30-day history, favorites, protected words, or review buckets.
```

## Latest Code Fix

Commit `cd71424` improved DeepSeek novelty by adding stronger exclusion context and audit metrics.

The code now asks DeepSeek to avoid:

- recent 30-day recommendation history
- current selected today words
- current batch duplicates
- favorites / pending / published words
- protected words
- recent candidate-pool collisions

It also tracks novelty metrics:

- `generatedUniqueCount`
- `importedUniqueCount`
- `recentHistoryRejectedCount`
- `favoriteProtectedRejectedCount`
- `currentBatchDuplicateRejectedCount`
- `reviewRejectedCount`
- `duplicateRate`
- `historyCollisionRate`

## Current Unfinished Validation

The improved novelty logic has not yet completed a fresh `count=30` Preview POST.

Reason:

```text
Preview AUTO_REFRESH_SECRET authentication is still returning 401 Unauthorized for GET /daily-refresh?date=2026-06-19.
```

Because the request is rejected by auth before workflow entry:

```text
DeepSeek is not called.
No new todaySnapshot is written.
No cards are generated.
Production is not polluted.
```

## Next Recommended Step

Do not merge yet.

Recommended sequence:

```text
1. Rotate Preview-only AUTO_REFRESH_SECRET.
2. Put only the raw secret value in Cloudflare Preview environment variables.
3. Redeploy only the Preview deployment for fix/daily-hot-quality-gate-pr.
4. Verify GET /daily-refresh?date=2026-06-19 returns 200 with Authorization: Bearer <secret>.
5. Stop and record auth success.
6. After explicit approval, run exactly one count=30 Preview test with skipCards=true and maxTopUpRounds=1.
```

Do not call DeepSeek or POST `/daily-refresh` until GET auth returns 200.

## Production Safety Summary

Across the recorded Preview work:

```text
Production deploy: not run
Production daily-refresh POST: not called
Production KV clear: not done
Production KV key count: remained 78 in checks
Production codex-preview* keys: 0 in checks
Production todaySnapshot: remained old 13-word snapshot in checks
```

## Merge Recommendation

Current recommendation:

```text
Do not merge PR #1 yet.
```

Reason:

```text
The code fix is in place and local validation passed, but the latest Preview count=30 validation is blocked by Preview auth.
```

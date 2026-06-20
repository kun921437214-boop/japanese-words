# Daily Hot Quality Gate Audit Summary

Updated: 2026-06-21

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

## Final Preview Validation

Latest Preview deployment:

```text
https://61af0dc4.jiyimianbao.pages.dev
https://fix-daily-hot-quality-gate-p.jiyimianbao.pages.dev
```

Final read/write validation:

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

Final todaySnapshot audit:

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

Interpretation:

```text
Preview auth is fixed.
The improved DeepSeek novelty path reached 20 Daily Hot words.
The transient top-up 502 was addressed by the retry patch and did not recur in the final run.
Quality gate behavior remained strict: no low-quality or generic-topic words were admitted.
`today_backfill` is a balanced-fill audit marker after homepage admission, not a low-quality old-word bypass.
```

Do not run more Preview POSTs before merge unless explicitly approved.

## Production Safety Summary

Across the recorded Preview work:

```text
Production deploy: not run
Production daily-refresh POST: not called
Production KV clear: not done
Production KV key count: remained 78 in checks
Production codex-preview* keys: 0 in checks
Production preview-test* keys: 0 in checks
Production todaySnapshot: remained old 13-word snapshot in checks
```

## Merge Recommendation

Current recommendation:

```text
Recommend merge PR #1 after explicit owner approval.
```

Reason:

```text
Local validation passed, final Preview count=30 validation completed with todayCount 20, and Production remained unpolluted.
```

# Data Rules

## Source Of Truth

- Cloudflare KV workflow is the team source of truth in production.
- localStorage is only a cache for the last loaded workflow.
- `data/words-data.json` is historical seed data, not the formal word-card source.
- `candidatePool` is the unified active candidate pool.
- `aiCard` is the only formal word-card content source.

`kotoba_pending_favorite_operations_v1` is a device-local delivery outbox, not a second team source of truth. It may temporarily overlay the last loaded workflow so a user action stays visible until the server confirms it.

## Workflow Top-Level Fields

```json
{
  "words": [],
  "statuses": {},
  "feedback": {},
  "publishedRecords": [],
  "candidatePool": {},
  "aiBatches": [],
  "todaySnapshot": {},
  "schemaVersion": 3
}
```

## Field Meaning

- `words`：Favorites / Topic Pool words selected by humans.
- `statuses`：favorite status: `none`, `pending`, `published`.
- `feedback`：team negative feedback and skip reasons.
- `publishedRecords`：Xiaohongshu published posts, one-time content capture, daily cumulative metric snapshots, and recommendation-source attribution.
- `candidatePool`：all active candidate words and DeepSeek metadata.
- `aiBatches`：DeepSeek generation/review batch records.
- `todaySnapshot`：current fixed Daily Hot recommendation list.
- `todaySnapshotHistory` / `historySnapshots`：historical Daily Hot snapshots when available.
- `aiPreview`：team-shared DeepSeek preview before import when enabled.

## Candidate Source Types

- `deepseek_generated`：DeepSeek generated candidate.
- `deepseek_reviewed`：historical seed word kept after DeepSeek review.
- `manual_keep`：user-selected, protected, or manually added word.

Do not show old labels such as local word, original word, or original library in user-facing UI.

## Candidate Important Fields

- `kanji`, `kana`, `romaji`, `meaning`, `category`
- `candidateType`, `displayBucket`, `freshness`
- `xhsFitScore`, `finalScore`, `expressionValueScore`
- `riskLevel`, `riskWarning`, `confidenceLevel`, `evidenceType`
- `reviewReason`, `reviewReasonType`, `suggestedAction`
- `emotionTone`, `sourceTags`, `aiBatchId`
- `manualReviewState`, `manualReviewNote`
- `lastScore`, `lastScoredAt`, `lastRecommendedAt`
- `recommendationCount`, `ignoredCount`
- `aiCard`, `aiCardHistory`

## Daily Hot Ranking Rules

Hard exclusions come first:

1. Already favorited.
2. Pending or published.
3. Published Records include the word.
4. Team skipped today.
5. Review / blocked / high risk.
6. Unknown evidence or review confidence.
7. Recent Daily Hot duplicate within the configured dedupe window.

Then rank by:

- Account fit.
- Expression value.
- Xiaohongshu content potential.
- Bucket priority.
- Emotion and topic balance.
- Feedback and published-performance signals.

Daily Hot should recommend expressions worth making into Xiaohongshu content, not generic topic tags.

## Manual Add Rules

Manual words should:

- Enter `words`.
- Create or update `candidatePool[kanji]`.
- Use `sourceType = manual_keep`.
- Preserve existing `manualReviewState`, `manualReviewNote`, and `aiCard`.
- Generate DeepSeek card later if no `aiCard.ready`.

Canceling favorite should remove the word from `words` but should not delete the candidatePool entry.

Favorite add/remove commands must:

- Apply atomically to the latest workflow inside the workflow coordinator.
- Be idempotent by operation ID and remain retryable after a timeout or page restart.
- Ignore a stale page-wide workflow revision; unrelated workflow updates must not reject the favorite action.
- Change only `words`, the target word's status, and the target candidate entry.
- Stay in the local delivery outbox and remain overlaid in the UI until a compact server read confirms the requested state.

## DeepSeek Word Card Rules

Only show formal card sections when:

```js
candidatePool[kanji].aiCard.cardStatus === "ready"
```

Without a ready card, show only basic information and a "generate DeepSeek word card" action.

## Import / Export Rules

- Do not export local template content as a formal word card.
- Full workflow backup must include `candidatePool`, `aiBatches`, `todaySnapshot`, and `publishedRecords`.
- Do not upload real private user data, API keys, large videos, or private export files to GitHub.

## Published Records Rules

- The official Xiaohongshu creator export is the primary metrics source.
- Keep exposure (`impressions`) and views (`views`) separate. Never write both into `latestStats.views`.
- `latestMetrics` stores the latest cumulative values: impressions, views, cover click rate, likes, comments, favorites, follows, shares, average watch seconds, and danmaku.
- `metricSnapshots` stores at most one cumulative snapshot per day and keeps the latest 16 days.
- Import must preview first, match idempotently, and stop on ambiguous duplicate title + publish-time identities.
- Post content (`description`, `coverUrl`, public `link`, and `noteId`) may be captured once from Creator Platform Note Management by clicking the cover to open the read-only note detail. Do not use the edit action or `/publish/update` page for collection. After `contentLocked` becomes true, later imports must not overwrite it.
- `contentCategory` distinguishes a normal `word_card`, confirmed `non_word` content such as book promotion, and `unknown` content still awaiting the first read-only detail capture. Confirmed `non_word` records are self-selected content and must not be counted or displayed as unmapped words.
- Metrics update once per day at 14:30 Asia/Shanghai while the post is no more than 15 days old. Older posts keep their final snapshot and do not update again.
- `selectionSource` distinguishes Daily Hot (Codex / DeepSeek / unknown provider), self-selected, and unmapped/unknown records.
- `latestStats` is only a derived compatibility mirror for existing ranking code. It is not the Published page source of truth.
- Legacy 1h / 2h / 4h / 24h / 72h snapshots, manual ratings, performance reasons, and auto-refresh fields are not part of the new Published product model.

## Easy Mistakes

- Letting a partial `/favorites` save clear `aiBatches` or `todaySnapshot`.
- Overwriting `aiCard` with an empty object during merge.
- Treating Daily Hot as the final publishing pool.
- Showing local template examples as formal DeepSeek content.
- Recommending generic topic labels such as `ネイル`, `副業`, or `転職` as strong Daily Hot words without a specific expression angle.

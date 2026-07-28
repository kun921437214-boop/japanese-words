# Data Rules

## Source Of Truth

- GitHub `main` is the code source of truth after reviewed pull requests are merged.
- Tencent Cloud FileKV under `/var/lib/japanese-words` is the team workflow source of truth in Production.
- Cloudflare KV is retained only as rollback infrastructure and must not receive routine Production writes while Tencent is active.
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
- `feedback`：selection feedback only. It records why a word is not suitable for the topic pool; card and cover feedback live under the candidate entry.
- `publishedRecords`：Xiaohongshu published posts, one-time content capture, daily cumulative metric snapshots, recommendation-source attribution, creative-version snapshots, and performance attribution.
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
- `aiCard`, `aiCardHistory`, `coverHistory`
- `generationFeedback.card`, `generationFeedback.cover`
- `publicationSnapshot`

## Feedback Rules

Keep the three feedback objects separate:

1. Selection feedback asks whether the word itself is worth making. It affects future topic ranking.
2. Card feedback asks why the written content needs regeneration. It must not penalize the word itself.
3. Cover feedback asks why the cover plan needs regeneration. It must not penalize the word itself.

Current selection feedback should be idempotent for the same word, reason, and day. A user may undo the most recent dismissal; `lastUndoneAtByReason` is the merge tombstone that prevents an older cloud count from reappearing.

Card and cover regeneration must always record a structured reason in `generationFeedback` before generating a new version. Card regeneration preserves the current cover and reference image. Cover regeneration preserves the current card text and invalidates the old reference image so the image workflow can create the new visual.

Do not add “adopt card” or “adopt cover” buttons. Marking a word as pending or published is the positive workflow signal; regeneration reasons are the explicit negative signals.

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

Only mature topic-performance signals may change word ranking. Cover and content performance are packaging diagnostics and must not directly punish the word.

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
- Full Production backup must include the main workflow, auxiliary workflow keys such as `codex-draft:*` and operation-health records, and all first-party reference images.
- A backup is not considered verified until it has been restored into an isolated directory and its workflow revision, candidate/card counts, drafts, and image metadata have been checked.
- Do not upload real private user data, API keys, large videos, or private export files to GitHub.

## Published Records Rules

- The official Xiaohongshu creator export is the primary metrics source.
- Keep exposure (`impressions`) and views (`views`) separate. Never write both into `latestStats.views`.
- `latestMetrics` stores the latest cumulative values: impressions, views, cover click rate, likes, comments, favorites, follows, shares, average watch seconds, and danmaku.
- `metricSnapshots` stores at most one cumulative snapshot per day and keeps the latest 16 days.
- Import must preview first, match idempotently, and stop on ambiguous duplicate title + publish-time identities.
- Creator Platform exports use a rolling 180-calendar-day window. Total XLSX row count may shrink when older posts age out and must not be treated as a failure by itself.
- Preview and commit completeness checks must require every existing post published within 15 days to appear in the official export. Missing active posts block commit; absent older posts stay in `publishedRecords`, and records outside the 180-day export window are reported as retained history.
- Preview `unmappedCount` and `nonWordCount` must be calculated after matching existing locked records so Chinese-only historical titles do not become false unmapped warnings.
- Post content (`description`, `coverUrl`, public `link`, and `noteId`) may be captured once from Creator Platform Note Management by clicking the cover to open the read-only note detail. Do not use the edit action or `/publish/update` page for collection. After `contentLocked` becomes true, later imports must not overwrite it.
- When the first locked post content includes a Xiaohongshu cover, the backend downloads it once into first-party image storage and replaces the display URL with `/published-cover`. `coverStorageKey` and `coverStoredAt` are immutable after success; daily metric refreshes must never re-download or replace that cover. Legacy locked records with external covers are migrated once during the next published refresh.
- `contentCategory` distinguishes a normal `word_card`, confirmed `non_word` content such as book promotion, and `unknown` content still awaiting the first read-only detail capture. Confirmed `non_word` records are self-selected content and must not be counted or displayed as unmapped words.
- Official published metrics import once per day at 13:20 Asia/Shanghai while the post is no more than 15 days old, so Monday's 14:30 next-week generation can consume the latest feedback. Older posts keep their final snapshot and do not update again. The Tencent runtime's legacy 14:30 link refresh is only a compatibility safety net and does not replace the official export as the primary source.
- `selectionSource` distinguishes Daily Hot (Codex / DeepSeek / unknown provider), self-selected, and unmapped/unknown records.
- When a word is marked published, capture the working `cardVersion`, `coverVersion`, selected/suggested title, and the relevant card and cover snapshots into `publicationSnapshot`. Published import copies this into immutable `creativeSnapshot` attribution data.
- `performanceAssessment` separates `topic`, `cover`, and `content`. Before 72 hours it stays `collecting`; from 72 hours it may produce an `early` assessment; at 15 days or after the record is frozen it becomes `final`.
- Topic assessment prioritizes favorites, shares, follows, and comments. Cover assessment prioritizes cover click-through and view rate. Content assessment prioritizes average watch, likes, comments, and shares.
- A dimension assessment requires enough mature comparison posts. When the sample is insufficient, keep it neutral instead of manufacturing a positive or negative conclusion.
- Daily recommendation learning may consume only mature topic assessment. Cover and content assessments are used to improve packaging and writing guidance.
- `latestStats` is only a derived compatibility mirror for existing ranking code. It is not the Published page source of truth.
- Legacy 1h / 2h / 4h / 24h / 72h snapshots, manual ratings, performance reasons, and auto-refresh fields are not part of the new Published product model.

## Easy Mistakes

- Letting a partial `/favorites` save clear `aiBatches` or `todaySnapshot`.
- Overwriting `aiCard` with an empty object during merge.
- Treating Daily Hot as the final publishing pool.
- Showing local template examples as formal DeepSeek content.
- Recommending generic topic labels such as `ネイル`, `副業`, or `転職` as strong Daily Hot words without a specific expression angle.

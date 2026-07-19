# Frontend Refactor Plan

## Goal

Reduce `app.js` risk through small, behavior-preserving extractions. Keep the static frontend, Cloudflare Pages Functions, existing API routes, localStorage keys, and KV workflow schema compatible throughout the migration.

## Completed: Phase 1 — Sync Safety Foundation

- `frontend/api-client.mjs` owns request timeout, cancellation, workflow mutation headers, API errors, and duplicate UI-operation locks.
- `frontend/workflow-sync.mjs` owns workflow read retries and favorite mutation reconciliation after revision conflicts.
- `frontend/workflow-cache.mjs` owns compact local cache writes and quota-error containment.
- Daily and historical snapshot cleaning/merging uses `shared/workflow-schema.mjs` as the browser/server source of truth.
- `app.js` is now an ES module. Existing inline handlers remain available through one temporary `window` compatibility facade.
- `scripts/test-frontend-modules.mjs` executes the extracted infrastructure instead of relying only on source-string checks.

## Completed: Phase 2 — Workflow Store

- `frontend/workflow-store.mjs` owns workflow revision and audit-log metadata.
- Scoped page loads use one registry for loaded state and concurrent-request deduplication.
- Remote scoped responses are revision-gated and merge partial candidate/history data in one place.
- Local-cache and cloud-save payloads are built through one stable field allowlist.
- Favorite command responses update revision and audit metadata through the store.

## Completed: Phase 3 — Page Modules and Word-Card Views

Extract one page at a time:

1. Favorites / Topic Pool — completed:
   - `frontend/favorites-page.mjs` owns the page view model, source/status filtering, immutable favorite transitions, and delegated page events;
   - Favorites page controls and cards no longer depend on inline click/change handlers;
   - favorite removal clears stale status in one tested transition, while status changes always preserve membership in the topic pool;
   - executable tests cover filters, counts, add/remove transitions, status transitions, and event routing.
2. Published Records — completed:
   - `frontend/published-page.mjs` owns performance scoring, save-rate-aware rating, page summaries, and delegated page events;
   - low-exposure posts with strong save rate are protected from being mislabeled as weak content, while the existing 72-hour observation window remains intact;
   - Published page controls and cards no longer depend on inline click handlers, and placeholder records now prefill the correct word when edited;
   - executable tests cover score weights, rating boundaries, page models, refresh summaries, and event routing.
3. Daily Recommendations and history — completed:
   - `frontend/daily-hot-page.mjs` owns date options, source-filter view models, historical date navigation, and delegated page/card events;
   - Today, tomorrow-preview, and historical date controls now share one tested date-selection model without changing snapshot or candidate ranking data;
   - Daily Hot page controls, recommendation cards, Codex preview cards, and empty-state generation actions no longer depend on inline click/change/keydown handlers;
   - executable tests cover date ordering, source filtering, history boundaries, stopped card controls, and keyboard preview routing.
4. Shared word-card rendering — completed:
   - `frontend/word-card-view.mjs` owns the read-only word-card view model used by Daily Recommendations, Favorites, internal Candidate Pool views, Codex draft previews, detail modals, and text export;
   - only `aiCard.cardStatus === "ready"` exposes formal titles, summaries, explanations, examples, interaction prompts, cover suggestions, or reference images;
   - pending, failed, stale, and timed-out cards share one status label and unavailable-message model while basic kana, romaji, and meaning remain visible;
   - regenerating an already-ready card keeps its last formal content visible while presenting the operation as in progress;
   - executable tests cover the formal-content gate, ready-card projection, in-flight regeneration, fallback fields, and failure copy.

Remove inline HTML handlers only after the corresponding page module has executable interaction tests.

## In Progress: Phase 4 — Compatibility Facade Reduction

- Application shell — completed:
  - `frontend/app-shell.mjs` owns delegated mobile-sidebar, primary-navigation, settings, backup/restore, outside-overlay, and Escape-key events;
  - `index.html` no longer contains inline click/change/keydown handlers, and primary navigation now supports Enter/Space keyboard activation;
  - eight temporary `window` exports were removed after executable controller tests covered routing, outside-overlay safety, restore changes, keyboard navigation, error handling, and cleanup;
  - desktop and mobile browser checks cover navigation, automatic sidebar close, settings open/close, backup/restore entry visibility, Escape, keyboard navigation, and horizontal overflow.
- Manual-word modal — completed:
  - `frontend/manual-word-modal.mjs` owns delegated new-word submission, duplicate confirmation, detail opening, and close actions;
  - generated manual-word modal markup no longer contains inline click handlers, and three temporary `window` exports were removed;
  - validation, duplicate handling, team sync, and DeepSeek generation behavior remain in the existing application services;
  - executable tests cover action routing, outside-root isolation, async failures, cleanup, and compatibility-facade removal;
  - browser checks cover empty-word validation, cancel/close actions, and reopening without creating or syncing a word.
- Next, move remaining generated modal interactions behind delegated controllers in small groups.
- Remove each temporary `window` export only after its last inline consumer has an executable interaction test.
- Keep generation, Cloudflare sync, KV, and workflow mutation behavior unchanged while reducing browser-global state.

## Required Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Also verify Daily Recommendations, Favorites, and Published Records in a real browser before deployment.

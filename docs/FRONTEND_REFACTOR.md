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

## Completed: Phase 4 — Compatibility Facade Removal

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
- Shared workflow and AI-management actions — completed:
  - `frontend/workflow-actions.mjs` owns delegated AI-preview selection, word-card generation, status/feedback, and internal candidate actions;
  - buttons and cards use escaped data attributes rather than executable inline JavaScript;
  - executable tests cover every route, propagation boundaries, outside-root isolation, async failures, and cleanup.
- Generated modal actions — completed:
  - `frontend/modal-actions.mjs` owns Codex preview, recommendation audit, word-detail, library-cleanup, and published-record modal actions;
  - validation, clipboard/export, workflow mutations, and Cloudflare synchronization remain in the existing application services;
  - executable tests cover parameter forwarding, close-before-favorite behavior, outside-root isolation, async failures, and cleanup.
- Image failure handling — completed:
  - `frontend/image-fallback.mjs` replaces static and generated image `onerror` handlers with one capture-phase controller;
  - source fallbacks, emoji replacements, missing-asset classes, and decorative-image removal retain their existing behavior.
- The temporary `Object.assign(window, ...)` compatibility facade and all inline HTML event attributes have been removed.
- Desktop and 390px mobile browser checks cover primary navigation, automatic mobile-sidebar close, Favorites, Published Records, manual-word and published-record modals, empty-form validation, settings, image assets, and horizontal overflow.
- Generation, Cloudflare sync, KV, API routes, localStorage keys, and workflow mutation behavior remain unchanged.

## Completed: Phase 5 — Published Record Share Parsing

- `frontend/published-record-parser.mjs` owns share-text URL extraction, count parsing, publish-time parsing, metadata cleanup, and the published-record autofill payload.
- Browser and server paths now reuse the same strict Xiaohongshu URL validation: HTTPS only, no embedded credentials or unexpected ports, and only real `xiaohongshu.com` / `xhslink.com` hosts or their subdomains.
- The published-record share field is now multiline so browser paste behavior cannot remove line breaks and join a valid URL to the following date or metrics.
- Author, date, URL, content-type, and metric lines are excluded from the note description; only actual descriptive text is retained.
- The static build copies every shared browser dependency and fails when any relative JavaScript module import is missing from `dist`.
- Executable tests cover valid share parsing, lookalike-domain and insecure-URL rejection, count/date helpers, multiline markup, and deployment-module integrity.
- Computer Use browser validation caught and verified both deployment-module loading and multiline paste behavior. The final check rejected a lookalike domain and correctly filled a valid link, title, author, publish time, description, and all five metrics without saving a record.

## Completed: Phase 6 — Workflow Backup Safety

- `frontend/workflow-backup.mjs` owns workflow backup construction, JSON parsing, root validation, summary copy, serialization, filename generation, and the shared 10 MB browser limit.
- Export and restore still pass through the existing application workflow cleaner, so favorites, statuses, feedback, published records, candidate cards, AI batches, today snapshots, history, revision, and audit metadata keep their current schema behavior.
- Invalid JSON and non-object roots are rejected before any local state replacement or cloud save; oversized file selection now also resets the file input so the same file can be selected again after correction.
- The browser keeps the existing confirmation boundary before restoration and reuses the shared text-download path for exports; no API path, localStorage key, Cloudflare binding, or workflow mutation behavior changed.
- Executable tests cover cleaning before export/restore, complete summary counts, serialization, filenames, size limits, invalid JSON, invalid roots, and missing-cleaner failure.
- Computer Use validation on the built site confirmed Daily Recommendations, Favorites, Published Records, settings open/close, both backup actions, and the desktop modal layout without exporting, restoring, or saving workflow data.

## Required Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

After every frontend update, use Computer Use to verify the affected workflow on the built site in a real browser. Also verify Daily Recommendations, Favorites, and Published Records before deployment.

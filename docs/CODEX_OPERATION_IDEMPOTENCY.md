# Codex upload and draft operation protocol

This opt-in protocol reuses Tencent's existing `LocalWorkflowCoordinator`
queue for each `favorites:<scope>` key. Operation records live in separate
`codex-operation:<scope>:<operationId>` FileKV records. Existing workflow,
card schemas, credentials, storage directories and API paths do not change.

## Requests and identity

- `PUT /codex-image?date=YYYY-MM-DD&word=...` with `X-Operation-Id` and image bytes.
- `PUT /codex-daily?date=YYYY-MM-DD` with `X-Operation-Id` and the usual draft JSON.
- `GET /codex-image?operationId=...` or `GET /codex-daily?operationId=...` to query
  the corresponding operation. Optional `code` selects the existing scope.

IDs must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,119}`. An ID belongs to one
scope, kind, target and input digest. Reusing it with a different payload,
target or endpoint kind returns 409 `OPERATION_ID_CONFLICT`. A conflicting
draft body `operationId` and header returns 400 `OPERATION_ID_MISMATCH`.

Image input digests bind the validated date, trimmed word, content type and
SHA256 of the image bytes. Draft digests bind the query target date and parsed
JSON payload, excluding the body `operationId` control field. Object key order
does not matter; array order and payload values do. SHA256 uses recursively
sorted JSON object keys and UTF-8 (`codexValueSha256`).

The normal result is unchanged, with an additional `operation` receipt. Each
successful replay returns the original result, original submitted timestamps
and result digest. The existing per-request `requestId` trace can differ.
The receipt contains `operationId`, `kind`, `target`, `inputSha256`, status,
creation/completion times, the original result, its digest and HTTP status.
This is upload/draft identity; it does not implement model generation or bind
the Mini controller's plan SHA automatically.

## Durable transitions and reconciliation

1. Under the shared coordinator queue, read the operation record. Verify its
   integrity digest and reject any conflicting identity before doing work.
2. Prepare one result and save a `pending` intent before any image/draft write.
   Opt-in image keys derive from scope and ID, rather than a new random UUID.
   Draft intents retain the exact validated document, the previous target
   digest and the raw validation workflow digest.
3. Inspect the target. Exact expected bytes/document mean the effect exists;
   verify it and finish the journal without rewriting it. An unchanged prior
   state permits one application of the saved intent. Any changed target or
   changed validation workflow blocks an interrupted draft with 409.
4. Read the written effect independently, then atomically save `complete`.
   If a process exits or a write returns an error after persistence, the next
   query/retry inspects the same saved intent and actual effect. It never
   generates another key or revalidates a different draft under the same ID.

Query responses distinguish an absent journal, pending intent, and completed
receipt. `currentEffect` describes the actual object as `absent`, `complete`
or `conflict`. Queries may finalize an already observed exact effect in the
journal; they do not create or rewrite images/drafts. A read error or corrupt
journal returns 503, never authoritative absence.

An absent journal only means no reservation at that serialized read. Another
request can reserve it later; PUT still checks identity inside the queue.
A pending reservation with absent effect is **not** an absent operation.
After another draft supersedes a completed operation, replay returns the old
receipt without restoring old content; lookup reports the current conflict.
Completed images deleted or expired later are likewise not recreated by replay.

A stored invalid draft keeps the original accepted 422 result and is idempotent.
Operation completion means the write was verified. It does not mean card/image
QA passed, publishing is approved, or a local automation may run.

## Compatibility and deployment limits

- No `X-Operation-Id` keeps the existing response and random upload-key behavior.
  Body-only draft `operationId` remains legacy stored metadata. Old clients
  therefore keep working but gain no retry protection until they opt in.
- Writes and operation lookup retain the existing Codex automation/admin/local
  identities. Public readers cannot query operation records. Public image-key
  GET and normal daily context/preview/draft permissions are unchanged.
- A workflow-only remote Durable Object namespace, or absent coordinator,
  returns 503 `CODEX_OPERATION_COORDINATOR_REQUIRED` for this opt-in protocol.
  There is no unsafe direct-KV fallback. Cloudflare legacy APIs remain intact;
  supporting opt-in operations there requires a separately reviewed coordinator.
- Deployment requires one Tencent server process/coordinator, zero cluster
  workers and one replica for each state directory. The systemd source template
  is `Type=simple`, runs one Node entry and declares
  `JAPANESE_WORDS_RUNTIME_PROCESSES=1`. Startup rejects cluster workers, a
  different declared process count, or `WEB_CONCURRENCY` other than `1`. These
  checks cannot discover independent processes/hosts: verify actual process
  topology and state-directory mapping before operation writes. Production
  topology has NOT been verified by this local change. Guarantees cover
  concurrent requests in one process and restart with intact FileKV, not
  multiple workers/processes/hosts sharing state.
- FileKV gives atomic replacement and file fsync, not an atomic transaction
  across image/draft/journal files or a guarantee for sudden power-loss directory
  durability. Retain complete state backups and test restore before release.
- Operation records have no TTL. State-bundle backup code copies all workflow
  KV keys and images. Its additive `codexOperationCount`/`codexOperationKeys`
  manifest fields identify the new journals for a restore check. Listing keys
  alone is not coverage proof: quiesce writers, verify each journal and effect
  after restoring a full bundle into an empty isolated directory. Local fixture
  restore tests are NOT production backup evidence. An older/incomplete backup
  or deleted journal removes idempotency history; never prune journals as
  duplicates or reuse IDs. Monitor disk growth before regular use.
- Install handlers, helper and local coordinator together. Before any opt-in PUT,
  clients must verify that operation lookup returns the new protocol (old code
  ignores the header). A rollback must pause new writes and retain journals.
  Apply the reviewed patch to the current production revision, preserving the
  separately deployed Chinese Feishu report changes; do not redeploy an old
  isolated tree over them.

## Persistent CLI client

`submit`, `upload-image` and `upload-images` now use the protocol. The first
attempt saves an ID before any PUT. Every invocation and every retry queries
that ID first; after a response loss it reconciles the saved identity and
current effect. An unavailable/unsupported/non-authoritative lookup never
permits a blind PUT. An absent or pending journal with an authoritatively
absent effect permits a retry using the SAME ID. Unresolved/conflicting effects,
corrupt records, missing remote history for a locally complete result, and an
expired/superseded completed effect stop the client. A verified 422 receipt is
retained and returned as rejection without resubmission.

The client imports the exact backend scope/ID/digest functions. Image digests
normalize the validated date, trimmed word (80 characters), lowercase content
MIME and exact byte SHA. Draft digests use parsed input excluding the control
`operationId`; validation output is not substituted into this digest. Header
and body IDs agree. Batch manifests add operation ID, input/result SHA fields;
reference-image/card schema and existing ready-item skipping are unchanged.

The active slot is SHA256 of `{origin, scope, kind, target}`; changing content
does not change the slot and cannot silently obtain a fresh ID. Explicit
`--operation-id` selects one single-upload/draft ID. Batch uploads use
`--operation-id-prefix` (up to 80 legal characters) plus a stable date/word hash,
never one shared ID for all images. Starting replacement content requires an
explicit `--new-operation` and a fixed new ID/prefix, after querying and verifying
the old completed current effect. That flag is a control input, not evidence of
user/content approval. Repeating the same replacement command retains its ID.
No client-created operation is inferred for already existing legacy artifacts.

Defaults: `<output-directory>/operations`, normally
`<original>/exports/codex-daily/<date>/operations`. `--operations-dir` can choose
an explicit persistent directory. In Mini business use, the guarded invocation
must use the pinned isolated source with original cwd/exports, and one stable
absolute operations directory on the verified volume. Moving to a fresh output
path without restoring its journal loses client identity and is not a retry.
Existing guard and cutover gates continue to apply; calling this CLI directly
is not automation activation authorization.

Local directories must belong to the current UID with mode 0700, regular journal
files mode 0600. A POSIX advisory lock serializes cooperating clients for each
slot. `/usr/bin/python3` with standard-library `fcntl` is required; missing helper,
busy owner, unsafe permissions or corrupt state fails closed. The helper holds
its OS lock until stdin EOF/process death; the empty `.lock` file stays on disk.
This CLIENT lock does not make the BACKEND coordinator work across processes.
The local platform is macOS/POSIX; Windows is not supported by this helper.

## Journal contents, retention and restore

Local schema version 1 has `origin`, normalized scope/kind/target, operation ID,
input SHA, prepared/unknown/blocked/complete state, creation time, optional last
HTTP status/error code, completed receipt, and an integrity SHA of the record.
A receipt contains the original backend response summary (counts, validation
errors, image key/URL/storage metadata), result SHA, HTTP status and effect state.
It contains NO Authorization header/token, image bytes or full draft document.
Word/date/IDs, URLs and validation messages remain private business metadata.
The integrity SHA detects accidental corruption; it is not an authentication MAC.
`history/<old-id>.json` retains a previous resolved slot when an explicit new ID
is selected. `.tmp` files may remain after a crash. No automatic pruning/cleanup
is provided for active/history journals; do not delete unresolved or completed
identities as redundant exports. Lock files are empty and not lock ownership
records. Retain journals until a separately reviewed retention protocol exists.

Backend schema version 1 records live in the existing FAVORITES FileKV, normally
`/var/lib/japanese-words/workflow-kv`, under
`codex-operation:<scope>:<id>`. Physical file names are FileKV implementation
names, so copy/restore by the complete KV directory or API, not guessed names.
The record includes the prepared FULL validated draft (card text, prompts,
reference/evidence/review metadata), previous document/workflow SHA, or image
intent metadata/key/byte SHA (no image bytes in the journal), original response
and integrity SHA. Actual bytes remain in `reference-images-kv`. These journals
need the same private permissions/backup handling as workflow state.

Tencent backup covers backend workflow KV, draft documents and images. It does
NOT cover the Mini operations directory. The current Mini snapshot GET runner
is not an exports backup. Before regular use, provide a separate private local
backup that includes the original exports directory, all active and history
operation JSON, draft/image upload manifests and source input files. Pause local
writers while copying; retain bytes/ownership and enforce 0700 on restored
journal directories and 0600 on files. Verify a complete relative-path SHA
manifest before admitting restored logs. Empty `.lock` files can be omitted;
unrecognized crash `.tmp` files should be quarantined, never promoted as logs.
Restore into a new empty directory, validate its manifest, then use the same
operations path/ID with GET-first reconciliation. Do not merge different journal
histories or reset IDs after a partial restore. Restore server bundles together;
client logs alone cannot recreate missing server history safely.

This is additive side-record storage: no migration of candidatePool/aiCard,
existing localStorage keys, existing draft content, package or lockfile is
required. Existing clients still work but do not obtain this protection. Code
rollback must keep both journals, pause operation writes and preserve full
business state. New clients reject an old backend before PUT. Running the old
client after rollback would lose the guard against blind upload retry; keep
those mutations paused until the supported protocol is restored.

No deployment, production state migration, task activation or new network
permission is part of this change. Project-bound readback remains a separate
gate. This protocol does not bypass it.

## Validation

`npm run test:codex` includes the operation suite. Tests cover concurrent and
sequential retries, conflicting pending/completed IDs, failures around intent,
effect and completion writes, real child exits and FileKV reopening, legacy
clients, corruption/read errors, superseding drafts and changed workflow state.
The CLI suite also covers before/after-PUT child process exit and restart,
response loss, changed payload, fixed new IDs, receipt corruption, local lock
contention, transient GET-before-same-ID retries, 422 replay, batch resume,
private journal contents and local journal restore. Startup tests reject declared
worker setups. The backend backup test restores both completed and pending
operation logs and verifies no effect rewrite. These are local fixture checks,
not concurrent multi-process backend guarantees or production restore evidence.
All network calls in these new suites are forbidden; handlers and temporary
in-memory/FileKV bindings replace transport. The existing repository typecheck
scope includes the shared backend helper; Node client modules are checked by
lint and runtime tests, without adding Node type dependencies.

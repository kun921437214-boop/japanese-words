# Production Operations Audit — 2026-07-26

## Scope

This audit followed the Tencent Production cutover rules. It did not deploy code, merge a pull request, write Production workflow data, or change Cloudflare rollback resources.

## Production Read-Only Results

- Site: `https://bijinihaitan.cn`
- Workflow backup: revision 45
- Favorites: 89 total
- Candidate pool: 865
- Published records: 46
- Current snapshot: `2026-07-26`, 10 words
- Next-day Codex draft: `2026-07-27`
  - status: `valid`
  - words: 10
  - ready cards: 10
  - ready images: 10
  - validation errors/warnings: 0 / 0
  - S / A levels: 5 / 5
  - same-day semantic duplicate clusters: 0

The read-only workflow backup was saved under the gitignored `exports/workflow-backups` directory:

- `workflow-2026-07-26T14-38-57-783Z-r45.json`
- SHA-256 reported by the backup command: `99158a4a66c7fc7045d4bfe83898eabc635f83b25602cb1bff14d244597fdfb4`

## Isolated Restore Drill

The revision-45 Production workflow was restored into a new `/private/tmp` FileKV directory. The importer copied all 180 referenced first-party images from the Production origin.

First restore validation:

- revision: 45
- favorites: 89
- candidates: 865
- published records: 46
- current snapshot: 10 words
- restored image keys: 180
- sample image: WebP, 40,990 bytes

The isolated data was then packaged with `server/tencent-backup.mjs` into a Tencent `state-*` bundle and restored again into a second isolated directory. The two restored copies matched on:

- workflow revision and principal counts
- current snapshot date and word count
- image-key count
- sample image key, content type, and SHA-256

No rehearsal command targeted `/var/lib/japanese-words`.

## Remaining Server-Side Verification

The local SSH key was not accepted by the Tencent host, so the latest server-created `/var/backups/japanese-words/state-*` directory and `journalctl` history could not be inspected directly. The local drill validates the current Production workflow, its 180 reachable images, and the complete state-bundle restore machinery, but it does not prove that the latest server bundle contains every auxiliary FileKV key such as `codex-draft:*`.

When authorized server credentials are available, complete the final check by selecting the latest server `state-*` bundle, restoring it to a new isolated directory, and comparing its manifest counts with Production. Do not restore a rehearsal into `/var/lib/japanese-words`.

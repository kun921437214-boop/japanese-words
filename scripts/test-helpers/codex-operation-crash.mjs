import path from 'node:path';
import { FileKV } from '../../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../../server/local-coordinator.mjs';
import { onRequest as image } from '../../functions/codex-image.js';
import { onRequest as daily } from '../../functions/codex-daily.js';
import { makeDraft } from './codex-operation-draft.mjs';

globalThis.fetch = () => { throw new Error('CRASH_TEST_NETWORK_FORBIDDEN'); };
const [root, kind, phase] = process.argv.slice(2);
const kv = new FileKV(path.join(root, 'workflow')), images = new FileKV(path.join(root, 'images'));
const binding = kind === 'image' ? images : kv;
const original = binding.put.bind(binding);
binding.put = async (key, ...args) => {
  const effect = kind === 'image' || key.startsWith('codex-draft:');
  if (effect && phase === 'before-effect') process.exit(73);
  await original(key, ...args);
  if (effect && phase === 'after-effect') process.exit(73);
};
const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: images,
  WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), ALLOW_INSECURE_LOCAL_DEV: 'true' };
const request = new Request(`http://localhost/codex-${kind === 'image' ? 'image' : 'daily'}?date=2026-07-14&word=モヤる`, {
  method: 'PUT', headers: { 'X-Operation-Id': 'crash-operation',
    'Content-Type': kind === 'image' ? 'image/webp' : 'application/json' },
  body: kind === 'image' ? new Uint8Array([1, 2, 3, 4]) : JSON.stringify(makeDraft())
});
await (kind === 'image' ? image : daily)({ env, request });
throw new Error('Expected child crash did not occur');

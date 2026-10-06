// Hermetic CLI preload: real handlers/FileKV, no socket and no real credential.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileKV } from '../../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../../server/local-coordinator.mjs';
import { onRequest as image } from '../../functions/codex-image.js';
import { onRequest as daily } from '../../functions/codex-daily.js';

const root = fs.realpathSync(process.env.CODEX_CLIENT_TEST_ROOT);
if (!root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('codex-client-cli-')) {
  throw new Error('UNSAFE_CLI_TEST_ROOT');
}
const kv = new FileKV(path.join(root, 'server/workflow'));
const images = new FileKV(path.join(root, 'server/images'));
const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: images,
  WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), CODEX_AUTOMATION_SECRET: 'offline-cli-secret' };
globalThis.fetch = async (urlValue, options = {}) => {
  const url = new URL(urlValue);
  if (url.origin !== 'https://fixture.invalid' || !['/codex-image', '/codex-daily'].includes(url.pathname)) {
    throw new Error('CLI_TEST_REAL_NETWORK_FORBIDDEN');
  }
  const request = new Request(url, options);
  fs.appendFileSync(path.join(root, 'transport.jsonl'), JSON.stringify({ method: request.method,
    path: url.pathname, operationId: request.headers.get('X-Operation-Id') || url.searchParams.get('operationId') || '' }) + '\n');
  if (request.method === 'PUT' && process.env.CODEX_CLIENT_TEST_CRASH === 'before-put') process.exit(73);
  const response = await (url.pathname === '/codex-image' ? image : daily)({ request, env });
  if (request.method === 'PUT' && process.env.CODEX_CLIENT_TEST_CRASH === 'after-put') process.exit(73);
  return response;
};

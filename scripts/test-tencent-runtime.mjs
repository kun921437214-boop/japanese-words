import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileKV } from '../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { handleWebRequest, matchesSchedule } from '../server/tencent-runtime.mjs';

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-tencent-'));
  const workflow = new FileKV(path.join(root, 'workflow'));
  const images = new FileKV(path.join(root, 'images'));
  return {
    FAVORITES: workflow,
    REFERENCE_IMAGES_KV: images,
    WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(workflow),
    ALLOW_PUBLIC_APP: 'true',
    SITE_URL: 'https://bijinihaitan.cn',
    ALLOWED_ORIGINS: 'https://bijinihaitan.cn'
  };
}

test('FileKV preserves JSON, binary metadata, listing, and TTL behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-kv-'));
  const kv = new FileKV(root);
  await kv.put('favorites:global', JSON.stringify({ words: ['モヤる'] }));
  assert.deepEqual(await kv.get('favorites:global', 'json'), { words: ['モヤる'] });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await kv.put('codex-daily/example.webp', bytes, { metadata: { contentType: 'image/webp' } });
  const image = await kv.getWithMetadata('codex-daily/example.webp', { type: 'arrayBuffer' });
  assert.deepEqual([...new Uint8Array(image.value)], [...bytes]);
  assert.equal(image.metadata.contentType, 'image/webp');
  assert.deepEqual((await kv.list({ prefix: 'favorites:' })).keys.map(item => item.name), ['favorites:global']);
  await kv.put('temporary', 'value', { expirationTtl: 0.001 });
  await new Promise(resolve => {
    setTimeout(resolve, 10);
  });
  assert.equal(await kv.get('temporary'), null);
});

test('local coordinator serializes concurrent favorite commands', async () => {
  const env = await makeEnv();
  const add = word => handleWebRequest(new Request('https://bijinihaitan.cn/favorites', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://bijinihaitan.cn',
      'Sec-Fetch-Site': 'same-origin',
      'X-Operation-Id': `test-${encodeURIComponent(word)}`
    },
    body: JSON.stringify({ action: 'add', word })
  }), env);
  const responses = await Promise.all([add('モヤる'), add('気まずい')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  await Promise.all(responses.map(response => response.arrayBuffer()));
  const stored = await env.FAVORITES.get('favorites:global', 'json');
  assert.deepEqual(new Set(stored.words), new Set(['モヤる', '気まずい']));
  assert.equal(stored.revision, 2);
});

test('Tencent runtime dispatches existing API handlers', async () => {
  const env = await makeEnv();
  const health = await handleWebRequest(new Request('https://bijinihaitan.cn/healthz'), env);
  const body = await health.json();
  assert.equal(health.status, 200);
  assert.equal(body.storageConfigured, true);
  assert.equal(body.workflowCoordinatorConfigured, true);
  const missing = await handleWebRequest(new Request('https://bijinihaitan.cn/unknown'), env);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test('Tencent scheduler matches the existing UTC cron definitions', () => {
  assert.equal(matchesSchedule('30 6 * * *', new Date('2026-07-20T06:30:00Z')), true);
  assert.equal(matchesSchedule('30 6 * * *', new Date('2026-07-20T06:29:00Z')), false);
  assert.equal(matchesSchedule('5,25,45 * * * *', new Date('2026-07-20T09:25:00Z')), true);
  assert.equal(matchesSchedule('10,20,30,40,50 16 * * *', new Date('2026-07-20T16:40:00Z')), true);
});

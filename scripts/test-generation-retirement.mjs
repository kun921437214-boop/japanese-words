import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest as candidates } from '../functions/ai-candidates.js';
import { onRequest as cards } from '../functions/ai-cards.js';
import { onRequest as refresh } from '../functions/daily-refresh.js';
import worker from '../worker/favorites-worker.js';
import { createApiClient } from '../frontend/api-client.mjs';
import { DEEPSEEK_DISABLED_CODE } from '../shared/generation-policy.mjs';
import { createMemoryKv } from './test-helpers/kv.mjs';

const routes = [['/ai-candidates', candidates], ['/ai-cards', cards], ['/daily-refresh', refresh]];

test('retired generation routes reject stale clients without provider calls or workflow writes', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => assert.fail('outbound call'));
  const kv = createMemoryKv({ 'favorites:global': { words: ['既存'], revision: 7 } });
  const before = [...kv.values];
  const env = { FAVORITES: kv, ALLOW_PUBLIC_APP: 'true', DEEPSEEK_API_KEY: 'test-only', DEEPSEEK_MODEL: 'test-only' };
  for (const [path, handler] of routes) {
    for (const action of ['stable_today', 'generate_word_card', 'enrich_words', 'scheduled_fallback']) {
      const response = await handler({ request: new Request(`https://example.invalid${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, words: ['既存'] })
      }), env });
      assert.equal(response.status, 410);
      const data = await response.json();
      assert.equal(data.error.code, DEEPSEEK_DISABLED_CODE);
      assert.equal(data.error.retryable, false);
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(kv.putCalls, 0);
  assert.deepEqual([...kv.values], before);
});

test('existing card and refresh status remain readable after retirement', async () => {
  const kv = createMemoryKv({});
  for (const [path, handler] of routes.slice(1)) {
    const response = await handler({ request: new Request(`https://example.invalid${path}`), env: { FAVORITES: kv, ALLOW_PUBLIC_APP: 'true' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  assert.equal(kv.putCalls, 0);
});

test('browser blocks retired generation requests while allowing reads and Codex writes', async () => {
  const calls = [];
  const client = createApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  } });
  for (const [path] of routes) {
    const response = await client.request(`https://example.invalid${path}`, { method: 'POST' });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, DEEPSEEK_DISABLED_CODE);
  }
  assert.equal(calls.length, 0);
  await client.request('https://example.invalid/ai-cards');
  await client.request('https://example.invalid/codex-daily', { method: 'POST' });
  assert.equal(calls.length, 2);
});

test('legacy card-batch cron performs no requests or scheduled generation', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => assert.fail('outbound call'));
  const jobs = [];
  for (const cron of ['10,20,30,40,50 16 * * *', '0 17 * * *']) {
    await worker.scheduled({ cron }, { FAVORITES: {}, SITE_URL: 'https://example.invalid', AUTO_REFRESH_SECRET: 'test-only' }, { waitUntil: job => jobs.push(job) });
  }
  assert.equal(jobs.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

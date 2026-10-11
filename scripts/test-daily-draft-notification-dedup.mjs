import assert from 'node:assert/strict';
import test from 'node:test';
import { runDailyOperationsHealthCheck as check } from '../worker/favorites-worker.js';
import { getCodexDraftStorageKey as draftKey } from '../shared/codex-daily-draft.mjs';

const base = new Date('2026-10-11T09:15:00.000Z');
const at = minutes => new Date(base.getTime() + minutes * 60000);
const key = date => `operations-health:daily:tomorrow-draft:${date}`;
const target = '2026-10-12';
const healthKey = key(target);
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-only';
const clone = value => value === undefined ? null : structuredClone(value);
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_BY_LOCAL_TEST'); };
function kv(initial = {}) {
  const data = new Map(Object.entries(initial)); const gets = []; const puts = [];
  return { data, gets, puts,
    async get(name, format) { assert.equal(format, 'json'); gets.push(name); return clone(data.get(name)); },
    async put(name, value, options) { puts.push({ name, options }); data.set(name, JSON.parse(value)); }
  };
}
function rig(storage = kv(), send = async () => Response.json({ code: 0 })) {
  const calls = [];
  const env = { FAVORITES: storage, OPS_ALERT_WEBHOOK_URL: webhook };
  const run = (minutes = 0, kind = 'tomorrow-draft') => check(env, { now: at(minutes), kind,
    fetchImpl: async (url, options) => { assert.equal(url, webhook); calls.push(JSON.parse(options.body)); return send(url, options); }
  });
  return { storage, env, calls, run };
}
const missing = promise => assert.rejects(promise, /health check failed.*draft_missing/);
const validDraft = () => ({ targetDateKey: target, status: 'valid', validation: { valid: true }, wordCount: 10, cardReadyCount: 10, imageReadyCount: 10 });
const oldRecord = sent => ({ kind: 'tomorrow-draft', targetDateKey: target, status: 'unhealthy', reasons: ['draft_missing'], checkedAt: at(0).toISOString(), lastNotificationAttemptAt: at(0).toISOString(), notification: { configured: true, sent, skipped: !sent, error: '' } });

test('continuous missing: first send only; skipped checks persist success and keep reading/rejecting', async () => {
  const r = rig();
  for (const minute of [0, 1, 30, 120]) await missing(r.run(minute));
  assert.equal(r.calls.length, 1);
  const stored = r.storage.data.get(healthKey);
  assert.equal(stored.draftMissingNotifiedAt, at(0).toISOString());
  assert.equal(stored.lastNotificationAttemptAt, at(0).toISOString());
  assert.equal(stored.checkedAt, at(120).toISOString());
  assert.equal(stored.notification.sent, false); assert.equal(stored.notification.skipped, true);
  assert.equal(r.storage.gets.filter(name => name === draftKey(target)).length, 4);
  assert.equal(r.storage.puts.length, 4);
  assert.ok(r.storage.puts.every(write => write.options.expirationTtl === 30 * 24 * 3600));
});

test('legacy explicit successful missing send migrates without another send', async () => {
  const r = rig(kv({ [healthKey]: oldRecord(true) }));
  await missing(r.run(31)); await missing(r.run(120));
  assert.equal(r.calls.length, 0);
  assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, at(0).toISOString());
});

test('legacy overwritten skipped record never turns an attempt into success', async () => {
  const r = rig(kv({ [healthKey]: oldRecord(false) }));
  await missing(r.run(1)); assert.equal(r.calls.length, 0);
  assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, '');
  await missing(r.run(31)); await missing(r.run(62));
  assert.equal(r.calls.length, 1);
  assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, at(31).toISOString());
});

test('failed delivery still retries after original cooldown and marks only eventual success', async () => {
  let attempt = 0; const r = rig(kv(), async () => ++attempt === 1 ? new Response('', { status: 503 }) : Response.json({ code: 0 }));
  await missing(r.run(0)); await missing(r.run(29));
  assert.equal(r.calls.length, 1); assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, '');
  await missing(r.run(30)); await missing(r.run(60));
  assert.equal(r.calls.length, 2); assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, at(30).toISOString());
});

test('recovery notifies and clears the episode; renewed missing remains eligible after existing cooldown', async () => {
  const r = rig(); await missing(r.run(0));
  r.storage.data.set(draftKey(target), validDraft());
  const recovered = await r.run(1);
  assert.equal(recovered.status, 'healthy'); assert.equal(recovered.draftMissingNotifiedAt, '');
  assert.match(r.calls[1].content.text, /恢复/);
  r.storage.data.delete(draftKey(target)); await missing(r.run(32));
  assert.equal(r.calls.length, 3); assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, at(32).toISOString());
});

test('different draft error retains original alert path and resets missing episode', async () => {
  const r = rig(); await missing(r.run(0));
  r.storage.data.set(draftKey(target), { ...validDraft(), wordCount: 9 });
  await assert.rejects(r.run(31), /draft_word_count_incomplete/);
  assert.equal(r.calls.length, 2); assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, '');
  r.storage.data.delete(draftKey(target)); await missing(r.run(62));
  assert.equal(r.calls.length, 3);
});

test('new date and today snapshot are not deduplicated by tomorrow missing success', async () => {
  const r = rig(); await missing(r.run(0)); await missing(r.run(24 * 60));
  assert.equal(r.calls.length, 2);
  assert.equal(r.storage.data.get(key('2026-10-13')).draftMissingNotifiedAt, at(1440).toISOString());
  await assert.rejects(r.run(0, 'today-snapshot'), /snapshot_date_mismatch/);
  await assert.rejects(r.run(31, 'today-snapshot'), /snapshot_date_mismatch/);
  assert.equal(r.calls.length, 4);
  assert.equal(Object.hasOwn(r.storage.data.get('operations-health:daily:today-snapshot:2026-10-11'), 'draftMissingNotifiedAt'), false);
});

test('legacy wrong scope, changed reasons, or nonboolean sent do not suppress missing', async () => {
  for (const changed of [{ targetDateKey: '2026-10-13' }, { kind: 'today-snapshot' }, { reasons: ['draft_missing', 'another_error'] }, { notification: { sent: 'true' } }]) {
    const r = rig(kv({ [healthKey]: { ...oldRecord(true), ...changed } }));
    await missing(r.run(31)); assert.equal(r.calls.length, 1);
  }
});

test('same KV and key concurrent checks serialize delivery and keep each health failure', async () => {
  let entered; const sending = new Promise(resolve => { entered = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const r = rig(kv(), async () => { entered(); await blocked; return Response.json({ code: 0 }); });
  const first = r.run(0); const second = r.run(0);
  const settled = Promise.allSettled([first, second]);
  await sending; assert.equal(r.calls.length, 1); release();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && /draft_missing/.test(result.reason.message)));
  assert.equal(r.calls.length, 1); assert.equal(r.storage.puts.length, 2);
});

test('a blocked key does not block another KV instance or another date', async () => {
  let entered; const sending = new Promise(resolve => { entered = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; }); let sends = 0;
  const r = rig(kv(), async () => { if (++sends === 1) { entered(); await blocked; } return Response.json({ code: 0 }); });
  const first = r.run(0); const firstResult = Promise.allSettled([first]); await sending;
  const other = rig();
  await missing(other.run(0)); await missing(r.run(1440));
  assert.equal(other.calls.length, 1); assert.equal(r.calls.length, 2);
  release(); await firstResult;
});

test('missing configuration is never a delivery success and later configuration may notify', async () => {
  const r = rig(); delete r.env.OPS_ALERT_WEBHOOK_URL;
  await missing(r.run(0)); assert.equal(r.storage.data.get(healthKey).draftMissingNotifiedAt, '');
  r.env.OPS_ALERT_WEBHOOK_URL = webhook;
  await missing(r.run(30)); await missing(r.run(60)); assert.equal(r.calls.length, 1);
});

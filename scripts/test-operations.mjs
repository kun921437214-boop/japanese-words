import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { sendOperationsNotification } from '../shared/operations-alert.mjs';
import { saveAlertEnvironment } from '../server/configure-ops-alert.mjs';
import { FileKV } from '../server/file-kv.mjs';
import { hasStoredReferenceImage, runWeeklyContentCheck } from '../server/weekly-content-check.mjs';
import { getWeeklyContentWindow } from '../shared/weekly-content-health.mjs';
import { runPublishedImport, validateOfficialPayload } from '../server/published-import-run.mjs';
import { handleWebRequest } from '../server/tencent-runtime.mjs';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { collectOperationsReport, runOperationsReport } from '../server/operations-report.mjs';

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/placeholder-test-only';
const NOW = new Date();
const payload = () => ({ source: 'xiaohongshu_creator_export', sourceFileName: 'example.xlsx', capturedAt: new Date(NOW.getTime() - 1000).toISOString(), capturedAtSource: 'official_export', rows: [{ title: '「尊い」の意味', publishedAt: new Date(NOW.getTime() - 86400000).toISOString(), contentType: '图文', impressions: 1000, views: 200, coverClickRate: '20%', likes: 20, comments: 2, favorites: 8, follows: 1, shares: 2, avgWatchSeconds: 5, danmaku: 0 }] });
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-ops-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Feishu validates business success, optional HMAC, and redacts errors', async () => {
  let sent;
  const env = { OPS_ALERT_WEBHOOK_URL: WEBHOOK, OPS_ALERT_SIGNING_SECRET: 'placeholder-signing-test' };
  const result = await sendOperationsNotification(env, { text: '[japanese-words] test' }, { nowMs: 1700000000000, fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ code: 0 }); } });
  assert.equal(result.sent, true);
  assert.equal(sent.msg_type, 'text');
  assert.equal(sent.timestamp, '1700000000');
  assert.equal(sent.sign, createHmac('sha256', '1700000000\nplaceholder-signing-test').update('').digest('base64'));
  assert.equal((await sendOperationsNotification(env, {}, { fetchImpl: async () => Response.json({ code: 19024 }) })).error, 'feishu_rejected');
  const failed = await sendOperationsNotification(env, {}, { fetchImpl: async () => { throw new Error(WEBHOOK); } });
  assert.equal(failed.error, 'webhook_transport_failed');
  assert.equal(JSON.stringify(failed).includes(WEBHOOK), false);
  assert.equal((await sendOperationsNotification({}, {})).configured, false);
});

test('configuration writes mode 600 and refuses an implicit overwrite or injection', async t => {
  const file = path.join(await temporary(t), 'ops.env');
  await saveAlertEnvironment(file, WEBHOOK);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveAlertEnvironment(file, WEBHOOK), /CONFIG_ALREADY_EXISTS/);
  await assert.rejects(saveAlertEnvironment(file + '2', `${WEBHOOK}\nOTHER=value`), /INVALID_FEISHU_WEBHOOK/);
});

test('image verification rejects expired, corrupt, mismatched records without deleting', async t => {
  const kv = new FileKV(await temporary(t));
  const key = 'codex-daily/2026-10-05/test.webp';
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).webp().toBuffer();
  await kv.put(key, bytes, { metadata: { contentType: 'image/webp' }, expirationTtl: 600 });
  assert.equal(await hasStoredReferenceImage(kv, key), true);
  const original = JSON.parse(await readFile(kv.fileForKey(key), 'utf8'));
  for (const patch of [{ expiresAt: '2000-01-01T00:00:00Z' }, { data: 'corrupted' }, { key: 'other' }, { metadata: { contentType: 'image/jpeg' } }]) {
    await writeFile(kv.fileForKey(key), JSON.stringify({ ...original, ...patch }));
    assert.equal(await hasStoredReferenceImage(kv, key), false);
    assert.equal((await stat(kv.fileForKey(key))).isFile(), true);
  }
});

test('weekly missing content alerts, recovery notifies once, and successful checks stop', async t => {
  const root = await temporary(t);
  const workflowKv = new FileKV(path.join(root, 'workflow'));
  const imageKv = new FileKV(path.join(root, 'images'));
  const now = new Date('2026-10-01T06:40:00Z');
  let notifications = 0;
  const options = { now, workflowKv, imageKv, alertUrl: WEBHOOK, validateDraft: draft => draft, imageExists: async () => true, fetchImpl: async () => { notifications++; return Response.json({ code: 0 }); } };
  assert.equal((await runWeeklyContentCheck(options)).status, 'unhealthy');
  assert.equal((await runWeeklyContentCheck(options)).status, 'unhealthy');
  assert.equal(notifications, 1);
  for (const date of getWeeklyContentWindow(now).targetDateKeys) {
    const items = Array.from({ length: 10 }, (_, index) => ({ kanji: `${date}-${index}`, aiCard: { referenceImage: { status: 'ready', key: `codex-daily/${date}/${index}.webp`, url: `/codex-image?key=codex-daily/${date}/${index}.webp` } } }));
    await workflowKv.put(`codex-draft:global:${date}`, JSON.stringify({ targetDateKey: date, status: 'valid', wordCount: 10, cardReadyCount: 10, imageReadyCount: 10, items, validation: { valid: true, errors: [], warnings: [], recommendationAudit: { items: items.map(item => ({ semanticClusterKey: item.kanji })) } } }));
  }
  const result = await runWeeklyContentCheck(options);
  assert.equal(result.status, 'healthy');
  assert.equal(result.totals.storedImages, 70);
  assert.equal(notifications, 2);
  assert.equal((await runWeeklyContentCheck({ ...options, validateDraft: () => { throw new Error('unexpected rescan'); } })).skipped, true);
});

test('payload gate rejects stale, duplicate and incomplete data before network access', () => {
  const p = payload();
  validateOfficialPayload(p, NOW);
  assert.throws(() => validateOfficialPayload({ ...p, capturedAt: '2020-01-01T00:00:00Z' }, NOW), /FRESH_EXPORT_REQUIRED/);
  assert.throws(() => validateOfficialPayload({ ...p, rows: [p.rows[0], p.rows[0]] }, NOW), /EXPORT_IDENTITY_AMBIGUOUS/);
  for (const value of [null, '', 'unknown', -1]) assert.throws(() => validateOfficialPayload({ ...p, rows: [{ ...p.rows[0], views: value }] }, NOW), /EXPORT_METRICS_INCOMPLETE/);
});

async function runtime(t) {
  const root = await temporary(t);
  const kv = new FileKV(path.join(root, 'workflow'));
  const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: new FileKV(path.join(root, 'images')), WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), AUTO_REFRESH_SECRET: 'placeholder-import-test', ALLOW_PUBLIC_APP: 'false', SITE_URL: 'https://bijinihaitan.cn' };
  return { kv, fetchImpl: (url, init) => handleWebRequest(new Request(url, init), env) };
}

test('official import previews, protects revision, reads back, and replays idempotently', async t => {
  const server = await runtime(t);
  const options = { token: 'placeholder-import-test', fetchImpl: server.fetchImpl, now: NOW, readWorkflow: () => server.kv.get('favorites:global', 'json') };
  const p = payload();
  assert.equal((await runPublishedImport(p, options)).status, 'preview');
  assert.equal(await server.kv.get('favorites:global'), null);
  const commit = await runPublishedImport(p, { ...options, confirm: 'IMPORT_PUBLISHED' });
  assert.equal(commit.status, 'verified');
  assert.equal((await runPublishedImport(p, { ...options, confirm: 'IMPORT_PUBLISHED' })).revision, commit.revision);
});

test('official import catches concurrent writes and incorrect readback', async t => {
  const server = await runtime(t);
  const options = { token: 'placeholder-import-test', now: NOW, confirm: 'IMPORT_PUBLISHED', readWorkflow: () => server.kv.get('favorites:global', 'json') };
  await assert.rejects(runPublishedImport(payload(), { ...options, fetchImpl: async (url, init) => {
    if (init.method === 'POST' && JSON.parse(init.body).mode === 'commit') await server.kv.put('favorites:global', JSON.stringify({ revision: 1 }));
    return server.fetchImpl(url, init);
  } }), /REVISION_CONFLICT/);
  await server.kv.delete('favorites:global');
  await assert.rejects(runPublishedImport(payload(), { ...options, fetchImpl: server.fetchImpl, readWorkflow: async () => {
    const data = await server.kv.get('favorites:global', 'json');
    data.publishedRecords[0].latestMetrics.views++;
    return data;
  } }), /READBACK_MISMATCH/);
});

test('daily report distinguishes not-due checks from missing results and retries a failed notification', async t => {
  const kv = new FileKV(await temporary(t));
  const now = new Date('2026-10-01T07:10:00Z');
  const words = Array.from({ length: 10 }, (_, index) => `fixture-${index}`);
  await kv.put('favorites:global', JSON.stringify({ revision: 10, todaySnapshot: { dateKey: '2026-10-01', words, source: 'codex_draft' },
    candidatePool: Object.fromEntries(words.map(word => [word, { aiCard: { cardStatus: 'ready', referenceImage: { status: 'ready' } } }])) }));
  const base = { now, workflowKv: kv, backup: { createdAt: '2026-10-01T07:00:00Z', revision: 10 } };
  const missing = await collectOperationsReport(base);
  assert.deepEqual(missing.problems, ['next_week_not_verified', 'official_export_not_verified_today']);
  assert.equal((await collectOperationsReport({ ...base, now: new Date('2026-10-01T04:00:00Z') })).published.status, 'pending');
  await kv.put('operations-health:weekly:next-week:2026-09-28', JSON.stringify({ status: 'healthy' }));
  await kv.put('operations-health:published:official-import:2026-10-01', JSON.stringify({ status: 'verified', checkedAt: '2026-10-01T05:20:00Z' }));
  assert.equal((await collectOperationsReport(base)).status, 'healthy');
  const options = { ...base, send: true, env: { OPS_ALERT_WEBHOOK_URL: WEBHOOK } };
  assert.equal((await runOperationsReport({ ...options, fetchImpl: async () => Response.json({ code: 19024 }) })).notification.sent, false);
  assert.equal((await runOperationsReport({ ...options, fetchImpl: async () => Response.json({ code: 0 }) })).notification.sent, true);
  assert.equal((await runOperationsReport({ ...options, fetchImpl: () => { throw new Error('unexpected repeated send'); } })).skipped, true);
});

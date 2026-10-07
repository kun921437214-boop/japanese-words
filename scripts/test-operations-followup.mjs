import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileKV } from '../server/file-kv.mjs';
import { FOLLOWUP_STATE_KEY, collectFollowupIssues, reconcileOperationsFollowup, verifyOperationsFollowupResult } from '../server/operations-followup.mjs';
import { copyKv } from '../server/copy-kv.mjs';
import { collectOperationsReport, formatOperationsReport, runOperationsReport } from '../server/operations-report.mjs';
import { runWeeklyContentCheck, isNonUrgentWeeklyGap } from '../server/weekly-content-check.mjs';
import { runDailyOperationsHealthCheck } from '../worker/favorites-worker.js';
import { getWeeklyContentWindow } from '../shared/weekly-content-health.mjs';

const now = new Date('2026-10-06T07:10:00Z');
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/placeholder-test-only';
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-followup-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function report(overrides = {}) {
  return { dateKey: '2026-10-06', checkedAt: now.toISOString(), status: 'attention', problems: ['today_content_incomplete'],
    today: { dateKey: '2026-10-06', words: 0, cards: 0, images: 0 },
    tomorrow: { targetDateKey: '2026-10-07', status: 'pending' },
    weekly: { targetWeekStart: '2026-10-12', targetWeekEnd: '2026-10-18', status: 'healthy', days: [] }, ...overrides };
}
function scheduler(submitToOwner) {
  return { kind: 'supported_codex', authorized: true, atomicOwnerQueue: true, durableIdempotency: true, submitToOwner };
}

test('healthy report creates no followup directory, no task, and no empty owner job', async t => {
  const root = await temporary(t); const followupDirectory = path.join(root, 'not-created');
  const result = await reconcileOperationsFollowup(report({ status: 'healthy', problems: [] }), { followupDirectory,
    codexScheduler: scheduler(() => { throw new Error('must not schedule'); }) });
  assert.equal(result.status, 'not_required'); await assert.rejects(stat(followupDirectory), { code: 'ENOENT' });
});

test('unavailable or unauthorized scheduler persists concrete gaps as explicitly not dispatched', async t => {
  const followupDirectory = await temporary(t);
  const gaps = report({ problems: ['next_week_check_failed'], weekly: { targetWeekStart: '2026-10-12', targetWeekEnd: '2026-10-18',
    days: getWeeklyContentWindow(now).targetDateKeys.map(dateKey => ({ dateKey, valid: false, words: 0, cards: 0, images: 0, reasons: ['draft_missing'] })) } });
  assert.equal(collectFollowupIssues(gaps).length, 7);
  const result = await reconcileOperationsFollowup(gaps, { followupDirectory });
  assert.equal(result.status, 'not_dispatched'); assert.equal(result.dispatched, false);
  const kv = new FileKV(followupDirectory);
  const stored = await kv.get(FOLLOWUP_STATE_KEY, 'json');
  assert.equal(Object.keys(stored.issues).length, 7);
  assert.deepEqual(stored.issues['2026-10-12:weekly-content'].details.missing, { words: 10, cards: 10, images: 10 });
  assert.equal((await stat(kv.fileForKey(FOLLOWUP_STATE_KEY))).mode & 0o777, 0o600);
});

test('stable date/type dedup survives restart; updates append to one authoritative owner task', async t => {
  const followupDirectory = await temporary(t); const requests = [];
  const codexScheduler = scheduler(async request => {
    requests.push(request); return { accepted: true, requestId: request.requestId, mode: requests.length === 1 ? 'created' : 'appended', taskId: 'official-owner-task' };
  });
  assert.equal((await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler })).mode, 'created');
  assert.equal((await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler })).status, 'already_dispatched');
  const changed = report({ today: { dateKey: '2026-10-06', words: 4, cards: 0, images: 0 }, problems: ['today_content_incomplete', 'tomorrow_check_not_confirmed'] });
  assert.equal((await reconcileOperationsFollowup(changed, { followupDirectory, codexScheduler })).mode, 'appended');
  assert.equal(requests.length, 2); assert.equal(requests[0].owner, requests[1].owner);
  assert.equal(requests[1].issues[0].key, '2026-10-06:today-content');
  assert.ok(requests[0].scope.humanBoundaries.includes('password_or_QR_or_OAuth_login'));
  assert.ok(requests[0].scope.forbiddenActions.includes('unapproved_production_mutation'));
});

test('ambiguous dispatch retries exactly the same request identity and never claims creation', async t => {
  const followupDirectory = await temporary(t); const ids = [];
  const failed = scheduler(async request => { ids.push(request.requestId); throw new Error('timeout'); });
  const first = await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler: failed });
  assert.equal(first.dispatched, false); assert.equal(first.reason, 'codex_dispatch_not_confirmed');
  const accepted = scheduler(async request => { ids.push(request.requestId); return { requestId: request.requestId, accepted: true, mode: 'appended', taskId: 'already-created-task' }; });
  assert.equal((await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler: accepted })).dispatched, true);
  assert.equal(ids[0], ids[1]);
});

test('cross-process owner lock prevents overlapping dispatch and is not stolen', async t => {
  const followupDirectory = await temporary(t);
  await writeFile(path.join(followupDirectory, 'owner.lock'), 'existing-owner');
  const result = await reconcileOperationsFollowup(report(), { followupDirectory,
    codexScheduler: scheduler(() => { throw new Error('concurrent dispatch'); }) });
  assert.equal(result.reason, 'owner_lock_busy');
  assert.equal(await readFile(path.join(followupDirectory, 'owner.lock'), 'utf8'), 'existing-owner');
});

test('overlapping callers cannot submit another owner task while the first dispatcher is running', async t => {
  const followupDirectory = await temporary(t);
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const codexScheduler = scheduler(async request => {
    calls++; started(); await waiting;
    return { accepted: true, requestId: request.requestId, mode: 'created', taskId: 'one-task' };
  });
  const first = reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler });
  await entered;
  const second = await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler });
  assert.equal(second.reason, 'owner_lock_busy'); assert.equal(calls, 1);
  release(); assert.equal((await first).taskId, 'one-task');
});

test('unconfirmed acknowledgement and unknown report issue never become successful followup', async t => {
  const followupDirectory = await temporary(t);
  const result = await reconcileOperationsFollowup(report({ problems: ['new_future_problem'] }), { followupDirectory,
    codexScheduler: scheduler(async () => ({ accepted: true, mode: 'created', taskId: 'missing-request-ack' })) });
  assert.equal(result.dispatched, false);
  const stored = await new FileKV(followupDirectory).get(FOLLOWUP_STATE_KEY, 'json');
  assert.equal(stored.issues['2026-10-06:unclassified-issue'].status, 'pending');
});

test('task completion needs authenticated receipt, fresh matching-window recheck, and cleared issues', async t => {
  const followupDirectory = await temporary(t);
  const codexScheduler = { ...scheduler(async request => ({ accepted: true, requestId: request.requestId, mode: 'created', taskId: 'task' })), verifyTaskReceipt: async receipt => receipt.taskId === 'task' };
  await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler });
  const receipt = { taskId: 'task', outcome: 'repaired', completedAt: now.toISOString(), humanBlockers: [] };
  const options = { followupDirectory, codexScheduler, recheck: async () => report({ checkedAt: new Date(now.getTime() + 1000).toISOString() }) };
  assert.equal((await verifyOperationsFollowupResult(receipt, options)).status, 'verification_failed');
  assert.equal((await verifyOperationsFollowupResult({ ...receipt, taskId: 'wrong' }, options)).reason, 'task_receipt_not_authenticated');
  assert.equal((await verifyOperationsFollowupResult(receipt, { ...options, recheck: async () => report({ status: 'healthy', problems: [], checkedAt: new Date(now.getTime() - 1000).toISOString() }) })).reason, 'fresh_post_repair_check_required');
  const passed = await verifyOperationsFollowupResult(receipt, { ...options, recheck: async () => report({ status: 'healthy', problems: [], checkedAt: new Date(now.getTime() + 1000).toISOString() }) });
  assert.equal(passed.resolved, true); assert.deepEqual(passed.resolvedKeys, ['2026-10-06:today-content']);
});

test('followup journal round-trips through the existing full-KV backup/restore copy path', async t => {
  const root = await temporary(t); const workflowKv = new FileKV(path.join(root, 'workflow'));
  await reconcileOperationsFollowup(report(), { workflowKv });
  const backup = new FileKV(path.join(root, 'backup'));
  const keys = await copyKv(workflowKv, backup, { reportListedKeys: true });
  assert.ok(keys.includes(FOLLOWUP_STATE_KEY));
  const restored = new FileKV(path.join(root, 'restored')); await copyKv(backup, restored);
  assert.deepEqual(await restored.get(FOLLOWUP_STATE_KEY, 'json'), await workflowKv.get(FOLLOWUP_STATE_KEY, 'json'));
});

test('human-login blocker remains open and missing result transport never claims repaired', async t => {
  const followupDirectory = await temporary(t);
  assert.equal((await verifyOperationsFollowupResult({}, { followupDirectory })).status, 'not_verified');
  const codexScheduler = { ...scheduler(async request => ({ accepted: true, requestId: request.requestId, mode: 'created', taskId: 'task' })), verifyTaskReceipt: async () => true };
  await reconcileOperationsFollowup(report(), { followupDirectory, codexScheduler });
  const result = await verifyOperationsFollowupResult({ taskId: 'task', completedAt: now.toISOString(), outcome: 'blocked', humanBlockers: ['OAuth本人登录'] },
    { followupDirectory, codexScheduler, recheck: async () => report() });
  assert.equal(result.status, 'human_action_required'); assert.equal(result.resolved, false);
});

test('weekly check still stores all 70 gaps, Chinese daily contains every date, and dispatch is separate from Feishu', async t => {
  const root = await temporary(t); const workflowKv = new FileKV(path.join(root, 'workflow'));
  let calls = 0;
  const checked = await runWeeklyContentCheck({ now, workflowKv, imageKv: new FileKV(path.join(root, 'images')), alertUrl: webhook,
    fetchImpl: async () => { calls++; return Response.json({ code: 0 }); } });
  assert.equal(checked.status, 'unhealthy'); assert.equal(checked.days.length, 7); assert.equal(calls, 0);
  const options = { now, workflowKv, backup: null, followupDirectory: path.join(root, 'followup'), send: true,
    env: { OPS_ALERT_WEBHOOK_URL: webhook }, fetchImpl: async () => { calls++; return Response.json({ code: 0 }); } };
  const result = await runOperationsReport(options);
  assert.equal(result.notification.sent, true); assert.equal(result.followup.dispatched, false);
  assert.equal(result.followup.reason, 'supported_codex_scheduler_unavailable'); assert.equal(calls, 1);
  const text = formatOperationsReport(await collectOperationsReport(options));
  assert.equal((text.match(/还缺10个词、10张词卡、10张可读取配图/g) || []).length, 7);
  const stored = await workflowKv.get('operations-health:report:2026-10-06', 'json');
  assert.equal(stored.notification.sent, true); assert.equal(stored.followup.dispatched, false);
  const retried = await runOperationsReport(options);
  assert.equal(retried.skipped, true); assert.equal(calls, 1);
});

test('same-day urgent health alert still sends and records failure', async t => {
  const root = await temporary(t); const kv = new FileKV(path.join(root, 'workflow')); let calls = 0;
  await assert.rejects(runDailyOperationsHealthCheck({ FAVORITES: kv, OPS_ALERT_WEBHOOK_URL: webhook }, { now,
    kind: 'today-snapshot', fetchImpl: async () => { calls++; return Response.json({ code: 0 }); } }), /health check failed/);
  assert.equal(calls, 1);
  const stored = await kv.get('operations-health:daily:today-snapshot:2026-10-06', 'json');
  assert.equal(stored.notification.sent, true); assert.equal(stored.status, 'unhealthy');
});

test('weekly quality errors and current-day gaps remain alert eligible; force recheck bypasses prior success', async t => {
  const record = { status: 'unhealthy', targetWeekStart: '2026-10-12', days: Array.from({ length: 7 }, () => ({ valid: false, reasons: ['draft_missing'] })) };
  assert.equal(isNonUrgentWeeklyGap(record, now), true);
  assert.equal(isNonUrgentWeeklyGap({ ...record, targetWeekStart: '2026-10-06' }, now), false);
  assert.equal(isNonUrgentWeeklyGap({ ...record, days: [{ valid: false, reasons: ['validation_errors'] }, ...record.days.slice(1)] }, now), false);
  const root = await temporary(t); const kv = new FileKV(root); const window = getWeeklyContentWindow(now);
  await kv.put(`operations-health:weekly:next-week:${window.runWeekStart}`, JSON.stringify({ ...window, status: 'healthy', days: window.targetDateKeys.map(targetDateKey => ({ targetDateKey, valid: true })) }));
  const result = await runWeeklyContentCheck({ now, workflowKv: kv, imageKv: kv, forceRecheck: true, alertUrl: '' });
  assert.equal(result.status, 'unhealthy'); assert.equal(result.days.length, 7); assert.equal(result.skipped, undefined);
});

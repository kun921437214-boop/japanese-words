import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { runCodexClientOperation, prepareCodexClientInput } from './lib/codex-operation-client.mjs';
import { codexOperationStorageKey } from '../shared/codex-operation.mjs';
import { onRequest as image } from '../functions/codex-image.js';
import { onRequest as daily } from '../functions/codex-daily.js';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { assertTencentSingleProcess } from '../server/tencent-runtime.mjs';
import { makeDraft } from './test-helpers/codex-operation-draft.mjs';

const exec = promisify(execFile), bytes = new Uint8Array([1, 2, 3, 4]);
const date = '2026-07-14', token = 'offline-unit-secret-do-not-store';
function fixture() {
  const values = new Map(), images = new Map(), calls = [];
  const kv = { async get(key, type) { const v = values.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { values.set(key, value); } };
  const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: {
    async getWithMetadata(key) { return images.get(key) || null; },
    async put(key, value, options) { images.set(key, { value, metadata: options.metadata }); }
  }, WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), CODEX_AUTOMATION_SECRET: token };
  const request = async (url, options = {}) => {
    const req = new Request(url, options), parsed = new URL(url);
    calls.push({ method: req.method, operationId: req.headers.get('X-Operation-Id') || parsed.searchParams.get('operationId') });
    const response = await (parsed.pathname === '/codex-image' ? image : daily)({ request: req, env });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('fixture response'), { status: response.status, data });
    return data;
  };
  return { request, calls, values, images, env };
}
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-client-unit-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function input(kind, root, request, extra = {}) {
  return { kind, journalDirectory: path.join(root, 'operations'), request, attempts: 1, retryDelayMs: 0,
    url: `https://fixture.invalid/codex-${kind === 'image' ? 'image' : 'daily'}?date=${date}&word=モヤる`,
    options: { headers: { Authorization: `Bearer ${token}`, 'Content-Type': kind === 'image' ? 'image/webp' : 'application/json' },
      body: kind === 'image' ? bytes : JSON.stringify(makeDraft()) }, ...extra };
}
const log = root => JSON.parse(fs.readFileSync(path.join(root, 'operations', fs.readdirSync(path.join(root, 'operations')).find(x => x.endsWith('.json')))));

test('startup rejects declared workers; this does not prove production has one process', () => {
  assert.doesNotThrow(() => assertTencentSingleProcess({ env: { JAPANESE_WORDS_RUNTIME_PROCESSES: '1' }, clusterWorker: false }));
  for (const env of [{ JAPANESE_WORDS_RUNTIME_PROCESSES: '2' }, { WEB_CONCURRENCY: '4' }]) {
    assert.throws(() => assertTencentSingleProcess({ env, clusterWorker: false }), /SINGLE_TENCENT_SERVER_PROCESS_REQUIRED/);
  }
  assert.throws(() => assertTencentSingleProcess({ env: {}, clusterWorker: true }), /SINGLE_TENCENT_SERVER_PROCESS_REQUIRED/);
});

test('client transient absent-effect failure retries only after GET, using the original ID', async t => {
  const root = await directory(t), f = fixture(), methods = []; let failed = false;
  const request = async (url, options) => {
    methods.push(options.method);
    if (options.method === 'PUT' && !failed) { failed = true; throw Object.assign(new Error('before effect'), { status: 503 }); }
    return f.request(url, options);
  };
  const result = await runCodexClientOperation(input('image', root, request, { attempts: 2 }));
  assert.deepEqual(methods, ['GET', 'PUT', 'GET', 'GET', 'PUT', 'GET']);
  assert.ok(f.calls.every(call => call.operationId === result.operation.operationId));
});

test('client rejected 422 draft retains the verified receipt and never resubmits it', async t => {
  const root = await directory(t), f = fixture(), a = input('draft', root, f.request);
  a.options.body = JSON.stringify({ ...makeDraft(), items: [] });
  await assert.rejects(runCodexClientOperation(a), error => error.status === 422);
  const id = log(root).operationId;
  await assert.rejects(runCodexClientOperation(a), error => error.status === 422);
  assert.equal(log(root).operationId, id); assert.equal(log(root).state, 'complete');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('client restored local journal preserves IDs and queries existing backend effects without PUT', async t => {
  const root = await directory(t), f = fixture();
  await runCodexClientOperation(input('image', root, f.request));
  const changed = input('image', root, f.request, { newOperation: true, operationId: 'approved-version-2' });
  changed.options.body = new Uint8Array([8]); await runCodexClientOperation(changed);
  const backup = path.join(root, 'backup'), restored = path.join(root, 'restored');
  fs.cpSync(path.join(root, 'operations'), backup, { recursive: true });
  fs.mkdirSync(restored, { mode: 0o700 }); fs.cpSync(backup, path.join(restored, 'operations'), { recursive: true });
  // Generic copies may create 0755 directories. Restore the documented private
  // directory/file modes before admitting the journal to a real CLI invocation.
  const privatize = directory => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) privatize(file); else fs.chmodSync(file, 0o600);
    }
  };
  privatize(backup); privatize(path.join(restored, 'operations'));
  const count = f.calls.length;
  const result = await runCodexClientOperation({ ...changed, journalDirectory: path.join(restored, 'operations') });
  assert.equal(result.operation.operationId, 'approved-version-2');
  assert.deepEqual(f.calls.slice(count).map(call => call.method), ['GET']);
  assert.equal(fs.readdirSync(path.join(restored, 'operations/history')).length, 1);
  assert.equal(fs.statSync(path.join(restored, 'operations')).mode & 0o777, 0o700);
});

test('client new-operation without a fixed explicit ID fails before any request or journal creation', async t => {
  const root = await directory(t), f = fixture();
  await assert.rejects(runCodexClientOperation(input('image', root, f.request, { newOperation: true })), /NEW_OPERATION_REQUIRES_EXPLICIT_ID/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(root, 'operations')), false);
});

test('client journals omit token, full draft and image bytes; receipts keep only backend summaries', async t => {
  const root = await directory(t), f = fixture(), a = input('draft', root, f.request);
  a.options.body = JSON.stringify({ ...makeDraft(), notes: 'private-full-draft-sentinel-7' });
  await runCodexClientOperation(a);
  const text = JSON.stringify(log(root));
  assert.ok(!text.includes(token)); assert.ok(!text.includes('private-full-draft-sentinel-7'));
  assert.equal(log(root).receipt.result.draft.items, undefined);
  const imageRoot = path.join(root, 'image');
  await runCodexClientOperation(input('image', imageRoot, f.request));
  assert.equal(log(imageRoot).payload, undefined); assert.equal(log(imageRoot).body, undefined);
});

for (const kind of ['image', 'draft']) {
  test(`client ${kind}: restarted invocation reuses durable ID and backend-normalized digest`, async t => {
    const root = await directory(t), f = fixture();
    const first = await runCodexClientOperation(input(kind, root, f.request));
    const second = await runCodexClientOperation(input(kind, root, f.request));
    assert.equal(first.operation.operationId, second.operation.operationId);
    assert.equal(first.operation.inputSha256, (await prepareCodexClientInput(input(kind, root, f.request).url, input(kind, root, f.request).options, kind)).inputSha256);
    assert.deepEqual(f.calls.map(x => x.method), ['GET', 'PUT', 'GET', 'GET']);
    assert.equal(log(root).state, 'complete');
    assert.ok(!JSON.stringify(log(root)).includes(token));
    assert.equal(fs.statSync(path.join(root, 'operations')).mode & 0o777, 0o700);
  });
  test(`client ${kind}: lost response and unavailable query retain ID; next invocation queries before writing`, async t => {
    const root = await directory(t), f = fixture(); let lost = false;
    const unreliable = async (url, options) => {
      if (options.method === 'GET' && lost) throw new Error('injected network failure');
      const result = await f.request(url, options);
      if (options.method === 'PUT') { lost = true; throw new Error('lost response'); }
      return result;
    };
    await assert.rejects(runCodexClientOperation(input(kind, root, unreliable)), /injected/);
    const id = log(root).operationId; assert.equal(log(root).state, 'unknown');
    const result = await runCodexClientOperation(input(kind, root, f.request));
    assert.equal(result.operation.operationId, id); assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
    assert.equal(f.calls.at(-1).method, 'GET');
  });
  test(`client ${kind}: changed payload resolves old ID then rejects without silently replacing it`, async t => {
    const root = await directory(t), f = fixture(); await runCodexClientOperation(input(kind, root, f.request));
    const id = log(root).operationId;
    const changed = input(kind, root, f.request);
    changed.options.body = kind === 'image' ? new Uint8Array([9]) : JSON.stringify({ ...makeDraft(), notes: 'changed payload' });
    await assert.rejects(runCodexClientOperation(changed), /CLIENT_PAYLOAD_CONFLICT/);
    assert.equal(log(root).operationId, id); assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
    assert.equal(f.calls.at(-1).method, 'GET');
  });
  test(`client ${kind}: explicit approved new ID after resolved result is restart-idempotent`, async t => {
    const root = await directory(t), f = fixture(); await runCodexClientOperation(input(kind, root, f.request));
    const changed = input(kind, root, f.request, { newOperation: true, operationId: 'approved-repair-version-2' });
    changed.options.body = kind === 'image' ? new Uint8Array([9]) : JSON.stringify({ ...makeDraft(), notes: 'approved repair' });
    const result = await runCodexClientOperation(changed), again = await runCodexClientOperation(changed);
    assert.equal(result.operation.operationId, 'approved-repair-version-2'); assert.equal(again.operation.operationId, result.operation.operationId);
    assert.equal(f.calls.filter(x => x.method === 'PUT').length, 2);
    assert.equal(fs.readdirSync(path.join(root, 'operations/history')).length, 1);
  });
}
test('client draft canonical object order, nested Unicode/null/arrays and body metadata match backend', async t => {
  const root = await directory(t), f = fixture(), payload = { ...makeDraft(), extra: { b: null, a: ['猫', 2] }, operationId: 'legacy-body-only' };
  const a = input('draft', root, f.request); a.options.body = JSON.stringify(payload);
  const first = await runCodexClientOperation(a);
  a.options.body = JSON.stringify(Object.fromEntries(Object.entries({ ...payload, operationId: 'other-legacy-field' }).reverse()));
  const second = await runCodexClientOperation(a);
  assert.equal(first.operation.inputSha256, second.operation.inputSha256); assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('client pending/unknown effect and unsupported old server never authorize a PUT', async t => {
  const root = await directory(t); let puts = 0;
  const request = async (_url, options) => { if (options.method === 'PUT') puts++; return { draft: { status: 'missing' } }; };
  await assert.rejects(runCodexClientOperation(input('image', root, request)), /CODEX_OPERATION_PROTOCOL_UNAVAILABLE/);
  const state = log(root);
  const pending = async () => ({ operation: { ...state, status: 'pending', authoritative: true, currentEffect: 'unknown' } });
  await assert.rejects(runCodexClientOperation(input('image', root, pending)), /REMOTE_OPERATION_STATE_UNRESOLVED/);
  assert.equal(puts, 0); assert.equal(log(root).operationId, state.operationId);
});
test('client unresolved operation cannot rotate, even under an explicit new-ID request', async t => {
  const root = await directory(t), f = fixture();
  const failing = async (url, options) => { if (options.method === 'PUT') throw new Error('before remote write'); return f.request(url, options); };
  await assert.rejects(runCodexClientOperation(input('image', root, failing)), /REMOTE_OPERATION_STATE_UNRESOLVED/);
  const old = log(root).operationId;
  await assert.rejects(runCodexClientOperation(input('image', root, f.request, { operationId: 'new-id', newOperation: true })), /PREVIOUS_OPERATION_NOT_RESOLVED/);
  assert.equal(log(root).operationId, old); assert.equal(f.calls.filter(x => x.method === 'PUT').length, 0);
});
test('client missing remote history for a locally complete ID stops instead of uploading again', async t => {
  const root = await directory(t), f = fixture(); await runCodexClientOperation(input('image', root, f.request));
  const id = log(root).operationId; f.values.delete(codexOperationStorageKey('global', id));
  await assert.rejects(runCodexClientOperation(input('image', root, f.request)), /OPERATION_HISTORY_MISSING/);
  assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('client receipt digest/identity mismatch is rejected without a PUT', async t => {
  const root = await directory(t), f = fixture(); await runCodexClientOperation(input('image', root, f.request));
  const request = async (url, options) => { const result = await f.request(url, options); result.operation.resultSha256 = '0'.repeat(64); return result; };
  await assert.rejects(runCodexClientOperation(input('image', root, request)), /REMOTE_OPERATION_RESULT_UNVERIFIED/);
  assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('client corrupt local journal stops without making any network request', async t => {
  const root = await directory(t), f = fixture(); await runCodexClientOperation(input('image', root, f.request));
  const file = path.join(root, 'operations', fs.readdirSync(path.join(root, 'operations')).find(x => x.endsWith('.json')));
  fs.writeFileSync(file, '{invalid'); const count = f.calls.length;
  await assert.rejects(runCodexClientOperation(input('image', root, f.request)), /CLIENT_JOURNAL_CORRUPT/); assert.equal(f.calls.length, count);
});
test('client lock serializes local journal owners, not multiple backend server processes', async t => {
  const root = await directory(t), f = fixture(); let entered, release;
  const gate = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const request = async (url, options) => { entered(); await hold; return f.request(url, options); };
  const first = runCodexClientOperation(input('image', root, request)); await gate;
  await assert.rejects(runCodexClientOperation(input('image', root, f.request)), /CLIENT_OPERATION_BUSY/);
  release(); await first; assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('client changing a completed target reports current-effect conflict without recreating it', async t => {
  const root = await directory(t), f = fixture(); await runCodexClientOperation(input('image', root, f.request)); f.images.clear();
  await assert.rejects(runCodexClientOperation(input('image', root, f.request)), /COMPLETED_EFFECT_NOT_CURRENT/);
  assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});

async function cliRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-client-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'image.webp'), bytes);
  fs.writeFileSync(path.join(root, 'draft.json'), JSON.stringify(makeDraft()));
  fs.writeFileSync(path.join(root, '.env.codex-daily'), 'THIS_FAKE_FILE_MUST_NOT_BE_READ=sentinel');
  return root;
}
function cli(root, command, crash = '', extras = []) {
  const args = ['--import', fileURLToPath(new URL('./test-helpers/codex-client-transport.mjs', import.meta.url)),
    fileURLToPath(new URL('./codex-daily.mjs', import.meta.url)), command, '--site', 'https://fixture.invalid', '--date', date,
    '--output', path.join(root, 'output'), '--confirm-submit', ...extras];
  if (command === 'upload-image') args.push('--file', path.join(root, 'image.webp'), '--word', 'モヤる');
  else args.push('--draft', path.join(root, 'draft.json'));
  return exec(process.execPath, args, { cwd: root, env: { ...process.env, CODEX_AUTOMATION_SECRET: 'offline-cli-secret',
    CODEX_DAILY_ENV_FILE: path.join(root, 'deliberately-nonexistent-env'), CODEX_CLIENT_TEST_ROOT: root, CODEX_CLIENT_TEST_CRASH: crash } });
}
for (const command of ['upload-image', 'submit']) {
  for (const phase of ['before-put', 'after-put']) {
    test(`actual CLI ${command}: process exit ${phase}, resumed CLI uses same ID and GET before PUT`, async t => {
      const root = await cliRoot(t);
      await assert.rejects(cli(root, command, phase), error => error.code === 73);
      const journalRoot = path.join(root, 'output'); const id = log(journalRoot).operationId;
      await cli(root, command);
      const calls = fs.readFileSync(path.join(root, 'transport.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(calls.filter(x => x.method === 'PUT').every(x => x.operationId === id));
      assert.equal(calls[2].method, 'GET');
      assert.equal(calls.filter(x => x.method === 'PUT').length, phase === 'after-put' ? 1 : 2);
      assert.equal(log(journalRoot).state, 'complete');
      assert.ok(!JSON.stringify(log(journalRoot)).includes('offline-cli-secret'));
    });
  }
}
test('actual batch CLI resumes first lost result and uploads each remaining image once', async t => {
  const root = await cliRoot(t), images = path.join(root, 'images'); fs.mkdirSync(images);
  makeDraft().items.forEach((item, index) => fs.writeFileSync(path.join(images, String(index + 1).padStart(2, '0') + '-' + item.kanji + '.webp'), bytes));
  await assert.rejects(cli(root, 'upload-images', 'after-put', ['--images-dir', images]), error => error.code === 73);
  await cli(root, 'upload-images', '', ['--images-dir', images]);
  const calls = fs.readFileSync(path.join(root, 'transport.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const putIds = calls.filter(x => x.method === 'PUT').map(x => x.operationId);
  assert.equal(putIds.length, 10); assert.equal(new Set(putIds).size, 10);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'draft.json'))).items.every(item => item.aiCard.referenceImage.status === 'ready'));
});

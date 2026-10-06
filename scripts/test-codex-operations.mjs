import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { onRequest as image } from '../functions/codex-image.js';
import { onRequest as daily } from '../functions/codex-daily.js';
import { FileKV } from '../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { codexOperationStorageKey, codexValueSha256 } from '../shared/codex-operation.mjs';
import { getCodexDraftStorageKey } from '../shared/codex-daily-draft.mjs';
import { makeDraft } from './test-helpers/codex-operation-draft.mjs';

// No HTTP listener, credential files, generation or production data.
globalThis.fetch = () => { throw new Error('OFFLINE_OPERATIONS_TEST_NETWORK_FORBIDDEN'); };
const runChild = promisify(execFile);
const imageBytes = new Uint8Array([1, 2, 3, 4]);
const date = '2026-07-14';
const draftKey = getCodexDraftStorageKey(date);
function fixture(fault = async () => {}) {
  const values = new Map(), objects = new Map(), writes = [];
  const kv = {
    async get(key, type) {
      await fault('read', key);
      const raw = values.get(key);
      return raw === undefined ? null : type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      await fault('before', key, value); values.set(key, value); writes.push(key);
      await fault('after', key, value);
    }
  };
  const images = {
    async getWithMetadata(key) { await fault('read-image', key); return objects.get(key) || null; },
    async put(key, bytes, options) {
      await fault('before-image', key); objects.set(key, { value: bytes, metadata: options.metadata });
      writes.push('image:' + key); await fault('after-image', key);
    }
  };
  const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: images,
    WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), ALLOW_INSECURE_LOCAL_DEV: 'true' };
  return { env, values, objects, writes, imageWrites: () => writes.filter(key => key.startsWith('image:')).length,
    draftWrites: () => writes.filter(key => key === draftKey).length };
}
async function put(env, kind, id, payload, query = '') {
  const request = new Request(`http://localhost/codex-${kind === 'image' ? 'image' : 'daily'}?date=${date}&word=モヤる${query}`, {
    method: 'PUT', headers: { 'Content-Type': kind === 'image' ? 'image/webp' : 'application/json',
      ...(id === null ? {} : { 'X-Operation-Id': id }) },
    body: kind === 'image' ? (payload || imageBytes) : JSON.stringify(payload ?? makeDraft())
  });
  const response = await (kind === 'image' ? image : daily)({ request, env });
  return { status: response.status, body: await response.json() };
}
async function lookup(env, kind, id, query = '') {
  const request = new Request(`http://localhost/codex-${kind === 'image' ? 'image' : 'daily'}?operationId=${encodeURIComponent(id)}${query}`);
  const response = await (kind === 'image' ? image : daily)({ request, env });
  return { status: response.status, body: await response.json() };
}
const resultWithoutTrace = body => { const { requestId: _trace, ...result } = body; return result; };

for (const kind of ['image', 'draft']) {
  test(`${kind}: sequential and concurrent identical IDs write one effect and return original result`, async () => {
    const f = fixture(), payload = kind === 'image' ? imageBytes : makeDraft();
    const responses = await Promise.all(Array.from({ length: 16 }, () => put(f.env, kind, 'same-operation', payload)));
    assert.ok(responses.every(response => response.status === 200));
    const first = resultWithoutTrace(responses[0].body);
    for (const response of responses) assert.deepEqual(resultWithoutTrace(response.body), first);
    assert.deepEqual(resultWithoutTrace((await put(f.env, kind, 'same-operation', payload)).body), first);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
    const state = (await lookup(f.env, kind, 'same-operation')).body.operation;
    assert.equal(state.status, 'complete'); assert.equal(state.currentEffect, 'complete');
    assert.equal(state.resultSha256, await codexValueSha256(state.result));
  });
  test(`${kind}: concurrent same ID with conflicting payload rejects one without another effect`, async () => {
    const f = fixture(), a = kind === 'image' ? imageBytes : makeDraft();
    const b = kind === 'image' ? new Uint8Array([7, 8]) : { ...a, notes: 'different payload' };
    const responses = await Promise.all([put(f.env, kind, 'conflicting-id', a), put(f.env, kind, 'conflicting-id', b)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(responses.find(response => response.status === 409).body.error.code, 'OPERATION_ID_CONFLICT');
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: before intent failure creates no effect; lookup is absent and retry can start`, async () => {
    let armed = true;
    const f = fixture(async (phase, key) => {
      if (armed && phase === 'before' && key.startsWith('codex-operation:')) { armed = false; throw new Error('injected'); }
    });
    assert.equal((await put(f.env, kind, 'before-intent')).status, 503);
    assert.equal((await lookup(f.env, kind, 'before-intent')).body.operation.status, 'absent');
    assert.equal(f.imageWrites() + f.draftWrites(), 0);
    assert.equal((await put(f.env, kind, 'before-intent')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: after intent failure is pending and retries saved intent without creating another effect`, async () => {
    let armed = true;
    const f = fixture(async (phase, key, value) => {
      if (armed && phase === 'after' && key.startsWith('codex-operation:') && JSON.parse(value).status === 'pending') {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'after-intent')).status, 503);
    const state = (await lookup(f.env, kind, 'after-intent')).body.operation;
    assert.equal(state.status, 'pending'); assert.equal(state.currentEffect, 'absent');
    assert.equal(f.imageWrites() + f.draftWrites(), 0);
    assert.equal((await put(f.env, kind, 'after-intent')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: effect failure before write is pending; retry writes once`, async () => {
    let armed = true;
    const f = fixture(async (phase, key) => {
      if (armed && ((kind === 'image' && phase === 'before-image')
          || (kind === 'draft' && phase === 'before' && key === draftKey))) {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'before-effect')).status, 503);
    assert.equal((await lookup(f.env, kind, 'before-effect')).body.operation.status, 'pending');
    assert.equal((await put(f.env, kind, 'before-effect')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: effect stored then error is reconciled by lookup without rewriting effect`, async () => {
    let armed = true;
    const f = fixture(async (phase, key) => {
      if (armed && ((kind === 'image' && phase === 'after-image')
          || (kind === 'draft' && phase === 'after' && key === draftKey))) {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'after-effect')).status, 503);
    const state = (await lookup(f.env, kind, 'after-effect')).body.operation;
    assert.equal(state.status, 'complete'); assert.equal(state.currentEffect, 'complete');
    const retry = await put(f.env, kind, 'after-effect'); assert.equal(retry.status, 200);
    assert.equal(retry.body.operation.resultSha256, state.resultSha256);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: completion record failure keeps pending intent and recovers without duplicate effect`, async () => {
    let armed = true;
    const f = fixture(async (phase, key, value) => {
      if (armed && phase === 'before' && key.startsWith('codex-operation:') && JSON.parse(value).status === 'complete') {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'failed-finish')).status, 503);
    assert.equal(JSON.parse(f.values.get(codexOperationStorageKey('global', 'failed-finish'))).status, 'pending');
    assert.equal((await put(f.env, kind, 'failed-finish')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: lost response after completed journal write returns original result without another effect`, async () => {
    let armed = true;
    const f = fixture(async (phase, key, value) => {
      if (armed && phase === 'after' && key.startsWith('codex-operation:') && JSON.parse(value).status === 'complete') {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'lost-final-response')).status, 503);
    assert.equal((await lookup(f.env, kind, 'lost-final-response')).body.operation.status, 'complete');
    assert.equal((await put(f.env, kind, 'lost-final-response')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: changed payload cannot take over an interrupted pending ID`, async () => {
    let armed = true;
    const f = fixture(async (phase, key) => {
      if (armed && ((kind === 'image' && phase === 'before-image') || (kind === 'draft' && phase === 'before' && key === draftKey))) {
        armed = false; throw new Error('injected');
      }
    });
    assert.equal((await put(f.env, kind, 'pending-conflict')).status, 503);
    const changed = kind === 'image' ? new Uint8Array([9]) : { ...makeDraft(), notes: 'change pending payload' };
    assert.equal((await put(f.env, kind, 'pending-conflict', changed)).status, 409);
    assert.equal(f.imageWrites() + f.draftWrites(), 0);
    assert.equal((await put(f.env, kind, 'pending-conflict')).status, 200);
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: unreadable journal or malformed record never proves absence or writes another effect`, async () => {
    const f = fixture(); await put(f.env, kind, 'corrupt-journal');
    const key = codexOperationStorageKey('global', 'corrupt-journal');
    for (const corrupted of ['{invalid', 'null', JSON.stringify({ schemaVersion: 1 })]) {
      f.values.set(key, corrupted);
      assert.equal((await lookup(f.env, kind, 'corrupt-journal')).body.error.code, 'CODEX_OPERATION_RECORD_CORRUPT');
      assert.equal((await put(f.env, kind, 'corrupt-journal')).status, 503);
    }
    assert.equal(kind === 'image' ? f.imageWrites() : f.draftWrites(), 1);
  });
  test(`${kind}: no serialized coordinator rejects opt-in but old no-ID client still works`, async () => {
    const f = fixture(); delete f.env.WORKFLOW_COORDINATOR;
    const result = await put(f.env, kind, 'no-coordinator');
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'CODEX_OPERATION_COORDINATOR_REQUIRED');
    assert.equal(f.writes.length, 0);
    const old = await put(f.env, kind, null); assert.equal(old.status, 200); assert.equal(old.body.operation, undefined);
  });
  for (const phase of ['before-effect', 'after-effect']) {
    test(`${kind}: real child exit ${phase}, FileKV restart query and retry do not duplicate effects`, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'codex-idempotency-crash-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await assert.rejects(runChild(process.execPath, [fileURLToPath(new URL('./test-helpers/codex-operation-crash.mjs', import.meta.url)),
        root, kind, phase]), error => error.code === 73);
      const kv = new FileKV(path.join(root, 'workflow')), imageKv = new FileKV(path.join(root, 'images'));
      const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: imageKv, WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv),
        ALLOW_INSECURE_LOCAL_DEV: 'true' };
      let effectWrites = 0;
      const binding = kind === 'image' ? imageKv : kv, original = binding.put.bind(binding);
      binding.put = async (key, ...args) => {
        if (kind === 'image' || key === draftKey) effectWrites++;
        return original(key, ...args);
      };
      const state = (await lookup(env, kind, 'crash-operation')).body.operation;
      assert.equal(state.status, phase === 'before-effect' ? 'pending' : 'complete');
      let priorEffectHash = '';
      const effectKey = kind === 'image' ? state.result?.key : draftKey;
      if (phase === 'after-effect') priorEffectHash = createHash('sha256').update(await readFile(binding.fileForKey(effectKey))).digest('hex');
      const retry = await put(env, kind, 'crash-operation'); assert.equal(retry.status, 200);
      assert.equal(effectWrites, phase === 'before-effect' ? 1 : 0);
      if (phase === 'after-effect') assert.equal(createHash('sha256').update(await readFile(binding.fileForKey(effectKey))).digest('hex'), priorEffectHash);
      assert.equal((await lookup(env, kind, 'crash-operation')).body.operation.status, 'complete');
    });
  }
}
test('same operation ID across endpoint kinds conflicts instead of reusing another result', async () => {
  const f = fixture(); assert.equal((await put(f.env, 'image', 'cross-kind')).status, 200);
  assert.equal((await put(f.env, 'draft', 'cross-kind')).status, 409);
  assert.equal((await lookup(f.env, 'draft', 'cross-kind')).status, 409); assert.equal(f.draftWrites(), 0);
});
test('scopes isolate IDs and deterministic image keys', async () => {
  const f = fixture(), a = await put(f.env, 'image', 'scoped-id'), b = await put(f.env, 'image', 'scoped-id', imageBytes, '&code=another_scope');
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.body.key, b.body.key);
});
test('draft canonical JSON key order and matching header/body ID produce same result', async () => {
  const f = fixture(), payload = makeDraft();
  const a = await put(f.env, 'draft', 'canonical-id', payload);
  const b = await put(f.env, 'draft', 'canonical-id', { operationId: 'canonical-id', ...Object.fromEntries(Object.entries(payload).reverse()) });
  assert.deepEqual(resultWithoutTrace(a.body), resultWithoutTrace(b.body)); assert.equal(f.draftWrites(), 1);
});
test('body-only legacy operationId remains stored metadata; mismatching opt-in header rejects', async () => {
  const f = fixture(), payload = { ...makeDraft(), operationId: 'old-client-metadata' };
  assert.equal((await put(f.env, 'draft', null, payload)).status, 200);
  assert.equal(JSON.parse(f.values.get(draftKey)).operationId, 'old-client-metadata');
  assert.equal((await put(f.env, 'draft', 'another-id', payload)).body.error.code, 'OPERATION_ID_MISMATCH');
  assert.equal(f.draftWrites(), 1);
});
test('legacy no-ID image uploads keep random keys and legacy response shape', async () => {
  const f = fixture(), a = await put(f.env, 'image', null), b = await put(f.env, 'image', null);
  assert.notEqual(a.body.key, b.body.key); assert.equal(a.body.operation, undefined); assert.equal(f.imageWrites(), 2);
});
test('invalid IDs and unauthenticated operation lookup are rejected before storage writes', async () => {
  const f = fixture();
  for (const id of ['', 'bad id', 'x'.repeat(121)]) {
    assert.equal((await put(f.env, 'image', id)).status, 400);
    assert.equal((await lookup(f.env, 'draft', id)).status, 400);
  }
  f.env.ALLOW_PUBLIC_APP = 'true';
  assert.equal((await lookup(f.env, 'image', 'private-operation')).status, 403);
  assert.equal((await lookup(f.env, 'draft', 'private-operation')).status, 403);
  assert.equal(f.writes.length, 0);
});
test('later draft update remains intact when an old complete ID is retried', async () => {
  const f = fixture(), payload = makeDraft(), first = await put(f.env, 'draft', 'old-complete', payload);
  await put(f.env, 'draft', 'new-complete', { ...payload, notes: 'new accepted content' });
  const latest = f.values.get(draftKey);
  assert.deepEqual(resultWithoutTrace((await put(f.env, 'draft', 'old-complete', payload)).body), resultWithoutTrace(first.body));
  assert.equal(f.values.get(draftKey), latest); assert.equal(f.draftWrites(), 2);
  assert.equal((await lookup(f.env, 'draft', 'old-complete')).body.operation.currentEffect, 'conflict');
});
test('pending draft detects a changed target and cannot overwrite a later writer', async () => {
  let armed = true;
  const f = fixture(async (phase, key) => {
    if (armed && phase === 'before' && key === draftKey) { armed = false; throw new Error('injected'); }
  });
  const payload = makeDraft(); await put(f.env, 'draft', 'pending-old', payload);
  await put(f.env, 'draft', null, { ...payload, notes: 'new legacy content' });
  const latest = f.values.get(draftKey), read = await lookup(f.env, 'draft', 'pending-old');
  assert.equal(read.body.operation.status, 'pending'); assert.equal(read.body.operation.currentEffect, 'conflict');
  assert.equal((await put(f.env, 'draft', 'pending-old', payload)).status, 409);
  assert.equal(f.values.get(draftKey), latest); assert.equal(f.draftWrites(), 1);
});
test('missing image after completed receipt is reported and never automatically recreated', async () => {
  const f = fixture(), first = await put(f.env, 'image', 'expired-image'); f.objects.clear();
  const state = (await lookup(f.env, 'image', 'expired-image')).body.operation;
  assert.equal(state.status, 'complete'); assert.equal(state.currentEffect, 'absent');
  const retry = await put(f.env, 'image', 'expired-image'); assert.equal(retry.body.key, first.body.key);
  assert.equal(f.imageWrites(), 1); assert.equal(f.objects.size, 0);
});
test('storage read failure stays unavailable, preserves pending journal and recovers', async () => {
  let failWrite = true, failRead = false;
  const f = fixture(async phase => {
    if (phase === 'before-image' && failWrite) { failWrite = false; throw new Error('injected'); }
    if (phase === 'read-image' && failRead) throw new Error('injected');
  });
  await put(f.env, 'image', 'read-error'); failRead = true;
  assert.equal((await lookup(f.env, 'image', 'read-error')).status, 503);
  assert.equal((await put(f.env, 'image', 'read-error')).status, 503); assert.equal(f.imageWrites(), 0);
  failRead = false; assert.equal((await put(f.env, 'image', 'read-error')).status, 200); assert.equal(f.imageWrites(), 1);
});
test('changed validation workflow blocks an interrupted draft before content write', async () => {
  let armed = true;
  const f = fixture(async (phase, key) => {
    if (armed && phase === 'before' && key === draftKey) { armed = false; throw new Error('injected'); }
  });
  assert.equal((await put(f.env, 'draft', 'workflow-changed')).status, 503);
  f.values.set('favorites:global', JSON.stringify({ revision: 1, words: ['new human state'] }));
  const state = (await lookup(f.env, 'draft', 'workflow-changed')).body.operation;
  assert.equal(state.status, 'pending'); assert.equal(state.currentEffect, 'conflict');
  assert.equal((await put(f.env, 'draft', 'workflow-changed')).status, 409); assert.equal(f.draftWrites(), 0);
});
test('changed stored bytes cannot complete a pending image or be overwritten by retry', async () => {
  let armed = true;
  const f = fixture(async phase => {
    if (armed && phase === 'after-image') { armed = false; throw new Error('injected'); }
  });
  await put(f.env, 'image', 'changed-object');
  const [key, object] = [...f.objects][0]; f.objects.set(key, { ...object, value: new Uint8Array([99]) });
  const state = (await lookup(f.env, 'image', 'changed-object')).body.operation;
  assert.equal(state.status, 'pending'); assert.equal(state.currentEffect, 'conflict');
  assert.equal((await put(f.env, 'image', 'changed-object')).status, 409); assert.equal(f.imageWrites(), 1);
});
test('validation rejection is a persisted 422 result and retry does not rewrite it', async () => {
  const f = fixture(), invalid = { targetDateKey: date, items: [] };
  const a = await put(f.env, 'draft', 'invalid-quality', invalid), b = await put(f.env, 'draft', 'invalid-quality', invalid);
  assert.equal(a.status, 422); assert.deepEqual(resultWithoutTrace(a.body), resultWithoutTrace(b.body));
  assert.equal(a.body.ok, false); assert.equal(a.body.operation.status, 'complete'); assert.equal(f.draftWrites(), 1);
});
test('workflow-only remote namespace cannot be used as a direct-KV idempotency fallback', async () => {
  const f = fixture(); let remoteCalls = 0;
  f.env.WORKFLOW_COORDINATOR = { getByName: () => ({ fetch: () => { remoteCalls++; throw new Error('not supported'); } }) };
  assert.equal((await put(f.env, 'image', 'unsupported-namespace')).body.error.code, 'CODEX_OPERATION_COORDINATOR_REQUIRED');
  assert.equal((await put(f.env, 'draft', 'unsupported-namespace')).body.error.code, 'CODEX_OPERATION_COORDINATOR_REQUIRED');
  assert.equal(remoteCalls, 0); assert.equal(f.writes.length, 0);
});
test('existing complete state backup/restore retains operation journals and avoids effect rewrites', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-idempotency-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), backups = path.join(root, 'backups'), restored = path.join(root, 'restored');
  const kv = new FileKV(path.join(data, 'workflow-kv')), imageKv = new FileKV(path.join(data, 'reference-images-kv'));
  await kv.put('favorites:global', JSON.stringify({ words: ['fixture'], revision: 1 }));
  const env = { FAVORITES: kv, REFERENCE_IMAGES_KV: imageKv, WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv),
    ALLOW_INSECURE_LOCAL_DEV: 'true' };
  assert.equal((await put(env, 'image', 'backup-image')).status, 200);
  const originalPut = kv.put.bind(kv); let armed = true;
  kv.put = async (key, value, options) => {
    if (armed && key.startsWith('codex-operation:') && JSON.parse(value).status === 'complete') {
      armed = false; throw new Error('injected before journal completion');
    }
    return originalPut(key, value, options);
  };
  assert.equal((await put(env, 'draft', 'backup-draft')).status, 503);
  await runChild(process.execPath, [fileURLToPath(new URL('../server/tencent-backup.mjs', import.meta.url))], {
    env: { ...process.env, JAPANESE_WORDS_DATA_DIR: data, JAPANESE_WORDS_BACKUP_DIR: backups }
  });
  const bundle = (await readdir(backups)).find(name => name.startsWith('state-'));
  assert.ok(bundle);
  const manifest = JSON.parse(await readFile(path.join(backups, bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.codexOperationCount, 2);
  assert.deepEqual(new Set(manifest.codexOperationKeys), new Set([
    codexOperationStorageKey('global', 'backup-image'), codexOperationStorageKey('global', 'backup-draft')
  ]));
  await runChild(process.execPath, [fileURLToPath(new URL('../server/import-cloudflare-backup.mjs', import.meta.url)),
    path.join(backups, bundle), `--data-dir=${restored}`, '--apply', '--confirm=IMPORT']);
  const restoredKv = new FileKV(path.join(restored, 'workflow-kv'));
  const restoredImages = new FileKV(path.join(restored, 'reference-images-kv'));
  let effectWrites = 0;
  for (const binding of [restoredKv, restoredImages]) {
    const original = binding.put.bind(binding);
    binding.put = async (key, ...args) => {
      if (key.startsWith('codex-draft:') || key.startsWith('codex-daily/')) effectWrites++;
      return original(key, ...args);
    };
  }
  const restoredEnv = { ...env, FAVORITES: restoredKv, REFERENCE_IMAGES_KV: restoredImages,
    WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(restoredKv) };
  for (const kind of ['image', 'draft']) {
    const state = (await lookup(restoredEnv, kind, 'backup-' + kind)).body.operation;
    assert.equal(state.status, 'complete'); assert.equal(state.currentEffect, 'complete');
    assert.equal((await put(restoredEnv, kind, 'backup-' + kind)).status, 200);
  }
  assert.equal(effectWrites, 0);
});

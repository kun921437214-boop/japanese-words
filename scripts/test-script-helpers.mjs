import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fetchJsonResponse } from './lib/http-json.mjs';
import { createJsonKv, createMemoryKv } from './test-helpers/kv.mjs';

const execFileAsync = promisify(execFile);

// Child processes receive only fixtures and test credentials. No local env files
// or real HTTP transport are available to the CLI paths under test.
async function runCli(t, script, args, { responses = [], files = {}, env = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({ ...files, 'responses.json': responses })) {
    await writeFile(path.join(directory, name), JSON.stringify(value));
  }
  const preload = path.join(directory, 'mock-fetch.mjs');
  await writeFile(preload, `
import { appendFileSync, readFileSync } from 'node:fs';
const responses = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url, options = {}) => {
  if (new URL(url).origin !== 'https://example.invalid') throw new Error('Unexpected HTTP origin');
  appendFileSync(new URL('./requests.jsonl', import.meta.url), JSON.stringify({
    url: String(url), method: options.method || 'GET',
    headers: Object.fromEntries(new Headers(options.headers)), body: options.body
  }) + '\\n');
  const fixture = responses.shift();
  if (!fixture) throw new Error('Unexpected additional request');
  return new Response(fixture.body ?? JSON.stringify(fixture.data), {
    status: fixture.status || 200, headers: fixture.headers
  });
};
`);
  let result;
  try {
    result = await execFileAsync(process.execPath, [
      '--import', preload, fileURLToPath(new URL(script, import.meta.url)), ...args
    ], {
      cwd: directory,
      timeout: 10000,
      env: {
        CODEX_SITE_URL: 'https://example.invalid', CODEX_AUTOMATION_SECRET: 'test-only',
        WORKFLOW_ENDPOINT: 'https://example.invalid/favorites', ADMIN_API_TOKEN: 'test-only',
        PUBLISHED_IMPORT_TOKEN: 'test-only', SITE_URL: 'https://example.invalid', ...env
      }
    });
  } catch (error) {
    result = error;
  }
  const requests = (await readFile(path.join(directory, 'requests.jsonl'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, requests, code: result.code || 0, stdout: result.stdout, stderr: result.stderr };
}

test('JSON transport leaves HTTP failures, invalid JSON, and valid JSON null distinguishable', async t => {
  const fixtures = [
    new Response('{"error":{"code":"BUSY"}}', { status: 503, headers: { 'X-Request-Id': 'trace-1' } }),
    new Response('网关错误', { status: 502 }),
    new Response(''),
    new Response('null')
  ];
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => fixtures.shift());
  const failed = await fetchJsonResponse('https://example.invalid');
  assert.equal(failed.response.status, 503);
  assert.equal(failed.response.headers.get('X-Request-Id'), 'trace-1');
  assert.equal(failed.data.error.code, 'BUSY');
  assert.equal(failed.parseError, null);
  const invalid = await fetchJsonResponse('https://example.invalid');
  assert.equal(invalid.response.status, 502);
  assert.equal(invalid.text, '网关错误');
  assert.ok(invalid.parseError instanceof SyntaxError);
  assert.equal(invalid.data, undefined);
  const empty = await fetchJsonResponse('https://example.invalid');
  assert.equal(empty.text, '');
  assert.ok(empty.parseError instanceof SyntaxError);
  const jsonNull = await fetchJsonResponse('https://example.invalid');
  assert.equal(jsonNull.data, null);
  assert.equal(jsonNull.parseError, null);
  assert.equal(fetchMock.mock.callCount(), 4);
});

test('JSON timeout still cancels a stalled body after response headers arrive', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  }));
  await assert.rejects(fetchJsonResponse('https://example.invalid', {}, { timeoutMs: 10 }), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('HTTP rejection can fail before reading a potentially stalled response body', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 503,
    text() { assert.fail('must not read rejected response body'); }
  }));
  await assert.rejects(fetchJsonResponse('https://example.invalid', {}, {
    checkResponse(response) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
  }), /HTTP 503/);
});

test('JSON transport honors caller cancellation and clears the completed request timeout', async t => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  controller.abort(reason);
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signal.throwIfAborted();
  });
  await assert.rejects(fetchJsonResponse('https://example.invalid', { signal: controller.signal }, { timeoutMs: 10 }), error => error === reason);

  let receivedSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    receivedSignal = signal;
    return new Response('{}');
  });
  await fetchJsonResponse('https://example.invalid', {}, { timeoutMs: 10 });
  await new Promise(resolve => { setTimeout(resolve, 20); });
  assert.equal(receivedSignal.aborted, false);
});

test('JSON transport propagates network and body-read failures without retrying', async t => {
  for (const phase of ['fetch', 'body']) {
    await t.test(phase, async subtest => {
      const failure = new Error('connection reset');
      const fetchMock = subtest.mock.method(globalThis, 'fetch', async () => {
        if (phase === 'fetch') throw failure;
        return { text: async () => { throw failure; } };
      });
      await assert.rejects(fetchJsonResponse('https://example.invalid', { method: 'PUT', body: '{}' }), error => error === failure);
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }
});

test('single-value KV fixtures preserve reference and clone isolation modes', async () => {
  const seed = { nested: { count: 1 } };
  const byReference = createJsonKv(seed);
  const cloned = createJsonKv(seed, { cloneReads: true });
  seed.nested.count = 2;
  assert.equal(await byReference.get('ignored'), seed);
  const read = await cloned.get();
  assert.equal(read.nested.count, 1);
  read.nested.count = 3;
  assert.equal((await cloned.get()).nested.count, 1);
  await cloned.put('also-ignored', '{"nested":{"count":4}}');
  assert.equal((await cloned.get()).nested.count, 4);
  assert.equal(cloned.putCalls, 1);
  assert.equal(cloned.getCalls, 3);
  assert.equal(await createJsonKv().get(), null);
});

test('multi-key KV fixtures preserve independent raw/JSON reads and write options', async () => {
  const kv = createMemoryKv({ draft: { revision: 1 }, workflow: { revision: 2 } });
  assert.equal(await kv.get('missing', 'json'), null);
  assert.equal(await kv.get('draft'), '{"revision":1}');
  const read = await kv.get('draft', 'json');
  read.revision = 99;
  assert.equal((await kv.get('draft', 'json')).revision, 1);
  await kv.put('draft', '{"revision":3}', { expirationTtl: 600 });
  assert.equal((await kv.get('workflow', 'json')).revision, 2);
  assert.equal(kv.values.get('draft'), '{"revision":3}');
  assert.deepEqual(kv.putOptions, [{ key: 'draft', options: { expirationTtl: 600 } }]);
  assert.equal(kv.putCalls, 1);
});

test('Codex CLI preserves authentication, empty-response behavior, and error messages', async t => {
  for (const fixture of [
    { data: { draft: { ready: true } }, expectedCode: 0 },
    { body: '', expectedCode: 0 },
    { body: 'not-json', error: /接口返回了非 JSON 内容/ },
    { status: 403, data: { error: { message: '权限不足' } }, error: /权限不足/ },
    { status: 429, data: { error: { code: 'RATE_LIMITED' } }, error: /RATE_LIMITED/ }
  ]) {
    const result = await runCli(t, 'codex-daily.mjs', ['status', '--date', '2026-09-08'], { responses: [fixture] });
    assert.equal(result.code, fixture.expectedCode ?? 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].headers.authorization, 'Bearer test-only');
    assert.equal(result.requests[0].method, 'GET');
    assert.match(result.requests[0].url, /date=2026-09-08&view=status/);
    if (fixture.error) assert.match(result.stderr, fixture.error);
    else assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test('workflow backup writes a private validated file and keeps public reads explicit', async t => {
  const result = await runCli(t, 'workflow-backup.mjs', [], { responses: [{ data: { revision: 12, words: ['尊い'] } }] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].method, 'GET');
  assert.equal(result.requests[0].headers.authorization, 'Bearer test-only');
  const report = JSON.parse(result.stdout);
  const stored = JSON.parse(await readFile(report.file, 'utf8'));
  assert.equal(stored.revision, 12);
  assert.deepEqual(stored.words, ['尊い']);
  assert.equal((await stat(report.file)).mode & 0o777, 0o600);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);

  const denied = await runCli(t, 'workflow-backup.mjs', [], { env: { ADMIN_API_TOKEN: '' } });
  assert.equal(denied.code, 1);
  assert.equal(denied.requests.length, 0);
  const publicRead = await runCli(t, 'workflow-backup.mjs', ['--public-read'], {
    env: { ADMIN_API_TOKEN: '' }, responses: [{ data: { revision: 12 } }]
  });
  assert.equal(publicRead.code, 0, publicRead.stderr);
  assert.equal(publicRead.requests[0].headers.authorization, undefined);
});

test('invalid workflow reads cannot create a backup or trigger a restore write', async t => {
  for (const script of ['workflow-backup.mjs', 'workflow-restore.mjs']) {
    for (const status of [200, 503]) {
      const result = await runCli(t, script,
        script === 'workflow-restore.mjs' ? ['backup.json', '--apply', '--confirm=RESTORE'] : [],
        { files: { 'backup.json': { revision: 1 } }, responses: [{ status, body: 'not-json' }] });
      assert.equal(result.code, 1);
      assert.deepEqual(result.requests.map(request => request.method), ['GET']);
      if (status === 503) assert.match(result.stderr, /读取失败（HTTP 503）/);
      else assert.match(result.stderr, /SyntaxError/);
      if (script === 'workflow-backup.mjs') assert.equal(result.stdout, '');
    }
  }
});

test('restore confirmation and revision headers remain mandatory; conflicts are not retried', async t => {
  const backup = { revision: 1, words: ['尊い'], candidatePool: {}, aiBatches: [], todaySnapshot: {} };
  const fixtures = { files: { 'backup.json': backup }, responses: [{ data: { revision: 12 } }] };
  const dry = await runCli(t, 'workflow-restore.mjs', ['backup.json'], fixtures);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(dry.requests.map(request => request.method), ['GET']);
  const unconfirmed = await runCli(t, 'workflow-restore.mjs', ['backup.json', '--apply'], fixtures);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stderr, /正式恢复必须同时提供/);
  assert.equal(unconfirmed.requests.length, 1);
  for (const response of [{ data: { revision: 13 } }, { status: 409, data: { error: { message: 'revision conflict' } } }]) {
    const result = await runCli(t, 'workflow-restore.mjs', ['backup.json', '--apply', '--confirm=RESTORE'], {
      ...fixtures, responses: [...fixtures.responses, response]
    });
    assert.equal(result.code, response.status ? 1 : 0, result.stderr);
    assert.deepEqual(result.requests.map(request => request.method), ['GET', 'PUT']);
    const request = result.requests[1];
    assert.equal(request.headers.authorization, 'Bearer test-only');
    assert.equal(request.headers['x-workflow-revision'], '12');
    assert.match(request.headers['x-operation-id'], /^restore-/);
    const payload = JSON.parse(request.body);
    assert.equal(payload.revision, undefined);
    assert.equal(payload.auditLog, undefined);
    assert.deepEqual(payload.words, backup.words);
    for (const field of ['candidatePool', 'aiBatches', 'todaySnapshot']) assert.ok(field in payload);
    if (response.status) assert.match(result.stderr, /恢复失败：revision conflict/);
    else assert.match(result.stdout, /"revision": 13/);
  }
});

test('published import retains preview default, JSON fallback, scoped token, and error codes', async t => {
  for (const response of [
    { data: { mode: 'preview', revision: 12 } },
    { body: 'not-json' },
    { status: 422, data: { error: { code: 'ACTIVE_ROWS_MISSING', message: 'missing active posts' } } },
    { status: 502, body: 'bad gateway' }
  ]) {
    const result = await runCli(t, 'import-xhs-published.mjs', ['--payload', 'payload.json', '--endpoint', 'https://example.invalid/published-import'], {
      files: { 'payload.json': { rows: [] } }, responses: [response]
    });
    assert.equal(result.code, response.status ? 1 : 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].method, 'POST');
    assert.equal(result.requests[0].headers.authorization, 'Bearer test-only');
    assert.equal(JSON.parse(result.requests[0].body).mode, 'preview');
    if (response.status === 422) assert.match(result.stderr, /ACTIVE_ROWS_MISSING: missing active posts/);
    if (response.status === 502) assert.match(result.stderr, /IMPORT_REQUEST_FAILED: 导入请求失败（HTTP 502）/);
  }
});

test('smoke CLI retains UTF-8 byte counts, error codes, request IDs, and no-cache headers', async t => {
  for (const response of [
    { status: 502, body: '网关错误' },
    { status: 503, data: { error: { code: 'UNAVAILABLE' } }, headers: { 'X-Request-Id': 'header-trace' } },
    { status: 503, data: { requestId: 'body-trace', error: { code: 'UNAVAILABLE' } }, headers: { 'X-Request-Id': 'header-trace' } }
  ]) {
    const result = await runCli(t, 'smoke-production.mjs', [], { responses: [response] });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stderr);
    assert.equal(report.details.status, response.status);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].headers['cache-control'], 'no-cache');
    if (response.body) assert.equal(report.details.bytes, Buffer.byteLength(response.body));
    else {
      assert.equal(report.details.code, 'UNAVAILABLE');
      assert.equal(report.details.requestId, response.data.requestId || 'header-trace');
    }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeRequest,
  buildCorsHeaders,
  readJsonBody
} from '../shared/api-security.mjs';
import {
  getWorkflowMutationMetadata,
  mergeAutomatedWorkflowUpdate,
  prepareWorkflowMutation
} from '../shared/workflow-mutation.mjs';
import {
  fetchPublishedRecordRemote,
  normalizeXiaohongshuUrl
} from '../shared/published-refresh.mjs';
import { onRequest as handleFavorites } from '../functions/favorites.js';
import { onRequest as handleTodaySnapshot } from '../functions/today-snapshot.js';
import { onRequest as handleAiCandidates } from '../functions/ai-candidates.js';
import { onRequest as handleHealth } from '../functions/healthz.js';
import { onRequest as handleMiddleware } from '../functions/_middleware.js';

function request(url = 'https://jiyimianbao.pages.dev/favorites', options = {}) {
  return new Request(url, options);
}

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  return Buffer.from(bytes).toString('base64url');
}

async function createAccessToken(claims) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const header = base64Url({ alg: 'RS256', kid: 'test-access-key', typ: 'JWT' });
  const payload = base64Url(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(input)
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return { token: `${input}.${base64Url(new Uint8Array(signature))}`, jwk: { ...jwk, kid: 'test-access-key' } };
}

function createKv(initialValue = null) {
  let value = initialValue;
  return {
    getCalls: 0,
    putCalls: 0,
    async get() {
      this.getCalls += 1;
      return value;
    },
    async put(_key, nextValue) {
      this.putCalls += 1;
      value = JSON.parse(nextValue);
    }
  };
}

test('team authorization fails closed when no credentials are configured', async () => {
  assert.equal((await authorizeRequest(request(), {})).ok, false);
});

test('admin and automation bearer tokens are scoped correctly', async () => {
  const adminRequest = request(undefined, { headers: { Authorization: 'Bearer admin-secret' } });
  assert.equal((await authorizeRequest(adminRequest, { ADMIN_API_TOKEN: 'admin-secret' })).ok, true);
  const automationRequest = request(undefined, { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal((await authorizeRequest(automationRequest, { AUTO_REFRESH_SECRET: 'cron-secret' })).ok, false);
  assert.equal((await authorizeRequest(automationRequest, { AUTO_REFRESH_SECRET: 'cron-secret' }, { allowAutomation: true })).ok, true);
});

test('Cloudflare Access rejects an unverified assertion', async () => {
  const accessRequest = request(undefined, {
    headers: {
      'Cf-Access-Authenticated-User-Email': 'editor@example.com',
      'Cf-Access-Jwt-Assertion': 'not.a.valid-signature'
    }
  });
  const authorization = await authorizeRequest(accessRequest, {
    TEAM_ACCESS_EMAILS: 'editor@example.com',
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'access-audience'
  });
  assert.equal(authorization.ok, false);
});

test('Cloudflare Access verifies JWT signature, issuer, audience, expiry, and email', async () => {
  const issuer = 'https://test-team.cloudflareaccess.com';
  const { token, jwk } = await createAccessToken({
    iss: issuer,
    aud: ['access-audience'],
    email: 'editor@example.com',
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const accessRequest = request(undefined, {
    headers: {
      'Cf-Access-Authenticated-User-Email': 'editor@example.com',
      'Cf-Access-Jwt-Assertion': token
    }
  });
  const authorization = await authorizeRequest(accessRequest, {
    TEAM_ACCESS_EMAILS: 'editor@example.com',
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: 'access-audience'
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.equal(authorization.ok, true);
  assert.equal(authorization.actor, 'editor@example.com');
});

test('insecure local development bypass is limited to loopback hosts', async () => {
  assert.equal((await authorizeRequest(request('http://localhost:8788/favorites'), { ALLOW_INSECURE_LOCAL_DEV: 'true' })).ok, true);
  assert.equal((await authorizeRequest(request(), { ALLOW_INSECURE_LOCAL_DEV: 'true' })).ok, false);
});

test('CORS reflects only same-site or explicitly allowed origins', () => {
  const sameSite = request(undefined, { headers: { Origin: 'https://jiyimianbao.pages.dev' } });
  assert.equal(buildCorsHeaders(sameSite, {})['Access-Control-Allow-Origin'], 'https://jiyimianbao.pages.dev');
  const crossSite = request(undefined, { headers: { Origin: 'https://evil.example' } });
  assert.equal(buildCorsHeaders(crossSite, {})['Access-Control-Allow-Origin'], undefined);
});

test('write authorization rejects cross-site browser requests before token checks', async () => {
  const crossSiteRequest = request(undefined, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-secret',
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site'
    }
  });
  const authorization = await authorizeRequest(crossSiteRequest, { ADMIN_API_TOKEN: 'admin-secret' });
  assert.equal(authorization.ok, false);
  assert.equal(authorization.status, 403);
  assert.equal(authorization.code, 'ORIGIN_NOT_ALLOWED');
});

test('JSON parser rejects invalid and oversized payloads', async () => {
  const invalid = await readJsonBody(request(undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), { maxBytes: 1024 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_JSON');
  const oversized = await readJsonBody(request(undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2048) }) }), { maxBytes: 1024 });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, 413);
  const wrongContentType = await readJsonBody(request(undefined, { method: 'POST', body: '{}' }), { maxBytes: 1024 });
  assert.equal(wrongContentType.status, 415);
  assert.equal(wrongContentType.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('workflow mutation increments revision and records an audit event', () => {
  const metadata = getWorkflowMutationMetadata(request(undefined, {
    headers: { 'X-Operation-Id': 'op-1', 'X-Workflow-Revision': '0' }
  }), {}, { action: 'favorite.add', actor: 'editor@example.com', target: 'モヤる' });
  const result = prepareWorkflowMutation({}, { words: ['モヤる'] }, metadata);
  assert.equal(result.ok, true);
  assert.equal(result.workflow.revision, 1);
  assert.equal(result.workflow.auditLog[0].id, 'op-1');
  assert.equal(result.workflow.auditLog[0].action, 'favorite.add');
  assert.equal(result.workflow.auditLog[0].before.favoriteCount, 0);
  assert.equal(result.workflow.auditLog[0].after.favoriteCount, 1);
});

test('workflow mutation rejects stale revisions and deduplicates operation ids', () => {
  const first = prepareWorkflowMutation({}, { words: ['モヤる'] }, {
    operationId: 'op-1', expectedRevision: 0, action: 'favorite.add', actor: 'editor@example.com'
  });
  const duplicate = prepareWorkflowMutation(first.workflow, { words: ['モヤる'] }, {
    operationId: 'op-1', expectedRevision: 1, action: 'favorite.add', actor: 'editor@example.com'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.workflow.revision, 1);
  const conflict = prepareWorkflowMutation(first.workflow, { words: ['モヤる', '余裕'] }, {
    operationId: 'op-2', expectedRevision: 0, action: 'favorite.add', actor: 'editor@example.com'
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.currentRevision, 1);
});

test('automated workflow merge preserves concurrent team-owned fields', () => {
  const current = {
    words: ['余裕'],
    statuses: { '余裕': 'pending' },
    feedback: { '余裕': { ignoredCount: 2 } },
    publishedRecords: [{ id: 'published-1', kanji: 'モヤる', title: '人工修改后的标题', updatedAt: '2026-07-13T01:00:00.000Z' }],
    candidatePool: { '余裕': { kanji: '余裕', meaning: '从容', updatedAt: '2026-07-13T01:00:00.000Z' } },
    revision: 4,
    auditLog: [{ id: 'team-op', action: 'favorite.add', actor: 'editor@example.com', at: '2026-07-13T01:00:00.000Z', revision: 4 }]
  };
  const staleAutomationResult = {
    words: ['余裕', '頑張る'],
    statuses: { '余裕': 'published', '頑張る': 'pending' },
    publishedRecords: [{ id: 'published-1', kanji: 'モヤる', title: '旧标题', updatedAt: '2026-07-12T01:00:00.000Z' }],
    candidatePool: { '集中': { kanji: '集中', meaning: '集中', updatedAt: '2026-07-13T02:00:00.000Z' } },
    todaySnapshot: { dateKey: '2026-07-13', words: ['集中'], generatedAt: '2026-07-13T02:00:00.000Z', version: 1 },
    revision: 1
  };
  const merged = mergeAutomatedWorkflowUpdate(current, staleAutomationResult);
  assert.deepEqual(merged.words, ['余裕']);
  assert.equal(merged.statuses['余裕'], 'pending');
  assert.equal(merged.statuses['頑張る'], undefined);
  assert.equal(merged.publishedRecords[0].title, '人工修改后的标题');
  assert.ok(merged.candidatePool['集中']);
  assert.deepEqual(merged.todaySnapshot.words, ['集中']);
  assert.equal(merged.revision, 4);
  assert.equal(merged.auditLog[0].id, 'team-op');
});

test('Xiaohongshu URL validation rejects lookalike hosts and unsafe protocols', () => {
  assert.ok(normalizeXiaohongshuUrl('https://www.xiaohongshu.com/explore/abc'));
  assert.ok(normalizeXiaohongshuUrl('https://xhslink.com/a/abc'));
  assert.equal(normalizeXiaohongshuUrl('https://xiaohongshu.com.evil.example/a'), '');
  assert.equal(normalizeXiaohongshuUrl('http://www.xiaohongshu.com/a'), '');
  assert.equal(normalizeXiaohongshuUrl('https://user:pass@www.xiaohongshu.com/a'), '');
});

test('published refresh rejects redirects outside allowed hosts', async () => {
  const result = await fetchPublishedRecordRemote('https://xhslink.com/a/test', async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://xiaohongshu.com.evil.example/steal' }
  }));
  assert.equal(result.ok, false);
  assert.match(result.message, /非小红书域名/);
});

test('workflow and today endpoints reject unauthenticated requests before KV reads', async () => {
  const favoritesKv = createKv({ words: ['モヤる'] });
  const favoritesResponse = await handleFavorites({ request: request(), env: { FAVORITES: favoritesKv } });
  assert.equal(favoritesResponse.status, 401);
  assert.equal(favoritesKv.getCalls, 0);

  const todayKv = createKv({ words: ['モヤる'] });
  const todayResponse = await handleTodaySnapshot({
    request: request('https://jiyimianbao.pages.dev/today-snapshot'),
    env: { FAVORITES: todayKv }
  });
  assert.equal(todayResponse.status, 401);
  assert.equal(todayKv.getCalls, 0);
});

test('favorite mutation is idempotent and rejects a stale revision', async () => {
  const kv = createKv({ words: [], revision: 0, auditLog: [] });
  const makeMutationRequest = (operationId, revision, word = 'モヤる') => request(undefined, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer admin-secret',
      'Content-Type': 'application/json',
      'X-Operation-Id': operationId,
      'X-Workflow-Revision': String(revision)
    },
    body: JSON.stringify({ action: 'add', word })
  });

  const firstResponse = await handleFavorites({
    request: makeMutationRequest('favorite-op-1', 0),
    env: { FAVORITES: kv, ADMIN_API_TOKEN: 'admin-secret' }
  });
  const firstData = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstData.revision, 1);
  assert.equal(kv.putCalls, 1);

  const duplicateResponse = await handleFavorites({
    request: makeMutationRequest('favorite-op-1', 1),
    env: { FAVORITES: kv, ADMIN_API_TOKEN: 'admin-secret' }
  });
  const duplicateData = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateData.mutation.duplicate, true);
  assert.equal(kv.putCalls, 1);

  const staleResponse = await handleFavorites({
    request: makeMutationRequest('favorite-op-2', 0, '余裕'),
    env: { FAVORITES: kv, ADMIN_API_TOKEN: 'admin-secret' }
  });
  const staleData = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(staleData.error.code, 'REVISION_CONFLICT');
  assert.equal(kv.putCalls, 1);
});

test('AI endpoint authenticates before exposing provider configuration', async () => {
  const response = await handleAiCandidates({
    request: request('https://jiyimianbao.pages.dev/ai-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stable_today' })
    }),
    env: {}
  });
  const data = await response.json();
  assert.equal(response.status, 401);
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

test('health check reports binding status without reading workflow data', async () => {
  const okResponse = await handleHealth({
    request: request('https://jiyimianbao.pages.dev/healthz'),
    env: { FAVORITES: {}, REFERENCE_IMAGES_KV: {} }
  });
  assert.equal(okResponse.status, 200);
  assert.equal((await okResponse.json()).imageStorageConfigured, true);
  const failedResponse = await handleHealth({ request: request('https://jiyimianbao.pages.dev/healthz'), env: {} });
  assert.equal(failedResponse.status, 503);
  assert.equal((await failedResponse.json()).imageStorageConfigured, false);
});

test('Pages middleware preserves the endpoint request id for response correlation', async () => {
  const response = await handleMiddleware({
    request: request('https://jiyimianbao.pages.dev/healthz'),
    env: {},
    async next() {
      return new Response(JSON.stringify({ ok: true, requestId: 'endpoint-request-id' }), {
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'endpoint-request-id' }
      });
    }
  });
  const data = await response.json();
  assert.equal(response.headers.get('X-Request-Id'), 'endpoint-request-id');
  assert.equal(data.requestId, 'endpoint-request-id');
});

test('Pages middleware converts uncaught exceptions to a safe response', async () => {
  const response = await handleMiddleware({
    request: request('https://jiyimianbao.pages.dev/favorites'),
    env: {},
    async next() {
      throw new Error('database password=secret-value');
    }
  });
  const data = await response.json();
  assert.equal(response.status, 500);
  assert.equal(data.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(data).includes('secret-value'), false);
});

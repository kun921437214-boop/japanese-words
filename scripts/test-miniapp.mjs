import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { handleMiniappRequest, miniappMemberId } from '../server/miniapp-api.mjs';
import { handleWebRequest } from '../server/tencent-runtime.mjs';
import { FileKV } from '../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';
import { buildCoordinatedWorkflowMutation } from '../shared/workflow-coordinator.mjs';
const require = createRequire(import.meta.url);
const { createStore } = require('../miniprogram/lib/store.js');
const { createClient } = require('../miniprogram/lib/client.js');
const { copyCard, wordView } = require('../miniprogram/lib/present.js');
const { workflow } = require('../miniprogram/lib/fixture.js');
const clone = value => JSON.parse(JSON.stringify(value));

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miniapp-test-'));
  const kv = new FileKV(path.join(root, 'workflow'));
  const sessions = new FileKV(path.join(root, 'sessions'));
  const env = { ENABLE_WECHAT_MINIAPP: 'true', WECHAT_APP_ID: 'test-app', WECHAT_APP_SECRET: 'test-only',
    WECHAT_MEMBER_IDS: miniappMemberId('test-app', 'test-openid'), MINIAPP_SESSIONS: sessions,
    FAVORITES: kv, REFERENCE_IMAGES_KV: new FileKV(path.join(root, 'images')), WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(kv), ALLOW_PUBLIC_APP: 'true' };
  await Promise.all([kv.ready, sessions.ready, env.REFERENCE_IMAGES_KV.ready]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = workflow();
  Object.values(fixture.candidatePool).forEach(entry => Object.assign(entry, { libraryAuditBucket: 'long_term', libraryAuditConfidenceLevel: 'medium', libraryAuditRiskLevel: 'low' }));
  fixture.todaySnapshot.dateKey = '2026-01-01';
  const stored = cleanStoredWorkflow(fixture);
  await kv.put('favorites:global', JSON.stringify(stored));
  const call = (route, method = 'GET', body, token, options = {}) => handleMiniappRequest(new Request(`https://example.test/miniapp${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env, { fetcher: async url => {
    assert.equal(url.origin, 'https://api.weixin.qq.com');
    assert.equal(url.pathname, '/sns/jscode2session');
    return Response.json({ openid: 'test-openid', session_key: 'never-return-me' });
  }, ...options });
  const login = async () => (await call('/login', 'POST', { code: 'valid-test-code' })).json();
  return { env, call, login, stored };
}

test('miniapp is opt-in and cannot fall back to public app or admin credentials', async t => {
  const { env, call } = await harness(t);
  assert.equal((await call('/workflow')).status, 401);
  env.ENABLE_WECHAT_MINIAPP = 'false';
  const res = await handleWebRequest(new Request('https://example.test/miniapp/workflow'), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'MINIAPP_NOT_CONFIGURED');
});

test('WeChat identity requires team approval and never returns OpenID, secret or session_key', async t => {
  const { env, call, login } = await harness(t);
  env.WECHAT_MEMBER_IDS = '';
  const denied = await call('/login', 'POST', { code: 'test' });
  assert.equal(denied.status, 403);
  const data = await denied.json();
  assert.match(data.error.memberId, /^[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(data).includes('test-openid'), false);
  env.WECHAT_MEMBER_IDS = data.error.memberId;
  const result = await login();
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result).includes('never-return-me'), false);
  const keys = await env.MINIAPP_SESSIONS.list();
  assert.equal(keys.keys[0].name.includes(result.token), false);
});

test('sessions expire, can be revoked, and logout invalidates the current token', async t => {
  const { env, call, login } = await harness(t);
  const auth = await login();
  assert.equal((await call('/me', 'GET', null, auth.token)).status, 200);
  assert.equal((await call('/me', 'GET', null, auth.token, { now: auth.expiresAt + 1 })).status, 401);
  env.WECHAT_MEMBER_IDS = '';
  assert.equal((await call('/me', 'GET', null, auth.token)).status, 403);
  env.WECHAT_MEMBER_IDS = auth.memberId;
  assert.equal((await call('/logout', 'POST', {}, auth.token)).status, 200);
  assert.equal((await call('/me', 'GET', null, auth.token)).status, 401);
});

test('scoped reads preserve projections and commands are idempotent without full workflow replacement', async t => {
  const { env, call, login, stored } = await harness(t);
  const { token } = await login();
  const today = await (await call('/workflow?scope=today', 'GET', null, token)).json();
  assert.equal(today.appView.partialCandidatePool, true);
  assert.equal(today.candidatePool['余白'].aiCard.projection, 'list');
  const detail = await (await call(`/card?word=${encodeURIComponent('余白')}`, 'GET', null, token)).json();
  assert.equal(detail.candidate.aiCard.projection, 'detail');
  const command = { action: 'add', word: '余白', operationId: 'operation-test-1234', baseRevision: -1, candidatePool: { '余白': { aiCard: {} } }, aiBatches: [] };
  assert.equal((await call('/favorite', 'POST', command, token)).status, 200);
  const duplicate = await (await call('/favorite', 'POST', command, token)).json();
  assert.equal(duplicate.mutation.duplicate, true);
  const after = await env.FAVORITES.get('favorites:global', 'json');
  assert.equal(after.revision, stored.revision + 1);
  assert.ok(after.words.includes('余白'));
  for (const key of ['candidatePool', 'aiBatches', 'todaySnapshot']) assert.deepEqual(after[key], stored[key]);
  assert.equal(after.auditLog[0].actor.startsWith('wechat:'), true);
  assert.equal((await call('/workflow', 'PUT', { words: [] }, token)).status, 404);
  assert.equal((await call('/daily-refresh', 'POST', {}, token)).status, 404);
  assert.equal((await call('/favorite', 'POST', { ...command, action: 'status', status: 'published' }, token)).status, 400);
});

test('published protection is evaluated inside serialized mutation, legacy commands remain compatible', async t => {
  const { stored } = await harness(t);
  stored.statuses['寄り道'] = 'published';
  const cmd = { action: 'remove', word: '寄り道' };
  assert.throws(() => buildCoordinatedWorkflowMutation(stored, cmd, { protectPublished: true }, { strategy: 'favorite-command' }), { code: 'PUBLISHED_READ_ONLY' });
  const legacy = buildCoordinatedWorkflowMutation(stored, cmd, { operationId: 'legacy-command' }, { strategy: 'favorite-command' });
  assert.equal(legacy.workflow.words.includes('寄り道'), false);
});

test('legacy card content without an explicit ready status cannot become formal through schema defaults', async t => {
  const { env, call, login } = await harness(t);
  const { token } = await login();
  const data = await env.FAVORITES.get('favorites:global', 'json');
  data.candidatePool['余白'].aiCard = { explanation: 'legacy template' };
  await env.FAVORITES.put('favorites:global', JSON.stringify(data));
  const detail = await (await call(`/card?word=${encodeURIComponent('余白')}`, 'GET', null, token)).json();
  assert.equal(detail.candidate.aiCard.cardStatus, 'none');
  assert.equal(detail.candidate.aiCard.explanation, undefined);
});

test('image reads only use the requested formal card storage key; no arbitrary URL forwarding', async t => {
  const { env, call, login } = await harness(t);
  const { token } = await login();
  assert.equal((await call('/image?word=unknown&key=secret', 'GET', null, token)).status, 404);
  const data = await env.FAVORITES.get('favorites:global', 'json');
  data.candidatePool['余白'].aiCard.referenceImage = { status: 'ready', key: 'codex-daily/2026-09-07/test.png' };
  await env.FAVORITES.put('favorites:global', JSON.stringify(data));
  await env.REFERENCE_IMAGES_KV.put('codex-daily/2026-09-07/test.png', new Uint8Array([1, 2]), { metadata: { contentType: 'image/png' } });
  const image = await call(`/image?word=${encodeURIComponent('余白')}`, 'GET', null, token);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.status, 200);
});

test('login upstream errors are sanitized and attempts are bounded', async t => {
  const { call } = await harness(t);
  const result = await call('/login', 'POST', { code: 'abc' }, null, { fetcher: async () => { throw new Error('secret-in-upstream-url'); } });
  assert.equal(result.status, 502);
  assert.equal((await result.text()).includes('secret-in-upstream-url'), false);
  for (let i = 0; i < 11; i++) await call('/login', 'POST', { code: 'abc' });
  assert.equal((await call('/login', 'POST', { code: 'abc' })).status, 429);
});

function localWx() {
  const storage = new Map();
  return { getStorageSync: key => storage.has(key) ? clone(storage.get(key)) : '', setStorageSync: (key, value) => storage.set(key, clone(value)) };
}
function storeHarness() {
  const wx = localWx(); let id = 'member-a'; const remote = workflow(); let posts = 0; let timeout = false;
  const client = { identity: () => id, ensureAuth: async () => {}, async request(route, method, body) {
    if (route.startsWith('/workflow') || route.startsWith('/confirmation')) return clone(remote);
    if (route === '/favorite' && method === 'POST') {
      posts++; if (!remote.words.includes(body.word)) remote.words.push(body.word);
      if (timeout) { timeout = false; throw new Error('lost response'); }
      return clone(remote);
    }
    throw new Error('unexpected request');
  } };
  return { wx, client, remote, store: createStore(wx, client), posts: () => posts, timeout: () => { timeout = true; }, changeMember: () => { id = 'member-b'; } };
}

test('offline favorites persist, stay visible and replay once after a process restart', async () => {
  const h = storeHarness(); await h.store.load('today'); h.store.online = false;
  h.store.enqueue('余白', 'add');
  assert.ok(h.store.view('today').words.includes('余白'));
  assert.equal(h.store.enqueue('余白', 'add'), false);
  const restarted = createStore(h.wx, h.client);
  assert.equal(restarted.pending().length, 1);
  await restarted.flush();
  assert.equal(restarted.pending().length, 0);
  assert.equal(h.posts(), 1);
});

test('a committed request with a lost response is confirmed before retry; queues cannot migrate between members', async () => {
  const h = storeHarness(); await h.store.load('today'); h.timeout();
  h.store.enqueue('余白', 'add'); await h.store.flush();
  assert.equal(h.store.pending().length, 1);
  await h.store.flush(); assert.equal(h.store.pending().length, 0); assert.equal(h.posts(), 1);
  h.store.online = false; h.store.enqueue('気分転換', 'add'); h.changeMember();
  assert.equal(h.store.pending().length, 0);
  assert.deepEqual(h.store.view('today').words, []);
});

test('accepting current team state clears only the local intent without a server mutation', async () => {
  const h = storeHarness(); await h.store.load('today'); h.store.online = false;
  h.store.enqueue('余白', 'add'); const op = h.store.pending()[0];
  await h.store.acceptRemote(op.operationId);
  assert.equal(h.store.pending().length, 0); assert.equal(h.posts(), 0);
  assert.equal(h.store.view('today').words.includes('余白'), false);
});

test('formal copy blocks missing, pending and projected cards', () => {
  assert.equal(copyCard({ aiCard: { summary: 'local template' } }), '');
  assert.equal(copyCard({ aiCard: { cardStatus: 'pending', explanation: 'stale content' } }), '');
  assert.equal(copyCard({ aiCard: { cardStatus: 'ready', projection: 'list', explanation: 'partial' } }), '');
  assert.ok(copyCard(workflow().candidatePool['余白']).includes('週末'));
  const view = wordView('test', { words: [], candidatePool: { test: { aiCard: { cardStatus: 'pending', summary: 'must hide' } } } });
  assert.equal(view.summary, '');
});

test('a deleted server card invalidates the cached formal detail', async () => {
  const wx = localWx(); let removed = false;
  const client = { identity: () => 'member-a', ensureAuth: async () => {}, async request() {
    if (removed) throw Object.assign(new Error('gone'), { status: 404 });
    return { candidate: workflow().candidatePool['余白'] };
  } };
  const store = createStore(wx, client);
  await store.loadDetail('余白'); assert.ok(store.detail('余白'));
  removed = true;
  await assert.rejects(store.loadDetail('余白'));
  assert.equal(store.detail('余白'), null);
});

test('client refreshes expired sessions once and refuses to replay a mutation under a different WeChat member', async () => {
  const wx = localWx(); let logins = 0; let mutationCalls = 0;
  wx.setStorageSync('kotoba_miniapp_auth_v1', { token: 'old', memberId: 'member-a', expiresAt: Date.now() + 100000 });
  wx.setStorageSync('kotoba_miniapp_consent_v1', true);
  wx.login = ({ success }) => { logins++; success({ code: 'fresh-code' }); };
  wx.request = ({ url, success }) => {
    if (url.endsWith('/login')) success({ statusCode: 200, data: { token: 'new', memberId: 'member-b', expiresAt: Date.now() + 100000 } });
    else { mutationCalls++; success({ statusCode: 401, data: { error: { code: 'SESSION_EXPIRED' } } }); }
  };
  const client = createClient(wx, { apiBaseUrl: 'https://example.test/miniapp' });
  await assert.rejects(client.request('/favorite', 'POST', { word: '余白', operationId: 'same-operation' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(logins, 1); assert.equal(mutationCalls, 1);
});

test('all app pages and local assets exist, and the app package contains no server secrets', async () => {
  const root = new URL('../miniprogram/', import.meta.url);
  const config = JSON.parse(await readFile(new URL('app.json', root), 'utf8'));
  for (const page of config.pages) for (const ext of ['js', 'json', 'wxml']) await readFile(new URL(`${page}.${ext}`, root));
  for (const tab of config.tabBar.list) for (const field of ['iconPath', 'selectedIconPath']) await readFile(new URL(tab[field], root));
  const visit = async url => {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.js')) assert.doesNotMatch(await readFile(file, 'utf8'), /WECHAT_APP_SECRET|DEEPSEEK_API_KEY|ADMIN_API_TOKEN|AUTO_REFRESH_SECRET/);
    }
  };
  await visit(root);
});

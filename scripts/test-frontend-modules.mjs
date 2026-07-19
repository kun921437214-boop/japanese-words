import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createApiClient, createApiError, getApiErrorMessage } from '../frontend/api-client.mjs';
import {
  buildFavoritesPageModel,
  createFavoritesPageController,
  normalizeFavoriteStatusFilter,
  transitionFavoriteStatus,
  transitionFavoriteToggle
} from '../frontend/favorites-page.mjs';
import { createWorkflowCache } from '../frontend/workflow-cache.mjs';
import { createWorkflowStore } from '../frontend/workflow-store.mjs';
import { createWorkflowSync } from '../frontend/workflow-sync.mjs';

function cleanTestWorkflow(value = {}) {
  return {
    words: Array.isArray(value.words) ? [...new Set(value.words)] : [],
    statuses: value.statuses || {},
    feedback: value.feedback || {},
    publishedRecords: value.publishedRecords || [],
    candidatePool: value.candidatePool || {},
    aiBatches: value.aiBatches || [],
    aiPreview: value.aiPreview || {},
    todaySnapshot: value.todaySnapshot || {},
    todayDismissed: value.todayDismissed || {},
    historySnapshots: value.historySnapshots || {},
    todaySnapshotHistory: value.todaySnapshotHistory || [],
    revision: Math.max(0, Number.parseInt(value.revision, 10) || 0),
    auditLog: Array.isArray(value.auditLog) ? value.auditLog.slice(0, 100) : [],
    appView: value.appView || {},
    updated: typeof value.updated === 'string' ? value.updated : null,
    schemaVersion: 2
  };
}

test('API client adds workflow revision and operation headers', async () => {
  let receivedOptions = null;
  const client = createApiClient({
    getWorkflowRevision: () => 42,
    fetchImpl: async (_endpoint, options) => {
      receivedOptions = options;
      return new Response('{}', { status: 200 });
    }
  });

  await client.request('/favorites', { method: 'POST' }, {
    workflowMutation: true,
    operationId: 'favorite-add-test'
  });

  assert.equal(receivedOptions.credentials, 'same-origin');
  assert.equal(receivedOptions.headers.get('X-Workflow-Revision'), '42');
  assert.equal(receivedOptions.headers.get('X-Operation-Id'), 'favorite-add-test');
});

test('API client cancels the previous request with the same key', async () => {
  let callCount = 0;
  const client = createApiClient({
    fetchImpl: async (_endpoint, options) => {
      callCount += 1;
      if (callCount > 1) return new Response('{}', { status: 200 });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
  });

  const first = client.request('/favorites', {}, { cancelKey: 'workflow-load' });
  const second = client.request('/favorites', {}, { cancelKey: 'workflow-load' });
  await assert.rejects(first, error => error.code === 'REQUEST_ABORTED');
  assert.equal((await second).status, 200);
  assert.equal(client.activeControllers.size, 0);
});

test('API client prevents duplicate UI operations and always releases the lock', async () => {
  const client = createApiClient({ fetchImpl: async () => new Response('{}') });
  let release;
  const first = client.runExclusive('favorite:测试', () => new Promise(resolve => { release = resolve; }));
  let duplicateNotified = false;
  const duplicate = await client.runExclusive('favorite:测试', async () => true, () => { duplicateNotified = true; });
  assert.equal(duplicate, false);
  assert.equal(duplicateNotified, true);
  release(true);
  assert.equal(await first, true);
  assert.equal(client.operationsInFlight.size, 0);
});

test('API errors preserve status, code and request id', () => {
  const error = createApiError({
    error: { code: 'REVISION_CONFLICT', message: '版本冲突', retryable: true },
    requestId: 'request-123'
  }, 409);
  assert.equal(getApiErrorMessage({}, 429), '请求过于频繁，请稍后重试');
  assert.equal(error.message, '版本冲突');
  assert.equal(error.status, 409);
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.equal(error.retryable, true);
  assert.equal(error.requestId, 'request-123');
});

test('favorite conflict reconciles remote state before sending a duplicate mutation', async () => {
  let requestCount = 0;
  let satisfied = false;
  const sync = createWorkflowSync({
    request: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    createError: createApiError,
    loadRemote: async () => {
      satisfied = true;
      return true;
    },
    delay: async () => {}
  });

  const result = await sync.mutate({
    endpoint: '/favorites',
    payload: { action: 'add', word: '思い切って' },
    operationId: 'favorite-add-once',
    isSatisfied: () => satisfied,
    buildReconciledResponse: () => ({ ok: true, reconciled: true })
  });

  assert.deepEqual(result, { ok: true, reconciled: true });
  assert.equal(requestCount, 1);
});

test('workflow reads stop before fetch when a newer scoped load supersedes them', async () => {
  let requested = false;
  const sync = createWorkflowSync({
    request: async () => {
      requested = true;
      return new Response('{}');
    },
    createError: createApiError
  });
  await assert.rejects(
    sync.read({ endpoint: '/favorites', isCurrent: () => false }),
    error => error.code === 'REQUEST_ABORTED'
  );
  assert.equal(requested, false);
});

test('workflow store rejects stale remote revisions without changing local metadata', () => {
  const store = createWorkflowStore({ cleanWorkflow: cleanTestWorkflow });
  store.replaceMetadata({ revision: 8, auditLog: [{ id: 'local-event' }] });
  const currentState = cleanTestWorkflow({ words: ['本地词'] });
  const result = store.prepareRemoteState({
    words: ['旧云端词'],
    revision: 7,
    auditLog: [{ id: 'remote-event' }]
  }, currentState);
  assert.equal(result.applied, false);
  assert.equal(result.stale, true);
  assert.deepEqual(result.state.words, ['本地词']);
  assert.deepEqual(store.getMetadata(), { revision: 8, auditLog: [{ id: 'local-event' }] });
});

test('workflow store merges scoped candidates and history without dropping local entries', () => {
  const store = createWorkflowStore({
    cleanWorkflow: cleanTestWorkflow,
    mergeCandidatePool: (local, remote) => ({ ...local, ...remote }),
    mergeHistorySnapshots: (local, remote) => ({ ...local, ...remote }),
    mergeTodaySnapshotHistory: (local, remote) => [...local, ...remote]
  });
  store.replaceMetadata({ revision: 3 });
  const result = store.prepareRemoteState({
    words: ['云端收藏'],
    candidatePool: { 云端词: { kanji: '云端词' } },
    historySnapshots: { '2026-07-19': { words: ['云端词'] } },
    todaySnapshotHistory: [{ dateKey: '2026-07-19' }],
    revision: 4,
    auditLog: [{ id: 'revision-4' }],
    appView: { scope: 'favorites', partialCandidatePool: true }
  }, {
    candidatePool: { 本地词: { kanji: '本地词' } },
    historySnapshots: { '2026-07-18': { words: ['本地词'] } },
    todaySnapshotHistory: [{ dateKey: '2026-07-18' }]
  });
  assert.equal(result.applied, true);
  assert.equal(result.mergePartialState, true);
  assert.deepEqual(Object.keys(result.state.candidatePool), ['本地词', '云端词']);
  assert.deepEqual(Object.keys(result.state.historySnapshots), ['2026-07-18', '2026-07-19']);
  assert.deepEqual(result.state.todaySnapshotHistory.map(item => item.dateKey), ['2026-07-18', '2026-07-19']);
  assert.deepEqual(store.getMetadata(), { revision: 4, auditLog: [{ id: 'revision-4' }] });
});

test('workflow store builds a stable full-save payload without app view metadata', () => {
  const store = createWorkflowStore({ cleanWorkflow: cleanTestWorkflow });
  store.replaceMetadata({ revision: 12, auditLog: [{ id: 'event-12' }] });
  const payload = store.buildPayload({
    words: ['收藏词'],
    candidatePool: { 收藏词: { kanji: '收藏词' } },
    appView: { scope: 'favorites', partialCandidatePool: true }
  }, '2026-07-19T09:00:00.000Z');
  assert.equal(payload.revision, 12);
  assert.deepEqual(payload.auditLog, [{ id: 'event-12' }]);
  assert.equal(payload.updated, '2026-07-19T09:00:00.000Z');
  assert.equal('appView' in payload, false);
  assert.deepEqual(Object.keys(payload), [
    'words', 'statuses', 'feedback', 'publishedRecords', 'candidatePool', 'aiBatches',
    'aiPreview', 'todaySnapshot', 'todayDismissed', 'historySnapshots',
    'todaySnapshotHistory', 'revision', 'auditLog', 'updated', 'schemaVersion'
  ]);
});

test('workflow store deduplicates concurrent scope loads and releases completed requests', async () => {
  const store = createWorkflowStore({ cleanWorkflow: cleanTestWorkflow });
  let loadCount = 0;
  let release;
  const loader = () => {
    loadCount += 1;
    return new Promise(resolve => { release = resolve; });
  };
  const first = store.loadScope('favorites', loader);
  const duplicate = store.loadScope('favorites', loader);
  assert.equal(first, duplicate);
  assert.equal(loadCount, 0);
  await Promise.resolve();
  assert.equal(loadCount, 1);
  release(true);
  assert.equal(await first, true);
  assert.equal(await store.loadScope('favorites', async () => 'fresh'), 'fresh');
  store.markScopeLoaded('favorites');
  assert.equal(store.isScopeLoaded('favorites'), true);
  assert.equal(store.hasLoadedScopes(), true);
});

test('workflow cache keeps current-page candidates first and omits heavy batches', () => {
  const writes = new Map();
  const storage = { setItem: (key, value) => writes.set(key, value) };
  const cache = createWorkflowCache({
    storage,
    cleanWorkflow: value => structuredClone(value),
    candidateLimit: 2,
    keys: {
      workflow: 'workflow',
      favorites: 'favorites',
      statuses: 'statuses',
      aiPreview: 'preview',
      todayDismissed: 'dismissed'
    }
  });
  const payload = {
    words: ['收藏词', '第二收藏词'],
    statuses: { 收藏词: 'pending' },
    candidatePool: {
      今日词: { kanji: '今日词' },
      收藏词: { kanji: '收藏词' },
      第二收藏词: { kanji: '第二收藏词' },
      无关词: { kanji: '无关词' }
    },
    aiBatches: [{ id: 'large-batch' }],
    aiPreview: {},
    todayDismissed: {},
    todaySnapshot: { words: ['今日词'] }
  };

  assert.equal(cache.write(payload), true);
  const stored = JSON.parse(writes.get('workflow'));
  assert.deepEqual(Object.keys(stored.candidatePool), ['今日词', '收藏词']);
  assert.deepEqual(stored.aiBatches, []);
  assert.deepEqual(JSON.parse(writes.get('favorites')), payload.words);
});

test('workflow cache quota errors do not escape into cloud sync flow', () => {
  const warnings = [];
  const cache = createWorkflowCache({
    storage: { setItem: () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); } },
    cleanWorkflow: value => value,
    keys: { workflow: 'workflow' },
    logger: { warn: (...args) => warnings.push(args) }
  });
  const result = cache.write({ words: [], statuses: {}, candidatePool: {}, aiBatches: [], todaySnapshot: {} });
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '本地缓存写入失败，已保留当前云端数据');
});

test('favorites page model applies source and status filters without changing the full pool', () => {
  const words = [
    { kanji: '思い切って', source: '每日热门', status: 'none' },
    { kanji: '詰めが甘い', source: '手动添加', status: 'pending' },
    { kanji: '立て直す', source: '每日热门', status: 'pending' }
  ];
  const model = buildFavoritesPageModel({
    words,
    sourceFilter: '每日热门',
    statusFilter: 'pending',
    getStatus: word => word.status
  });

  assert.deepEqual(model.visibleWords.map(word => word.kanji), ['立て直す']);
  assert.equal(model.total, 3);
  assert.equal(model.visible, 1);
  assert.equal(model.countText, '筛选显示 1 / 3 个词');
  assert.deepEqual(model.autoGenerateWords, ['立て直す']);
  assert.equal(normalizeFavoriteStatusFilter('published'), 'all');
  assert.equal(words.length, 3);
});

test('favorite transitions are immutable and clear stale status when removing a word', () => {
  const favorites = ['思い切って', '詰めが甘い'];
  const statuses = { 思い切って: 'pending', 詰めが甘い: 'published' };
  const removed = transitionFavoriteToggle({ kanji: '思い切って', favorites, statuses, forceState: false });

  assert.equal(removed.action, 'remove');
  assert.deepEqual(removed.favorites, ['詰めが甘い']);
  assert.deepEqual(removed.statuses, { 詰めが甘い: 'published' });
  assert.deepEqual(favorites, ['思い切って', '詰めが甘い']);
  assert.deepEqual(statuses, { 思い切って: 'pending', 詰めが甘い: 'published' });

  const added = transitionFavoriteToggle({ kanji: '立て直す', favorites: removed.favorites, statuses: removed.statuses, forceState: true });
  assert.equal(added.action, 'add');
  assert.deepEqual(added.favorites, ['立て直す', '詰めが甘い']);
});

test('favorite status transition adds missing words and normalizes invalid status', () => {
  const pending = transitionFavoriteStatus({
    kanji: '手間取る',
    status: 'pending',
    favorites: ['思い切って'],
    statuses: {}
  });
  assert.deepEqual(pending.favorites, ['手間取る', '思い切って']);
  assert.deepEqual(pending.statuses, { 手間取る: 'pending' });

  const cleared = transitionFavoriteStatus({
    kanji: '手間取る',
    status: 'unexpected',
    favorites: pending.favorites,
    statuses: pending.statuses
  });
  assert.equal(cleared.status, 'none');
  assert.deepEqual(cleared.statuses, {});
});

test('favorites page controller delegates card and filter actions without window handlers', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createFavoritesPageController({
    root,
    onOpenDetail: id => calls.push(['detail', id]),
    onToggleFavorite: (kanji, forceState) => calls.push(['favorite', kanji, forceState]),
    onSelectStatus: (kanji, status) => calls.push(['status', kanji, status]),
    onSourceFilter: value => calls.push(['source', value]),
    onStatusFilter: value => calls.push(['filter', value])
  });
  const dispatch = (type, actionElement, { stop = false } = {}) => {
    let stopped = false;
    listeners.get(type)({
      target: {
        closest: selector => {
          if (selector === '[data-favorites-action]') return actionElement;
          if (selector === '[data-favorites-stop]') return stop ? {} : null;
          return null;
        }
      },
      stopPropagation: () => { stopped = true; },
      preventDefault() {}
    });
    return stopped;
  };

  dispatch('click', { dataset: { favoritesAction: 'open-detail', wordId: 'favorite-card-1' } });
  const stopped = dispatch('click', {
    dataset: { favoritesAction: 'toggle-favorite', kanji: '思い切って', forceState: 'false' }
  }, { stop: true });
  dispatch('click', { dataset: { favoritesAction: 'select-status', kanji: '詰めが甘い', status: 'pending' } }, { stop: true });
  dispatch('change', { dataset: { favoritesAction: 'source-filter' }, value: '每日热门' });
  dispatch('change', { dataset: { favoritesAction: 'status-filter' }, value: 'pending' });

  assert.equal(stopped, true);
  assert.deepEqual(calls, [
    ['detail', 'favorite-card-1'],
    ['favorite', '思い切って', false],
    ['status', '詰めが甘い', 'pending'],
    ['source', '每日热门'],
    ['filter', 'pending']
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('module migration exposes every inline handler through the compatibility facade', () => {
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const combined = `${indexSource}\n${appSource}`;
  const handlers = new Set();
  const attributePattern = /\bon(?:click|change|input|submit)=["']([^"']+)["']/g;
  for (const match of combined.matchAll(attributePattern)) {
    for (const call of match[1].matchAll(/(?<!\.)\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!['if', 'encodeURIComponent'].includes(call[1])) handlers.add(call[1]);
    }
  }
  const facadeStart = appSource.indexOf('Object.assign(window, {');
  const facadeEnd = appSource.indexOf('\n});', facadeStart);
  const facade = appSource.slice(facadeStart, facadeEnd);
  assert.ok(indexSource.includes('<script type="module" src="app.js"></script>'));
  assert.ok(facadeStart > 0);
  handlers.forEach(handler => assert.match(facade, new RegExp(`\\b${handler}\\b`), `missing window handler: ${handler}`));
  const favoritesMarkup = indexSource.slice(indexSource.indexOf('id="page-favorites"'), indexSource.indexOf('id="page-published"'));
  const favoriteCardSource = appSource.slice(appSource.indexOf('function renderFavoriteCard'), appSource.indexOf('function renderTodayGrid'));
  assert.doesNotMatch(favoritesMarkup, /on(?:click|change)=/);
  assert.doesNotMatch(favoriteCardSource, /onclick=/);
});

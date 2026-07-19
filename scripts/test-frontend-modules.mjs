import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createApiClient, createApiError, getApiErrorMessage } from '../frontend/api-client.mjs';
import {
  AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY,
  AI_CARD_PENDING_TTL_MS,
  buildTodayAiCardsRequest,
  buildWordCardRequestPayload,
  canAutoGenerateAiCard,
  getSingleTodayAiCardGenerationOptions,
  getTodayAiCardActionState,
  isAiCardStalePending,
  selectMissingTodayAiCardKanjis
} from '../frontend/ai-card-generation.mjs';
import {
  buildAutoAiCandidatePayload,
  requestAutoAiCandidateBatch
} from '../frontend/ai-candidate-service.mjs';
import { createAppShellController } from '../frontend/app-shell.mjs';
import {
  buildFavoriteSelectionExportText,
  buildRecommendationAuditCsv,
  csvCell,
  getRecommendationAuditFilename
} from '../frontend/content-export.mjs';
import {
  buildDailyHotDateOptions,
  buildDailyHotSourceFilterModel,
  buildHistoryNavigationModel,
  createDailyHotPageController,
  normalizeDailyHotDateSelection
} from '../frontend/daily-hot-page.mjs';
import {
  buildFavoritesPageModel,
  createFavoritesPageController,
  normalizeFavoriteStatusFilter,
  transitionFavoriteStatus,
  transitionFavoriteToggle
} from '../frontend/favorites-page.mjs';
import { createImageFallbackController } from '../frontend/image-fallback.mjs';
import { createManualWordModalController } from '../frontend/manual-word-modal.mjs';
import { createModalActionsController } from '../frontend/modal-actions.mjs';
import {
  extractFirstUrl,
  extractPublishedAtFromShareText,
  parseCountLikeValue,
  parseXiaohongshuSharePayload
} from '../frontend/published-record-parser.mjs';
import {
  buildPublishedPageModel,
  createPublishedPageController,
  getPublishedAutoRefreshSummary,
  getPublishedPerformanceScore,
  getRecentPublishedAverage,
  ratePublishedRecord
} from '../frontend/published-page.mjs';
import { createWorkflowCache } from '../frontend/workflow-cache.mjs';
import { createWorkflowStore } from '../frontend/workflow-store.mjs';
import { createWorkflowSync } from '../frontend/workflow-sync.mjs';
import { buildWordCardViewModel, WORD_CARD_STATUS_LABELS } from '../frontend/word-card-view.mjs';
import { createWorkflowActionsController } from '../frontend/workflow-actions.mjs';
import {
  MAX_WORKFLOW_BACKUP_BYTES,
  buildWorkflowBackup,
  formatWorkflowBackupSummary,
  getWorkflowBackupFilename,
  parseWorkflowBackupText,
  serializeWorkflowBackup
} from '../frontend/workflow-backup.mjs';

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

test('AI card pending timeout and action state stay deterministic', () => {
  const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
  const freshPending = { cardStatus: 'pending', generatedAt: new Date(nowMs - AI_CARD_PENDING_TTL_MS + 1000).toISOString() };
  const stalePending = { cardStatus: 'pending', generatedAt: new Date(nowMs - AI_CARD_PENDING_TTL_MS - 1000).toISOString() };

  assert.equal(isAiCardStalePending(freshPending, {}, { nowMs }), false);
  assert.equal(isAiCardStalePending(stalePending, {}, { nowMs }), true);
  assert.deepEqual(getTodayAiCardActionState({ aiCard: freshPending, nowMs }), {
    status: 'pending',
    stalePending: false,
    label: '生成中',
    disabled: true
  });
  assert.deepEqual(getTodayAiCardActionState({ aiCard: stalePending, nowMs }), {
    status: 'pending',
    stalePending: true,
    label: '重试',
    disabled: false
  });
  assert.equal(getTodayAiCardActionState({ aiCard: { cardStatus: 'ready' } }).label, '重新生成');
  assert.equal(getTodayAiCardActionState({ aiCard: { cardStatus: 'failed' } }).label, '重试');
  assert.deepEqual(getTodayAiCardActionState({ aiCard: { cardStatus: 'none' }, inFlight: true }), {
    status: 'none',
    stalePending: false,
    label: '生成中',
    disabled: true
  });
});

test('single today-card generation enables only the matching retry mode', () => {
  const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
  assert.deepEqual(getSingleTodayAiCardGenerationOptions({ aiCard: { cardStatus: 'ready' }, nowMs }), {
    force: true,
    retryFailed: false,
    retryStalePending: false,
    maxWords: 1
  });
  assert.deepEqual(getSingleTodayAiCardGenerationOptions({ aiCard: { cardStatus: 'failed' }, nowMs }), {
    force: false,
    retryFailed: true,
    retryStalePending: false,
    maxWords: 1
  });
  const stalePending = { cardStatus: 'pending', generatedAt: new Date(nowMs - AI_CARD_PENDING_TTL_MS - 1).toISOString() };
  assert.equal(getSingleTodayAiCardGenerationOptions({ aiCard: stalePending, nowMs }).retryStalePending, true);
});

test('automatic AI-card policy preserves in-flight, status, and daily-attempt guards', () => {
  assert.equal(canAutoGenerateAiCard({ aiCard: { cardStatus: 'none' }, attemptCount: 0 }), true);
  assert.equal(canAutoGenerateAiCard({ aiCard: { cardStatus: 'failed' }, attemptCount: 1 }), true);
  assert.equal(canAutoGenerateAiCard({ aiCard: { cardStatus: 'ready' }, force: true }), false);
  assert.equal(canAutoGenerateAiCard({ aiCard: { cardStatus: 'pending' }, force: true }), false);
  assert.equal(canAutoGenerateAiCard({ aiCard: { cardStatus: 'none' }, inFlight: true }), false);
  assert.equal(canAutoGenerateAiCard({
    aiCard: { cardStatus: 'failed' },
    attemptCount: AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY
  }), false);
  assert.equal(canAutoGenerateAiCard({
    aiCard: { cardStatus: 'failed' },
    attemptCount: AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY,
    force: true
  }), true);
});

test('missing today-card selection skips ready, pending, failed, duplicates, and overflow', () => {
  const kanjis = ['未生成', '已完成', '生成中', '失败', '需更新', '未生成', '补位一', '补位二', '补位三', '补位四'];
  const candidatePool = {
    已完成: { aiCard: { cardStatus: 'ready' } },
    生成中: { aiCard: { cardStatus: 'pending' } },
    失败: { aiCard: { cardStatus: 'failed' } },
    需更新: { aiCard: { cardStatus: 'stale' } }
  };
  assert.deepEqual(selectMissingTodayAiCardKanjis({ kanjis, candidatePool }), [
    '未生成', '需更新', '补位一', '补位二', '补位三'
  ]);
});

test('AI-card request builders preserve limits, retry flags, and account context', () => {
  assert.deepEqual(buildTodayAiCardsRequest(['一', '一', '二', '三', '四', '五', '六'], {
    force: true,
    retryFailed: true,
    retryStalePending: true,
    maxWords: 99
  }), {
    mode: 'today',
    words: ['一', '二', '三', '四', '五'],
    force: true,
    retryFailed: true,
    retryStalePending: true,
    maxWords: 5
  });

  const words = Array.from({ length: 22 }, (_, index) => ({ kanji: `词${index + 1}` }));
  const payload = buildWordCardRequestPayload({
    words,
    favorites: ['気が重い'],
    negativeFeedback: { 基本: { reason: 'tooBasic' } },
    publishedWords: ['抜け感'],
    accountLearningSummary: { priority: 'saves' }
  });
  assert.equal(payload.action, 'generate_word_card');
  assert.equal(payload.count, 20);
  assert.equal(payload.context.words.length, 20);
  assert.deepEqual(payload.context.favorites, ['気が重い']);
  assert.deepEqual(payload.context.publishedWords, ['抜け感']);
  assert.deepEqual(payload.context.accountLearningSummary, { priority: 'saves' });
  assert.equal(payload.preferences.includeHighRisk, 'review_only');
});

test('automatic candidate service builds a stable context without duplicate favorites', () => {
  const payload = buildAutoAiCandidatePayload({
    favorites: ['気が重い', '気が重い', '抜け感'],
    negativeFeedback: { 基本: { lastReason: 'tooBasic' } },
    publishedRecords: [{ id: 'published-1', word: '沼', date: '2026-07-18' }],
    candidatePool: {
      そわそわ: {
        kanji: 'そわそわ',
        candidateType: '网络口语词',
        freshness: '长期',
        riskLevel: 'low',
        confidenceLevel: 'high',
        displayBucket: 'today',
        lastScore: 88
      }
    }
  });
  assert.equal(payload.action, 'stable_today');
  assert.equal(payload.count, 50);
  assert.deepEqual(payload.context.favorites, ['気が重い', '抜け感']);
  assert.deepEqual(payload.context.publishedWords, ['沼']);
  assert.equal(payload.context.existingCandidates[0].kanji, 'そわそわ');
  assert.equal(payload.context.existingCandidates[0].lastScore, 88);
});

test('automatic candidate service normalizes response and preserves batch trace', async () => {
  const payload = buildAutoAiCandidatePayload({});
  const result = await requestAutoAiCandidateBatch({
    request: async (_endpoint, requestOptions, meta) => {
      assert.equal(requestOptions.method, 'POST');
      assert.equal(meta.timeoutMs, 100000);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ kanji: 'そわそわ' }, {}],
          usage: { model: 'deepseek-test', createdAt: '2026-07-19T00:00:00.000Z' },
          summary: { trendNotes: '生活感表达增加' }
        })
      };
    },
    endpoint: '/ai-candidates',
    payload,
    normalizeItem: (item, batchId) => item.kanji ? { ...item, batchId } : null,
    buildBatchItems: rawItems => rawItems,
    buildTrace: () => ({ promptVersion: 'test-v1' }),
    cleanBatch: batch => batch,
    createBatchId: () => 'auto-test'
  });
  assert.deepEqual(result.items, [{ kanji: 'そわそわ', batchId: 'auto-test' }]);
  assert.equal(result.batch.id, 'auto-test');
  assert.equal(result.batch.rawCount, 2);
  assert.equal(result.batch.rejectedCount, 1);
  assert.equal(result.batch.promptVersion, 'test-v1');
  assert.equal(result.batch.trendNotes, '生活感表达增加');
});

test('automatic candidate service surfaces API errors', async () => {
  await assert.rejects(() => requestAutoAiCandidateBatch({
    request: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: '候选词服务暂时不可用' } })
    }),
    endpoint: '/ai-candidates',
    payload: buildAutoAiCandidatePayload({}),
    normalizeItem: item => item,
    buildBatchItems: items => items,
    buildTrace: () => ({}),
    cleanBatch: batch => batch
  }), /候选词服务暂时不可用/);
});

test('workflow backup builder cleans and serializes the complete workflow payload', () => {
  const backup = buildWorkflowBackup({
    words: ['抜け感', '抜け感', '気が重い'],
    candidatePool: { '抜け感': {}, '気が重い': {} },
    publishedRecords: [{ id: 'published-1' }],
    todaySnapshot: { words: ['抜け感'] },
    revision: 7
  }, { cleanWorkflow: cleanTestWorkflow });

  assert.deepEqual(backup.words, ['抜け感', '気が重い']);
  assert.equal(backup.revision, 7);
  assert.equal(formatWorkflowBackupSummary(backup), '选题 2 个、候选 2 个、发布记录 1 条、今日推荐 1 个');
  assert.equal(JSON.parse(serializeWorkflowBackup(backup)).revision, 7);
  assert.equal(getWorkflowBackupFilename('2026-07-19'), 'japanese-words-workflow-backup-2026-07-19.json');
  assert.equal(MAX_WORKFLOW_BACKUP_BYTES, 10 * 1024 * 1024);
});

test('workflow backup parser rejects invalid roots before cleaning restored data', () => {
  const restored = parseWorkflowBackupText('{"words":["抜け感","抜け感"],"revision":8}', {
    cleanWorkflow: cleanTestWorkflow
  });
  assert.deepEqual(restored.words, ['抜け感']);
  assert.equal(restored.revision, 8);
  assert.throws(
    () => parseWorkflowBackupText('{broken', { cleanWorkflow: cleanTestWorkflow }),
    /备份文件不是有效的 JSON/
  );
  assert.throws(
    () => parseWorkflowBackupText('[]', { cleanWorkflow: cleanTestWorkflow }),
    /备份根节点必须是 JSON 对象/
  );
  assert.throws(
    () => parseWorkflowBackupText('{}'),
    /工作流清理器不可用/
  );
});

test('recommendation audit CSV preserves every field and escapes spreadsheet values', () => {
  const csv = buildRecommendationAuditCsv({
    audit: {
      date: '2026-07-19',
      items: [{
        kanji: '気が重い',
        meaning: '心情沉重，"不想面对"',
        recommendationLevel: 'A',
        riskLevel: 'low',
        originType: 'candidate_pool',
        originLabel: '候选池旧词',
        fromDeepSeekNew: false,
        fromCandidatePool: true,
        isBackfill: false,
        fromLocalFallback: false,
        isDedupRelaxed: false,
        dedupDaysUsed: 30,
        finalScore: 88,
        accountLearningBonus: 7,
        accountLearningPenalty: 0,
        expressionValueScore: 92,
        chineseTransparencyScore: 45,
        genericTopicPenalty: 0,
        selectedReason: '有场景、适合收藏',
        diagnosis: ['情绪状态词', '容易配图']
      }]
    },
    words: [{ kanji: '気が重い', reading: 'きがおもい', meaning: '回退意思' }],
    riskStateByKanji: { '気が重い': '低风险' }
  });

  assert.equal(csv.split('\n').length, 2);
  assert.match(csv, /"心情沉重，""不想面对"""/);
  assert.match(csv, /"きがおもい"/);
  assert.match(csv, /"低风险"/);
  assert.match(csv, /"否","是","否","否","否","30","88"/);
  assert.match(csv, /"情绪状态词；容易配图"/);
  assert.equal(csvCell(['甲', '乙']), '"甲；乙"');
  assert.equal(getRecommendationAuditFilename('2026-07-19'), 'daily-hot-audit-2026-07-19.csv');
});

test('favorite selection export exposes formal fields only for ready card views', () => {
  const text = buildFavoriteSelectionExportText({
    dateLabel: '2026/7/19',
    items: [
      {
        word: { kanji: '抜け感', reading: 'ぬけかん', meaning: '松弛感' },
        statusLabel: '待发布',
        wordCardView: {
          hasFormalCard: false,
          unavailableMessage: 'DeepSeek 词卡未生成',
          suggestedTitles: ['不应导出的标题']
        }
      },
      {
        word: { kanji: '気が重い', reading: 'きがおもい', meaning: '心情沉重' },
        statusLabel: '无',
        wordCardView: {
          hasFormalCard: true,
          suggestedTitles: ['这个日语词太适合今天了'],
          summary: '不想面对某件事时的沉重感。',
          explanation: '强调心理负担。',
          contentAngles: ['上班前', '社交压力'],
          examples: [{ jp: '明日の会議は気が重い。', cn: '想到明天的会议就心情沉重。' }],
          coverSuggestion: { coverText: '不想面对', mainVisual: '通勤人物', style: '柔和插画' },
          interactionPrompts: ['你最近为什么気が重い？']
        }
      }
    ]
  });

  assert.match(text, /📅 2026\/7\/19/);
  assert.match(text, /1\. 【抜け感】ぬけかん/);
  assert.match(text, /DeepSeek 词卡未生成/);
  assert.doesNotMatch(text, /不应导出的标题/);
  assert.match(text, /推荐标题：这个日语词太适合今天了/);
  assert.match(text, /明日の会議は気が重い。（想到明天的会议就心情沉重。）/);
  assert.match(text, /互动引导：你最近为什么気が重い？/);
});

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

test('app shell controller routes navigation, settings, backup and outside-overlay actions', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createAppShellController({
    root,
    onToggleSidebar: () => calls.push(['sidebar']),
    onSwitchTab: tab => calls.push(['tab', tab]),
    onOpenSettings: () => calls.push(['settings', 'open']),
    onCloseSettings: () => calls.push(['settings', 'close']),
    onCloseModal: () => calls.push(['modal', 'close']),
    onExportBackup: () => calls.push(['backup', 'export']),
    onSelectRestore: () => calls.push(['backup', 'select'])
  });
  const action = (name, dataset = {}) => {
    const element = { dataset: { appShellAction: name, ...dataset } };
    element.closest = selector => selector === '[data-app-shell-action]' ? element : null;
    return element;
  };
  const click = target => listeners.get('click')({ target });

  click(action('toggle-sidebar'));
  click(action('switch-tab', { tab: 'favorites' }));
  click(action('open-settings'));
  click(action('close-settings'));
  click(action('export-backup'));
  click(action('select-restore'));
  const modalOverlay = action('close-modal-outside');
  click({ closest: () => modalOverlay });
  assert.equal(calls.some(call => call[0] === 'modal'), false);
  click(modalOverlay);
  const settingsOverlay = action('close-settings-outside');
  click(settingsOverlay);

  assert.deepEqual(calls, [
    ['sidebar'],
    ['tab', 'favorites'],
    ['settings', 'open'],
    ['settings', 'close'],
    ['backup', 'export'],
    ['backup', 'select'],
    ['modal', 'close'],
    ['settings', 'close']
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('app shell controller routes restore changes, keyboard navigation and errors safely', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const errors = [];
  createAppShellController({
    root,
    onSwitchTab: tab => calls.push(['tab', tab]),
    onRestoreWorkflow: event => calls.push(['restore', event.target.dataset.fileName]),
    onEscape: () => calls.push(['escape']),
    onExportBackup: () => { throw new Error('backup failed'); },
    onError: error => errors.push(error.message)
  });
  const action = (name, dataset = {}) => {
    const element = { dataset: { appShellAction: name, ...dataset } };
    element.closest = selector => selector === '[data-app-shell-action]' ? element : null;
    return element;
  };
  const restoreInput = action('restore-workflow', { fileName: 'backup.json' });
  listeners.get('change')({ target: restoreInput });
  let prevented = false;
  listeners.get('keydown')({
    key: 'Enter',
    target: action('switch-tab', { tab: 'published' }),
    preventDefault: () => { prevented = true; }
  });
  listeners.get('keydown')({ key: 'Escape', target: {} });
  listeners.get('click')({ target: action('export-backup') });

  assert.equal(prevented, true);
  assert.deepEqual(calls, [
    ['restore', 'backup.json'],
    ['tab', 'published'],
    ['escape']
  ]);
  assert.deepEqual(errors, ['backup failed']);
});

test('manual word modal controller routes close, submit, duplicate confirmation and detail actions', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createManualWordModalController({
    root,
    onClose: () => calls.push(['close']),
    onSubmit: () => calls.push(['submit']),
    onConfirmExisting: (kanji, rawOptions) => calls.push(['confirm', kanji, rawOptions]),
    onOpenDetail: kanji => calls.push(['detail', kanji])
  });
  const action = (name, dataset = {}) => {
    const element = { dataset: { manualWordAction: name, ...dataset } };
    element.closest = selector => selector === '[data-manual-word-action]' ? element : null;
    return element;
  };
  const click = target => listeners.get('click')({ target });

  click(action('close'));
  click(action('submit'));
  click(action('confirm-existing', {
    kanji: '抜け感',
    manualOptions: '{"discoverySource":"小红书"}'
  }));
  click(action('open-detail', { kanji: '抜け感' }));

  assert.deepEqual(calls, [
    ['close'],
    ['submit'],
    ['confirm', '抜け感', '{"discoverySource":"小红书"}'],
    ['detail', '抜け感']
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('manual word modal controller ignores outside actions and reports async failures', async () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: element => element.inside !== false
  };
  const errors = [];
  createManualWordModalController({
    root,
    onSubmit: async () => { throw new Error('submit failed'); },
    onClose: () => { throw new Error('outside action should be ignored'); },
    onError: error => errors.push(error.message)
  });
  const outside = { dataset: { manualWordAction: 'close' }, inside: false };
  outside.closest = () => outside;
  listeners.get('click')({ target: outside });
  const submit = { dataset: { manualWordAction: 'submit' }, inside: true };
  submit.closest = () => submit;
  listeners.get('click')({ target: submit });
  await Promise.resolve();

  assert.deepEqual(errors, ['submit failed']);
});

test('workflow actions controller routes shared card and feedback actions', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  let stopped = 0;
  const controller = createWorkflowActionsController({
    root,
    onGenerateTodayCard: kanji => calls.push(['today-card', kanji]),
    onGenerateDeepSeekCard: (kanji, force) => calls.push(['deepseek-card', kanji, force]),
    onToggleStatus: kanji => calls.push(['toggle-status', kanji]),
    onSelectStatus: (kanji, status) => calls.push(['select-status', kanji, status]),
    onToggleFeedback: kanji => calls.push(['toggle-feedback', kanji]),
    onNegativeFeedback: (kanji, reason) => calls.push(['feedback', kanji, reason]),
    onCodexFeedback: (kanji, reason) => calls.push(['codex-feedback', kanji, reason])
  });
  const action = (name, dataset = {}) => {
    const element = { dataset: { workflowAction: name, ...dataset } };
    element.closest = selector => selector.includes('data-workflow-action') ? element : null;
    return element;
  };
  const click = target => listeners.get('click')({ target, stopPropagation: () => { stopped += 1; } });

  click(action('generate-today-card', { kanji: '気が楽' }));
  click(action('generate-deepseek-card', { kanji: '沼', force: 'true' }));
  click(action('toggle-status', { kanji: '沼' }));
  click(action('select-status', { kanji: '沼', status: 'pending' }));
  click(action('toggle-feedback', { kanji: '沼' }));
  click(action('apply-feedback', { kanji: '沼', reason: 'tooBasic', context: 'default' }));
  click(action('apply-feedback', { kanji: 'エモい', reason: 'uninterested', context: 'codex-preview' }));

  assert.deepEqual(calls, [
    ['today-card', '気が楽'],
    ['deepseek-card', '沼', true],
    ['toggle-status', '沼'],
    ['select-status', '沼', 'pending'],
    ['toggle-feedback', '沼'],
    ['feedback', '沼', 'tooBasic'],
    ['codex-feedback', 'エモい', 'uninterested']
  ]);
  assert.equal(stopped, 7);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('workflow actions controller isolates outside actions and reports async failures', async () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: element => element.inside !== false
  };
  const errors = [];
  createWorkflowActionsController({
    root,
    onGenerateTodayCard: async () => { throw new Error('card failed'); },
    onToggleStatus: () => { throw new Error('outside action should be ignored'); },
    onError: error => errors.push(error.message)
  });
  const outside = { dataset: { workflowAction: 'toggle-status' }, inside: false };
  outside.closest = () => outside;
  listeners.get('click')({ target: outside });
  const generate = { dataset: { workflowAction: 'generate-today-card', kanji: '沼' }, inside: true };
  generate.closest = () => generate;
  listeners.get('click')({ target: generate, stopPropagation() {} });
  await Promise.resolve();

  assert.deepEqual(errors, ['card failed']);
});

test('modal actions controller routes all remaining generated modal actions', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createModalActionsController({
    root,
    onClose: () => calls.push(['close']),
    onToggleCodexFavorite: kanji => calls.push(['codex-favorite', kanji]),
    onExportRecommendationAudit: () => calls.push(['audit']),
    onMarkPending: kanji => calls.push(['pending', kanji]),
    onOpenPublishedRecord: (recordId, presetKanji) => calls.push(['record', recordId, presetKanji]),
    onCopyLibraryCleanup: mode => calls.push(['cleanup', mode]),
    onAutofillPublishedRecord: () => calls.push(['autofill']),
    onSavePublishedRecord: () => calls.push(['save']),
    onOpenPublishedDetail: recordId => calls.push(['published-detail', recordId]),
    onRefreshPublishedRecord: recordId => calls.push(['refresh', recordId])
  });
  const action = (name, dataset = {}) => {
    const element = { dataset: { modalAction: name, ...dataset } };
    element.closest = selector => selector === '[data-modal-action]' ? element : null;
    return element;
  };
  const click = target => listeners.get('click')({ target, stopPropagation() {} });

  click(action('close'));
  click(action('toggle-codex-favorite', { kanji: '沼' }));
  click(action('export-recommendation-audit'));
  click(action('mark-pending', { kanji: '抜け感' }));
  click(action('open-published-record', { recordId: 'record-1', presetKanji: '抜け感' }));
  click(action('copy-library-cleanup', { mode: 'dry' }));
  click(action('autofill-published-record'));
  click(action('save-published-record'));
  click(action('open-published-detail', { recordId: 'record-1' }));
  click(action('refresh-published-record', { recordId: 'record-1' }));

  assert.deepEqual(calls, [
    ['close'],
    ['close'],
    ['codex-favorite', '沼'],
    ['audit'],
    ['pending', '抜け感'],
    ['record', 'record-1', '抜け感'],
    ['cleanup', 'dry'],
    ['autofill'],
    ['save'],
    ['published-detail', 'record-1'],
    ['refresh', 'record-1']
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('modal actions controller isolates outside actions and reports async failures', async () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: element => element.inside !== false
  };
  const errors = [];
  createModalActionsController({
    root,
    onSavePublishedRecord: async () => { throw new Error('save failed'); },
    onClose: () => { throw new Error('outside action should be ignored'); },
    onError: error => errors.push(error.message)
  });
  const outside = { dataset: { modalAction: 'close' }, inside: false };
  outside.closest = () => outside;
  listeners.get('click')({ target: outside });
  const save = { dataset: { modalAction: 'save-published-record' }, inside: true };
  save.closest = () => save;
  listeners.get('click')({ target: save, stopPropagation() {} });
  await Promise.resolve();

  assert.deepEqual(errors, ['save failed']);
});

test('image fallback controller handles source, text, class and removal fallbacks', () => {
  let errorListener = null;
  const root = {
    addEventListener: (type, listener, capture) => {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      errorListener = listener;
    },
    removeEventListener: (type, listener, capture) => {
      assert.equal(type, 'error');
      assert.equal(listener, errorListener);
      assert.equal(capture, true);
      errorListener = null;
    }
  };
  const controller = createImageFallbackController({ root });
  const sourceImage = { dataset: { imageFallback: 'fallback-src', fallbackSrc: 'fallback.svg' }, src: 'broken.png', remove() { this.removed = true; } };
  errorListener({ target: sourceImage });
  assert.equal(sourceImage.src, 'fallback.svg');
  assert.equal(sourceImage.dataset.fallbackApplied, 'true');
  errorListener({ target: sourceImage });
  assert.equal(sourceImage.removed, true);

  const textParent = { textContent: '' };
  errorListener({ target: { dataset: { imageFallback: 'parent-text', fallbackText: '🍞' }, parentElement: textParent } });
  assert.equal(textParent.textContent, '🍞');

  const addedClasses = [];
  const classImage = {
    dataset: { imageFallback: 'parent-class-remove', parentClass: 'asset-missing' },
    parentElement: { classList: { add: value => addedClasses.push(value) } },
    remove() { this.removed = true; }
  };
  errorListener({ target: classImage });
  assert.deepEqual(addedClasses, ['asset-missing']);
  assert.equal(classImage.removed, true);

  const removeImage = { dataset: { imageFallback: 'remove' }, remove() { this.removed = true; } };
  errorListener({ target: removeImage });
  assert.equal(removeImage.removed, true);
  controller.destroy();
  assert.equal(errorListener, null);
});

test('published record parser extracts a safe Xiaohongshu share payload', () => {
  const parsed = parseXiaohongshuSharePayload(`
这个日语词太适合形容下班后的我
@记忆面包 图文
https://www.xiaohongshu.com/explore/abc123，
2026/07/19 18:30
点赞 1.2万 收藏 345 评论 67 分享 8 浏览 2.5w
正文里补充一点使用语境
  `);

  assert.equal(parsed.url, 'https://www.xiaohongshu.com/explore/abc123');
  assert.equal(parsed.noteId, 'abc123');
  assert.equal(parsed.title, '这个日语词太适合形容下班后的我');
  assert.equal(parsed.authorName, '记忆面包');
  assert.equal(parsed.contentType, '图文');
  assert.equal(parsed.publishedAt, '2026-07-19T18:30');
  assert.deepEqual(parsed.latestStats, {
    likes: 12000,
    favorites: 345,
    comments: 67,
    shares: 8,
    views: 25000
  });
  assert.equal(parsed.description, '正文里补充一点使用语境');
  assert.doesNotMatch(parsed.description, /https?:\/\//);
});

test('published record parser rejects lookalike and insecure URLs', () => {
  const lookalike = parseXiaohongshuSharePayload('测试标题\nhttps://xiaohongshu.com.evil.example/explore/abc');
  const insecure = parseXiaohongshuSharePayload('测试标题\nhttp://www.xiaohongshu.com/explore/abc');

  assert.equal(lookalike.url, '');
  assert.equal(lookalike.noteId, '');
  assert.equal(insecure.url, '');
  assert.equal(extractFirstUrl('链接：https://xhslink.com/a/abc。'), 'https://xhslink.com/a/abc');
  assert.equal(parseCountLikeValue('1.5k'), 1500);
  assert.equal(parseCountLikeValue('not-a-number'), 0);
  assert.equal(extractPublishedAtFromShareText('发布于 2026-7-9'), '2026-07-09T00:00');
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

test('daily hot date options keep today and tomorrow first and deduplicate history', () => {
  const options = buildDailyHotDateOptions({
    todayDateKey: '2026-07-19',
    tomorrowDateKey: '2026-07-20',
    historyDates: ['2026-07-18', '2026-07-17', '2026-07-18', '2026-07-20', 'invalid'],
    formatWeekday: dateKey => ({ '2026-07-20': '周一', '2026-07-18': '周六', '2026-07-17': '周五' })[dateKey] || ''
  });

  assert.deepEqual(options, [
    { value: 'today', label: '今天 · 2026-07-19' },
    { value: '2026-07-20', label: '明天 · 2026-07-20 · 周一' },
    { value: '2026-07-18', label: '2026-07-18 · 周六' },
    { value: '2026-07-17', label: '2026-07-17 · 周五' }
  ]);
  assert.equal(normalizeDailyHotDateSelection('2026-07-18', options), '2026-07-18');
  assert.equal(normalizeDailyHotDateSelection('2026-06-01', options), 'today');
});

test('daily hot source model filters a view without changing recommendation order', () => {
  const words = [
    { kanji: '思い切って', source: '每日热门归档' },
    { kanji: '手間取る', source: 'DeepSeek' },
    { kanji: '詰めが甘い', source: '每日热门归档' }
  ];
  const model = buildDailyHotSourceFilterModel({ words, sourceFilter: '每日热门归档' });

  assert.deepEqual(model.sources, ['每日热门归档', 'DeepSeek']);
  assert.deepEqual(model.visibleWords.map(word => word.kanji), ['思い切って', '詰めが甘い']);
  assert.equal(model.total, 3);
  assert.equal(model.visible, 2);
  assert.deepEqual(words.map(word => word.kanji), ['思い切って', '手間取る', '詰めが甘い']);
  assert.equal(buildDailyHotSourceFilterModel({ words, sourceFilter: '失效来源' }).sourceFilter, 'all');
});

test('history navigation sorts dates and keeps earlier/later boundaries stable', () => {
  const navigation = buildHistoryNavigationModel({
    dates: ['2026-07-17', '2026-07-19', '2026-07-18', '2026-07-18'],
    currentDate: '2026-07-18'
  });

  assert.deepEqual(navigation.dates, ['2026-07-19', '2026-07-18', '2026-07-17']);
  assert.equal(navigation.currentIndex, 1);
  assert.equal(navigation.earlierDisabled, false);
  assert.equal(navigation.laterDisabled, false);
  assert.equal(navigation.shift(1), '2026-07-17');
  assert.equal(navigation.shift(-1), '2026-07-19');
  assert.equal(navigation.shift(99), '2026-07-17');
});

test('daily hot controller routes filters, cards and keyboard preview without inline handlers', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createDailyHotPageController({
    root,
    onDateChange: value => calls.push(['date', value]),
    onSourceChange: (scope, value) => calls.push(['source', scope, value]),
    onManage: action => calls.push(['manage', action]),
    onOpenDetail: id => calls.push(['detail', id]),
    onToggleFavorite: kanji => calls.push(['favorite', kanji]),
    onOpenCodexPreview: index => calls.push(['preview', index]),
    onShiftHistory: step => calls.push(['shift', step])
  });
  const dispatch = (type, actionElement, options = {}) => {
    let stopped = false;
    let prevented = false;
    const stopElement = options.stopContains === undefined ? null : { contains: () => options.stopContains };
    listeners.get(type)({
      key: options.key,
      target: {
        closest: selector => selector === '[data-daily-hot-action]' ? actionElement : stopElement
      },
      stopPropagation: () => { stopped = true; },
      preventDefault: () => { prevented = true; }
    });
    return { stopped, prevented };
  };

  dispatch('change', { dataset: { dailyHotAction: 'date' }, value: '2026-07-18' });
  dispatch('change', { dataset: { dailyHotAction: 'source', scope: 'history' }, value: 'DeepSeek' });
  dispatch('click', { dataset: { dailyHotAction: 'manage', manageAction: 'fill' } });
  dispatch('click', { dataset: { dailyHotAction: 'manage', manageAction: 'audit' } });
  dispatch('click', { dataset: { dailyHotAction: 'manage', manageAction: 'exportAudit' } });
  dispatch('click', { dataset: { dailyHotAction: 'open-detail', wordId: 'today-1' } });
  assert.equal(dispatch('click', { dataset: { dailyHotAction: 'toggle-favorite', kanji: '思い切って' } }, { stopContains: true }).stopped, true);
  dispatch('click', { dataset: { dailyHotAction: 'shift-history', step: '-1' } });
  const keyResult = dispatch('keydown', { dataset: { dailyHotAction: 'open-codex-preview', index: '3' } }, { key: 'Enter' });
  const beforeStoppedAncestor = calls.length;
  dispatch('click', { dataset: { dailyHotAction: 'open-detail', wordId: 'blocked-card' } }, { stopContains: false });

  assert.equal(keyResult.prevented, true);
  assert.equal(calls.length, beforeStoppedAncestor);
  assert.deepEqual(calls, [
    ['date', '2026-07-18'],
    ['source', 'history', 'DeepSeek'],
    ['manage', 'fill'],
    ['manage', 'audit'],
    ['manage', 'exportAudit'],
    ['detail', 'today-1'],
    ['favorite', '思い切って'],
    ['shift', -1],
    ['preview', 3]
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
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

test('published performance score weights saves and deeper engagement above likes', () => {
  const score = getPublishedPerformanceScore({
    latestStats: { likes: 10, favorites: 5, comments: 2, shares: 1, views: 1000 }
  });
  assert.equal(score, 29);
  assert.equal(getRecentPublishedAverage([
    { sourceStatus: 'placeholder', latestStats: { likes: 999 } },
    { publishedAt: '2026-07-18', latestStats: { likes: 20 } },
    { publishedAt: '2026-07-17', latestStats: { favorites: 10 } }
  ]), 20);
});

test('published rating keeps high-save low-exposure content from penalizing the word', () => {
  const rating = ratePublishedRecord({
    publishedAt: '2026-07-15T12:00:00.000Z',
    latestStats: { likes: 10, favorites: 50, comments: 2, shares: 1, views: 1000 }
  }, {
    now: Date.parse('2026-07-19T12:00:00.000Z'),
    recentAverage: 300
  });

  assert.equal(rating.performanceScore, 119);
  assert.equal(rating.saveRate, 0.05);
  assert.equal(rating.level, '正常');
  assert.match(rating.reason, /流量不足/);
});

test('published rating waits 72 hours and flags high-exposure low-engagement content', () => {
  const recent = ratePublishedRecord({
    publishedAt: '2026-07-19T00:00:00.000Z',
    latestStats: { likes: 100, favorites: 30, comments: 10, shares: 2, views: 1000 }
  }, {
    now: Date.parse('2026-07-19T12:00:00.000Z'),
    recentAverage: 100
  });
  assert.equal(recent.level, '待评估');

  const weak = ratePublishedRecord({
    publishedAt: '2026-07-15T00:00:00.000Z',
    latestStats: { likes: 2, favorites: 2, comments: 1, shares: 0, views: 5000 }
  }, {
    now: Date.parse('2026-07-19T12:00:00.000Z'),
    recentAverage: 5
  });
  assert.equal(weak.level, '偏弱');
  assert.match(weak.reason, /有一定曝光但互动偏低/);
});

test('published page model and refresh summary provide stable empty and status copy', () => {
  assert.deepEqual(buildPublishedPageModel([]), {
    items: [],
    count: 0,
    isEmpty: true,
    countText: '管理已经发到小红书的内容和表现'
  });
  const model = buildPublishedPageModel([{ type: 'record' }, { type: 'placeholder' }]);
  assert.equal(model.countText, '当前共 2 条已发布记录 / 占位项');
  const summary = getPublishedAutoRefreshSummary({
    autoRefresh: {
      status: 'success',
      source: 'remote',
      lastMessage: '已更新',
      lastAttemptAt: '2026-07-19T09:10:00.000Z'
    }
  }, {
    statusLabels: { idle: '待更新', success: '更新成功' },
    sourceLabels: { remote: '页面识别' }
  });
  assert.deepEqual(summary, {
    label: '更新成功',
    message: '已更新',
    sourceLabel: '页面识别',
    timeLabel: '2026-07-19 09:10'
  });
});

test('published page controller routes cards, placeholders and actions without opening stopped links', () => {
  const listeners = new Map();
  const root = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    contains: () => true
  };
  const calls = [];
  const controller = createPublishedPageController({
    root,
    onOpenDetail: recordId => calls.push(['detail', recordId]),
    onEditRecord: (recordId, presetKanji) => calls.push(['edit', recordId, presetKanji]),
    onRefresh: recordId => calls.push(['refresh', recordId]),
    onRender: () => calls.push(['render'])
  });
  const dispatch = (actionElement, stopContains = null) => {
    let stopped = false;
    const stopElement = stopContains === null ? null : { contains: () => stopContains };
    listeners.get('click')({
      target: {
        closest: selector => selector === '[data-published-action]' ? actionElement : stopElement
      },
      stopPropagation: () => { stopped = true; },
      preventDefault() {}
    });
    return stopped;
  };

  dispatch({ dataset: { publishedAction: 'open-detail', recordId: 'record-1' } });
  dispatch({ dataset: { publishedAction: 'edit-record', recordId: '', presetKanji: '詰めが甘い' } });
  assert.equal(dispatch({ dataset: { publishedAction: 'refresh', recordId: 'record-1' } }, true), true);
  dispatch({ dataset: { publishedAction: 'render' } });
  const beforeStoppedLink = calls.length;
  assert.equal(dispatch({ dataset: { publishedAction: 'open-detail', recordId: 'record-1' } }, false), true);
  assert.equal(calls.length, beforeStoppedLink);
  assert.deepEqual(calls, [
    ['detail', 'record-1'],
    ['edit', '', '詰めが甘い'],
    ['refresh', 'record-1'],
    ['render']
  ]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test('word card view hides every formal field and reference image until the card is ready', () => {
  const view = buildWordCardViewModel({
    word: { kanji: 'しみじみ', reading: 'しみじみ', meaning: '深切地感受' },
    aiCard: {
      cardStatus: 'pending',
      summary: '不应提前展示',
      explanation: '不应提前展示',
      examples: [{ jp: 'しみじみ思う。', cn: '深有感触。' }],
      suggestedTitles: ['不应提前展示'],
      referenceImage: { status: 'ready', url: 'https://example.com/pending.png' }
    }
  });

  assert.equal(view.hasFormalCard, false);
  assert.equal(view.statusLabel, '生成中');
  assert.equal(view.summary, '');
  assert.equal(view.explanation, '');
  assert.deepEqual(view.examples, []);
  assert.deepEqual(view.suggestedTitles, []);
  assert.equal(view.hasReferenceImage, false);
  assert.equal(view.referenceImageUrl, '');
  assert.equal(view.listTitle, '生成中');
  assert.match(view.unavailableMessage, /生成中/);
});

test('word card view exposes sanitized formal content and image for ready cards', () => {
  const view = buildWordCardViewModel({
    word: { kanji: '思い切って', reading: 'おもいきって', meaning: '下定决心' },
    aiCard: {
      cardStatus: 'ready',
      cardSource: 'codex',
      summary: '跨过犹豫，鼓起勇气行动。',
      explanation: '用于终于下定决心采取行动的语境。',
      examples: [{ jp: '思い切って聞いてみた。', cn: '鼓起勇气问了。' }],
      suggestedTitles: ['日本人说「思い切って」是什么感觉？'],
      contentAngles: ['行动前的犹豫'],
      interactionPrompts: ['你最近鼓起勇气做了什么？'],
      coverSuggestion: { coverText: '思い切って', mainVisual: '跨过小河' },
      referenceImage: { status: 'ready', url: 'https://example.com/ready.png' }
    }
  });

  assert.equal(view.hasFormalCard, true);
  assert.equal(view.sourceLabel, 'Codex 词卡');
  assert.equal(view.statusLabel, '已生成词卡');
  assert.equal(view.title, '日本人说「思い切って」是什么感觉？');
  assert.equal(view.summary, '跨过犹豫，鼓起勇气行动。');
  assert.equal(view.examples.length, 1);
  assert.equal(view.hasCoverSuggestion, true);
  assert.equal(view.referenceImageUrl, 'https://example.com/ready.png');
  assert.equal(view.listTitle, view.title);
});

test('word card view labels DeepSeek cards by their stored source and marks stale pending cards retryable', () => {
  const view = buildWordCardViewModel({
    aiCard: { cardStatus: 'pending', cardSource: 'deepseek_api' },
    stalePending: true
  });

  assert.equal(view.sourceLabel, 'DeepSeek 词卡');
  assert.equal(view.statusLabel, '生成超时 · 可重试');
  assert.match(view.unavailableMessage, /DeepSeek 词卡生成已超时/);
});

test('word card view keeps ready content visible while an explicit regeneration is in flight', () => {
  const view = buildWordCardViewModel({
    aiCard: {
      cardStatus: 'ready',
      summary: '已经生成的正式内容',
      suggestedTitles: ['已有标题']
    },
    inFlight: true
  });

  assert.equal(view.storedStatus, 'ready');
  assert.equal(view.status, 'pending');
  assert.equal(view.statusLabel, '生成中');
  assert.equal(view.hasFormalCard, true);
  assert.equal(view.summary, '已经生成的正式内容');
});

test('word card view centralizes fallback data and failure copy', () => {
  const view = buildWordCardViewModel({
    word: { kanji: '気が楽', reading: 'きがらく', romaji: 'word-romaji', meaning: '轻松' },
    entry: { kana: 'きがらく', romaji: 'kigarak', meaning: 'entry meaning' },
    aiCard: { cardStatus: 'failed', summary: '失败内容不展示' }
  });

  assert.deepEqual(view.basic, {
    kanji: '気が楽',
    kana: 'きがらく',
    romaji: 'kigarak',
    meaning: '轻松'
  });
  assert.equal(view.statusLabel, WORD_CARD_STATUS_LABELS.failed);
  assert.equal(view.summary, '');
  assert.match(view.unavailableMessage, /生成失败/);
});

test('module migration removes inline handlers and the temporary window compatibility facade', () => {
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const combined = `${indexSource}\n${appSource}`;
  assert.ok(indexSource.includes('<script type="module" src="app.js"></script>'));
  assert.ok(appSource.includes("from './frontend/ai-card-generation.mjs'"));
  assert.ok(appSource.includes("from './frontend/app-shell.mjs'"));
  assert.ok(appSource.includes("from './frontend/content-export.mjs'"));
  assert.ok(appSource.includes("from './frontend/image-fallback.mjs'"));
  assert.ok(appSource.includes("from './frontend/manual-word-modal.mjs'"));
  assert.ok(appSource.includes("from './frontend/modal-actions.mjs'"));
  assert.ok(appSource.includes("from './frontend/word-card-view.mjs'"));
  assert.ok(appSource.includes("from './frontend/workflow-actions.mjs'"));
  assert.ok(appSource.includes('buildWordCardViewModel'));
  assert.doesNotMatch(combined, /\son[a-z]+=/i);
  assert.doesNotMatch(appSource, /Object\.assign\(window/);
  assert.doesNotMatch(appSource, /Compatibility facade/);
  assert.ok(indexSource.includes('data-app-shell-action="switch-tab"'));
  assert.ok(indexSource.includes('data-manage-action="audit"'));
  assert.ok(indexSource.includes('data-manage-action="exportAudit"'));
  assert.ok(indexSource.includes('data-image-fallback="parent-text"'));
  assert.ok(appSource.includes('data-manual-word-action="submit"'));
  assert.ok(appSource.includes('data-workflow-action="generate-deepseek-card"'));
  assert.equal(appSource.includes('data-workflow-action="candidate-state"'), false);
  assert.equal(appSource.includes('data-workflow-action="ai-preview-selection"'), false);
  assert.ok(appSource.includes('data-modal-action="save-published-record"'));
  assert.ok(appSource.includes('data-image-fallback="fallback-src"'));
});

test('published record share input preserves multiline text for safe parsing', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appSource.includes("from './frontend/published-record-parser.mjs'"));
  assert.match(appSource, /<textarea[^>]+id="recordLink"[^>]*>/);
  assert.doesNotMatch(appSource, /<input[^>]+id="recordLink"[^>]*>/);
});

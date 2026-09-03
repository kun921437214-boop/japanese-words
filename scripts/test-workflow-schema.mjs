import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cleanStoredWorkflow,
  isCompatibleTodaySnapshotGeneratorVersion,
  mergeWorkflow,
  mergeWorkflowForFullSave,
  stripInvalidCurrentTodaySnapshot
} from '../shared/workflow-schema.mjs';
import {
  cleanTodaySnapshot,
  generateTodaySnapshot,
  getRecentDailyHotBlockedWords,
  TODAY_HISTORY_DEDUP_DAYS,
  TODAY_SNAPSHOT_GENERATOR_VERSION,
  isCurrentGeneratorSnapshot
} from '../shared/today-snapshot.mjs';
import {
  DAILY_CONTENT_MIX_TARGETS,
  buildDailyQualityContext,
  buildDailyQualitySummary,
  getDailyContentMixLane,
  getDailyExpressionForm,
  getDailyQualityCategory,
  getDailyQualityScoreDelta
} from '../shared/today-quality.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';
import { DAILY_WORD_COUNT } from '../shared/daily-config.mjs';
import { buildDeepSeekExclusionContext } from '../shared/deepseek-exclusion.mjs';
import {
  AI_CARD_PENDING_TTL_MS as FRONTEND_AI_CARD_PENDING_TTL_MS,
  isAiCardStalePending as isFrontendAiCardStalePending
} from '../frontend/ai-card-generation.mjs';
import {
  applyFavoriteAction,
  buildAppWorkflowView,
  buildCandidateDetailView,
  buildFavoriteCommandView,
  buildPublishedDetailView
} from '../functions/favorites.js';
import {
  applyAiCardGenerationResult,
  isAiCardStalePending,
  selectTodayAiCardTargets,
  summarizeTodayAiCards
} from '../functions/ai-cards.js';
import {
  AI_CARD_FAILED_RETRY_TTL_MS,
  getTodayAiCardBatchPlan
} from '../worker/favorites-worker.js';

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const readyCard = {
  cardStatus: 'ready',
  cardSource: 'deepseek_api',
  cardModel: 'deepseek-v4-flash',
  generatedAt: '2026-05-30T01:00:00.000Z',
  summary: '小红书审美表达。',
  explanation: '用于描述自然又不费力的审美氛围。',
  examples: [{ jp: 'こなれ感がある。', cn: '很有随性的高级感。' }],
  suggestedTitles: ['日本人说「こなれ」，不是普通熟练'],
  interactionPrompts: ['你会用它形容哪种穿搭？']
};

test('前端初始化不会自动触发今日推荐生成', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal((appSource.match(/queueDailyAutoRefreshIfNeeded\(/g) || []).length, 1);
  assert.ok(appSource.includes('if (!options.force) return false;'));
  assert.equal(appSource.includes('正在自动生成今日推荐'), false);
  assert.equal(appSource.includes('自动生成中'), false);
  assert.ok(appSource.includes('function handleGenerateTodaySnapshot()'));
});

test('首次 pageshow 不会取消手机端初始化同步，BFCache 恢复时才重新同步', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const syncSource = fs.readFileSync(new URL('../frontend/workflow-sync.mjs', import.meta.url), 'utf8');
  const styleSource = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.ok(appSource.includes("window.addEventListener('pageshow', event =>"));
  assert.ok(appSource.includes('if (!event.persisted) {'));
  assert.ok(appSource.includes('void flushPendingFavoriteIntents();'));
  assert.ok(syncSource.includes('timeoutMs: config.timeoutMs || 45000'));
  assert.ok(syncSource.includes("cache: 'no-store'"));
  assert.ok(appSource.includes('void syncRemoteDataInBackground().finally(() => flushPendingFavoriteIntents());'));
  assert.ok(appSource.includes('if (cloudLoaded === false) {'));
  assert.ok(appSource.includes('if (cloudWorkflowFailed) {'));
  assert.ok(styleSource.includes('animation:pageIn 0.28s ease backwards;'));
  assert.ok(styleSource.includes('@media (hover:none), (pointer:coarse)'));
});

test('移动端本地缓存超额不会把成功的云端同步误判为失败', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const cacheSource = fs.readFileSync(new URL('../frontend/workflow-cache.mjs', import.meta.url), 'utf8');
  assert.ok(appSource.includes('const LOCAL_WORKFLOW_CACHE_CANDIDATE_LIMIT = DEFAULT_CANDIDATE_LIMIT;'));
  assert.ok(appSource.includes('const workflowCache = createWorkflowCache({'));
  assert.ok(cacheSource.includes('...safeArray(cleaned.todaySnapshot?.words)'));
  assert.ok(cacheSource.includes('candidatePool: compactCandidatePool'));
  assert.ok(cacheSource.includes('aiBatches: []'));
  assert.ok(cacheSource.includes("logger.warn('本地缓存写入失败，已保留当前云端数据'"));
  assert.ok(appSource.includes('const workflowCached = writeLocalWorkflowCache(payload);'));
  assert.equal((cacheSource.match(/storage\.setItem\(/g) || []).length, 1);
});

test('首屏先渲染本地缓存并并行刷新非依赖数据源', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appSource.includes("loadLocalWorkflow({ deferLibraryAudit: true })"));
  assert.ok(appSource.includes('const [rankingsLoaded, cloudLoaded] = await Promise.all(['));
  assert.ok(appSource.includes('void scheduleLibraryReviewHydration();'));
  assert.ok(appSource.includes("apiFetch('data/library-review.json', { cache: 'default' }"));
  assert.ok(appSource.includes('const [synced, workflowSynced] = await Promise.all(['));
  assert.equal(appSource.includes('void loadCodexTomorrowDraftStatus();'), false);
  assert.equal(appSource.includes('await loadCodexTomorrowDraftStatus();'), false);
});

test('候选池后台从用户界面下线但内部日更数据结构保持不变', () => {
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal(indexSource.includes('data-tab="candidate"'), false);
  assert.equal(indexSource.includes('id="page-candidate"'), false);
  assert.equal(indexSource.includes('候选池后台'), false);
  assert.equal(indexSource.includes('id="candidateGrid"'), false);
  assert.ok(appSource.includes("['today', 'favorites', 'published'].includes(normalizedTab)"));
  assert.ok(appSource.includes("(['today', 'favorites', 'published'].includes(savedTab)"));
  assert.equal(appSource.includes("document.getElementById('candidateGrid')"), false);
  assert.equal(appSource.includes('candidateSelection'), false);
  assert.equal(appSource.includes('renderAiWorkbench'), false);
  assert.ok(appSource.includes('candidatePool: cleanCandidatePool(candidatePool)'));
});

test('收藏页面显示已收藏并请求精简 app 工作流', () => {
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appSource.includes("none: '已收藏'"));
  assert.ok(indexSource.includes('<option value="none">已收藏</option>'));
  assert.ok(appSource.includes("url.searchParams.set('view', 'app');"));
  assert.ok(appSource.includes("url.searchParams.set('scope', scope);"));
  assert.ok(appSource.includes("if (historyDate) url.searchParams.set('historyDate', historyDate);"));
  assert.equal(appSource.includes("none: '无'"), false);
});

test('app 工作流只返回页面所需候选且不改变云端完整候选池', () => {
  const candidatePool = {
    收藏词: { kanji: '收藏词', kana: 'しゅうぞうし', meaning: '收藏测试词', sourceType: 'manual_keep' },
    今日词: {
      kanji: '今日词',
      kana: 'きょうし',
      meaning: '今日测试词',
      sourceType: 'deepseek_generated',
      sourceText: '不应发送到 app view 的生成原文',
      aiCard: {
        ...readyCard,
        summary: '列表需要的摘要',
        explanation: '只应在词卡详情接口返回的完整解释',
        suggestedTitles: ['列表标题', '详情备用标题'],
        interactionPrompts: ['只应在完整详情返回']
      },
      aiCardHistory: [{ cardStatus: 'ready', summary: '旧词卡' }]
    },
    发布词: { kanji: '发布词', kana: 'はっぴょうし', meaning: '发布测试词', sourceType: 'deepseek_reviewed' },
    历史词: { kanji: '历史词', kana: 'れきしし', meaning: '历史测试词', sourceType: 'deepseek_generated' },
    无关词: { kanji: '无关词', kana: 'むかんし', meaning: '无关测试词', sourceType: 'deepseek_generated' }
  };
  const fullWorkflow = {
    words: ['收藏词'],
    statuses: {},
    publishedRecords: [{
      id: 'published-test',
      word: '发布词',
      title: '已发布测试',
      description: '🍞发布词\n(はっぴょうし) ⓪\n列表可安全使用的已发布释义\n🍞这是例句',
      contentCategory: 'word_card',
      contentLocked: true,
      metricSnapshots: [{ dateKey: '2026-07-19', views: 100 }]
    }],
    candidatePool,
    aiBatches: [{ id: 'batch-test', action: 'generate_candidates' }],
    todaySnapshot: {
      dateKey: '2026-07-19',
      words: ['今日词'],
      generatedAt: '2026-07-19T00:00:00.000Z',
      generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
      version: 1
    },
    historySnapshots: {
      '2026-07-18': {
        dateKey: '2026-07-18',
        words: ['历史词'],
        generatedAt: '2026-07-18T00:00:00.000Z',
        version: 1,
        recommendationAudit: {
          date: '2026-07-18',
          total: 1,
          items: [{ kanji: '历史词', recommendationLevel: 'A', finalScore: 88 }]
        }
      }
    }
  };
  const appView = buildAppWorkflowView(fullWorkflow);
  assert.deepEqual(Object.keys(appView.candidatePool).sort(), ['今日词', '发布词', '收藏词'].sort());
  assert.deepEqual(appView.aiBatches, []);
  const historyView = buildAppWorkflowView(fullWorkflow, { historyDate: '2026-07-18' });
  assert.deepEqual(Object.keys(historyView.candidatePool).sort(), ['今日词', '发布词', '历史词', '收藏词'].sort());
  const todayScope = buildAppWorkflowView(fullWorkflow, { scope: 'today' });
  assert.deepEqual(Object.keys(todayScope.candidatePool), ['今日词']);
  assert.equal(todayScope.appView.scope, 'today');
  assert.equal(todayScope.appView.partialCandidatePool, true);
  assert.equal(todayScope.appView.partialPublishedRecords, true);
  assert.equal(todayScope.appView.candidateProjection, 'list');
  assert.deepEqual(todayScope.publishedRecords, []);
  assert.deepEqual(todayScope.candidatePool['今日词'].aiCardHistory, []);
  assert.equal(todayScope.candidatePool['今日词'].sourceText, '');
  assert.equal(todayScope.candidatePool['今日词'].candidateProjection, 'list');
  assert.equal(todayScope.candidatePool['今日词'].aiCard.projection, 'list');
  assert.equal(todayScope.candidatePool['今日词'].aiCard.summary, '列表需要的摘要');
  assert.equal(todayScope.candidatePool['今日词'].aiCard.explanation, undefined);
  assert.deepEqual(todayScope.candidatePool['今日词'].aiCard.suggestedTitles, ['列表标题']);
  assert.deepEqual(todayScope.historySnapshots['2026-07-18'].recommendationAudit, {});
  const historyScope = buildAppWorkflowView(fullWorkflow, { scope: 'today', historyDate: '2026-07-18' });
  assert.deepEqual(Object.keys(historyScope.candidatePool), ['历史词']);
  assert.equal(historyScope.historySnapshots['2026-07-18'].recommendationAudit.items.length, 1);
  const favoritesScope = buildAppWorkflowView(fullWorkflow, { scope: 'favorites' });
  assert.deepEqual(Object.keys(favoritesScope.candidatePool), ['收藏词']);
  assert.deepEqual(favoritesScope.historySnapshots, {});
  assert.deepEqual(favoritesScope.todaySnapshotHistory, []);
  assert.deepEqual(favoritesScope.publishedRecords, []);
  const publishedScope = buildAppWorkflowView(fullWorkflow, { scope: 'published' });
  assert.deepEqual(Object.keys(publishedScope.candidatePool), ['发布词']);
  assert.equal(publishedScope.appView.publishedSummary, true);
  assert.equal(publishedScope.publishedRecords[0].description, '');
  assert.equal(publishedScope.publishedRecords[0].contentSummary, '列表可安全使用的已发布释义');
  assert.deepEqual(publishedScope.publishedRecords[0].metricSnapshots, []);
  const publishedDetail = buildPublishedDetailView(fullWorkflow, 'published-test');
  assert.equal(publishedDetail.ok, true);
  assert.equal(publishedDetail.record.description, '🍞发布词\n(はっぴょうし) ⓪\n列表可安全使用的已发布释义\n🍞这是例句');
  assert.equal(publishedDetail.record.metricSnapshots.length, 1);
  assert.equal(publishedDetail.candidate.kanji, '发布词');
  assert.equal(buildPublishedDetailView(fullWorkflow, 'missing-record').ok, false);
  const candidateDetail = buildCandidateDetailView(fullWorkflow, '今日词');
  assert.equal(candidateDetail.ok, true);
  assert.equal(candidateDetail.candidate.candidateProjection, 'detail');
  assert.equal(candidateDetail.candidate.aiCard.projection, 'detail');
  assert.equal(candidateDetail.candidate.aiCard.explanation, '只应在词卡详情接口返回的完整解释');
  assert.deepEqual(candidateDetail.candidate.aiCard.suggestedTitles, ['列表标题', '详情备用标题']);
  assert.equal(buildCandidateDetailView(fullWorkflow, '不存在').ok, false);
  const unrelatedCandidatePool = { ...candidatePool };
  Object.defineProperty(unrelatedCandidatePool, '大型无关词', {
    enumerable: true,
    get() {
      throw new Error('今日视图不应清洗无关候选');
    }
  });
  const projectedTodayScope = buildAppWorkflowView({
    ...fullWorkflow,
    candidatePool: unrelatedCandidatePool
  }, { scope: 'today' });
  assert.deepEqual(Object.keys(projectedTodayScope.candidatePool), ['今日词']);
  const savedFromCompactCandidate = applyFavoriteAction(fullWorkflow, {
    action: 'status',
    word: '今日词',
    status: 'pending',
    candidatePool: todayScope.candidatePool
  });
  assert.equal(savedFromCompactCandidate.candidatePool['今日词'].sourceText, '不应发送到 app view 的生成原文');
  assert.equal(savedFromCompactCandidate.candidatePool['今日词'].aiCardHistory.length, 1);
  const savedFromCompactHistory = mergeWorkflowForFullSave(fullWorkflow, {
    historySnapshots: todayScope.historySnapshots,
    todaySnapshotHistory: todayScope.todaySnapshotHistory
  });
  assert.equal(savedFromCompactHistory.historySnapshots['2026-07-18'].recommendationAudit.items.length, 1);
  assert.equal(Object.keys(candidatePool).length, 5);
  assert.ok(candidatePool['无关词']);
  assert.equal(candidatePool['今日词'].sourceText, '不应发送到 app view 的生成原文');
  assert.equal(candidatePool['今日词'].aiCardHistory.length, 1);
});

test('前端按页面加载候选并在收藏数据到齐前禁止渲染', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const storeSource = fs.readFileSync(new URL('../frontend/workflow-store.mjs', import.meta.url), 'utf8');
  assert.ok(appSource.includes('const workflowStore = createWorkflowStore({'));
  assert.ok(storeSource.includes('const loadedScopes = new Set();'));
  assert.ok(appSource.includes('function ensureWorkflowScopeLoaded(scope, options = {})'));
  assert.ok(appSource.includes("if (!isWorkflowScopeLoaded('favorites'))"));
  assert.ok(appSource.includes("renderWorkflowScopeState('favorites');"));
  assert.ok(appSource.includes("scope: cleanScope,"));
  assert.ok(appSource.includes('mergeCandidatePool: true'));
  assert.ok(storeSource.includes('const mergePartialState = Boolean(config.mergeCandidatePool || data.appView?.partialCandidatePool);'));
  assert.ok(storeSource.includes('? mergeHistorySnapshots(currentState.historySnapshots, data.historySnapshots)'));
  assert.ok(appSource.includes('applyWorkflowData(prepared.state);'));
  assert.ok(appSource.includes('scheduleWorkflowCacheWrite(prepared.data.updated || lastCloudSyncAt);'));
  assert.ok(appSource.includes('void scheduleLibraryReviewHydration();'));
});

test('收藏命令只返回小响应且状态操作可补回缺失收藏', () => {
  const current = {
    words: ['既有收藏'],
    statuses: {},
    candidatePool: {
      既有收藏: { kanji: '既有收藏', meaning: '既有词', sourceType: 'manual_keep' },
      新状态词: { kanji: '新状态词', meaning: '状态词', sourceType: 'manual_keep' }
    },
    aiBatches: [{ id: 'large-batch', action: 'generate_candidates', rawOutput: 'x'.repeat(4000) }],
    todaySnapshot: { dateKey: '2026-07-19', words: ['既有收藏'], version: 1 }
  };
  const updated = applyFavoriteAction(current, { action: 'status', word: '新状态词', status: 'pending' });
  assert.ok(updated.words.includes('新状态词'));
  assert.equal(updated.statuses['新状态词'], 'pending');

  const commandView = buildFavoriteCommandView(updated, '新状态词');
  assert.deepEqual(commandView.words, updated.words);
  assert.equal(commandView.statuses['新状态词'], 'pending');
  assert.equal(commandView.candidate.kanji, '新状态词');
  assert.equal('aiBatches' in commandView, false);
  assert.equal('todaySnapshot' in commandView, false);
});

test('前端收藏使用小命令响应并防止旧同步覆盖新版本', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const syncSource = fs.readFileSync(new URL('../frontend/workflow-sync.mjs', import.meta.url), 'utf8');
  const storeSource = fs.readFileSync(new URL('../frontend/workflow-store.mjs', import.meta.url), 'utf8');
  const commandSource = appSource.slice(
    appSource.indexOf('function buildFavoriteCommandPayload'),
    appSource.indexOf('async function fetchFavoriteCommandState')
  );
  assert.ok(appSource.includes("url.searchParams.set('view', 'command');"));
  assert.ok(appSource.includes('function applyFavoriteCommandResponse(responseData, kanji)'));
  assert.ok(commandSource.includes('payload.candidatePool = { [kanji]: candidate };'));
  assert.equal(commandSource.includes('publishedRecords'), false);
  assert.equal(commandSource.includes('aiBatches'), false);
  assert.equal(commandSource.includes('aiPreview'), false);
  assert.ok(storeSource.includes('data.revision < revision'));
  assert.ok(syncSource.includes("error?.code === 'REQUEST_ABORTED'"));
  assert.ok(syncSource.includes('function isRetryableWorkflowMutationError(error)'));
  assert.ok(appSource.includes("async function requestFavoriteCommand(kanji, action, status = '', operationId = '')"));
  assert.ok(syncSource.includes('for (let attempt = 0; attempt < 2; attempt += 1)'));
  assert.ok(appSource.includes('operationId: operationId || createOperationId'));
  assert.ok(syncSource.includes('timeoutMs: config.timeoutMs || 30000'));
  assert.ok(appSource.includes('function isFavoriteCommandDataSatisfied(responseData, kanji, action, status = \'\')'));
  assert.ok(appSource.includes('reconcile: () => fetchFavoriteCommandState(kanji)'));
  assert.ok(appSource.includes('buildReconciledResponse: responseData => ({ ...responseData, ok: true, reconciled: true })'));
  assert.ok(syncSource.includes("if (error?.status === 409 && !reconciled) break;"));
  assert.ok(appSource.includes('const favoriteIntentStore = createFavoriteIntentStore({'));
  assert.ok(appSource.includes('favoriteIntentStore.markWaiting'));
  assert.ok(appSource.includes('applyPendingFavoriteIntents();'));
  assert.equal(appSource.includes('favorites = previousFavorites;'), false);
  assert.ok(appSource.includes("window.addEventListener('online', () =>"));
  assert.ok(appSource.includes("document.addEventListener('visibilitychange', () =>"));
});

test('历史日期缺少 aiCard 时安全渲染并按需重新加载词卡', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
  assert.equal(isFrontendAiCardStalePending({
    cardStatus: 'pending',
    generatedAt: new Date(nowMs - FRONTEND_AI_CARD_PENDING_TTL_MS - 1).toISOString()
  }, {}, { nowMs }), true);
  assert.equal(isFrontendAiCardStalePending({ cardStatus: 'none' }, {}, { nowMs }), false);
  assert.ok(appSource.includes("const card = cleanAiCard(aiCard || {}) || { cardStatus: 'none' };"));
  assert.ok(appSource.includes('正在加载这一天的词卡内容'));
  assert.ok(appSource.includes("void ensureWorkflowScopeLoaded('today', { historyDate }).then"));
  assert.ok(appSource.includes("console.error('工作流已同步，但页面渲染失败'"));
});

test('Codex 明日预览保留团队操作和完整词卡详情', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appSource.includes('function toggleCodexDraftFavorite(kanji)'));
  assert.ok(appSource.includes('function applyCodexDraftFeedback(kanji'));
  assert.ok(appSource.includes("renderFeedbackControl(item.kanji, { context: 'codex-preview' })"));
  assert.ok(appSource.includes('加入收藏 / 选题池'));
  assert.ok(appSource.includes('目标受众'));
  assert.ok(appSource.includes('封面建议'));
  assert.ok(appSource.includes('const interactionPrompts = wordCardView.interactionPrompts;'));
  assert.ok(appSource.includes('interactionPrompts.map(prompt =>'));
  assert.ok(appSource.includes('相近词'));
  assert.ok(appSource.includes('风险与使用提醒'));
});

test('Codex 组合生成器版本在前端保持为当日快照', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appSource.includes('function isCompatibleTodaySnapshotGeneratorVersion(value'));
  assert.ok(appSource.includes("generatorVersion.startsWith(`${TODAY_SNAPSHOT_GENERATOR_VERSION}+`)"));
  assert.ok(appSource.includes('cleanTodaySnapshot as cleanSharedTodaySnapshot'));
  assert.ok(appSource.includes('return cleanSharedTodaySnapshot(snapshot);'));
  assert.ok(appSource.includes('&& isCompatibleTodaySnapshotGeneratorVersion(cleanSnapshot.generatorVersion)'));
});

test('Codex 当日快照通过共享版本门并保留来源元数据', () => {
  const now = new Date('2026-07-16T03:16:07.412Z');
  const snapshot = {
    dateKey: '2026-07-16',
    words: ['胸がざわつく'],
    generatedAt: now.toISOString(),
    source: 'codex_draft',
    version: 2,
    generatorVersion: `${TODAY_SNAPSHOT_GENERATOR_VERSION}+codex-daily-v1`,
    createdBy: 'codex'
  };
  const cleanedSnapshot = cleanTodaySnapshot(snapshot);
  assert.equal(isCompatibleTodaySnapshotGeneratorVersion(snapshot.generatorVersion), true);
  assert.equal(isCurrentGeneratorSnapshot(snapshot, now), true);
  assert.equal(cleanedSnapshot.source, 'codex_draft');
  assert.equal(cleanedSnapshot.createdBy, 'codex');

  const workflow = stripInvalidCurrentTodaySnapshot({ todaySnapshot: snapshot }, now);
  assert.deepEqual(workflow.todaySnapshot.words, snapshot.words);
  assert.equal(workflow.todaySnapshot.source, 'codex_draft');
  assert.equal(workflow.todaySnapshot.createdBy, 'codex');
});

test('Codex 参考图在列表卡和详情卡中完整展示', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const wordCardViewSource = fs.readFileSync(new URL('../frontend/word-card-view.mjs', import.meta.url), 'utf8');
  const styleSource = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.ok(appSource.includes("from './frontend/word-card-view.mjs'"));
  assert.ok(wordCardViewSource.includes("storedStatus === 'ready'"));
  assert.ok(wordCardViewSource.includes("card.referenceImage?.status === 'ready'"));
  assert.ok(appSource.includes('wordCardView.hasReferenceImage'));
  assert.ok(appSource.includes('daily-hot-reference-card'));
  assert.ok(appSource.includes('function renderWordDetailHero(word, wordCardView, fallbackHero)'));
  assert.ok(appSource.includes('modal-hero-full-reference'));
  assert.ok(appSource.includes('查看原图 ↗'));
  assert.match(styleSource, /\.daily-hot-reference-card \.card-image\s*\{[^}]*object-fit:contain;/);
  assert.match(styleSource, /\.modal-hero-full-reference \.modal-hero-img\s*\{[^}]*object-fit:contain;/);
  assert.match(styleSource, /\.modal-container\s*\{[^}]*overflow-x:hidden;/);
  assert.match(styleSource, /@media \(max-width:640px\)[\s\S]*?\.detail-judgement-grid,[\s\S]*?grid-template-columns:1fr;/);
  assert.ok(styleSource.includes('aspect-ratio:3 / 4;'));
});

test('Tencent runtime owns scheduled jobs while Cloudflare rollback cron stays disabled', () => {
  const workerConfig = fs.readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  const workerSource = fs.readFileSync(new URL('../worker/favorites-worker.js', import.meta.url), 'utf8');
  const tencentSource = fs.readFileSync(new URL('../server/tencent-runtime.mjs', import.meta.url), 'utf8');

  assert.ok(workerConfig.includes('crons = []'));
  assert.equal(workerConfig.includes('"0 16 * * *"'), false);
  assert.equal(workerConfig.includes('"30 6 * * *"'), false);
  assert.equal(workerConfig.includes('"5,25,45 * * * *"'), false);
  assert.equal(workerConfig.includes('"10,20,30,40,50 16 * * *"'), false);
  assert.equal(workerConfig.includes('"0 17 * * *"'), false);
  assert.equal(workerConfig.includes('"15 9 * * *"'), false);
  assert.equal(workerConfig.includes('"10 16 * * *"'), false);
  assert.ok(tencentSource.includes("'0 16 * * *'"));
  assert.ok(tencentSource.includes("'30 6 * * *'"));
  assert.ok(tencentSource.includes("'5,25,45 * * * *'"));
  assert.ok(tencentSource.includes("'10,20,30,40,50 16 * * *'"));
  assert.ok(tencentSource.includes("'0 17 * * *'"));
  assert.ok(workerSource.includes("const DAILY_REFRESH_CRON = '0 16 * * *';"));
  assert.ok(workerSource.includes("const PUBLISHED_REFRESH_CRON = '30 6 * * *';"));
  assert.ok(workerSource.includes("const CODEX_LATE_PROMOTION_CRON = '5,25,45 * * * *';"));
  assert.ok(workerSource.includes("DAILY_DRAFT_HEALTH_CRON = '15 9 * * *';"));
  assert.ok(workerSource.includes("DAILY_SNAPSHOT_HEALTH_CRON = '10 16 * * *';"));
  assert.ok(workerSource.includes("const AI_CARD_BATCH_MAX_WORDS = 5;"));
  assert.ok(workerSource.includes("new URL(`${siteUrl}/codex-daily`)"));
  assert.ok(workerSource.includes("action: 'promote'"));
  assert.ok(workerSource.includes("new URL(`${siteUrl}/daily-refresh`)"));
  assert.ok(workerSource.includes("refreshUrl.searchParams.set('mode', 'manual')"));
  assert.ok(workerSource.includes("refreshUrl.searchParams.set('runInline', 'true')"));
  assert.ok(workerSource.includes("refreshUrl.searchParams.set('skipCards', 'true')"));
  assert.ok(workerSource.includes("'Content-Type': 'application/json'"));
  assert.ok(workerSource.includes('Authorization: `Bearer ${autoRefreshSecret}`'));
  assert.ok(workerSource.includes("new URL(`${siteUrl}/ai-cards`)"));
  assert.ok(workerSource.includes("mode: 'today'"));
  assert.ok(workerSource.includes('maxWords: AI_CARD_BATCH_MAX_WORDS'));
  assert.ok(workerSource.includes('retryStalePending: plan.retryStalePending'));
  assert.ok(workerSource.includes('retryFailed: plan.retryFailed'));
  assert.ok(workerSource.includes('words: plan.targetWords'));
  assert.ok(workerSource.includes('if (!plan.shouldRun)'));
  assert.ok(workerSource.includes('cron !== PUBLISHED_REFRESH_CRON'));
  assert.ok(workerSource.includes('triggerCodexPromotionIfAvailable(env)'));
  assert.ok(workerSource.includes("requireScheduledSuccess('daily publish'"));
  assert.equal(workerSource.includes('triggerDailyPublishOrFallback(env).catch'), false);
  assert.equal(workerSource.includes('force: true'), false);
});

test('scheduled Worker retries stale pending cards without blocking missing cards', () => {
  const plan = getTodayAiCardBatchPlan({
    readyCount: 1,
    missingCount: 14,
    pendingCount: 5,
    stalePendingCount: 5
  });
  assert.equal(plan.activePendingCount, 0);
  assert.equal(plan.retryStalePending, true);
  assert.equal(plan.shouldRun, true);
});

test('scheduled Worker still waits while card generation is actively pending', () => {
  const plan = getTodayAiCardBatchPlan({
    readyCount: 8,
    missingCount: 10,
    pendingCount: 2,
    stalePendingCount: 1
  });
  assert.equal(plan.activePendingCount, 1);
  assert.equal(plan.retryStalePending, true);
  assert.equal(plan.shouldRun, false);
});

test('scheduled Worker retries old failed cards from the observed daily state', () => {
  const nowMs = Date.parse('2026-07-12T00:40:00.000Z');
  const failedWords = ['沼', '残暑', '手料理', '絶賛'];
  const plan = getTodayAiCardBatchPlan({
    readyCount: 16,
    missingCount: 0,
    failedCount: 4,
    pendingCount: 0,
    stalePendingCount: 0,
    items: [
      { kanji: '懐かしい', cardStatus: 'ready', generatedAt: '2026-07-11T16:11:38.627Z' },
      ...failedWords.map(kanji => ({
        kanji,
        cardStatus: 'failed',
        generatedAt: '2026-06-11T08:09:19.000Z'
      }))
    ]
  }, { nowMs });
  assert.equal(plan.retryableFailedCount, 4);
  assert.equal(plan.retryFailed, true);
  assert.deepEqual(plan.targetWords, failedWords);
  assert.equal(plan.shouldRun, true);
});

test('scheduled Worker waits before retrying a fresh failed card', () => {
  const nowMs = Date.parse('2026-07-12T00:40:00.000Z');
  const plan = getTodayAiCardBatchPlan({
    readyCount: 19,
    missingCount: 0,
    failedCount: 1,
    pendingCount: 0,
    stalePendingCount: 0,
    items: [{
      kanji: '絶賛',
      cardStatus: 'failed',
      generatedAt: new Date(nowMs - AI_CARD_FAILED_RETRY_TTL_MS + 1000).toISOString()
    }]
  }, { nowMs });
  assert.equal(plan.retryableFailedCount, 0);
  assert.equal(plan.retryFailed, false);
  assert.deepEqual(plan.targetWords, []);
  assert.equal(plan.shouldRun, false);
});

function makeQualityCandidate(kanji, overrides = {}) {
  return {
    kanji,
    meaning: `${kanji} 的小红书表达场景`,
    sourceType: 'deepseek_generated',
    displayBucket: 'today',
    riskLevel: 'low',
    confidenceLevel: 'high',
    evidenceType: 'common_usage',
    lastReviewState: 'approved',
    expressionValueScore: 84,
    xhsFitScore: 82,
    candidateType: '生活方式词',
    reason: '有情绪、社交或生活状态画面，适合标题封面收藏。',
    ...overrides
  };
}

test('daily quality audit flags 2026-06-29 basic greeting heavy set', () => {
  const entries = [
    'ありがとうございます',
    'おはようございます',
    'お願いします',
    'ぐっと',
    'こんにちは',
    'こんばんは',
    'しんみり',
    'ほのぼの',
    'かぶる',
    'だらける',
    '胸きゅん',
    'お疲れ気味',
    'やる気',
    '神回',
    'かわちい',
    'ちゅき',
    'アイシャドウベース',
    'くすみ',
    'わくわく',
    'グロスリップ'
  ].map(kanji => makeQualityCandidate(kanji));
  const summary = buildDailyQualitySummary(entries);
  assert.equal(summary.categoryCounts.basic_greeting, 4);
  assert.equal(summary.categoryCounts.textbook_polite, 1);
  assert.equal(summary.categoryCounts.beauty_product, 2);
  assert.equal(summary.categoryCounts.cute_slang, 3);
  assert.equal(summary.relaxed, true);
  assert.ok(summary.warnings.some(text => text.includes('basic_greeting_textbook_polite')));
  assert.ok(summary.warnings.some(text => text.includes('beauty_product')));
  assert.ok(summary.warnings.some(text => text.includes('cute_slang')));
});

test('daily snapshot selection enforces the published-review content mix and phrase limits', () => {
  const emotionWords = ['ぐっと', 'しんみり'];
  const socialWords = ['かぶる', '気を遣う'];
  const abbreviationWords = ['タイパ', 'コスパ'];
  const trendWords = ['メロい'];
  const beautyExpressionWords = ['オーロラ肌', 'シアーレイヤード'];
  const flexibleWords = ['追い込み'];
  const basicWords = ['ありがとうございます', 'おはようございます', 'こんにちは', 'こんばんは'];
  const politeWords = ['お願いします', 'よろしくお願いします'];
  const beautyWords = ['アイシャドウベース', 'グロスリップ', 'マスカラ'];
  const fandomWords = ['推し増し', '尊み', '沼落ち', '解釈一致'];
  const candidatePool = {};
  [
    ...emotionWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '网络口语词', reason: '情绪状态，中文不好直译，有收藏价值。' })),
    ...socialWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '稳定候选', reason: '人际关系和社交语感表达。' })),
    ...abbreviationWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '网络口语词', reason: '成熟日常缩略语，说明完整形式和常用场景。' })),
    ...trendWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '新鲜梗词', displayBucket: 'meme_fast', evidenceType: 'trend_claim', freshness: '短期', reason: '有时间证据的低风险流行表达。' })),
    ...beautyExpressionWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '美妆穿搭词', reason: '具体美妆穿搭表达，可视化且能讲语感差异。' })),
    ...flexibleWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '生活方式词', reason: '生活学习状态场景。' })),
    ...basicWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 95, candidateType: '稳定候选', reason: '基础问候。' })),
    ...politeWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 94, candidateType: '稳定候选', reason: '教材礼貌表达。' })),
    ...beautyWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 93, candidateType: '美妆穿搭词', reason: '美妆品类名。' })),
    ...fandomWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 92, candidateType: '追星兴趣词', reason: '追星圈层表达。' }))
  ].forEach(entry => {
    candidatePool[entry.kanji] = entry;
  });
  const { result } = generateTodaySnapshot({ candidatePool }, {
    now: new Date('2026-06-30T01:00:00.000Z'),
    createdBy: 'server'
  });
  const words = result.todaySnapshot.words;
  const categories = words.map(word => getDailyQualityCategory(candidatePool[word]));
  const countCategory = category => categories.filter(item => item === category).length;
  const laneCounts = words.reduce((result, word) => {
    const lane = getDailyContentMixLane(candidatePool[word]);
    result[lane] = (result[lane] || 0) + 1;
    return result;
  }, {});
  const forms = words.map(word => getDailyExpressionForm(candidatePool[word]));
  assert.equal(words.length, DAILY_WORD_COUNT);
  assert.ok(countCategory('basic_greeting') + countCategory('textbook_polite') <= 1);
  assert.ok(countCategory('beauty_product') <= 1);
  assert.ok(countCategory('fandom_circle') <= 2);
  assert.ok(countCategory('emotion_state') >= 2);
  assert.ok(countCategory('social_nuance') >= 2);
  assert.deepEqual(laneCounts, DAILY_CONTENT_MIX_TARGETS);
  assert.deepEqual(result.todaySnapshot.recommendationAudit.qualitySummary.contentMixLaneCounts, DAILY_CONTENT_MIX_TARGETS);
  assert.equal(result.todaySnapshot.recommendationAudit.items.every(item => item.contentMixLane && item.expressionForm), true);
  assert.ok(forms.filter(form => form !== 'short_expression').length <= 2);
  assert.ok(forms.filter(form => form === 'long_idiom').length <= 1);
  assert.equal(result.recommendationAudit.qualitySummary.relaxed, false);
});

test('content mix distinguishes specific beauty expressions and established abbreviations from generic labels', () => {
  assert.equal(getDailyContentMixLane(makeQualityCandidate('タイパ', {
    candidateType: '网络口语词',
    reason: '成熟日常缩略语，完整形式与使用场景明确。'
  })), 'daily_abbreviation');
  assert.equal(getDailyContentMixLane(makeQualityCandidate('謎略語', {
    candidateType: '网络口语词',
    confidenceLevel: 'review',
    evidenceType: 'unknown',
    reason: '来源不明缩写。'
  })), 'flexible');
  assert.equal(getDailyContentMixLane(makeQualityCandidate('オーロラ肌', {
    candidateType: '美妆穿搭词',
    reason: '具体美妆表达，可视化且能讲语感差异。'
  })), 'beauty_fashion_expression');
  assert.equal(getDailyContentMixLane(makeQualityCandidate('ネイル', {
    candidateType: '美妆穿搭词',
    reason: '泛美妆标签。'
  })), 'flexible');
  assert.equal(getDailyExpressionForm(makeQualityCandidate('ときめく')), 'short_expression');
  assert.equal(getDailyExpressionForm(makeQualityCandidate('コスパがいい')), 'full_phrase');
  assert.equal(getDailyExpressionForm(makeQualityCandidate('一石二鳥', { reason: '固定惯用语，适合解释。' })), 'long_idiom');
});

test('daily quality scoring penalizes recent semantic cluster repeats', () => {
  const workflow = {
    historySnapshots: {
      '2026-06-20': { dateKey: '2026-06-20', words: ['気が合う'] },
      '2026-05-01': { dateKey: '2026-05-01', words: ['気が置けない'] }
    }
  };
  const entry = makeQualityCandidate('気が楽', { reason: '情绪状态和気が表达。' });
  const repeatedContext = buildDailyQualityContext(workflow, { today: '2026-06-29' });
  const emptyContext = buildDailyQualityContext({}, { today: '2026-06-29' });
  assert.ok(getDailyQualityScoreDelta(entry, repeatedContext) < getDailyQualityScoreDelta(entry, emptyContext));
});

test('getAccountLearningSummary 提供账号学习规则入口', () => {
  const summary = getAccountLearningSummary();
  assert.ok(summary.preferredDirections.includes('情绪状态'));
  assert.ok(summary.avoidDirections.includes('太教材'));
  assert.ok(summary.titlePatterns.length >= 3);
  assert.ok(summary.coverPatterns.includes('不要像教材课件'));
});

test('cleanStoredWorkflow 补齐缺失字段', () => {
  const cleaned = cleanStoredWorkflow({});
  assert.deepEqual(cleaned.words, []);
  assert.deepEqual(cleaned.statuses, {});
  assert.deepEqual(cleaned.feedback, {});
  assert.deepEqual(cleaned.publishedRecords, []);
  assert.deepEqual(cleaned.candidatePool, {});
  assert.deepEqual(cleaned.aiBatches, []);
  assert.deepEqual(cleaned.todaySnapshot.words, []);
  assert.equal(cleaned.schemaVersion, 3);
  assert.equal(cleaned.revision, 0);
  assert.deepEqual(cleaned.auditLog, []);
});

test('cleanStoredWorkflow 不删除 candidatePool.aiCard', () => {
  const cleaned = cleanStoredWorkflow({
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        meaning: '自然熟练的高级感',
        aiCard: readyCard
      }
    }
  });
  assert.equal(cleaned.candidatePool['こなれ'].aiCard.cardStatus, 'ready');
  assert.equal(cleaned.candidatePool['こなれ'].aiCard.summary, readyCard.summary);
});

test('cleanStoredWorkflow 保留内容与封面反馈、版本历史和发布留档', () => {
  const cleaned = cleanStoredWorkflow({
    feedback: {
      'こなれ': {
        reasons: { uninterested: 1, badVisual: 2 },
        lastAppliedDateByReason: { uninterested: '2026-07-22' },
        lastUndoneAtByReason: { tooBasic: '2026-07-22T03:30:00.000Z' }
      }
    },
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        aiCard: { ...readyCard, cardVersion: 3, coverVersion: 2 },
        generationFeedback: {
          card: { reasons: { unnaturalExamples: 1 }, lastReason: 'unnaturalExamples', updatedAt: '2026-07-22T02:00:00.000Z' },
          cover: { reasons: { mobileUnreadable: 1 }, lastReason: 'mobileUnreadable', updatedAt: '2026-07-22T03:00:00.000Z' }
        },
        coverHistory: [{ coverVersion: 1, coverSuggestion: { coverText: '旧封面' }, generatedAt: '2026-07-20T02:00:00.000Z' }],
        publicationSnapshot: { capturedAt: '2026-07-22T04:00:00.000Z', cardVersion: 3, coverVersion: 2, suggestedTitle: '最终标题' }
      }
    }
  });
  assert.equal(cleaned.feedback['こなれ'].lastAppliedDateByReason.uninterested, '2026-07-22');
  assert.equal(cleaned.feedback['こなれ'].lastUndoneAtByReason.tooBasic, '2026-07-22T03:30:00.000Z');
  assert.equal(cleaned.candidatePool['こなれ'].generationFeedback.card.reasons.unnaturalExamples, 1);
  assert.equal(cleaned.candidatePool['こなれ'].generationFeedback.cover.reasons.mobileUnreadable, 1);
  assert.equal(cleaned.candidatePool['こなれ'].coverHistory[0].coverSuggestion.coverText, '旧封面');
  assert.equal(cleaned.candidatePool['こなれ'].publicationSnapshot.suggestedTitle, '最终标题');
});

test('mergeWorkflow 保留较新的负反馈撤销，不被云端旧计数恢复', () => {
  const merged = mergeWorkflow({
    feedback: {
      'こなれ': {
        reasons: {},
        lastReason: '',
        lastAppliedDateByReason: {},
        lastUndoneAtByReason: { uninterested: '2026-07-22T04:05:00.000Z' },
        updatedAt: '2026-07-22T04:05:00.000Z'
      }
    }
  }, {
    feedback: {
      'こなれ': {
        reasons: { uninterested: 1 },
        lastReason: 'uninterested',
        lastAppliedDateByReason: { uninterested: '2026-07-22' },
        updatedAt: '2026-07-22T04:00:00.000Z'
      }
    }
  });
  assert.equal(merged.feedback['こなれ'].reasons.uninterested, undefined);
  assert.equal(merged.feedback['こなれ'].lastAppliedDateByReason.uninterested, undefined);
  assert.equal(merged.feedback['こなれ'].lastReason, '');
  assert.equal(merged.feedback['こなれ'].lastUndoneAtByReason.uninterested, '2026-07-22T04:05:00.000Z');
});

test('cleanStoredWorkflow 不删除手动添加来源元数据和 z世代 标签', () => {
  const cleaned = cleanStoredWorkflow({
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '很有情绪氛围',
        sourceTags: ['手动添加', 'z世代'],
        discoverySource: '小红书',
        discoveryContext: '在穿搭内容里看到，适合做标题。',
        evidenceCheckedAt: '2026-08-12T06:00:00.000Z',
        evidenceSources: [{
          label: '公开趋势榜单',
          url: 'https://example.com/trend',
          publishedAt: '2026-08-10'
        }],
        realUsageExamples: ['この写真、エモい。', '放課後の空気がエモい。'],
        usageScope: '年轻人日常、社交媒体',
        stabilityLevel: 'stable',
        trendPeriod: '2026-08',
        qualityGateStatus: 'ready'
      }
    }
  });
  assert.equal(cleaned.candidatePool['エモい'].discoverySource, '小红书');
  assert.equal(cleaned.candidatePool['エモい'].discoveryContext, '在穿搭内容里看到，适合做标题。');
  assert.ok(cleaned.candidatePool['エモい'].sourceTags.includes('手动添加'));
  assert.ok(cleaned.candidatePool['エモい'].sourceTags.includes('z世代'));
  assert.equal(cleaned.candidatePool['エモい'].evidenceCheckedAt, '2026-08-12T06:00:00.000Z');
  assert.deepEqual(cleaned.candidatePool['エモい'].evidenceSources, [{
    label: '公开趋势榜单',
    url: 'https://example.com/trend',
    publishedAt: '2026-08-10'
  }]);
  assert.deepEqual(cleaned.candidatePool['エモい'].realUsageExamples, ['この写真、エモい。', '放課後の空気がエモい。']);
  assert.equal(cleaned.candidatePool['エモい'].usageScope, '年轻人日常、社交媒体');
  assert.equal(cleaned.candidatePool['エモい'].stabilityLevel, 'stable');
  assert.equal(cleaned.candidatePool['エモい'].trendPeriod, '2026-08');
  assert.equal(cleaned.candidatePool['エモい'].qualityGateStatus, 'ready');
});

test('mergeWorkflowForFullSave 保存手动添加词时同时保留收藏和候选库', () => {
  const saved = mergeWorkflowForFullSave(cleanStoredWorkflow({
    words: ['既存词'],
    candidatePool: {
      '既存词': {
        kanji: '既存词',
        sourceType: 'manual_keep',
        meaning: '已有手动词'
      }
    }
  }), {
    words: ['顔面コンプ', '既存词'],
    candidatePool: {
      '顔面コンプ': {
        kanji: '顔面コンプ',
        sourceType: 'manual_keep',
        meaning: '外貌相关自卑感',
        sourceTags: ['手动添加', '受保护'],
        discoverySource: '手动添加',
        discoveryContext: '从评论区看到，想做成选题。',
        aiCard: { cardStatus: 'none' }
      }
    },
    updated: '2026-06-08T10:00:00.000Z'
  });

  assert.ok(saved.words.includes('顔面コンプ'));
  assert.equal(saved.candidatePool['顔面コンプ'].sourceType, 'manual_keep');
  assert.equal(saved.candidatePool['顔面コンプ'].protected, true);
  assert.equal(saved.candidatePool['顔面コンプ'].discoveryContext, '从评论区看到，想做成选题。');
});

test('cleanStoredWorkflow 不删除 todaySnapshot', () => {
  const cleaned = cleanStoredWorkflow({
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['こなれ'],
      generatedAt: '2026-05-31T00:00:00.000Z',
      source: 'candidatePool',
      batchIds: ['batch-a'],
      version: 2
    }
  });
  assert.equal(cleaned.todaySnapshot.dateKey, '2026-05-31');
  assert.deepEqual(cleaned.todaySnapshot.words, ['こなれ']);
});

test('cleanStoredWorkflow 不删除 aiBatches', () => {
  const cleaned = cleanStoredWorkflow({
    aiBatches: [{
      id: 'batch-a',
      action: 'wild_ideas',
      model: 'deepseek-v4-flash',
      createdAt: '2026-05-31T01:00:00.000Z',
      itemCount: 20,
      rawOutput: '{"items":[]}'
    }]
  });
  assert.equal(cleaned.aiBatches.length, 1);
  assert.equal(cleaned.aiBatches[0].id, 'batch-a');
  assert.equal(cleaned.aiBatches[0].rawOutput, '{"items":[]}');
});

test('cleanStoredWorkflow 不删除团队 AI 预览和团队跳过记录', () => {
  const cleaned = cleanStoredWorkflow({
    aiPreview: {
      items: [{ kanji: '抜け感', romaji: 'nukekan', meaning: '松弛留白感', displayBucket: 'today' }],
      selected: ['抜け感'],
      batchId: 'batch-preview',
      savedAt: '2026-05-31T01:00:00.000Z'
    },
    todayDismissed: {
      dateKey: '2026-05-31',
      words: ['ワロタ'],
      updatedAt: '2026-05-31T01:05:00.000Z'
    }
  });
  assert.equal(cleaned.aiPreview.items[0].kanji, '抜け感');
  assert.deepEqual(cleaned.aiPreview.selected, ['抜け感']);
  assert.deepEqual(cleaned.todayDismissed.words, ['ワロタ']);
});

test('mergeWorkflow 合并 candidatePool 时空字段不覆盖 aiCard/reason/riskWarning', () => {
  const merged = mergeWorkflow({
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        reason: '适合穿搭和审美内容。',
        riskWarning: '不要用于正式商务说明。',
        sourceText: '完整 DeepSeek 生成原文',
        aiCard: readyCard,
        updatedAt: '2026-05-30T01:00:00.000Z'
      }
    }
  }, {
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        reason: '',
        riskWarning: '',
        sourceText: '',
        aiCard: {},
        updatedAt: '2026-05-31T01:00:00.000Z'
      }
    }
  });
  const entry = merged.candidatePool['こなれ'];
  assert.equal(entry.aiCard.cardStatus, 'ready');
  assert.equal(entry.reason, '适合穿搭和审美内容。');
  assert.equal(entry.riskWarning, '不要用于正式商务说明。');
  assert.equal(entry.sourceText, '完整 DeepSeek 生成原文');
});

test('mergeWorkflow 合并 candidatePool 时保留手动添加来源元数据', () => {
  const merged = mergeWorkflow({
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '情绪化、有氛围',
        sourceTags: ['手动添加'],
        discoverySource: 'YouTube',
        discoveryContext: '视频标题里看到。',
        evidenceCheckedAt: '2026-05-30T00:30:00.000Z',
        evidenceSources: ['视频标题和评论区'],
        realUsageExamples: ['この曲、エモい。', '夕焼けがエモすぎる。'],
        usageScope: '社交媒体口语',
        stabilityLevel: 'stable',
        trendPeriod: '长期使用',
        qualityGateStatus: 'ready',
        updatedAt: '2026-05-30T01:00:00.000Z'
      }
    }
  }, {
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '',
        sourceTags: ['受保护'],
        updatedAt: '2026-05-31T01:00:00.000Z'
      }
    }
  });
  const entry = merged.candidatePool['エモい'];
  assert.equal(entry.discoverySource, 'YouTube');
  assert.equal(entry.discoveryContext, '视频标题里看到。');
  assert.ok(entry.sourceTags.includes('手动添加'));
  assert.equal(entry.evidenceCheckedAt, '2026-05-30T00:30:00.000Z');
  assert.deepEqual(entry.evidenceSources, [{ label: '视频标题和评论区', url: '', publishedAt: '' }]);
  assert.deepEqual(entry.realUsageExamples, ['この曲、エモい。', '夕焼けがエモすぎる。']);
  assert.equal(entry.usageScope, '社交媒体口语');
  assert.equal(entry.stabilityLevel, 'stable');
  assert.equal(entry.trendPeriod, '长期使用');
  assert.equal(entry.qualityGateStatus, 'ready');
});

test('mergeWorkflow 合并 publishedRecords 时更新指标但不覆盖已锁定内容', () => {
  const merged = mergeWorkflow({
    publishedRecords: [{
      id: 'record-1',
      word: 'こなれ',
      title: '旧标题',
      description: '首次保存的帖子正文',
      coverUrl: 'https://example.com/first.jpg',
      contentLocked: true,
      contentImportedAt: '2026-05-30T01:00:00.000Z',
      latestMetrics: { likes: 1, favorites: 2, comments: 0, shares: 0, views: 100 },
      lastMetricsImportedAt: '2026-05-30T01:00:00.000Z',
      updatedAt: '2026-05-30T01:00:00.000Z'
    }]
  }, {
    publishedRecords: [{
      id: 'record-1',
      word: 'こなれ',
      description: '后续不应覆盖的正文',
      latestMetrics: { likes: 10, favorites: 5, comments: 1, shares: 0, views: 1000 },
      lastMetricsImportedAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:00:00.000Z'
    }]
  });
  const record = merged.publishedRecords[0];
  assert.equal(record.description, '首次保存的帖子正文');
  assert.equal(record.coverUrl, 'https://example.com/first.jpg');
  assert.equal(record.latestStats.views, 1000);
  assert.equal(record.updatedAt, '2026-05-31T01:00:00.000Z');
});

test('mergeWorkflow 保留已锁定发布内容的非单词分类', () => {
  const merged = mergeWorkflow({
    publishedRecords: [{
      id: 'promo-1',
      title: '书籍宣传',
      contentCategory: 'non_word',
      description: '首次保存的宣传正文',
      contentLocked: true,
      contentImportedAt: '2026-05-30T01:00:00.000Z',
      updatedAt: '2026-05-30T01:00:00.000Z'
    }]
  }, {
    publishedRecords: [{
      id: 'promo-1',
      title: '书籍宣传',
      latestMetrics: { views: 1000 },
      lastMetricsImportedAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:00:00.000Z'
    }]
  });
  assert.equal(merged.publishedRecords[0].contentCategory, 'non_word');
  assert.equal(merged.publishedRecords[0].word, '');
  assert.equal(merged.publishedRecords[0].description, '首次保存的宣传正文');
});

test('mergeWorkflow 合并 todaySnapshot 时同一天 version 高者优先', () => {
  const merged = mergeWorkflow({
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['旧词'],
      generatedAt: '2026-05-31T01:00:00.000Z',
      version: 1
    }
  }, {
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['新词'],
      generatedAt: '2026-05-31T00:00:00.000Z',
      version: 2
    }
  });
  assert.deepEqual(merged.todaySnapshot.words, ['新词']);
  assert.equal(merged.todaySnapshot.version, 2);
});

test('published-refresh 类写回不会导致 aiBatches/todaySnapshot 丢失', () => {
  const current = cleanStoredWorkflow({
    aiBatches: [{ id: 'batch-a', action: 'wild_ideas', createdAt: '2026-05-31T01:00:00.000Z' }],
    todaySnapshot: { dateKey: '2026-05-31', words: ['こなれ'], generatedAt: '2026-05-31T01:00:00.000Z', version: 1 },
    publishedRecords: [{ id: 'record-1', word: 'こなれ', description: '保留正文', contentLocked: true, contentImportedAt: '2026-05-30T01:00:00.000Z', updatedAt: '2026-05-30T01:00:00.000Z' }]
  });
  const saved = mergeWorkflow(current, {
    publishedRecords: [{ id: 'record-1', word: 'こなれ', latestMetrics: { likes: 3 }, lastMetricsImportedAt: '2026-05-31T01:00:00.000Z', updatedAt: '2026-05-31T01:00:00.000Z' }]
  });
  assert.equal(saved.aiBatches[0].id, 'batch-a');
  assert.deepEqual(saved.todaySnapshot.words, ['こなれ']);
  assert.equal(saved.publishedRecords[0].description, '保留正文');
});

test('worker PUT 类保存不会导致 aiBatches/todaySnapshot 丢失', () => {
  const current = cleanStoredWorkflow({
    words: ['こなれ'],
    aiBatches: [{ id: 'batch-a', action: 'wild_ideas', createdAt: '2026-05-31T01:00:00.000Z' }],
    todaySnapshot: { dateKey: '2026-05-31', words: ['こなれ'], generatedAt: '2026-05-31T01:00:00.000Z', version: 1 }
  });
  const saved = mergeWorkflowForFullSave(current, {
    words: ['抜け感'],
    statuses: {},
    updated: '2026-05-31T02:00:00.000Z'
  });
  assert.deepEqual(saved.words, ['抜け感']);
  assert.equal(saved.aiBatches[0].id, 'batch-a');
  assert.deepEqual(saved.todaySnapshot.words, ['こなれ']);
});

test('收藏增量同步不会用客户端空 todaySnapshot 覆盖服务端今日快照', () => {
  const snapshotWords = Array.from({ length: 20 }, (_, index) => `今日词${index + 1}`);
  const current = cleanStoredWorkflow({
    words: ['こなれ'],
    todaySnapshot: {
      dateKey: '2026-06-21',
      words: snapshotWords,
      generatedAt: '2026-06-21T02:57:40.000Z',
      generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
      version: 1
    },
    todayDismissed: {
      dateKey: '2026-06-21',
      words: ['跳过词'],
      updatedAt: '2026-06-21T03:00:00.000Z'
    },
    historySnapshots: {
      '2026-06-20': {
        dateKey: '2026-06-20',
        words: ['历史词'],
        generatedAt: '2026-06-20T02:00:00.000Z',
        version: 1
      }
    },
    todaySnapshotHistory: [{
      dateKey: '2026-06-19',
      words: ['快照历史词'],
      generatedAt: '2026-06-19T02:00:00.000Z',
      version: 1
    }]
  });
  const saved = applyFavoriteAction(current, {
    action: 'add',
    word: '新收藏',
    todaySnapshot: {},
    todayDismissed: {},
    historySnapshots: {},
    todaySnapshotHistory: []
  });

  assert.ok(saved.words.includes('新收藏'));
  assert.equal(saved.todaySnapshot.dateKey, '2026-06-21');
  assert.deepEqual(saved.todaySnapshot.words, snapshotWords);
  assert.deepEqual(saved.todayDismissed.words, ['跳过词']);
  assert.ok(saved.historySnapshots['2026-06-20']);
  assert.ok(saved.todaySnapshotHistory.some(snapshot => snapshot.dateKey === '2026-06-19'));
});

function makeCardWorkflow(overrides = {}) {
  const todayWords = Array.from({ length: 20 }, (_, index) => `今日卡片词${index + 1}`);
  const candidatePool = todayWords.reduce((pool, kanji, index) => {
    pool[kanji] = makeTodayCandidate(kanji, index + 1, {
      aiCard: { cardStatus: 'none' }
    });
    return pool;
  }, {});
  return cleanStoredWorkflow({
    words: ['既有收藏'],
    statuses: { '既有收藏': 'pending' },
    feedback: { 既有收藏: { reasons: { notFresh: 1 }, lastReason: 'notFresh' } },
    publishedRecords: [{ id: 'published-1', word: '既有收藏', title: '已发布记录' }],
    candidatePool,
    todaySnapshot: {
      dateKey: '2026-06-21',
      words: todayWords,
      generatedAt: '2026-06-21T02:57:40.000Z',
      generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
      version: 1
    },
    historySnapshots: {
      '2026-06-20': { dateKey: '2026-06-20', words: ['历史保留词'], generatedAt: '2026-06-20T02:00:00.000Z', version: 1 }
    },
    todaySnapshotHistory: [{ dateKey: '2026-06-19', words: ['历史快照词'], generatedAt: '2026-06-19T02:00:00.000Z', version: 1 }],
    ...overrides
  });
}

test('ai-cards 单词生成只写回 aiCard 且不改变 todaySnapshot', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  const selection = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], maxWords: 5 });
  assert.deepEqual(selection.targets, [target]);
  const result = applyAiCardGenerationResult(workflow, {
    targets: selection.targets,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T03:00:00.000Z' },
    items: [{
      kanji: target,
      aiCard: {
        cardStatus: 'ready',
        summary: '适合做小红书选题的情绪词。',
        explanation: '有明确场景和标题价值。'
      }
    }]
  });

  assert.equal(result.savedCount, 1);
  assert.equal(result.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(result.workflow.candidatePool[target].aiCard.cardModel, 'deepseek-test');
  assert.deepEqual(result.workflow.todaySnapshot.words, workflow.todaySnapshot.words);
  assert.deepEqual(result.workflow.words, workflow.words);
  assert.deepEqual(result.workflow.statuses, workflow.statuses);
  assert.equal(result.workflow.publishedRecords[0].id, 'published-1');
  assert.ok(result.workflow.historySnapshots['2026-06-20']);
});

test('ai-cards 批量选择最多 5 个且跳过非 today 词', () => {
  const workflow = makeCardWorkflow();
  const requested = [...workflow.todaySnapshot.words.slice(0, 7), '不属于今日'];
  const selection = selectTodayAiCardTargets(workflow, { mode: 'today', words: requested, maxWords: 10 });
  assert.equal(selection.targets.length, 5);
  assert.equal(selection.skipped.notToday.includes('不属于今日'), true);
  assert.deepEqual(selection.skipped.limited, workflow.todaySnapshot.words.slice(5, 7));
});

test('ai-cards ready 默认不重复生成，force=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = readyCard;
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target] });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.ready, [target]);
  const forced = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], force: true });
  assert.deepEqual(forced.targets, [target]);

  const applied = applyAiCardGenerationResult(workflow, {
    targets: [target],
    force: true,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T04:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '新版词卡' } }]
  });
  assert.equal(applied.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(applied.workflow.candidatePool[target].aiCardHistory.length, 1);
});

test('ai-cards 内容重生成保留封面，封面重生成保留单词卡内容', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    ...readyCard,
    cardVersion: 2,
    coverVersion: 3,
    coverSuggestion: { coverText: '原封面', mainVisual: '原画面' },
    referenceImage: { status: 'ready', url: '/codex-image?key=old' }
  };
  const cardRegenerated = applyAiCardGenerationResult(workflow, {
    targets: [target],
    force: true,
    regenerationScope: 'card',
    feedbackReason: 'unnaturalExamples',
    usage: { model: 'deepseek-test', createdAt: '2026-07-22T04:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '新版内容', coverSuggestion: { coverText: '不应采用' } } }]
  });
  assert.equal(cardRegenerated.workflow.candidatePool[target].aiCard.summary, '新版内容');
  assert.equal(cardRegenerated.workflow.candidatePool[target].aiCard.coverSuggestion.coverText, '原封面');
  assert.equal(cardRegenerated.workflow.candidatePool[target].aiCard.referenceImage.url, '/codex-image?key=old');
  assert.equal(cardRegenerated.workflow.candidatePool[target].aiCardHistory.length, 1);

  const coverRegenerated = applyAiCardGenerationResult(workflow, {
    targets: [target],
    force: true,
    regenerationScope: 'cover',
    feedbackReason: 'mobileUnreadable',
    usage: { model: 'deepseek-test', createdAt: '2026-07-22T05:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '不应采用', coverSuggestion: { coverText: '新封面', mainVisual: '新画面' } } }]
  });
  assert.equal(coverRegenerated.workflow.candidatePool[target].aiCard.summary, readyCard.summary);
  assert.equal(coverRegenerated.workflow.candidatePool[target].aiCard.coverSuggestion.coverText, '新封面');
  assert.equal(coverRegenerated.workflow.candidatePool[target].aiCard.referenceImage.status, 'missing');
  assert.equal(coverRegenerated.workflow.candidatePool[target].coverHistory.length, 1);
  assert.equal(coverRegenerated.workflow.candidatePool[target].aiCardHistory.length, 0);
});

test('ai-cards failed 默认不重试，retryFailed=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'failed',
    summary: '上次失败',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target] });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.failed, [target]);
  const retry = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], retryFailed: true });
  assert.deepEqual(retry.targets, [target]);
});

test('ai-cards stale pending 默认不重试，retryStalePending=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  workflow.candidatePool[target].updatedAt = '2026-06-21T03:01:00.000Z';
  const nowMs = Date.parse('2026-06-21T03:12:01.000Z');

  assert.equal(isAiCardStalePending(workflow.candidatePool[target], nowMs), true);
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], nowMs });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.pending, [target]);
  assert.deepEqual(skipped.skipped.stalePending, [target]);

  const retry = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(retry.targets, [target]);
});

test('ai-cards fresh pending 即使 retryStalePending=true 也不重试', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:08:00.000Z'
  };
  const nowMs = Date.parse('2026-06-21T03:12:00.000Z');

  assert.equal(isAiCardStalePending(workflow.candidatePool[target], nowMs), false);
  const skipped = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.pending, [target]);
  assert.deepEqual(skipped.skipped.stalePending, []);
});

test('ai-cards stale pending 汇总统计正确', () => {
  const workflow = makeCardWorkflow();
  workflow.candidatePool[workflow.todaySnapshot.words[0]].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  workflow.candidatePool[workflow.todaySnapshot.words[1]].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:11:00.000Z'
  };

  const summary = summarizeTodayAiCards(workflow, { nowMs: Date.parse('2026-06-21T03:12:01.000Z') });
  assert.equal(summary.pendingCount, 2);
  assert.equal(summary.stalePendingCount, 1);
  assert.equal(summary.items[0].stalePending, true);
  assert.equal(summary.items[1].stalePending, false);
});

test('ai-cards stale pending 重试写回不改变 todaySnapshot / favorites', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  const nowMs = Date.parse('2026-06-21T03:12:01.000Z');
  const selection = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(selection.targets, [target]);

  const result = applyAiCardGenerationResult(workflow, {
    targets: selection.targets,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T04:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '重试成功词卡' } }]
  });
  assert.equal(result.savedCount, 1);
  assert.equal(result.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(result.workflow.candidatePool[target].aiCard.summary, '重试成功词卡');
  assert.deepEqual(result.workflow.todaySnapshot.words, workflow.todaySnapshot.words);
  assert.deepEqual(result.workflow.words, workflow.words);
  assert.deepEqual(result.workflow.statuses, workflow.statuses);
  assert.ok(result.workflow.historySnapshots['2026-06-20']);
});

test('ai-cards 状态汇总统计 ready missing failed', () => {
  const workflow = makeCardWorkflow();
  workflow.candidatePool[workflow.todaySnapshot.words[0]].aiCard = readyCard;
  workflow.candidatePool[workflow.todaySnapshot.words[1]].aiCard = { cardStatus: 'failed', summary: '失败' };
  const summary = summarizeTodayAiCards(workflow);
  assert.equal(summary.todaySnapshot.words.length, 20);
  assert.equal(summary.readyCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.missingCount, 18);
});

test('worker PUT 类保存不会导致 aiPreview/todayDismissed 丢失', () => {
  const current = cleanStoredWorkflow({
    aiPreview: {
      items: [{ kanji: '抜け感', meaning: '松弛留白感', displayBucket: 'today' }],
      selected: ['抜け感'],
      savedAt: '2026-05-31T01:00:00.000Z'
    },
    todayDismissed: {
      dateKey: '2026-05-31',
      words: ['ワロタ'],
      updatedAt: '2026-05-31T01:05:00.000Z'
    }
  });
  const saved = mergeWorkflowForFullSave(current, {
    words: ['抜け感'],
    updated: '2026-05-31T02:00:00.000Z'
  });
  assert.equal(saved.aiPreview.items[0].kanji, '抜け感');
  assert.deepEqual(saved.todayDismissed.words, ['ワロタ']);
});

test('cleanStoredWorkflow 不删除 todaySnapshotHistory', () => {
  const cleaned = cleanStoredWorkflow({
    todaySnapshotHistory: [{
      dateKey: '2026-06-07',
      words: ['旧推荐'],
      generatedAt: '2026-06-07T00:00:00.000Z',
      version: 1
    }]
  });
  assert.equal(cleaned.todaySnapshotHistory.length, 1);
  assert.equal(cleaned.todaySnapshotHistory[0].dateKey, '2026-06-07');
  assert.deepEqual(cleaned.todaySnapshotHistory[0].words, ['旧推荐']);
});

test('mergeWorkflow 合并 todaySnapshotHistory 不丢日期', () => {
  const merged = mergeWorkflow({
    todaySnapshotHistory: [{ dateKey: '2026-06-06', words: ['本地词'], generatedAt: '2026-06-06T00:00:00.000Z', version: 1 }]
  }, {
    todaySnapshotHistory: [{ dateKey: '2026-06-07', words: ['云端词'], generatedAt: '2026-06-07T00:00:00.000Z', version: 1 }]
  });
  const dates = merged.todaySnapshotHistory.map(snapshot => snapshot.dateKey);
  assert.ok(dates.includes('2026-06-06'));
  assert.ok(dates.includes('2026-06-07'));
});

function makeTodayCandidate(kanji, index, overrides = {}) {
  return {
    kanji,
    kana: `かな${index}`,
    romaji: `word${index}`,
    meaning: `测试词 ${index}`,
    category: `测试分类${index}`,
    candidateType: '审美氛围词',
    displayBucket: 'today',
    emotionTone: index % 3 === 0 ? 'lifestyle' : 'aesthetic',
    reason: '有情绪共鸣和生活场景，适合做标题封面并被收藏。',
    expressionValueScore: 86,
    sourceType: 'deepseek_generated',
    xhsFitScore: 88,
    riskLevel: 'low',
    confidenceLevel: 'high',
    evidenceType: 'common_usage',
    suggestedAction: '可以收藏观察',
    ...overrides
  };
}

test('getRecentDailyHotBlockedWords 收集最近 30 天历史词', () => {
  const blocked = getRecentDailyHotBlockedWords({
    historySnapshots: {
      '2026-06-01': { dateKey: '2026-06-01', words: ['历史归档词'], generatedAt: '2026-06-01T00:00:00.000Z', version: 1 }
    },
    todaySnapshotHistory: [{ dateKey: '2026-05-20', words: ['快照历史词'], generatedAt: '2026-05-20T00:00:00.000Z', version: 1 }]
  }, TODAY_HISTORY_DEDUP_DAYS, { today: '2026-06-08' });
  assert.ok(blocked.has('历史归档词'));
  assert.ok(blocked.has('快照历史词'));
});

test('buildDeepSeekExclusionContext 构建 DeepSeek 避重清单并保留原因', () => {
  const exclusion = buildDeepSeekExclusionContext({
    recentHistoryWords: ['モヤる', '抜け感', '清潔感'],
    favoriteWords: ['しんどい'],
    pendingWords: ['気を遣う'],
    publishedWords: ['距離感'],
    selectedTodayWords: ['空気読む'],
    currentBatchWords: ['だるい', '気まずい'],
    protectedWords: ['刺さる'],
    existingRecentCandidateWords: ['透け感']
  }, { limit: 20 });
  ['モヤる', '抜け感', '清潔感', 'しんどい', '気を遣う', '距離感', '空気読む', 'だるい', '気まずい', '刺さる', '透け感'].forEach(word => {
    assert.ok(exclusion.excludedWords.includes(word), `${word} 应进入 DeepSeek 禁止列表`);
  });
  assert.deepEqual(exclusion.excludedReasons.current_batch_duplicate, ['だるい', '気まずい']);
  assert.deepEqual(exclusion.excludedReasons.favorite_or_pending, ['しんどい', '気を遣う']);
  assert.deepEqual(exclusion.excludedReasons.published, ['距離感']);
  assert.deepEqual(exclusion.excludedReasons.selected_today, ['空気読む']);
});

test('generateTodaySnapshot 硬排除最近 30 天历史词', () => {
  const candidatePool = {};
  ['回流词A', '回流词B', '回流词C'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1);
  });
  Array.from({ length: 20 }, (_, index) => `新候选${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 10);
  });
  const { result } = generateTodaySnapshot({
    candidatePool,
    historySnapshots: {
      '2026-06-03': { dateKey: '2026-06-03', words: ['回流词A', '回流词B', '回流词C'], generatedAt: '2026-06-03T00:00:00.000Z', version: 1 }
    }
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(result.dedupDaysUsed, 30);
  assert.equal(result.relaxedDedup, false);
  assert.equal(result.todaySnapshot.generatorVersion, TODAY_SNAPSHOT_GENERATOR_VERSION);
  assert.equal(isCurrentGeneratorSnapshot(result.todaySnapshot, new Date('2026-06-08T01:00:00.000Z')), true);
  assert.equal(words.length, DAILY_WORD_COUNT);
  assert.equal(words.some(word => word.startsWith('回流词')), false);
});

test('generateTodaySnapshot 硬排除中文直读低价值首页词', () => {
  const candidatePool = {};
  ['副業', '資格勉強', '自己投資', '転職', '在宅勤務', '寿司', '部屋', 'ガチ恋'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, {
      meaning: '偏泛的职场主题词',
      category: '职场',
      candidateType: '生活方式词',
      xhsFitScore: 95
    });
  });
  Array.from({ length: 24 }, (_, index) => `補充かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 10);
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(words.length, DAILY_WORD_COUNT);
  assert.equal(words.includes('副業'), false);
  assert.equal(words.includes('資格勉強'), false);
  assert.equal(words.includes('自己投資'), false);
  assert.equal(words.includes('転職'), false);
  assert.equal(words.includes('在宅勤務'), false);
  assert.equal(words.includes('寿司'), false);
  assert.equal(words.includes('部屋'), false);
  assert.equal(words.includes('ガチ恋'), false);
});

test('generateTodaySnapshot 降级泛话题词并优先表达价值高的词', () => {
  const candidatePool = {};
  const strongWords = ['清潔感', '木漏れ日', '大正解', '布教', '小確幸', '自己肯定感', '推し変'];
  strongWords.forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, {
      meaning: '中文不好直译但有共鸣的日语表达',
      category: index >= 3 ? '追星兴趣' : '情绪语感',
      candidateType: index >= 3 ? '追星兴趣词' : '稳定候选',
      displayBucket: index >= 5 ? 'meme_fast' : 'today',
      emotionTone: index >= 3 ? 'fandom' : 'positive',
      xhsFitScore: 94,
      expressionValueScore: 92,
      reason: '有情绪共鸣、人际语感和明确小红书标题封面角度，适合收藏。'
    });
  });
  ['ネイル', 'ベースメイク', 'オーバサイズ', 'メンズメイク', '資格勉強', '自己投資', 'おじさん構文', '紅葉', 'お弁当', '地雷系', '祭り', '副業', '転職'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 20, {
      meaning: '偏泛话题分类词',
      category: '话题分类',
      candidateType: '生活方式词',
      xhsFitScore: 96,
      reason: '更像搜索标签或话题分类，单独做标题和配图价值弱。'
    });
  });
  Array.from({ length: 24 }, (_, index) => `表現かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 40, {
      meaning: '有场景的日语表达',
      category: index % 2 ? '生活场景' : '人际语感',
      candidateType: index % 2 ? '生活方式词' : '网络口语词',
      displayBucket: index % 2 ? 'today' : 'meme_fast',
      emotionTone: index % 2 ? 'lifestyle' : 'positive',
      xhsFitScore: 86,
      expressionValueScore: 84,
      reason: '有生活场景和情绪共鸣，能做收藏型小红书标题。'
    });
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(words.length, DAILY_WORD_COUNT);
  assert.ok(strongWords.filter(word => words.includes(word)).length >= 4, '高表达价值词应占据明显的优先位置');
  ['ネイル', 'ベースメイク', 'オーバサイズ', 'オーバーサイズ', 'メンズメイク', '資格勉強', '自己投資', 'おじさん構文', '紅葉', 'お弁当', '地雷系', '祭り', '副業', '転職'].forEach(word => {
    assert.equal(words.includes(word), false, `${word} 不应默认进入每日热门`);
  });
});

test('generateTodaySnapshot 候选不足时不再回流 30 天内历史词', () => {
  const candidatePool = {};
  Array.from({ length: 20 }, (_, index) => `历史高分${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, { xhsFitScore: 92 });
  });
  const { result } = generateTodaySnapshot({
    candidatePool,
    historySnapshots: {
      '2026-06-03': { dateKey: '2026-06-03', words: Object.keys(candidatePool), generatedAt: '2026-06-03T00:00:00.000Z', version: 1 }
    }
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  assert.equal(result.dedupDaysUsed, 30);
  assert.equal(result.relaxedDedup, false);
  assert.equal(result.shortage, true);
  assert.equal(result.todaySnapshot.words.length, 0);
  assert.equal(result.words.some(word => word.historicalBackfill), false);
});

test('generateTodaySnapshot 保留 DeepSeek 新鲜度审计统计', () => {
  const candidatePool = {};
  Array.from({ length: 20 }, (_, index) => `新鮮かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1);
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, {
    mode: 'create',
    now: new Date('2026-06-08T01:00:00.000Z'),
    noveltySummary: {
      generatedUniqueCount: 37,
      importedUniqueCount: 31,
      recentHistoryRejectedCount: 19,
      favoriteProtectedRejectedCount: 6,
      currentBatchDuplicateRejectedCount: 8,
      reviewRejectedCount: 6,
      duplicateRate: 35,
      historyCollisionRate: 51
    }
  });
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.generatedUniqueCount, 37);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.importedUniqueCount, 31);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.recentHistoryRejectedCount, 19);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.duplicateRate, 35);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.historyCollisionRate, 51);
});

test('isCurrentGeneratorSnapshot 拒绝旧逻辑快照', () => {
  const legacySnapshot = {
    dateKey: '2026-06-08',
    words: ['旧词'],
    generatedAt: '2026-06-08T00:00:00.000Z',
    source: 'candidatePool',
    version: 1
  };
  assert.equal(isCurrentGeneratorSnapshot(legacySnapshot, new Date('2026-06-08T01:00:00.000Z')), false);
});

test('stripInvalidCurrentTodaySnapshot 清除当天旧逻辑快照但保留归档', () => {
  const cleaned = stripInvalidCurrentTodaySnapshot({
    todaySnapshot: {
      dateKey: '2026-06-08',
      words: ['旧逻辑词'],
      generatedAt: '2026-06-08T00:00:00.000Z',
      source: 'candidatePool',
      version: 1
    }
  }, new Date('2026-06-08T01:00:00.000Z'));
  assert.equal(cleaned.todaySnapshot.words.length, 0);
  assert.deepEqual(cleaned.historySnapshots['2026-06-08'].words, ['旧逻辑词']);
});

console.log('workflow schema smoke tests passed');

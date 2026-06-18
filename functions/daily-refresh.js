import { addDays, buildRankingForDate, cleanDateKey, cleanStoredRanking, dateKey } from '../shared/rankings.mjs';
import { cleanStoredWorkflow, generateTodaySnapshot, isCurrentGeneratorSnapshot } from '../shared/today-snapshot.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};
const PROMPT_VERSION_BY_ACTION = {
  stable_today: 'candidate-v3',
  wild_ideas: 'candidate-v3',
  generate_candidates: 'candidate-v3',
  extract_from_materials: 'candidate-v3',
  enrich_words: 'card-v2',
  generate_word_card: 'card-v2',
  rerank_candidates: 'rerank-v1',
  audit_library_for_delete: 'library-audit-v2',
  audit_missing_library_words: 'library-audit-v2'
};
const DEFAULT_CANDIDATE_COUNT = 50;
const PREVIEW_TEST_CANDIDATE_COUNT = 10;
const DEFAULT_MAX_TOP_UP_ROUNDS = 2;
const PREVIEW_TEST_MAX_TOP_UP_ROUNDS = 1;
const STALE_RUNNING_MS = 15 * 60 * 1000;
const AI_ENDPOINT_TIMEOUT_MS = 90 * 1000;
const RUN_STATE_TTL_SECONDS = 3 * 24 * 60 * 60;
const REFRESH_STEPS = [
  'started',
  'load_workflow',
  'generate_candidates_start',
  'generate_candidates_done',
  'import_candidates_start',
  'import_candidates_done',
  'select_today_start',
  'select_today_done',
  'top_up_generate_start',
  'top_up_generate_done',
  'top_up_import_start',
  'top_up_import_done',
  'top_up_select_done',
  'save_workflow_start',
  'save_workflow_done',
  'completed',
  'generate_cards_start',
  'generate_cards_done',
  'generate_cards_failed',
  'failed'
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) return {};
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function getRequestOption(url, body, name) {
  if (body && Object.prototype.hasOwnProperty.call(body, name)) return body[name];
  return url.searchParams.get(name);
}

function getRefreshOptions(url, body = {}) {
  const mode = cleanText(getRequestOption(url, body, 'mode'), 40);
  const isPreviewTest = ['preview-test', 'test'].includes(mode);
  const defaultCount = isPreviewTest ? PREVIEW_TEST_CANDIDATE_COUNT : DEFAULT_CANDIDATE_COUNT;
  const defaultTopUpRounds = isPreviewTest ? PREVIEW_TEST_MAX_TOP_UP_ROUNDS : DEFAULT_MAX_TOP_UP_ROUNDS;
  const countMax = isPreviewTest ? 20 : 100;
  const topUpMax = isPreviewTest ? PREVIEW_TEST_MAX_TOP_UP_ROUNDS : DEFAULT_MAX_TOP_UP_ROUNDS;
  return {
    mode: isPreviewTest ? 'preview-test' : 'default',
    isPreviewTest,
    count: cleanInteger(getRequestOption(url, body, 'count'), defaultCount, 1, countMax),
    skipCards: cleanBoolean(getRequestOption(url, body, 'skipCards'), isPreviewTest),
    maxTopUpRounds: cleanInteger(getRequestOption(url, body, 'maxTopUpRounds'), defaultTopUpRounds, 0, topUpMax)
  };
}

function getStepIndex(step) {
  const index = REFRESH_STEPS.indexOf(step);
  return index >= 0 ? index + 1 : 0;
}

function createRequestId() {
  return `daily_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v3';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function getAiInputHash(payload = {}) {
  return hashText(stableStringify({
    action: payload.action,
    input: payload.input,
    items: payload.items,
    rules: payload.rules,
    preferences: payload.preferences,
    context: payload.context,
    count: payload.count
  }));
}

function cleanTraceText(value, maxLength = 8000) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value, maxLength);
  try {
    return cleanText(JSON.stringify(value), maxLength);
  } catch (error) {
    return '';
  }
}

function getAiTraceFromUsage(usage = {}, payload = {}) {
  return {
    promptVersion: cleanText(usage.promptVersion || getPromptVersion(payload.action), 80),
    inputHash: cleanText(usage.inputHash || getAiInputHash(payload), 120),
    rawOutput: cleanTraceText(usage.rawOutput, 8000),
    normalizedOutput: cleanTraceText(usage.normalizedOutput, 8000),
    reviewResult: ['accepted', 'rejected', 'edited'].includes(usage.reviewResult) ? usage.reviewResult : 'accepted'
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueWords(words) {
  return [...new Set(safeArray(words).map(item => cleanText(item, 80)).filter(Boolean))];
}

function getStorageKey(url) {
  const code = String(url.searchParams.get('code') || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return code.length >= 8 ? `favorites:${code}` : 'favorites:global';
}

function getRankingStorageKey(dateKeyValue) {
  return `rankings:${dateKeyValue}`;
}

function getDateRange(startDateKey, endDateKey) {
  const dates = [];
  let cursor = startDateKey;
  while (cursor) {
    dates.push(cursor);
    if (cursor === endDateKey) break;
    cursor = addDays(cursor, 1);
  }
  return dates;
}

async function readRankingHistoryWords(env, todayDateKey, days = 30) {
  const earliestDateKey = addDays(todayDateKey, -days);
  const generationStartDateKey = addDays(earliestDateKey, -15);
  const cachedSelections = new Map();
  const historyDateKeys = getDateRange(generationStartDateKey, todayDateKey);
  const storedRankings = await Promise.all(historyDateKeys.map(async currentDateKey => {
    const stored = await env.FAVORITES.get(getRankingStorageKey(currentDateKey), 'json');
    return {
      dateKey: currentDateKey,
      ranking: cleanStoredRanking(stored, currentDateKey)
    };
  }));

  storedRankings.forEach(({ dateKey: currentDateKey, ranking }) => {
    if (ranking.words.length === 20) cachedSelections.set(currentDateKey, ranking.words);
  });

  const rankingHistoryWords = {};
  historyDateKeys.forEach(cursor => {
    let words = cachedSelections.get(cursor);
    if (!words || words.length !== 20) {
      words = buildRankingForDate(cursor, cachedSelections);
      cachedSelections.set(cursor, words);
    }
    if (cursor >= earliestDateKey && cursor < todayDateKey) {
      rankingHistoryWords[cursor] = words;
    }
  });

  return rankingHistoryWords;
}

function getPublishedWords(workflow) {
  return new Set(safeArray(workflow.publishedRecords).map(record => cleanText(record.word, 80)).filter(Boolean));
}

function isFavoriteOrPublished(kanji, workflow) {
  if (safeArray(workflow.words).includes(kanji)) return true;
  if (['pending', 'published'].includes(workflow.statuses?.[kanji])) return true;
  return getPublishedWords(workflow).has(kanji);
}

function cleanAiCard(card = {}) {
  return {
    ...card,
    cardStatus: ['none', 'pending', 'ready', 'failed', 'stale'].includes(card.cardStatus) ? card.cardStatus : 'none',
    cardSource: cleanText(card.cardSource, 80),
    cardModel: cleanText(card.cardModel, 120),
    generatedAt: typeof card.generatedAt === 'string' ? card.generatedAt : ''
  };
}

function isBlockedCandidate(item = {}) {
  return Boolean(item.blocked || item.displayBucket === 'blocked');
}

function importAiCandidates(workflow, items = [], batch = {}) {
  const nextWorkflow = cleanStoredWorkflow(workflow);
  const stats = {
    generated: safeArray(items).length,
    imported: 0,
    skipped: 0,
    review: 0,
    blocked: 0
  };
  const pool = { ...(nextWorkflow.candidatePool || {}) };
  safeArray(items).forEach(item => {
    const kanji = cleanText(item.kanji, 80);
    if (!kanji || isBlockedCandidate(item)) {
      stats.blocked += 1;
      stats.skipped += 1;
      return;
    }
    if (isFavoriteOrPublished(kanji, nextWorkflow)) {
      stats.skipped += 1;
      return;
    }
    const existing = pool[kanji] || {};
    const isReview = item.displayBucket === 'review'
      || item.riskLevel === 'high'
      || item.confidenceLevel === 'review'
      || item.evidenceType === 'unknown';
    pool[kanji] = {
      ...existing,
      ...item,
      kanji,
      sourceType: item.sourceType === 'deepseek_api' ? 'deepseek_generated' : (item.sourceType || 'deepseek_generated'),
      sourcePromptType: item.sourcePromptType || batch.action || 'stable_today',
      sourcePromptVersion: item.sourcePromptVersion || batch.promptVersion || getPromptVersion(item.sourcePromptType || batch.action || 'stable_today'),
      sourceTags: uniqueWords([...(existing.sourceTags || []), ...(item.sourceTags || []), 'DeepSeek', 'AI候选', '自动日更']).slice(0, 12),
      aiBatchId: item.aiBatchId || batch.id || '',
      importedAt: existing.importedAt || nowIso(),
      updatedAt: nowIso(),
      aiCard: existing.aiCard || item.aiCard,
      aiCardHistory: existing.aiCardHistory || item.aiCardHistory,
      manualReviewState: existing.manualReviewState || item.manualReviewState || '',
      manualReviewNote: existing.manualReviewNote || item.manualReviewNote || '',
      lastReviewState: isReview ? 'review' : (item.lastReviewState || existing.lastReviewState || 'watch')
    };
    stats.imported += 1;
    if (isReview) stats.review += 1;
  });
  const nextBatches = safeArray(nextWorkflow.aiBatches).map(item => item.id === batch.id
    ? { ...item, importedCount: stats.imported, skippedCount: stats.skipped }
    : item);
  return {
    workflow: cleanStoredWorkflow({
      ...nextWorkflow,
      candidatePool: pool,
      aiBatches: nextBatches,
      updated: nowIso()
    }),
    stats
  };
}

function buildCandidatePayload(workflow, options = {}) {
  return {
    action: 'stable_today',
    input: '',
    count: cleanInteger(options.count, DEFAULT_CANDIDATE_COUNT, 1, 100),
    preferences: {
      includeMemes: true,
      includeHighRisk: 'review_only',
      readingFormat: 'romaji_kana'
    },
    context: {
      favorites: workflow.words,
      negativeFeedback: workflow.feedback,
      publishedWords: safeArray(workflow.publishedRecords).map(record => record.word).filter(Boolean),
      existingCandidates: Object.values(workflow.candidatePool || {}).map(entry => ({
        kanji: entry.kanji,
        candidateType: entry.candidateType,
        freshness: entry.freshness,
        riskLevel: entry.riskLevel,
        emotionTone: entry.emotionTone,
        confidenceLevel: entry.confidenceLevel,
        evidenceType: entry.evidenceType,
        displayBucket: entry.displayBucket,
        reviewReason: entry.reviewReason,
        reviewReasonType: entry.reviewReasonType,
        lastScore: entry.lastScore
      }))
    }
  };
}

function buildWordCardPayloadItems(workflow, kanjis) {
  return uniqueWords(kanjis).map(kanji => {
    const entry = workflow.candidatePool?.[kanji];
    if (!entry) return null;
    return {
      kanji: entry.kanji,
      romaji: entry.romaji || '',
      kana: entry.kana || '',
      meaning: entry.meaning || '',
      category: entry.category || '',
      candidateType: entry.candidateType || '',
      freshness: entry.freshness || '',
      xhsFitScore: entry.xhsFitScore || 0,
      riskLevel: entry.riskLevel || 'low',
      confidenceLevel: entry.confidenceLevel || 'medium',
      evidenceType: entry.evidenceType || 'common_usage',
      displayBucket: entry.displayBucket || 'long_term',
      emotionTone: entry.emotionTone || 'neutral',
      reason: entry.reason || '',
      reviewReason: entry.reviewReason || '',
      sourceType: entry.sourceType || '',
      sourceTags: safeArray(entry.sourceTags).slice(0, 12),
      discoverySource: entry.discoverySource || '',
      discoveryContext: entry.discoveryContext || '',
      isManualAdded: entry.sourceType === 'manual' || safeArray(entry.sourceTags).includes('手动添加'),
      examples: safeArray(entry.examples).slice(0, 2),
      suggestedTitles: safeArray(entry.suggestedTitles).slice(0, 3),
      coverSuggestion: entry.coverSuggestion || {}
    };
  }).filter(Boolean);
}

async function callJsonEndpoint(origin, path, payload, options = {}) {
  const timeoutMs = cleanInteger(options.timeoutMs, AI_ENDPOINT_TIMEOUT_MS, 1000, AI_ENDPOINT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateCandidates(origin, workflow, options = {}) {
  const payload = buildCandidatePayload(workflow, options);
  const data = await callJsonEndpoint(origin, '/ai-candidates', payload);
  const batchId = `daily_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = getAiTraceFromUsage(data.usage || {}, payload);
  const rawItems = safeArray(data.items);
  const items = rawItems.map(item => ({
    ...item,
    sourceType: 'deepseek_generated',
    sourcePromptType: 'stable_today',
    sourcePromptVersion: trace.promptVersion,
    sourceText: '',
    sourceTags: uniqueWords([...(item.sourceTags || []), 'DeepSeek', 'AI候选', '自动日更']),
    aiBatchId: batchId,
    updatedAt: nowIso()
  }));
  const normalizedByKanji = new Map(items.map(item => [cleanText(item.kanji, 80), item]));
  const batchItems = rawItems.map((item, index) => {
    const kanji = cleanText(item.kanji || item.word, 80);
    const normalized = normalizedByKanji.get(kanji) || {};
    return {
      kanji,
      kana: cleanText(normalized.kana || item.kana, 80),
      romaji: cleanText(normalized.romaji || item.romaji, 120),
      meaning: cleanText(normalized.meaning || item.meaning, 240),
      candidateType: cleanText(normalized.candidateType || item.candidateType, 80),
      displayBucket: cleanText(normalized.displayBucket || item.displayBucket, 40),
      riskLevel: cleanText(normalized.riskLevel || item.riskLevel, 20),
      confidenceLevel: cleanText(normalized.confidenceLevel || item.confidenceLevel, 20),
      sourceAction: 'stable_today',
      sourceBatchId: batchId,
      rawRank: index + 1,
      rejectedReason: normalized.blocked ? 'blocked' : (!kanji ? 'missing_kanji' : ''),
      selectedForToday: false
    };
  }).filter(item => item.kanji).slice(0, 200);
  const batch = {
    id: batchId,
    action: 'stable_today',
    model: data.usage?.model || 'deepseek-v4-flash',
    createdAt: data.usage?.createdAt || nowIso(),
    itemCount: items.length,
    promptType: 'stable_today',
    rawCount: rawItems.length,
    normalizedCount: items.length,
    acceptedCount: 0,
    rejectedCount: Math.max(0, rawItems.length - items.length),
    importedCount: 0,
    skippedCount: 0,
    items: batchItems,
    ...trace,
    promptSummary: '后台自动日更',
    trendNotes: data.summary?.trendNotes || ''
  };
  return { items, batch };
}

async function generateCards(origin, workflow) {
  const snapshotWords = safeArray(workflow.todaySnapshot?.words);
  const targets = snapshotWords.filter(kanji => cleanAiCard(workflow.candidatePool?.[kanji]?.aiCard || {}).cardStatus !== 'ready');
  let generatedCards = 0;
  const pool = { ...(workflow.candidatePool || {}) };
  const cardBatches = [];
  for (let index = 0; index < targets.length; index += 5) {
    const batchWords = targets.slice(index, index + 5);
    const words = buildWordCardPayloadItems({ ...workflow, candidatePool: pool }, batchWords);
    if (!words.length) continue;
    try {
      const payload = {
        action: 'generate_word_card',
        input: JSON.stringify(words).slice(0, 12000),
        count: words.length,
        preferences: {
          includeMemes: true,
          includeHighRisk: 'review_only',
          readingFormat: 'romaji_kana'
        },
        context: {
          words,
          accountLearningSummary: getAccountLearningSummary()
        }
      };
      const data = await callJsonEndpoint(origin, '/ai-candidates', payload);
      let savedInBatch = 0;
      safeArray(data.items).forEach((item, itemIndex) => {
        const kanji = cleanText(item.kanji || words[itemIndex]?.kanji, 80);
        if (!kanji || !pool[kanji]) return;
        pool[kanji] = {
          ...pool[kanji],
          aiCard: {
            ...(item.aiCard || item.card || item),
            cardStatus: 'ready',
            cardSource: 'deepseek_api',
            cardModel: item.aiCard?.cardModel || data.usage?.model || 'deepseek-v4-flash',
            generatedAt: item.aiCard?.generatedAt || data.usage?.createdAt || nowIso()
          },
          updatedAt: nowIso()
        };
        generatedCards += 1;
        savedInBatch += 1;
      });
      const trace = getAiTraceFromUsage(data.usage || {}, payload);
      cardBatches.push({
        id: `daily_card_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        action: 'generate_word_card',
        model: data.usage?.model || 'deepseek-v4-flash',
        createdAt: data.usage?.createdAt || nowIso(),
        itemCount: words.length,
        importedCount: savedInBatch,
        skippedCount: Math.max(0, words.length - savedInBatch),
        ...trace,
        promptSummary: batchWords.join('、'),
        trendNotes: data.summary?.trendNotes || ''
      });
    } catch (error) {
      batchWords.forEach(kanji => {
        if (!pool[kanji]) return;
        pool[kanji] = {
          ...pool[kanji],
          aiCard: {
            cardStatus: 'failed',
            cardSource: 'deepseek_api',
            cardModel: '',
            generatedAt: nowIso(),
            summary: cleanText(error.message || '生成失败', 300)
          },
          updatedAt: nowIso()
        };
      });
    }
  }
  return {
    workflow: cleanStoredWorkflow({
      ...workflow,
      candidatePool: pool,
      aiBatches: [...cardBatches, ...safeArray(workflow.aiBatches)].slice(0, 100),
      updated: nowIso()
    }),
    generatedCards
  };
}

function isAuthorized(request, env) {
  const secret = cleanText(env.AUTO_REFRESH_SECRET, 500);
  if (!secret) return false;
  return (request.headers.get('Authorization') || '') === `Bearer ${secret}`;
}

function getRefreshStateKey(today) {
  return `daily-refresh:${today}`;
}

function cleanRefreshRunState(state = {}) {
  const record = state || {};
  const rawStatus = cleanText(record.status, 40);
  const status = rawStatus === 'success' ? 'completed' : rawStatus;
  return {
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(String(record.dateKey || '')) ? String(record.dateKey) : '',
    status: ['running', 'completed', 'failed'].includes(status) ? status : '',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : '',
    lastStep: cleanText(record.lastStep, 80),
    stepIndex: cleanInteger(record.stepIndex, 0, 0, REFRESH_STEPS.length),
    totalSteps: cleanInteger(record.totalSteps, REFRESH_STEPS.length, 0, REFRESH_STEPS.length),
    error: cleanText(record.error, 500),
    errorStack: cleanText(record.errorStack, 3000),
    generatedCandidates: cleanInteger(record.generatedCandidates, 0, 0, 10000),
    importedCandidates: cleanInteger(record.importedCandidates, 0, 0, 10000),
    todayCount: cleanInteger(record.todayCount, 0, 0, 1000),
    generatedCards: cleanInteger(record.generatedCards, 0, 0, 1000),
    queuedCards: cleanInteger(record.queuedCards, 0, 0, 1000),
    topUpTriggered: Boolean(record.topUpTriggered),
    topUpRoundsUsed: cleanInteger(record.topUpRoundsUsed, 0, 0, 20),
    requestId: cleanText(record.requestId, 120),
    mode: cleanText(record.mode, 40),
    count: cleanInteger(record.count, 0, 0, 100),
    skipCards: Boolean(record.skipCards),
    maxTopUpRounds: cleanInteger(record.maxTopUpRounds, 0, 0, 20),
    previousRunStale: Boolean(record.previousRunStale),
    previousRunStartedAt: typeof record.previousRunStartedAt === 'string' ? record.previousRunStartedAt : '',
    previousRunUpdatedAt: typeof record.previousRunUpdatedAt === 'string' ? record.previousRunUpdatedAt : '',
    cardGenerationSkipped: Boolean(record.cardGenerationSkipped),
    cardError: cleanText(record.cardError, 500)
  };
}

async function readRefreshRunState(env, today) {
  return cleanRefreshRunState(await env.FAVORITES.get(getRefreshStateKey(today), 'json'));
}

async function writeRefreshRunState(env, today, state) {
  const existing = cleanRefreshRunState(await env.FAVORITES.get(getRefreshStateKey(today), 'json'));
  const cleanState = cleanRefreshRunState({
    ...existing,
    ...state,
    dateKey: today,
    updatedAt: state.updatedAt || nowIso()
  });
  await env.FAVORITES.put(getRefreshStateKey(today), JSON.stringify(cleanState), { expirationTtl: RUN_STATE_TTL_SECONDS });
  return cleanState;
}

function getRunningStaleInfo(state) {
  if (state.status !== 'running') {
    return { isRunning: false, isStale: false, ageMs: 0 };
  }
  const referenceTime = Date.parse(state.updatedAt || state.startedAt || '');
  if (!Number.isFinite(referenceTime)) {
    return { isRunning: true, isStale: true, ageMs: Number.POSITIVE_INFINITY };
  }
  const ageMs = Date.now() - referenceTime;
  return {
    isRunning: true,
    isStale: ageMs > STALE_RUNNING_MS,
    ageMs
  };
}

function isFreshRunningState(state) {
  const staleInfo = getRunningStaleInfo(state);
  return staleInfo.isRunning && !staleInfo.isStale;
}

async function generateCardsAndSave(origin, workflow, env, key) {
  const cardResult = await generateCards(origin, workflow);
  const storedAfterCards = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
  const mergedPool = {
    ...(storedAfterCards.candidatePool || {}),
    ...(cardResult.workflow.candidatePool || {})
  };
  const mergedBatches = [];
  const seenBatchIds = new Set();
  [...safeArray(cardResult.workflow.aiBatches), ...safeArray(storedAfterCards.aiBatches)].forEach(batch => {
    if (!batch?.id || seenBatchIds.has(batch.id)) return;
    seenBatchIds.add(batch.id);
    mergedBatches.push(batch);
  });
  await env.FAVORITES.put(key, JSON.stringify(cleanStoredWorkflow({
    ...storedAfterCards,
    candidatePool: mergedPool,
    todaySnapshot: storedAfterCards.todaySnapshot?.words?.length ? storedAfterCards.todaySnapshot : cardResult.workflow.todaySnapshot,
    aiBatches: mergedBatches.slice(0, 100),
    updated: nowIso()
  })));
  return cardResult.generatedCards;
}

async function runDailyRefreshJob({ origin, env, key, today, options = {}, requestId = '', startedAt = '', previousRun = {} }) {
  const runState = {
    status: 'running',
    dateKey: today,
    startedAt: startedAt || nowIso(),
    finishedAt: '',
    lastStep: 'started',
    stepIndex: getStepIndex('started'),
    totalSteps: REFRESH_STEPS.length,
    generatedCandidates: 0,
    importedCandidates: 0,
    todayCount: 0,
    generatedCards: 0,
    queuedCards: 0,
    topUpTriggered: false,
    topUpRoundsUsed: 0,
    error: '',
    errorStack: '',
    requestId,
    mode: options.mode || 'default',
    count: cleanInteger(options.count, DEFAULT_CANDIDATE_COUNT, 1, 100),
    skipCards: Boolean(options.skipCards),
    maxTopUpRounds: cleanInteger(options.maxTopUpRounds, DEFAULT_MAX_TOP_UP_ROUNDS, 0, DEFAULT_MAX_TOP_UP_ROUNDS),
    previousRunStale: Boolean(previousRun.stale),
    previousRunStartedAt: cleanText(previousRun.startedAt, 80),
    previousRunUpdatedAt: cleanText(previousRun.updatedAt, 80),
    cardGenerationSkipped: false,
    cardError: ''
  };
  let lastStep = 'started';
  const writeStep = async (step, patch = {}) => {
    lastStep = step;
    Object.assign(runState, patch, {
      lastStep: step,
      stepIndex: getStepIndex(step)
    });
    return writeRefreshRunState(env, today, runState);
  };

  try {
    await writeStep('load_workflow');
    const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    if (isCurrentGeneratorSnapshot(stored.todaySnapshot, new Date())) {
      return writeStep('completed', {
        status: 'completed',
        finishedAt: nowIso(),
        generatedCandidates: 0,
        importedCandidates: 0,
        todayCount: stored.todaySnapshot.words.length,
        generatedCards: 0,
        queuedCards: 0
      });
    }

    await writeStep('generate_candidates_start');
    const generated = await generateCandidates(origin, stored, { count: runState.count });
    let totalGenerated = generated.items.length;
    await writeStep('generate_candidates_done', { generatedCandidates: totalGenerated });
    const workflowWithBatch = cleanStoredWorkflow({
      ...stored,
      aiBatches: [generated.batch, ...safeArray(stored.aiBatches)].slice(0, 100)
    });
    await writeStep('import_candidates_start', { generatedCandidates: totalGenerated });
    let imported = importAiCandidates(workflowWithBatch, generated.items, generated.batch);
    let totalImported = imported.stats.imported;
    await writeStep('import_candidates_done', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported
    });
    await writeStep('select_today_start', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported
    });
    const rankingHistoryWords = await readRankingHistoryWords(env, today, 30);
    let snapshot = generateTodaySnapshot({ ...imported.workflow, rankingHistoryWords }, { mode: 'create', createdBy: 'server' });
    await writeStep('select_today_done', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
    });

    for (let round = 0; snapshot.result.shortage && round < runState.maxTopUpRounds; round += 1) {
      await writeStep('top_up_generate_start', {
        topUpTriggered: true,
        topUpRoundsUsed: round,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
      });
      const extraGenerated = await generateCandidates(origin, snapshot.workflow, { count: runState.count });
      totalGenerated += extraGenerated.items.length;
      await writeStep('top_up_generate_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
      });
      const workflowWithExtraBatch = cleanStoredWorkflow({
        ...snapshot.workflow,
        aiBatches: [extraGenerated.batch, ...safeArray(snapshot.workflow.aiBatches)].slice(0, 100)
      });
      await writeStep('top_up_import_start', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
      });
      imported = importAiCandidates(workflowWithExtraBatch, extraGenerated.items, extraGenerated.batch);
      totalImported += imported.stats.imported;
      await writeStep('top_up_import_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
      });
      snapshot = generateTodaySnapshot({ ...imported.workflow, rankingHistoryWords }, { mode: 'fill', createdBy: 'server' });
      await writeStep('top_up_select_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length
      });
      if (!imported.stats.imported) break;
    }

    const finalWorkflow = cleanStoredWorkflow({ ...snapshot.workflow, updated: nowIso() });

    await writeStep('save_workflow_start', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: safeArray(finalWorkflow.todaySnapshot?.words).length
    });
    await env.FAVORITES.put(key, JSON.stringify(finalWorkflow));
    const todayWords = safeArray(finalWorkflow.todaySnapshot?.words);
    const cardTargets = todayWords.filter(kanji => cleanAiCard(finalWorkflow.candidatePool?.[kanji]?.aiCard || {}).cardStatus !== 'ready');
    await writeStep('save_workflow_done', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: todayWords.length,
      queuedCards: cardTargets.length
    });

    await writeStep('completed', {
      status: 'completed',
      finishedAt: nowIso(),
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: todayWords.length,
      generatedCards: 0,
      queuedCards: cardTargets.length,
      cardGenerationSkipped: Boolean(runState.skipCards)
    });

    let generatedCards = 0;
    if (!runState.skipCards && cardTargets.length) {
      try {
        await writeStep('generate_cards_start', {
          status: 'completed',
          finishedAt: runState.finishedAt || nowIso(),
          queuedCards: cardTargets.length
        });
        generatedCards = await generateCardsAndSave(origin, finalWorkflow, env, key);
        return writeStep('generate_cards_done', {
          status: 'completed',
          finishedAt: runState.finishedAt || nowIso(),
          generatedCards,
          queuedCards: cardTargets.length
        });
      } catch (cardError) {
        console.warn('daily-refresh card generation failed', cardError?.message || cardError);
        return writeStep('generate_cards_failed', {
          status: 'completed',
          finishedAt: runState.finishedAt || nowIso(),
          generatedCards,
          queuedCards: cardTargets.length,
          cardError: cleanText(cardError?.message || 'card generation failed', 500)
        });
      }
    }
    return cleanRefreshRunState(runState);
  } catch (error) {
    console.warn('daily-refresh background job failed', error?.message || error);
    return writeRefreshRunState(env, today, {
      ...runState,
      status: 'failed',
      lastStep,
      stepIndex: getStepIndex(lastStep),
      finishedAt: nowIso(),
      error: cleanText(error?.message || 'daily refresh failed', 500),
      errorStack: cleanText(error?.stack || '', 3000)
    });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (!['GET', 'POST'].includes(request.method)) {
    return jsonResponse({ ok: false, status: 'failed', error: 'Method not allowed' }, 405);
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, status: 'failed', error: 'Unauthorized' }, 401);
  }
  if (!env.FAVORITES) {
    return jsonResponse({ ok: false, status: 'failed', error: 'KV namespace FAVORITES is not configured' }, 500);
  }

  const url = new URL(request.url);
  const key = getStorageKey(url);
  const today = dateKey(new Date());
  const origin = url.origin;

  try {
    if (request.method === 'GET') {
      const stateDate = cleanDateKey(url.searchParams.get('date')) || today;
      const runState = await readRefreshRunState(env, stateDate);
      const staleInfo = getRunningStaleInfo(runState);
      return jsonResponse({
        ok: true,
        ...runState,
        dateKey: stateDate,
        isStale: staleInfo.isStale,
        staleAfterMs: STALE_RUNNING_MS,
        runningAgeMs: staleInfo.ageMs
      });
    }

    const body = await readJsonBody(request);
    const options = getRefreshOptions(url, body);
    const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    if (isCurrentGeneratorSnapshot(stored.todaySnapshot, new Date())) {
      const completedState = await writeRefreshRunState(env, today, {
        status: 'completed',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        lastStep: 'completed',
        stepIndex: getStepIndex('completed'),
        totalSteps: REFRESH_STEPS.length,
        generatedCandidates: 0,
        importedCandidates: 0,
        todayCount: stored.todaySnapshot.words.length,
        generatedCards: 0,
        queuedCards: 0,
        requestId: createRequestId(),
        mode: options.mode,
        count: options.count,
        skipCards: options.skipCards,
        maxTopUpRounds: options.maxTopUpRounds
      });
      return jsonResponse({
        ok: true,
        skipped: true,
        ...completedState
      });
    }

    const runState = await readRefreshRunState(env, today);
    const staleInfo = getRunningStaleInfo(runState);
    if (isFreshRunningState(runState)) {
      return jsonResponse({
        ok: true,
        ...runState,
        isStale: false,
        staleAfterMs: STALE_RUNNING_MS,
        runningAgeMs: staleInfo.ageMs
      });
    }
    const requestId = createRequestId();
    const startedAt = nowIso();
    const initialState = await writeRefreshRunState(env, today, {
      status: 'running',
      startedAt,
      finishedAt: '',
      lastStep: 'started',
      stepIndex: getStepIndex('started'),
      totalSteps: REFRESH_STEPS.length,
      generatedCandidates: 0,
      importedCandidates: 0,
      todayCount: 0,
      generatedCards: 0,
      queuedCards: 0,
      topUpTriggered: false,
      topUpRoundsUsed: 0,
      error: '',
      errorStack: '',
      requestId,
      mode: options.mode,
      count: options.count,
      skipCards: options.skipCards,
      maxTopUpRounds: options.maxTopUpRounds,
      previousRunStale: staleInfo.isStale,
      previousRunStartedAt: staleInfo.isStale ? runState.startedAt : '',
      previousRunUpdatedAt: staleInfo.isStale ? runState.updatedAt : '',
      cardGenerationSkipped: false,
      cardError: ''
    });

    const job = runDailyRefreshJob({
      origin,
      env,
      key,
      today,
      options,
      requestId,
      startedAt,
      previousRun: {
        stale: staleInfo.isStale,
        startedAt: runState.startedAt,
        updatedAt: runState.updatedAt
      }
    });
    if (options.isPreviewTest) {
      const finalState = await job;
      return jsonResponse({
        ok: finalState.status !== 'failed',
        ...finalState,
        queued: false,
        isStale: false,
        staleAfterMs: STALE_RUNNING_MS
      }, finalState.status === 'failed' ? 500 : 200);
    }
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(job);
    } else {
      await job;
    }
    return jsonResponse({
      ok: true,
      ...initialState,
      queued: true,
      isStale: false,
      staleAfterMs: STALE_RUNNING_MS
    });
  } catch (error) {
    console.warn('daily-refresh failed', error?.message || error);
    return jsonResponse({
      ok: false,
      status: 'failed',
      generatedCandidates: 0,
      importedCandidates: 0,
      todayCount: 0,
      generatedCards: 0,
      dateKey: today,
      error: cleanText(error.message || 'daily refresh failed', 500)
    }, 500);
  }
}

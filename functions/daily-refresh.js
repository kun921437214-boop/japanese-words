import { isStoredDailyWordCount } from '../shared/daily-config.mjs';
import { addDays, buildRankingForDate, cleanDateKey, cleanStoredRanking, dateKey, WORDS_PER_DAY } from '../shared/rankings.mjs';
import {
  cleanStoredWorkflow,
  generateTodaySnapshot,
  getChineseTransparencyScore,
  getExpressionValueScore,
  isCurrentGeneratorSnapshot,
  isGenericTopicWord
} from '../shared/today-snapshot.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';
import {
  buildDeepSeekExclusionContext,
  flattenWords,
  normalizeKanjiSpelling
} from '../shared/deepseek-exclusion.mjs';
import {
  API_LIMITS,
  authorizeRequest,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  readJsonBody as readLimitedJsonBody,
  unauthorizedResponse
} from '../shared/api-security.mjs';
import { mergeAutomatedWorkflowUpdate } from '../shared/workflow-mutation.mjs';
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';
const PROMPT_VERSION_BY_ACTION = {
  stable_today: 'candidate-v4-content-mix',
  wild_ideas: 'candidate-v4-content-mix',
  generate_candidates: 'candidate-v4-content-mix',
  extract_from_materials: 'candidate-v4-content-mix',
  enrich_words: 'card-v2',
  generate_word_card: 'card-v2',
  rerank_candidates: 'rerank-v1',
  audit_library_for_delete: 'library-audit-v2',
  audit_missing_library_words: 'library-audit-v2'
};
const DEFAULT_CANDIDATE_COUNT = 50;
const PREVIEW_TEST_CANDIDATE_COUNT = 10;
const PREVIEW_TEST_MAX_CANDIDATE_COUNT = 50;
const DEFAULT_MAX_TOP_UP_ROUNDS = 2;
const PREVIEW_TEST_MAX_TOP_UP_ROUNDS = 1;
const STALE_RUNNING_MS = 15 * 60 * 1000;
const AI_ENDPOINT_TIMEOUT_MS = 90 * 1000;
const AI_ENDPOINT_MAX_RETRIES = 1;
const AI_ENDPOINT_RETRY_MIN_DELAY_MS = 1500;
const AI_ENDPOINT_RETRY_MAX_DELAY_MS = 3000;
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

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function getRetryDelayMs() {
  return Math.round(AI_ENDPOINT_RETRY_MIN_DELAY_MS + Math.random() * (AI_ENDPOINT_RETRY_MAX_DELAY_MS - AI_ENDPOINT_RETRY_MIN_DELAY_MS));
}

function createEndpointError(message, options = {}) {
  const error = new Error(message);
  error.status = options.status || 0;
  error.retryable = Boolean(options.retryable);
  error.reason = options.reason || '';
  return error;
}

function isRetryableHttpStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

function isTemporaryNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'TypeError'
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('connection')
    || message.includes('econnreset')
    || message.includes('etimedout');
}

function getRequestOption(url, body, name) {
  if (body && Object.prototype.hasOwnProperty.call(body, name)) return body[name];
  return url.searchParams.get(name);
}

function getRefreshOptions(url, body = {}) {
  const mode = cleanText(getRequestOption(url, body, 'mode'), 40);
  const isPreviewTest = ['preview-test', 'test'].includes(mode);
  const isManualMode = ['manual', 'inline', 'manual-inline'].includes(mode);
  const requestedInline = cleanBoolean(getRequestOption(url, body, 'runInline'), false);
  const runInline = isPreviewTest || isManualMode || requestedInline;
  const defaultCount = isPreviewTest ? PREVIEW_TEST_CANDIDATE_COUNT : DEFAULT_CANDIDATE_COUNT;
  const defaultTopUpRounds = isPreviewTest ? PREVIEW_TEST_MAX_TOP_UP_ROUNDS : DEFAULT_MAX_TOP_UP_ROUNDS;
  // Preview test allows a higher candidate count for controlled validation while keeping production defaults unchanged.
  const countMax = isPreviewTest ? PREVIEW_TEST_MAX_CANDIDATE_COUNT : 100;
  const topUpMax = isPreviewTest ? PREVIEW_TEST_MAX_TOP_UP_ROUNDS : DEFAULT_MAX_TOP_UP_ROUNDS;
  return {
    mode: isPreviewTest ? 'preview-test' : (isManualMode ? 'manual' : (requestedInline ? 'inline' : 'default')),
    isPreviewTest,
    runInline,
    count: cleanInteger(getRequestOption(url, body, 'count'), defaultCount, 1, countMax),
    skipCards: cleanBoolean(getRequestOption(url, body, 'skipCards'), isPreviewTest || isManualMode || requestedInline),
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
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v4-content-mix';
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
  return [...new Set(safeArray(words).map(item => normalizeKanjiSpelling(item)).filter(Boolean))];
}

function daysBetweenIso(value, now = new Date()) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - time) / 86400000);
}

function getPendingWords(workflow = {}) {
  return Object.entries(workflow.statuses || {})
    .filter(([, status]) => ['pending', 'published'].includes(status))
    .map(([word]) => word);
}

function isProtectedWordExcluded(entry = {}) {
  if (!entry?.protected) return false;
  if (['review', 'blocked', 'long_term', 'seasonal'].includes(entry.displayBucket)) return true;
  if (['medium', 'high'].includes(entry.riskLevel)) return true;
  if (entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown' || entry.lastReviewState === 'review') return true;
  return false;
}

function getProtectedExcludedWords(workflow = {}) {
  return Object.values(workflow.candidatePool || {})
    .filter(isProtectedWordExcluded)
    .map(entry => entry.kanji);
}

function getRecentlyRecommendedCandidateWords(workflow = {}, now = new Date(), days = 30) {
  return Object.values(workflow.candidatePool || {})
    .filter(entry => {
      const selectedAt = entry.recommendationAudit?.selectedAt || entry.lastRecommendedAt || '';
      return Boolean(entry.kanji && selectedAt && daysBetweenIso(selectedAt, now) <= days);
    })
    .map(entry => entry.kanji);
}

function getExclusionReason(kanji, exclusionContext = {}) {
  const cleanKanji = normalizeKanjiSpelling(kanji);
  const reasons = exclusionContext.excludedReasons || {};
  const priority = [
    ['current_batch_duplicate', 'duplicate_in_current_batch'],
    ['selected_today', 'selected_today'],
    ['favorite_or_pending', 'favorite_or_pending'],
    ['published', 'published'],
    ['recent_history_30d', 'recent_history_30d'],
    ['protected', 'protected_word'],
    ['existing_recent_candidate', 'recently_recommended_candidate']
  ];
  for (const [key, reason] of priority) {
    if (uniqueWords(reasons[key]).includes(cleanKanji)) return reason;
  }
  if (uniqueWords(exclusionContext.excludedWords).includes(cleanKanji)) return 'excluded_word';
  return '';
}

function buildWorkflowExclusionContext(workflow = {}, rankingHistoryWords = {}, options = {}) {
  const now = options.now || new Date();
  return buildDeepSeekExclusionContext({
    recentHistoryWords: flattenWords(rankingHistoryWords),
    favoriteWords: workflow.words,
    pendingWords: getPendingWords(workflow),
    publishedWords: [...getPublishedWords(workflow)],
    selectedTodayWords: workflow.todaySnapshot?.words || [],
    currentBatchWords: options.currentBatchWords || [],
    protectedWords: getProtectedExcludedWords(workflow),
    existingRecentCandidateWords: getRecentlyRecommendedCandidateWords(workflow, now, 30)
  });
}

function createNoveltyStats() {
  return {
    generatedWords: new Set(),
    importedWords: new Set(),
    recentHistoryRejectedWords: new Set(),
    favoriteProtectedRejectedWords: new Set(),
    currentBatchDuplicateRejectedWords: new Set(),
    reviewRejectedWords: new Set(),
    generatedTotal: 0
  };
}

function recordGeneratedWords(stats, items = []) {
  safeArray(items).forEach(item => {
    const kanji = normalizeKanjiSpelling(item?.kanji || item?.word);
    if (!kanji) return;
    stats.generatedWords.add(kanji);
    stats.generatedTotal += 1;
  });
}

function mergeImportNoveltyStats(stats, importStats = {}) {
  safeArray(importStats.importedWords).forEach(word => stats.importedWords.add(normalizeKanjiSpelling(word)));
  [
    'recent_history_30d',
    'recently_recommended_candidate'
  ].forEach(reason => {
    safeArray(importStats.rejectedWordsByReason?.[reason]).forEach(word => stats.recentHistoryRejectedWords.add(normalizeKanjiSpelling(word)));
  });
  [
    'favorite_or_pending',
    'published',
    'protected_word'
  ].forEach(reason => {
    safeArray(importStats.rejectedWordsByReason?.[reason]).forEach(word => stats.favoriteProtectedRejectedWords.add(normalizeKanjiSpelling(word)));
  });
  safeArray(importStats.rejectedWordsByReason?.duplicate_in_current_batch).forEach(word => stats.currentBatchDuplicateRejectedWords.add(normalizeKanjiSpelling(word)));
  safeArray(importStats.rejectedWordsByReason?.review_required).forEach(word => stats.reviewRejectedWords.add(normalizeKanjiSpelling(word)));
}

function getNoveltySummary(stats) {
  const generatedUniqueCount = stats.generatedWords.size;
  const duplicateCount = Math.max(0, stats.generatedTotal - generatedUniqueCount);
  const recentHistoryRejectedCount = stats.recentHistoryRejectedWords.size;
  return {
    generatedUniqueCount,
    importedUniqueCount: stats.importedWords.size,
    recentHistoryRejectedCount,
    favoriteProtectedRejectedCount: stats.favoriteProtectedRejectedWords.size,
    currentBatchDuplicateRejectedCount: stats.currentBatchDuplicateRejectedWords.size,
    reviewRejectedCount: stats.reviewRejectedWords.size,
    duplicateRate: stats.generatedTotal ? Math.round((duplicateCount / stats.generatedTotal) * 100) : 0,
    historyCollisionRate: generatedUniqueCount ? Math.round((recentHistoryRejectedCount / generatedUniqueCount) * 100) : 0
  };
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
    if (isStoredDailyWordCount(ranking.words.length)) cachedSelections.set(currentDateKey, ranking.words);
  });

  const rankingHistoryWords = {};
  historyDateKeys.forEach(cursor => {
    let words = cachedSelections.get(cursor);
    if (!words || !isStoredDailyWordCount(words.length)) {
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

function getSoftRejectedReason(item = {}) {
  if (item.displayBucket === 'review' || item.riskLevel === 'high' || item.confidenceLevel === 'review' || item.evidenceType === 'unknown') return 'review_required';
  if (isGenericTopicWord(item)) return 'generic_topic';
  if (getExpressionValueScore(item) < 55) return 'low_expression_value';
  if (getChineseTransparencyScore(item) >= 80) return 'high_chinese_transparency';
  return '';
}

function importAiCandidates(workflow, items = [], batch = {}, options = {}) {
  const nextWorkflow = cleanStoredWorkflow(workflow);
  const stats = {
    generated: safeArray(items).length,
    imported: 0,
    skipped: 0,
    review: 0,
    blocked: 0,
    importedWords: [],
    rejectedWordsByReason: {}
  };
  const pool = { ...(nextWorkflow.candidatePool || {}) };
  const seenInCurrentImport = new Set();
  const rejectedReasonByKanji = {};
  const addRejectedReason = (kanji, reason) => {
    const cleanKanji = normalizeKanjiSpelling(kanji);
    if (!cleanKanji || !reason) return;
    rejectedReasonByKanji[cleanKanji] = reason;
    if (!stats.rejectedWordsByReason[reason]) stats.rejectedWordsByReason[reason] = [];
    stats.rejectedWordsByReason[reason].push(cleanKanji);
  };
  safeArray(items).forEach(item => {
    const kanji = normalizeKanjiSpelling(item.kanji);
    if (!kanji) {
      stats.blocked += 1;
      stats.skipped += 1;
      addRejectedReason(item.kanji, 'missing_kanji');
      return;
    }
    if (seenInCurrentImport.has(kanji)) {
      stats.skipped += 1;
      addRejectedReason(kanji, 'duplicate_in_current_batch');
      return;
    }
    seenInCurrentImport.add(kanji);
    if (isBlockedCandidate(item)) {
      stats.blocked += 1;
      stats.skipped += 1;
      addRejectedReason(kanji, 'blocked');
      return;
    }
    const exclusionReason = getExclusionReason(kanji, options.exclusionContext);
    if (exclusionReason) {
      stats.skipped += 1;
      addRejectedReason(kanji, exclusionReason);
      return;
    }
    if (isFavoriteOrPublished(kanji, nextWorkflow)) {
      stats.skipped += 1;
      addRejectedReason(kanji, nextWorkflow.statuses?.[kanji] === 'published' || getPublishedWords(nextWorkflow).has(kanji) ? 'published' : 'favorite_or_pending');
      return;
    }
    const existing = pool[kanji] || {};
    if (isProtectedWordExcluded(existing)) {
      stats.skipped += 1;
      addRejectedReason(kanji, 'protected_word');
      return;
    }
    const isReview = item.displayBucket === 'review'
      || item.riskLevel === 'high'
      || item.confidenceLevel === 'review'
      || item.evidenceType === 'unknown';
    const softRejectedReason = getSoftRejectedReason({ ...item, kanji });
    if (softRejectedReason) addRejectedReason(kanji, softRejectedReason);
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
    stats.importedWords.push(kanji);
    if (isReview) stats.review += 1;
  });
  const nextBatches = safeArray(nextWorkflow.aiBatches).map(item => item.id === batch.id
    ? {
        ...item,
        acceptedCount: stats.imported,
        rejectedCount: stats.skipped,
        importedCount: stats.imported,
        skippedCount: stats.skipped,
        items: safeArray(item.items).map(batchItem => {
          const kanji = normalizeKanjiSpelling(batchItem.kanji);
          const rejectedReason = rejectedReasonByKanji[kanji] || batchItem.rejectedReason || '';
          return {
            ...batchItem,
            kanji,
            rejectedReason
          };
        })
      }
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
  const exclusionContext = options.exclusionContext || buildDeepSeekExclusionContext();
  return {
    action: 'stable_today',
    input: '',
    count: cleanInteger(options.count, DEFAULT_CANDIDATE_COUNT, 1, 100),
    batchHint: cleanText(options.batchHint, 1000),
    avoidWords: exclusionContext.excludedWords,
    preferences: {
      includeMemes: true,
      includeHighRisk: 'review_only',
      readingFormat: 'romaji_kana'
    },
    context: {
      favorites: workflow.words,
      negativeFeedback: workflow.feedback,
      publishedWords: safeArray(workflow.publishedRecords).map(record => record.word).filter(Boolean),
      deepSeekExclusion: exclusionContext,
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
  const maxRetries = cleanInteger(options.maxRetries, AI_ENDPOINT_MAX_RETRIES, 0, 1);
  const callLabel = cleanText(options.callLabel || `${path}:${payload?.action || 'unknown'}`, 120);
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (typeof options.onAttempt === 'function') {
        await options.onAttempt({
          path,
          callLabel,
          attempt,
          maxAttempts: maxRetries + 1
        });
      }
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.authorization ? { Authorization: options.authorization } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          throw createEndpointError(`${callLabel} returned invalid JSON on attempt ${attempt}`, {
            status: response.status,
            retryable: false,
            reason: 'invalid_json'
          });
        }
      }
      if (!response.ok || data.error) {
        const message = data.error?.message || data.error || `HTTP ${response.status}`;
        const status = response.status || cleanInteger(String(message).match(/HTTP\s+(\d+)/i)?.[1], 0, 0, 599);
        throw createEndpointError(message, {
          status,
          retryable: isRetryableHttpStatus(status),
          reason: status ? `http_${status}` : 'endpoint_error'
        });
      }
      return data;
    } catch (error) {
      const retryable = error?.retryable || error?.name === 'AbortError' || isTemporaryNetworkError(error);
      const normalizedError = error?.name === 'AbortError'
        ? createEndpointError(`${path} timed out after ${timeoutMs}ms`, { retryable: true, reason: 'timeout' })
        : error;
      lastError = normalizedError;
      if (!retryable || attempt > maxRetries) {
        const suffix = attempt > 1 ? ` after ${attempt} attempts` : ` on attempt ${attempt}`;
        if (typeof options.onFailure === 'function') {
          await options.onFailure({
            path,
            callLabel,
            attempt,
            maxAttempts: maxRetries + 1,
            status: normalizedError.status || 0,
            error: normalizedError.message || String(normalizedError),
            reason: normalizedError.reason || 'failed'
          });
        }
        throw createEndpointError(`AI call ${callLabel} failed${suffix}: ${normalizedError.message || normalizedError}`, {
          status: normalizedError.status || 0,
          retryable: false,
          reason: normalizedError.reason || 'failed'
        });
      }
      const delayMs = getRetryDelayMs();
      if (typeof options.onRetry === 'function') {
        await options.onRetry({
          path,
          callLabel,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          delayMs,
          status: normalizedError.status || 0,
          error: normalizedError.message || String(normalizedError),
          reason: normalizedError.reason || 'retryable_error'
        });
      }
      await sleep(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError || createEndpointError(`AI call ${callLabel} failed`, { retryable: false, reason: 'unknown' });
}

async function generateCandidates(origin, workflow, options = {}) {
  const payload = buildCandidatePayload(workflow, options);
  const data = await callJsonEndpoint(origin, '/ai-candidates', payload, {
    callLabel: options.callLabel,
    authorization: options.authorization,
    onAttempt: options.onAttempt,
    onRetry: options.onRetry,
    onFailure: options.onFailure
  });
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

async function generateCards(origin, workflow, authorization = '') {
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
      const data = await callJsonEndpoint(origin, '/ai-candidates', payload, { authorization });
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
    generatedUniqueCount: cleanInteger(record.generatedUniqueCount, 0, 0, 10000),
    importedCandidates: cleanInteger(record.importedCandidates, 0, 0, 10000),
    importedUniqueCount: cleanInteger(record.importedUniqueCount, 0, 0, 10000),
    recentHistoryRejectedCount: cleanInteger(record.recentHistoryRejectedCount, 0, 0, 10000),
    favoriteProtectedRejectedCount: cleanInteger(record.favoriteProtectedRejectedCount, 0, 0, 10000),
    currentBatchDuplicateRejectedCount: cleanInteger(record.currentBatchDuplicateRejectedCount, 0, 0, 10000),
    reviewRejectedCount: cleanInteger(record.reviewRejectedCount, 0, 0, 10000),
    duplicateRate: cleanInteger(record.duplicateRate, 0, 0, 100),
    historyCollisionRate: cleanInteger(record.historyCollisionRate, 0, 0, 100),
    aiCallFailures: cleanInteger(record.aiCallFailures, 0, 0, 100),
    aiRetryCount: cleanInteger(record.aiRetryCount, 0, 0, 100),
    aiRetryLastCall: cleanText(record.aiRetryLastCall, 120),
    aiRetryLastError: cleanText(record.aiRetryLastError, 500),
    lastAiCallPath: cleanText(record.lastAiCallPath, 120),
    lastAiCallAttempt: cleanInteger(record.lastAiCallAttempt, 0, 0, 10),
    lastAiCallError: cleanText(record.lastAiCallError, 500),
    todayCount: cleanInteger(record.todayCount, 0, 0, 1000),
    generatedCards: cleanInteger(record.generatedCards, 0, 0, 1000),
    queuedCards: cleanInteger(record.queuedCards, 0, 0, 1000),
    topUpTriggered: Boolean(record.topUpTriggered),
    topUpRoundsUsed: cleanInteger(record.topUpRoundsUsed, 0, 0, 20),
    requestId: cleanText(record.requestId, 120),
    mode: cleanText(record.mode, 40),
    runInline: Boolean(record.runInline),
    executionMode: ['waitUntil', 'inline'].includes(record.executionMode) ? record.executionMode : '',
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

async function generateCardsAndSave(origin, workflow, env, key, requestId = '') {
  const authorization = env.AUTO_REFRESH_SECRET ? `Bearer ${String(env.AUTO_REFRESH_SECRET).trim()}` : '';
  const cardResult = await generateCards(origin, workflow, authorization);
  const storedAfterCards = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
  const mergedWorkflow = mergeAutomatedWorkflowUpdate(storedAfterCards, cardResult.workflow);
  const mutation = await commitWorkflowMutation(env, key, mergedWorkflow, {
    operationId: `${requestId || crypto.randomUUID()}:cards`,
    expectedRevision: null,
    action: 'daily-refresh.cards',
    actor: 'scheduled-worker',
    target: storedAfterCards.todaySnapshot?.dateKey || '',
    summary: `生成 ${cardResult.generatedCards} 张词卡`
  }, { strategy: 'automated' });
  return cardResult.generatedCards;
}

async function runDailyRefreshJob({ origin, env, key, today, options = {}, requestId = '', startedAt = '', previousRun = {} }) {
  const internalAuthorization = env.AUTO_REFRESH_SECRET
    ? `Bearer ${String(env.AUTO_REFRESH_SECRET).trim()}`
    : '';
  const runState = {
    status: 'running',
    dateKey: today,
    startedAt: startedAt || nowIso(),
    finishedAt: '',
    lastStep: 'started',
    stepIndex: getStepIndex('started'),
    totalSteps: REFRESH_STEPS.length,
    generatedCandidates: 0,
    generatedUniqueCount: 0,
    importedCandidates: 0,
    importedUniqueCount: 0,
    recentHistoryRejectedCount: 0,
    favoriteProtectedRejectedCount: 0,
    currentBatchDuplicateRejectedCount: 0,
    reviewRejectedCount: 0,
    duplicateRate: 0,
    historyCollisionRate: 0,
    aiCallFailures: 0,
    aiRetryCount: 0,
    aiRetryLastCall: '',
    aiRetryLastError: '',
    lastAiCallPath: '',
    lastAiCallAttempt: 0,
    lastAiCallError: '',
    todayCount: 0,
    generatedCards: 0,
    queuedCards: 0,
    topUpTriggered: false,
    topUpRoundsUsed: 0,
    error: '',
    errorStack: '',
    requestId,
    mode: options.mode || 'default',
    runInline: Boolean(options.runInline),
    executionMode: ['waitUntil', 'inline'].includes(options.executionMode) ? options.executionMode : '',
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
  const writeAiAttempt = async details => writeStep(lastStep, {
    lastAiCallPath: cleanText(details.path, 120),
    lastAiCallAttempt: cleanInteger(details.attempt, 0, 0, 10),
    lastAiCallError: ''
  });
  const writeAiRetry = async details => {
    runState.aiCallFailures += 1;
    runState.aiRetryCount += 1;
    return writeStep(lastStep, {
      aiCallFailures: runState.aiCallFailures,
      aiRetryCount: runState.aiRetryCount,
      aiRetryLastCall: cleanText(`${details.callLabel} attempt ${details.attempt}/${details.maxAttempts}`, 120),
      aiRetryLastError: cleanText(`${details.error}; retrying in ${details.delayMs}ms`, 500),
      lastAiCallPath: cleanText(details.path, 120),
      lastAiCallAttempt: cleanInteger(details.attempt, 0, 0, 10),
      lastAiCallError: cleanText(`${details.error}; retrying in ${details.delayMs}ms`, 500)
    });
  };
  const writeAiFailure = async details => {
    runState.aiCallFailures += 1;
    return writeStep(lastStep, {
      aiCallFailures: runState.aiCallFailures,
      lastAiCallPath: cleanText(details.path, 120),
      lastAiCallAttempt: cleanInteger(details.attempt, 0, 0, 10),
      lastAiCallError: cleanText(details.error || 'AI call failed', 500)
    });
  };

  try {
    await writeStep('load_workflow');
    const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    if (isCurrentGeneratorSnapshot(stored.todaySnapshot, new Date())) {
      return writeStep('completed', {
        status: 'completed',
        finishedAt: nowIso(),
        generatedCandidates: 0,
        generatedUniqueCount: 0,
        importedCandidates: 0,
        importedUniqueCount: 0,
        recentHistoryRejectedCount: 0,
        favoriteProtectedRejectedCount: 0,
        currentBatchDuplicateRejectedCount: 0,
        reviewRejectedCount: 0,
        duplicateRate: 0,
        historyCollisionRate: 0,
        aiCallFailures: 0,
        aiRetryCount: 0,
        aiRetryLastCall: '',
        aiRetryLastError: '',
        lastAiCallPath: '',
        lastAiCallAttempt: 0,
        lastAiCallError: '',
        todayCount: stored.todaySnapshot.words.length,
        generatedCards: 0,
        queuedCards: 0
      });
    }

    const rankingHistoryWords = await readRankingHistoryWords(env, today, 30);
    const noveltyStats = createNoveltyStats();
    const getNoveltyPatch = () => getNoveltySummary(noveltyStats);
    const getExclusionContext = workflow => buildWorkflowExclusionContext(workflow, rankingHistoryWords, {
      currentBatchWords: [...noveltyStats.generatedWords]
    });

    await writeStep('generate_candidates_start');
    const initialExclusionContext = getExclusionContext(stored);
    const generated = await generateCandidates(origin, stored, {
      authorization: internalAuthorization,
      callLabel: 'initial_candidates',
      onAttempt: writeAiAttempt,
      onRetry: writeAiRetry,
      onFailure: writeAiFailure,
      count: runState.count,
      exclusionContext: initialExclusionContext,
      batchHint: '首批每日热门候选：请避开禁止列表，生成新的低风险日语表达。'
    });
    recordGeneratedWords(noveltyStats, generated.items);
    let totalGenerated = generated.items.length;
    await writeStep('generate_candidates_done', { generatedCandidates: totalGenerated, ...getNoveltyPatch() });
    const workflowWithBatch = cleanStoredWorkflow({
      ...stored,
      aiBatches: [generated.batch, ...safeArray(stored.aiBatches)].slice(0, 100)
    });
    await writeStep('import_candidates_start', { generatedCandidates: totalGenerated, ...getNoveltyPatch() });
    let imported = importAiCandidates(workflowWithBatch, generated.items, generated.batch, {
      exclusionContext: initialExclusionContext
    });
    mergeImportNoveltyStats(noveltyStats, imported.stats);
    let totalImported = imported.stats.imported;
    await writeStep('import_candidates_done', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      ...getNoveltyPatch()
    });
    await writeStep('select_today_start', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      ...getNoveltyPatch()
    });
    let snapshot = generateTodaySnapshot(
      { ...imported.workflow, rankingHistoryWords },
      { mode: 'create', createdBy: 'server', noveltySummary: getNoveltyPatch() }
    );
    await writeStep('select_today_done', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
      ...getNoveltyPatch()
    });

    for (let round = 0; snapshot.result.shortage && round < runState.maxTopUpRounds; round += 1) {
      await writeStep('top_up_generate_start', {
        topUpTriggered: true,
        topUpRoundsUsed: round,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
        ...getNoveltyPatch()
      });
      const topUpExclusionContext = getExclusionContext(snapshot.workflow);
      const extraGenerated = await generateCandidates(origin, snapshot.workflow, {
        authorization: internalAuthorization,
        callLabel: `top_up_candidates_round_${round + 1}`,
        onAttempt: writeAiAttempt,
        onRetry: writeAiRetry,
        onFailure: writeAiFailure,
        count: runState.count,
        exclusionContext: topUpExclusionContext,
        batchHint: `topUp 补词：当前今日热门只有 ${safeArray(snapshot.workflow.todaySnapshot?.words).length}/${WORDS_PER_DAY} 个。首批、本轮已生成、今日已选和近 30 天历史词都在禁止列表里，必须换新方向。`
      });
      recordGeneratedWords(noveltyStats, extraGenerated.items);
      totalGenerated += extraGenerated.items.length;
      await writeStep('top_up_generate_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
        ...getNoveltyPatch()
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
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
        ...getNoveltyPatch()
      });
      imported = importAiCandidates(workflowWithExtraBatch, extraGenerated.items, extraGenerated.batch, {
        exclusionContext: topUpExclusionContext
      });
      mergeImportNoveltyStats(noveltyStats, imported.stats);
      totalImported += imported.stats.imported;
      await writeStep('top_up_import_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
        ...getNoveltyPatch()
      });
      snapshot = generateTodaySnapshot(
        { ...imported.workflow, rankingHistoryWords },
        { mode: 'fill', createdBy: 'server', noveltySummary: getNoveltyPatch() }
      );
      await writeStep('top_up_select_done', {
        topUpTriggered: true,
        topUpRoundsUsed: round + 1,
        generatedCandidates: totalGenerated,
        importedCandidates: totalImported,
        todayCount: safeArray(snapshot.workflow.todaySnapshot?.words).length,
        ...getNoveltyPatch()
      });
      if (!imported.stats.imported) break;
    }

    const storedBeforeSave = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    const finalCandidateWorkflow = mergeAutomatedWorkflowUpdate(storedBeforeSave, {
      ...snapshot.workflow,
      updated: nowIso()
    });
    const mutation = await commitWorkflowMutation(env, key, finalCandidateWorkflow, {
      operationId: requestId || crypto.randomUUID(),
      expectedRevision: null,
      action: 'daily-refresh.generate',
      actor: 'scheduled-worker',
      target: today,
      summary: `生成 ${safeArray(finalCandidateWorkflow.todaySnapshot?.words).length} 个今日推荐`
    }, { strategy: 'automated' });
    const finalWorkflow = mutation.workflow;

    await writeStep('save_workflow_start', {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: safeArray(finalWorkflow.todaySnapshot?.words).length,
      ...getNoveltyPatch()
    });
    const todayWords = safeArray(finalWorkflow.todaySnapshot?.words);
    const cardTargets = todayWords.filter(kanji => cleanAiCard(finalWorkflow.candidatePool?.[kanji]?.aiCard || {}).cardStatus !== 'ready');
    const workflowSavedPatch = {
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: todayWords.length,
      queuedCards: cardTargets.length,
      ...getNoveltyPatch()
    };
    if (runState.skipCards) {
      return writeStep('save_workflow_done', {
        ...workflowSavedPatch,
        status: 'completed',
        finishedAt: nowIso(),
        generatedCards: 0,
        cardGenerationSkipped: true
      });
    }

    await writeStep('save_workflow_done', workflowSavedPatch);

    await writeStep('completed', {
      status: 'completed',
      finishedAt: nowIso(),
      generatedCandidates: totalGenerated,
      importedCandidates: totalImported,
      todayCount: todayWords.length,
      generatedCards: 0,
      queuedCards: cardTargets.length,
      ...getNoveltyPatch(),
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
        generatedCards = await generateCardsAndSave(origin, finalWorkflow, env, key, requestId);
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
      aiRetryLastError: cleanText(error?.message || 'daily refresh failed', 500),
      lastAiCallError: cleanText(error?.message || 'daily refresh failed', 500),
      errorStack: cleanText(error?.stack || '', 3000)
    });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const methods = ['GET', 'POST', 'OPTIONS'];
  const responseRequestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId: responseRequestId });
  const fail = (status, code, message, options = {}) => errorResponse(request, env, status, code, message, { methods, requestId: responseRequestId, ...options });

  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env, methods);
  }
  if (!['GET', 'POST'].includes(request.method)) {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  const authorization = await authorizeRequest(request, env, { allowAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId: responseRequestId });
  if (!env.FAVORITES) {
    return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');
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
      return respond({
        ok: true,
        ...runState,
        dateKey: stateDate,
        isStale: staleInfo.isStale,
        staleAfterMs: STALE_RUNNING_MS,
        runningAgeMs: staleInfo.ageMs
      });
    }

    const hasJsonBody = (request.headers.get('Content-Type') || '').includes('application/json');
    const parsed = hasJsonBody
      ? await readLimitedJsonBody(request, { maxBytes: API_LIMITS.command })
      : { ok: true, value: {} };
    if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
    const body = parsed.value;
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
        maxTopUpRounds: options.maxTopUpRounds,
        generatedUniqueCount: 0,
        importedUniqueCount: 0,
        recentHistoryRejectedCount: 0,
        favoriteProtectedRejectedCount: 0,
        currentBatchDuplicateRejectedCount: 0,
        reviewRejectedCount: 0,
        duplicateRate: 0,
        historyCollisionRate: 0,
        aiCallFailures: 0,
        aiRetryCount: 0,
        aiRetryLastCall: '',
        aiRetryLastError: '',
        lastAiCallPath: '',
        lastAiCallAttempt: 0,
        lastAiCallError: '',
        runInline: options.runInline,
        executionMode: options.runInline ? 'inline' : ''
      });
      return respond({
        ok: true,
        skipped: true,
        ...completedState
      });
    }

    const runState = await readRefreshRunState(env, today);
    const staleInfo = getRunningStaleInfo(runState);
    if (isFreshRunningState(runState)) {
      return respond({
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
      generatedUniqueCount: 0,
      importedCandidates: 0,
      importedUniqueCount: 0,
      recentHistoryRejectedCount: 0,
      favoriteProtectedRejectedCount: 0,
      currentBatchDuplicateRejectedCount: 0,
      reviewRejectedCount: 0,
      duplicateRate: 0,
      historyCollisionRate: 0,
      aiCallFailures: 0,
      aiRetryCount: 0,
      aiRetryLastCall: '',
      aiRetryLastError: '',
      lastAiCallPath: '',
      lastAiCallAttempt: 0,
      lastAiCallError: '',
      todayCount: 0,
      generatedCards: 0,
      queuedCards: 0,
      topUpTriggered: false,
      topUpRoundsUsed: 0,
      error: '',
      errorStack: '',
      requestId,
      mode: options.mode,
      runInline: options.runInline,
      executionMode: options.runInline ? 'inline' : (typeof context.waitUntil === 'function' ? 'waitUntil' : 'inline'),
      count: options.count,
      skipCards: options.skipCards,
      maxTopUpRounds: options.maxTopUpRounds,
      previousRunStale: staleInfo.isStale,
      previousRunStartedAt: staleInfo.isStale ? runState.startedAt : '',
      previousRunUpdatedAt: staleInfo.isStale ? runState.updatedAt : '',
      cardGenerationSkipped: false,
      cardError: ''
    });

    const executionMode = options.runInline || typeof context.waitUntil !== 'function' ? 'inline' : 'waitUntil';
    const jobOptions = {
      ...options,
      executionMode
    };
    const job = runDailyRefreshJob({
      origin,
      env,
      key,
      today,
      options: jobOptions,
      requestId,
      startedAt,
      previousRun: {
        stale: staleInfo.isStale,
        startedAt: runState.startedAt,
        updatedAt: runState.updatedAt
      }
    });
    if (executionMode === 'inline') {
      const finalState = await job;
      return respond({
        ok: finalState.status !== 'failed',
        ...finalState,
        queued: false,
        isStale: false,
        staleAfterMs: STALE_RUNNING_MS
      }, finalState.status === 'failed' ? 500 : 200);
    }
    context.waitUntil(job);
    return respond({
      ok: true,
      ...initialState,
      queued: true,
      isStale: false,
      staleAfterMs: STALE_RUNNING_MS
    });
  } catch (error) {
    console.warn('daily-refresh failed', error?.message || error);
    return respond({
      ok: false,
      status: 'failed',
      generatedCandidates: 0,
      generatedUniqueCount: 0,
      importedCandidates: 0,
      importedUniqueCount: 0,
      recentHistoryRejectedCount: 0,
      favoriteProtectedRejectedCount: 0,
      currentBatchDuplicateRejectedCount: 0,
      reviewRejectedCount: 0,
      duplicateRate: 0,
      historyCollisionRate: 0,
      aiCallFailures: 0,
      aiRetryCount: 0,
      aiRetryLastCall: '',
      aiRetryLastError: '',
      lastAiCallPath: '',
      lastAiCallAttempt: 0,
      lastAiCallError: '',
      todayCount: 0,
      generatedCards: 0,
      dateKey: today,
      error: cleanText(error.message || 'daily refresh failed', 500)
    }, 500);
  }
}

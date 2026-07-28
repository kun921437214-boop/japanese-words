import {
  addDays,
  buildRankingForDate,
  cleanRankingsDays,
  cleanStoredRanking,
  dateKey
} from '../shared/rankings.mjs';
import {
  getExpectedDailyWordCount,
  isStoredDailyWordCount
} from '../shared/daily-config.mjs';
import { refreshPublishedRecords } from '../shared/published-refresh.mjs';
import { persistPublishedRecordCovers } from '../functions/published-cover.js';
import {
  cleanPublishedRecords as cleanWorkflowPublishedRecords,
  cleanStoredWorkflow,
  mergeWorkflow,
  mergeWorkflowForFullSave
} from '../shared/workflow-schema.mjs';
import {
  API_LIMITS,
  authorizeRequest,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  readJsonBody,
  unauthorizedResponse
} from '../shared/api-security.mjs';
import { getCodexDraftStorageKey } from '../shared/codex-daily-draft.mjs';
import {
  getWorkflowMutationMetadata,
  inspectWorkflowMutation
} from '../shared/workflow-mutation.mjs';
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';

const DAILY_REFRESH_CRON = '0 16 * * *';
const PUBLISHED_REFRESH_CRON = '30 6 * * *';
const CODEX_LATE_PROMOTION_CRON = '5,25,45 * * * *';
export const DAILY_DRAFT_HEALTH_CRON = '15 9 * * *';
export const DAILY_SNAPSHOT_HEALTH_CRON = '10 16 * * *';
const AI_CARD_BATCH_CRONS = new Set([
  '10,20,30,40,50 16 * * *',
  '0 17 * * *'
]);
const AI_CARD_BATCH_MAX_WORDS = 5;
const DAILY_HEALTH_TTL_SECONDS = 30 * 24 * 60 * 60;
const DAILY_HEALTH_NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
export const AI_CARD_FAILED_RETRY_TTL_MS = 30 * 60 * 1000;

function toCount(value) {
  return Math.max(0, Number.parseInt(value, 10) || 0);
}

function parseTimeMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRetryableFailedItem(item = {}, nowMs = Date.now()) {
  if (item?.cardStatus !== 'failed') return false;
  const failedAtMs = parseTimeMs(item?.generatedAt);
  return !failedAtMs || nowMs - failedAtMs >= AI_CARD_FAILED_RETRY_TTL_MS;
}

export function getTodayAiCardBatchPlan(status = {}, options = {}) {
  const readyCount = toCount(status?.readyCount);
  const missingCount = toCount(status?.missingCount);
  const failedCount = toCount(status?.failedCount);
  const pendingCount = toCount(status?.pendingCount);
  const stalePendingCount = Math.min(pendingCount, toCount(status?.stalePendingCount));
  const activePendingCount = Math.max(0, pendingCount - stalePendingCount);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const items = Array.isArray(status?.items) ? status.items : [];
  const retryableFailedWords = items
    .filter(item => isRetryableFailedItem(item, nowMs))
    .map(item => String(item?.kanji || '').trim())
    .filter(Boolean);
  const retryableFailedSet = new Set(retryableFailedWords);
  const targetWords = items
    .filter(item => (
      item?.cardStatus === 'none'
      || Boolean(item?.stalePending)
      || retryableFailedSet.has(String(item?.kanji || '').trim())
    ))
    .map(item => String(item?.kanji || '').trim())
    .filter(Boolean);
  const retryStalePending = stalePendingCount > 0;
  const retryFailed = retryableFailedWords.length > 0;
  const workCount = missingCount + stalePendingCount + retryableFailedWords.length;

  return {
    readyCount,
    missingCount,
    failedCount,
    pendingCount,
    stalePendingCount,
    activePendingCount,
    retryStalePending,
    retryFailed,
    retryableFailedCount: retryableFailedWords.length,
    targetWords,
    shouldRun: workCount > 0 && activePendingCount === 0
  };
}

async function readLimitedText(response, maxLength = 500) {
  const text = await response.text().catch(() => '');
  return text.slice(0, maxLength);
}

function cleanAlertUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function dailyHealthStorageKey(kind, targetDateKey) {
  return `operations-health:daily:${kind}:${targetDateKey}`;
}

async function sendOperationsAlert(env, record, options = {}) {
  const webhookUrl = cleanAlertUrl(env.OPS_ALERT_WEBHOOK_URL);
  if (!webhookUrl) return { configured: false, sent: false, error: '' };
  const fetchImpl = options.fetchImpl || fetch;
  const stateLabel = record.status === 'healthy' ? '恢复' : '异常';
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[japanese-words] 每日内容${stateLabel}：${record.kind} ${record.targetDateKey}（${record.reasons.join('；') || '检查通过'}）`,
        event: 'japanese_words_daily_health',
        status: record.status,
        kind: record.kind,
        targetDateKey: record.targetDateKey,
        reasons: record.reasons,
        checkedAt: record.checkedAt
      }),
      signal: globalThis.AbortSignal?.timeout?.(10_000)
    });
    if (!response.ok) {
      const message = await readLimitedText(response);
      throw new Error(`HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }
    return { configured: true, sent: true, error: '' };
  } catch (error) {
    return {
      configured: true,
      sent: false,
      error: String(error?.message || error).slice(0, 500)
    };
  }
}

function buildDraftHealthRecord(draft, targetDateKey, checkedAt) {
  const expectedWordCount = getExpectedDailyWordCount(targetDateKey);
  const reasons = [];
  if (!draft) reasons.push('draft_missing');
  if (draft && draft.targetDateKey !== targetDateKey) reasons.push('draft_date_mismatch');
  if (draft && !['valid', 'published'].includes(draft.status)) reasons.push('draft_not_valid');
  if (draft && !draft.validation?.valid) reasons.push('draft_validation_failed');
  if (draft && Number(draft.wordCount) !== expectedWordCount) reasons.push('draft_word_count_incomplete');
  if (draft && Number(draft.cardReadyCount) !== expectedWordCount) reasons.push('draft_cards_incomplete');
  return {
    kind: 'tomorrow-draft',
    targetDateKey,
    status: reasons.length ? 'unhealthy' : 'healthy',
    reasons,
    checkedAt,
    expectedWordCount,
    wordCount: Number(draft?.wordCount) || 0,
    cardReadyCount: Number(draft?.cardReadyCount) || 0,
    imageReadyCount: Number(draft?.imageReadyCount) || 0,
    source: 'codex-draft',
    draftStatus: String(draft?.status || 'missing')
  };
}

function buildSnapshotHealthRecord(workflow, targetDateKey, checkedAt) {
  const snapshot = workflow.todaySnapshot || {};
  const expectedWordCount = getExpectedDailyWordCount(targetDateKey);
  const reasons = [];
  if (snapshot.dateKey !== targetDateKey) reasons.push('snapshot_date_mismatch');
  if (snapshot.words.length !== expectedWordCount) reasons.push('snapshot_word_count_incomplete');
  return {
    kind: 'today-snapshot',
    targetDateKey,
    status: reasons.length ? 'unhealthy' : 'healthy',
    reasons,
    checkedAt,
    expectedWordCount,
    wordCount: snapshot.words.length,
    source: String(snapshot.source || 'missing')
  };
}

export async function runDailyOperationsHealthCheck(env, options = {}) {
  if (!env.FAVORITES) throw new Error('daily health check requires FAVORITES storage');
  const kind = options.kind === 'tomorrow-draft' ? 'tomorrow-draft' : 'today-snapshot';
  const now = options.now instanceof Date ? options.now : new Date();
  const checkedAt = now.toISOString();
  const currentDateKey = dateKey(now);
  const targetDateKey = kind === 'tomorrow-draft' ? addDays(currentDateKey, 1) : currentDateKey;
  const key = dailyHealthStorageKey(kind, targetDateKey);
  const previous = await env.FAVORITES.get(key, 'json');
  const record = kind === 'tomorrow-draft'
    ? buildDraftHealthRecord(
      await env.FAVORITES.get(getCodexDraftStorageKey(targetDateKey), 'json'),
      targetDateKey,
      checkedAt
    )
    : buildSnapshotHealthRecord(
      cleanStoredWorkflow(await env.FAVORITES.get('favorites:global', 'json')),
      targetDateKey,
      checkedAt
    );

  const previousAttemptMs = Date.parse(String(previous?.lastNotificationAttemptAt || ''));
  const notificationDue = record.status === 'unhealthy'
    && (!Number.isFinite(previousAttemptMs) || now.getTime() - previousAttemptMs >= DAILY_HEALTH_NOTIFICATION_COOLDOWN_MS);
  const recoveryDue = record.status === 'healthy' && previous?.status === 'unhealthy';
  let notification = {
    configured: Boolean(cleanAlertUrl(env.OPS_ALERT_WEBHOOK_URL)),
    sent: false,
    error: '',
    skipped: true
  };
  let lastNotificationAttemptAt = String(previous?.lastNotificationAttemptAt || '');
  if (notificationDue || recoveryDue) {
    notification = {
      ...(await sendOperationsAlert(env, record, options)),
      skipped: false
    };
    lastNotificationAttemptAt = checkedAt;
  }
  const storedRecord = {
    ...record,
    previousStatus: String(previous?.status || ''),
    lastNotificationAttemptAt,
    notification
  };
  await env.FAVORITES.put(key, JSON.stringify(storedRecord), {
    expirationTtl: DAILY_HEALTH_TTL_SECONDS
  });
  if (record.status === 'unhealthy') {
    throw new Error(`daily ${record.kind} health check failed for ${targetDateKey}: ${record.reasons.join(', ')}`);
  }
  return storedRecord;
}

async function requireScheduledSuccess(label, promise) {
  const result = await promise;
  if (!result?.ok) {
    const reason = result?.reason || result?.error || `HTTP ${result?.status || 0}`;
    throw new Error(`${label} failed: ${reason}`);
  }
  return result;
}

export async function triggerDailyPublishOrFallback(env, fetchImpl = fetch) {
  const siteUrl = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  const autoRefreshSecret = String(env.AUTO_REFRESH_SECRET || '').trim();
  if (!siteUrl || !autoRefreshSecret) {
    console.warn('daily publish skipped because SITE_URL or AUTO_REFRESH_SECRET is missing');
    return { ok: false, source: 'skipped' };
  }

  const targetDateKey = dateKey(new Date());
  const codexUrl = new URL(`${siteUrl}/codex-daily`);
  codexUrl.searchParams.set('date', targetDateKey);
  try {
    const codexResponse = await fetchImpl(codexUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${autoRefreshSecret}`
      },
      body: JSON.stringify({ action: 'promote', targetDateKey })
    });
    const result = await codexResponse.json().catch(() => null);
    if (codexResponse.ok && result?.published) {
      console.log('Codex daily draft promoted', targetDateKey, result.source || 'codex_draft');
      return { ok: true, source: 'codex', status: codexResponse.status };
    }
    console.warn('Codex daily draft unavailable; using DeepSeek fallback', codexResponse.status, result?.error?.code || 'UNKNOWN');
  } catch (error) {
    console.warn('Codex daily draft promotion failed; using DeepSeek fallback', error?.message || error);
  }

  const refreshUrl = new URL(`${siteUrl}/daily-refresh`);
  refreshUrl.searchParams.set('mode', 'manual');
  refreshUrl.searchParams.set('runInline', 'true');
  refreshUrl.searchParams.set('skipCards', 'true');
  const response = await fetchImpl(refreshUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${autoRefreshSecret}`
    },
    body: JSON.stringify({ action: 'scheduled_fallback', targetDateKey })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false || result?.queued === true || result?.status === 'failed') {
    const reason = result?.error?.code || result?.error || result?.status || 'daily_refresh_failed';
    console.warn('daily refresh did not complete', response.status, reason);
    return {
      ok: false,
      source: 'deepseek',
      status: response.status,
      reason: String(reason).slice(0, 200)
    };
  }
  console.log('daily refresh completed', response.status, result?.status || 'completed');
  return {
    ok: true,
    source: 'deepseek',
    status: response.status,
    refreshStatus: String(result?.status || 'completed')
  };
}

export async function triggerCodexPromotionIfAvailable(env, fetchImpl = fetch) {
  const siteUrl = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  const autoRefreshSecret = String(env.AUTO_REFRESH_SECRET || '').trim();
  if (!siteUrl || !autoRefreshSecret || !env.FAVORITES) {
    console.warn('late Codex promotion skipped because required configuration is missing');
    return { ok: false, source: 'skipped', reason: 'configuration_missing' };
  }

  const targetDateKey = dateKey(new Date());
  const draftKey = getCodexDraftStorageKey(targetDateKey);
  const draft = await env.FAVORITES.get(draftKey, 'json');
  if (!draft) return { ok: true, source: 'skipped', reason: 'draft_missing', targetDateKey };
  if (draft.status === 'published' || draft.publishedAt) {
    return { ok: true, source: 'skipped', reason: 'already_published', targetDateKey };
  }
  if (draft.status !== 'valid' || !draft.validation?.valid) {
    return { ok: true, source: 'skipped', reason: 'draft_not_valid', targetDateKey };
  }

  const codexUrl = new URL(`${siteUrl}/codex-daily`);
  codexUrl.searchParams.set('date', targetDateKey);
  try {
    const response = await fetchImpl(codexUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${autoRefreshSecret}`
      },
      body: JSON.stringify({ action: 'promote', targetDateKey })
    });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.published) {
      console.log('late Codex draft promoted', targetDateKey, Boolean(result.alreadyPublished));
      return {
        ok: true,
        source: 'codex',
        status: response.status,
        targetDateKey,
        alreadyPublished: Boolean(result.alreadyPublished)
      };
    }
    console.warn('late Codex promotion unavailable', targetDateKey, response.status, result?.error?.code || 'UNKNOWN');
    return {
      ok: false,
      source: 'codex',
      status: response.status,
      targetDateKey,
      reason: result?.error?.code || 'promotion_failed'
    };
  } catch (error) {
    console.warn('late Codex promotion failed', targetDateKey, error?.message || error);
    return { ok: false, source: 'codex', status: 0, targetDateKey, reason: 'network_error' };
  }
}

async function triggerTodayAiCardBatch(env) {
  const siteUrl = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  const autoRefreshSecret = String(env.AUTO_REFRESH_SECRET || '').trim();
  if (!siteUrl || !autoRefreshSecret) {
    console.warn('ai card batch skipped because SITE_URL or AUTO_REFRESH_SECRET is missing');
    return;
  }

  const cardsUrl = new URL(`${siteUrl}/ai-cards`);
  const statusResponse = await fetch(cardsUrl.toString(), {
    headers: { Authorization: `Bearer ${autoRefreshSecret}` }
  });
  if (!statusResponse.ok) {
    const text = await readLimitedText(statusResponse);
    console.warn('ai card batch status returned non-OK', statusResponse.status, text);
    return;
  }

  const status = await statusResponse.json().catch(() => null);
  const plan = getTodayAiCardBatchPlan(status);
  console.log('ai card batch status', plan);

  if (!plan.shouldRun) {
    if (plan.activePendingCount > 0) {
      console.warn('ai card batch skipped because cards are actively pending', plan);
    }
    return;
  }

  const response = await fetch(cardsUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${autoRefreshSecret}`
    },
    body: JSON.stringify({
      mode: 'today',
      maxWords: AI_CARD_BATCH_MAX_WORDS,
      retryStalePending: plan.retryStalePending,
      retryFailed: plan.retryFailed,
      words: plan.targetWords
    })
  });
  if (!response.ok) {
    const text = await readLimitedText(response);
    console.warn('ai card batch returned non-OK', response.status, text);
    return;
  }

  const result = await response.json().catch(() => ({}));
  console.log('ai card batch completed', {
    status: response.status,
    savedCount: Number.parseInt(result?.savedCount, 10) || 0,
    missingCount: plan.missingCount,
    readyCount: plan.readyCount,
    stalePendingCount: plan.stalePendingCount,
    retryableFailedCount: plan.retryableFailedCount
  });
}

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function cleanWords(words) {
  if (!Array.isArray(words)) return [];
  return [...new Set(
    words
      .filter(word => typeof word === 'string')
      .map(word => word.trim())
      .filter(Boolean)
      .map(word => word.slice(0, 80))
  )].slice(0, 500);
}

function cleanStatus(status) {
  return ['pending', 'published'].includes(status) ? status : 'none';
}

function cleanFeedback(feedback) {
  return Object.entries(feedback || {}).reduce((result, [word, record]) => {
    const cleanWord = String(word || '').trim().slice(0, 80);
    if (!cleanWord) return result;
    const reasons = Object.entries(record?.reasons || {}).reduce((reasonResult, [reason, count]) => {
      if (!['uninterested', 'tooBasic', 'tooTextbook', 'notForXhs', 'inaccurate'].includes(reason)) return reasonResult;
      const cleanCount = Math.max(0, Math.min(50, Number.parseInt(count, 10) || 0));
      if (cleanCount > 0) reasonResult[reason] = cleanCount;
      return reasonResult;
    }, {});
    result[cleanWord] = {
      reasons,
      lastReason: ['uninterested', 'tooBasic', 'tooTextbook', 'notForXhs', 'inaccurate'].includes(record?.lastReason) ? record.lastReason : '',
      updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
      needsReview: Boolean(record?.needsReview || reasons.inaccurate)
    };
    return result;
  }, {});
}

function cleanStats(stats) {
  return {
    likes: Math.max(0, Number.parseInt(stats?.likes, 10) || 0),
    favorites: Math.max(0, Number.parseInt(stats?.favorites, 10) || 0),
    comments: Math.max(0, Number.parseInt(stats?.comments, 10) || 0),
    shares: Math.max(0, Number.parseInt(stats?.shares, 10) || 0),
    views: Math.max(0, Number.parseInt(stats?.views, 10) || 0)
  };
}

function cleanAutoRefreshState(state = {}) {
  return {
    status: ['idle', 'success', 'failed', 'partial'].includes(state?.status) ? state.status : 'idle',
    lastAttemptAt: typeof state?.lastAttemptAt === 'string' ? state.lastAttemptAt : '',
    lastSuccessAt: typeof state?.lastSuccessAt === 'string' ? state.lastSuccessAt : '',
    lastMessage: String(state?.lastMessage || '').trim().slice(0, 1000),
    source: ['remote', 'text'].includes(state?.source) ? state.source : '',
    updatedFields: Array.isArray(state?.updatedFields)
      ? [...new Set(state.updatedFields.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20)
      : []
  };
}

function cleanSnapshots(snapshots) {
  const nodeTypes = ['1h', '2h', '4h', '24h', '72h'];
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  return nodeTypes.map(nodeType => {
    const matched = safeSnapshots.find(snapshot => snapshot?.nodeType === nodeType) || { nodeType };
    return {
      nodeType,
      ...cleanStats(matched),
      capturedAt: typeof matched?.capturedAt === 'string' ? matched.capturedAt : '',
      source: matched?.source === 'auto' ? 'auto' : 'manual'
    };
  });
}

function cleanPublishedRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.slice(0, 1000).map((record, index) => ({
    id: String(record?.id || `record_${index}`).trim().slice(0, 120),
    word: String(record?.word || '').trim().slice(0, 80),
    link: String(record?.link || '').trim().slice(0, 1000),
    title: String(record?.title || '').trim().slice(0, 200),
    description: String(record?.description || '').trim().slice(0, 4000),
    contentType: ['图文', '视频', '其他'].includes(record?.contentType) ? record.contentType : '图文',
    authorName: String(record?.authorName || '').trim().slice(0, 120),
    publishedAt: typeof record?.publishedAt === 'string' ? record.publishedAt : '',
    latestStats: cleanStats(record?.latestStats || record),
    snapshots: cleanSnapshots(record?.snapshots),
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
    rating: String(record?.rating || '').trim().slice(0, 40),
    performanceReason: Array.isArray(record?.performanceReason)
      ? record.performanceReason.filter(item => ['wordMismatch', 'titleProblem', 'coverProblem', 'contentProblem', 'timingProblem', 'lowExposure', 'dataAbnormal', 'observing'].includes(item)).slice(0, 8)
      : [],
    performanceNote: String(record?.performanceNote || '').trim().slice(0, 1000),
    remarks: String(record?.remarks || '').trim().slice(0, 2000),
    sourceStatus: record?.sourceStatus === 'placeholder' ? 'placeholder' : 'record',
    autoRefresh: cleanAutoRefreshState(record?.autoRefresh)
  })).filter(record => record.word || record.link || record.title);
}

function cleanCandidateScoreBreakdown(breakdown = {}) {
  return {
    platformHeatScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.platformHeatScore, 10) || 0)),
    accountFitScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.accountFitScore, 10) || 0)),
    contentValueScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.contentValueScore, 10) || 0)),
    dataFeedbackScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.dataFeedbackScore, 10) || 0)),
    referenceQualityScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.referenceQualityScore, 10) || 0)),
    confidenceWeightScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.confidenceWeightScore, 10) || 0)),
    extensionBoost: Math.max(-30, Math.min(30, Number.parseInt(breakdown?.extensionBoost, 10) || 0)),
    feedbackPenalty: Math.max(0, Math.min(100, Number.parseInt(breakdown?.feedbackPenalty, 10) || 0)),
    duplicatePenalty: Math.max(0, Math.min(100, Number.parseInt(breakdown?.duplicatePenalty, 10) || 0)),
    finalScore: Math.max(0, Math.min(100, Number.parseInt(breakdown?.finalScore, 10) || 0))
  };
}

const PURE_KANJI_RE = /^[\u3400-\u9fff々ヶ]+$/;

function cleanCandidatePoolEntry(kanji, entry = {}) {
  const cleanWord = String(kanji || '').trim().slice(0, 80);
  if (!cleanWord || PURE_KANJI_RE.test(cleanWord)) return null;
  return {
    kanji: cleanWord,
    sourceTags: Array.isArray(entry.sourceTags) ? [...new Set(entry.sourceTags.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 12) : [],
    extensionFrom: Array.isArray(entry.extensionFrom) ? [...new Set(entry.extensionFrom.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 12) : [],
    firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : null,
    lastScoredAt: typeof entry.lastScoredAt === 'string' ? entry.lastScoredAt : null,
    lastRecommendedAt: typeof entry.lastRecommendedAt === 'string' ? entry.lastRecommendedAt : null,
    lastScore: Math.max(0, Math.min(100, Number.parseInt(entry.lastScore, 10) || 0)),
    recommendationCount: Math.max(0, Math.min(9999, Number.parseInt(entry.recommendationCount, 10) || 0)),
    ignoredCount: Math.max(0, Math.min(9999, Number.parseInt(entry.ignoredCount, 10) || 0)),
    wasRecommended: Boolean(entry.wasRecommended),
    historicalBackfill: Boolean(entry.historicalBackfill),
    lastDecayAt: typeof entry.lastDecayAt === 'string' ? entry.lastDecayAt : '',
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : '',
    lastOrigin: ['today', 'history', 'pool', 'favorite', 'lookup'].includes(entry?.lastOrigin) ? entry.lastOrigin : 'pool',
    lastConfidenceLevel: ['high', 'medium', 'low', 'review'].includes(entry?.lastConfidenceLevel) ? entry.lastConfidenceLevel : 'medium',
    lastReviewState: ['ready', 'watch', 'review'].includes(entry?.lastReviewState) ? entry.lastReviewState : 'watch',
    lastReviewNote: String(entry?.lastReviewNote || '').trim().slice(0, 240),
    manualReviewState: ['ready', 'watch', 'review', ''].includes(String(entry?.manualReviewState || '')) ? String(entry?.manualReviewState || '') : '',
    manualReviewNote: String(entry?.manualReviewNote || '').trim().slice(0, 240),
    lastBreakdown: cleanCandidateScoreBreakdown(entry?.lastBreakdown || {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null
  };
}

function cleanCandidatePool(pool) {
  return Object.entries(pool || {}).reduce((result, [kanji, entry]) => {
    const cleanEntry = cleanCandidatePoolEntry(kanji, entry);
    if (cleanEntry) result[cleanEntry.kanji] = cleanEntry;
    return result;
  }, {});
}

function cleanStoredData(data) {
  return cleanStoredWorkflow(data);
}

function getStorageKey(url) {
  const code = cleanSyncCode(url.searchParams.get('code'));
  return code.length >= 8 ? `favorites:${code}` : 'favorites:global';
}

function getRankingStorageKey(dateKeyValue) {
  return `rankings:${dateKeyValue}`;
}

async function refreshWorkflowPublishedData(env, key, data, options = {}) {
  const result = await refreshPublishedRecords(data.publishedRecords, {
    recordId: options.recordId || '',
    fetchImpl: fetch,
    now: new Date()
  });
  const persistedCovers = await persistPublishedRecordCovers(result.records, env, {
    recordId: options.recordId || '',
    fetchImpl: fetch,
    nowIso: new Date().toISOString()
  });
  const nextData = mergeWorkflow(data, {
    publishedRecords: cleanWorkflowPublishedRecords(persistedCovers.records),
    updated: new Date().toISOString()
  });
  const mutation = await commitWorkflowMutation(env, key, nextData, options.mutationMetadata || {
    operationId: crypto.randomUUID(),
    expectedRevision: null,
    action: 'scheduled.published-refresh',
    actor: 'scheduled-worker',
    target: options.recordId || '',
    summary: `更新 ${result.summary?.updated || 0} 条发布数据`
  }, { strategy: 'merge' });
  return {
    data: mutation.workflow,
    summary: result.summary,
    coverSummary: persistedCovers.summary,
    mutation
  };
}

async function readStoredSelections(env, startDateKey, endDateKey) {
  const selections = new Map();
  let cursor = startDateKey;
  while (cursor) {
    const stored = await env.FAVORITES.get(getRankingStorageKey(cursor), 'json');
    const ranking = cleanStoredRanking(stored, cursor);
    if (isStoredDailyWordCount(ranking.words.length)) selections.set(cursor, ranking.words);
    if (cursor === endDateKey) break;
    cursor = addDays(cursor, 1);
  }
  return selections;
}

async function ensureRankings(env, requestedDays) {
  const todayDateKey = dateKey();
  const earliestRequestedDateKey = addDays(todayDateKey, -(requestedDays - 1));
  const generationStartDateKey = addDays(earliestRequestedDateKey, -15);
  const cachedSelections = await readStoredSelections(env, generationStartDateKey, todayDateKey);
  const responseDays = [];
  let cursor = generationStartDateKey;

  while (cursor) {
    let words = cachedSelections.get(cursor);
    if (!words || !isStoredDailyWordCount(words.length)) {
      words = buildRankingForDate(cursor, cachedSelections);
      cachedSelections.set(cursor, words);
      await env.FAVORITES.put(getRankingStorageKey(cursor), JSON.stringify({
        dateKey: cursor,
        words,
        updated: new Date().toISOString()
      }));
    }

    if (cursor >= earliestRequestedDateKey) {
      responseDays.push({
        dateKey: cursor,
        words,
        updated: null
      });
    }

    if (cursor === todayDateKey) break;
    cursor = addDays(cursor, 1);
  }

  return {
    todayKey: todayDateKey,
    days: responseDays.reverse()
  };
}

export default {
  async fetch(request, env) {
    const methods = ['GET', 'POST', 'PUT', 'OPTIONS'];
    const requestId = getRequestId(request);
    const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
    const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods, requestId });

    try {
    if (request.method === 'OPTIONS') {
      return optionsResponse(request, env, methods);
    }

    if (!env.FAVORITES) {
      return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');
    }

    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return respond({ ok: true, service: 'japanese-words-sync', scheduledOnly: true });
    }
    if (String(env.ENABLE_LEGACY_WORKER_API || '').toLowerCase() !== 'true') {
      return fail(410, 'LEGACY_API_DISABLED', 'Worker 直连接口已停用，请使用 Cloudflare Pages Functions');
    }

    const authorization = await authorizeRequest(request, env, { allowAutomation: true });
    if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });
    if (url.pathname === '/rankings') {
      if (request.method !== 'GET') {
        return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      const requestedDays = cleanRankingsDays(url.searchParams.get('days'), 8);
      const data = await ensureRankings(env, requestedDays);
      return respond(data);
    }

    if (url.pathname === '/published-refresh') {
      if (request.method !== 'POST') {
        return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.published });
      if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
      const body = parsed.value;
      const key = getStorageKey(url);
      const stored = await env.FAVORITES.get(key, 'json');
      const current = cleanStoredData(stored);
      const mutationMetadata = getWorkflowMutationMetadata(request, body, {
        action: 'published.refresh',
        actor: authorization.actor,
        target: String(body?.recordId || '').trim(),
        summary: '刷新发布数据'
      });
      const inspection = inspectWorkflowMutation(current, mutationMetadata);
      if (inspection.conflict) {
        return respond({
          ok: false,
          error: { code: 'REVISION_CONFLICT', message: '团队数据已被其他人更新，请刷新后重试', retryable: true },
          currentRevision: inspection.currentRevision
        }, 409);
      }
      if (inspection.duplicate) {
        return respond({
          publishedRecords: current.publishedRecords,
          summary: { updated: 0, failed: 0, skipped: current.publishedRecords.length },
          revision: current.revision,
          mutation: { duplicate: true, operationId: inspection.event?.id || '' }
        });
      }
      const workingRecords = Array.isArray(body?.publishedRecords) && body.publishedRecords.length
        ? cleanWorkflowPublishedRecords(body.publishedRecords)
        : current.publishedRecords;
      const refreshed = await refreshWorkflowPublishedData(env, key, {
        ...current,
        publishedRecords: workingRecords
      }, {
        recordId: String(body?.recordId || '').trim(),
        mutationMetadata
      });
      return respond({
        publishedRecords: refreshed.data.publishedRecords,
        summary: refreshed.summary,
        updated: refreshed.data.updated,
        revision: refreshed.data.revision,
        mutation: { duplicate: refreshed.mutation.duplicate, operationId: refreshed.mutation.event?.id || '' }
      });
    }

    if (url.pathname !== '/favorites') {
      return fail(404, 'NOT_FOUND', 'Not found');
    }

    const key = getStorageKey(url);

    if (request.method === 'GET') {
      const stored = await env.FAVORITES.get(key, 'json');
      return respond(cleanStoredData(stored));
    }

    if (request.method === 'PUT') {
      const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.workflow });
      if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
      const body = parsed.value;

      const stored = await env.FAVORITES.get(key, 'json');
      const current = cleanStoredWorkflow(stored);
      const data = mergeWorkflowForFullSave(current, {
        ...body,
        updated: new Date().toISOString()
      });
      const mutation = await commitWorkflowMutation(env, key, data, getWorkflowMutationMetadata(request, body, {
        action: 'workflow.replace',
        actor: authorization.actor,
        summary: '保存完整团队工作流'
      }), { strategy: 'full-save' });
      if (mutation.conflict) {
        return respond({
          ok: false,
          error: { code: 'REVISION_CONFLICT', message: '团队数据已被其他人更新，请刷新后重试', retryable: true },
          currentRevision: mutation.currentRevision
        }, 409);
      }
      return respond({
        ...mutation.workflow,
        mutation: { duplicate: mutation.duplicate, operationId: mutation.event?.id || '' }
      });
    }

    if (request.method === 'POST') {
      const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.command });
      if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
      const body = parsed.value;

      const word = cleanWords([body.word])[0];
      if (!word) return fail(400, 'INVALID_WORD', 'Invalid word');
      if (!['add', 'remove', 'status'].includes(body.action)) return fail(400, 'INVALID_ACTION', 'Invalid action');

      const command = {
        action: body.action,
        word,
        status: cleanStatus(body.status),
        candidatePool: body?.candidatePool?.[word] ? { [word]: body.candidatePool[word] } : {}
      };
      const metadata = getWorkflowMutationMetadata(request, body, {
        action: `favorite.${body.action}`,
        actor: authorization.actor,
        target: word,
        summary: body.action === 'status' ? `状态更新为 ${cleanStatus(body.status)}` : ''
      });
      const mutation = await commitWorkflowMutation(env, key, command, {
        ...metadata,
        expectedRevision: null
      }, { strategy: 'favorite-command' });
      if (mutation.conflict) {
        return respond({
          ok: false,
          error: { code: 'REVISION_CONFLICT', message: '团队数据已被其他人更新，请刷新后重试', retryable: true },
          currentRevision: mutation.currentRevision
        }, 409);
      }
      return respond({
        ...mutation.workflow,
        mutation: { duplicate: mutation.duplicate, operationId: mutation.event?.id || '' }
      });
    }

    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    } catch (error) {
      console.error(JSON.stringify({
        event: 'worker_http_error',
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        errorName: String(error?.name || 'Error').slice(0, 120)
      }));
      return fail(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  },

  async scheduled(controller, env, ctx) {
    const cron = String(controller?.cron || '').trim();
    if (cron === DAILY_REFRESH_CRON) {
      ctx.waitUntil(
        requireScheduledSuccess('daily publish', triggerDailyPublishOrFallback(env))
      );
    }

    if (cron === DAILY_DRAFT_HEALTH_CRON) {
      ctx.waitUntil(runDailyOperationsHealthCheck(env, { kind: 'tomorrow-draft' }));
    }

    if (cron === DAILY_SNAPSHOT_HEALTH_CRON) {
      ctx.waitUntil(runDailyOperationsHealthCheck(env, { kind: 'today-snapshot' }));
    }

    if (cron === CODEX_LATE_PROMOTION_CRON) {
      ctx.waitUntil(
        triggerCodexPromotionIfAvailable(env).catch(error => console.warn('late Codex promotion failed', error?.message || error))
      );
    }

    if (AI_CARD_BATCH_CRONS.has(cron)) {
      ctx.waitUntil(
        triggerTodayAiCardBatch(env).catch(error => console.warn('ai card batch failed', error?.message || error))
      );
    }

    if (!env.FAVORITES || cron !== PUBLISHED_REFRESH_CRON) return;
    let cursor;
    do {
      const listed = await env.FAVORITES.list({ prefix: 'favorites:', cursor });
      for (const keyInfo of listed.keys) {
        const key = keyInfo.name;
        const stored = await env.FAVORITES.get(key, 'json');
        const current = cleanStoredData(stored);
        if (!current.publishedRecords.length) continue;
        ctx.waitUntil(refreshWorkflowPublishedData(env, key, current));
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }
};

import { refreshPublishedRecords } from '../shared/published-refresh.mjs';
import {
  cleanPublishedRecords as cleanWorkflowPublishedRecords,
  cleanStoredWorkflow,
  mergeWorkflow
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
import {
  getWorkflowMutationMetadata,
  inspectWorkflowMutation
} from '../shared/workflow-mutation.mjs';
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';
import { persistPublishedRecordCovers } from './published-cover.js';

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

function cleanStatuses(statuses, words) {
  const allowedWords = new Set(cleanWords(words));
  return Object.entries(statuses || {}).reduce((result, [word, status]) => {
    const cleanWord = String(word || '').trim().slice(0, 80);
    const cleanStatusValue = cleanStatus(status);
    if (allowedWords.has(cleanWord) && cleanStatusValue !== 'none') result[cleanWord] = cleanStatusValue;
    return result;
  }, {});
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

const PURE_KANJI_RE = /^[\u3400-\u9fff々ヶ]+$/;

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
    lastBreakdown: {
      platformHeatScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.platformHeatScore, 10) || 0)),
      accountFitScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.accountFitScore, 10) || 0)),
      contentValueScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.contentValueScore, 10) || 0)),
      dataFeedbackScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.dataFeedbackScore, 10) || 0)),
      referenceQualityScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.referenceQualityScore, 10) || 0)),
      confidenceWeightScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.confidenceWeightScore, 10) || 0)),
      extensionBoost: Math.max(-30, Math.min(30, Number.parseInt(entry?.lastBreakdown?.extensionBoost, 10) || 0)),
      feedbackPenalty: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.feedbackPenalty, 10) || 0)),
      duplicatePenalty: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.duplicatePenalty, 10) || 0)),
      finalScore: Math.max(0, Math.min(100, Number.parseInt(entry?.lastBreakdown?.finalScore, 10) || 0))
    },
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

export async function onRequest({ request, env }) {
  const methods = ['POST', 'OPTIONS'];
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods, requestId });

  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env, methods);
  }

  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  if (!env.FAVORITES) {
    return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');
  }

  const authorization = await authorizeRequest(request, env, { allowAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });

  const url = new URL(request.url);
  const key = getStorageKey(url);
  const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.published });
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
  const body = parsed.value;
  const stored = await env.FAVORITES.get(key, 'json');
  const current = cleanStoredData(stored);
  const mutationMetadata = getWorkflowMutationMetadata(request, body, {
    action: 'published.refresh',
    actor: authorization.actor,
    target: String(body?.recordId || '').trim()
  });
  const inspection = inspectWorkflowMutation(current, mutationMetadata);
  if (inspection.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '发布记录已被其他人更新，请刷新后重试', retryable: true },
      currentRevision: inspection.currentRevision
    }, 409);
  }
  if (inspection.duplicate) {
    return respond({
      ok: true,
      publishedRecords: current.publishedRecords,
      summary: { total: 0, successCount: 0, failureCount: 0, message: '重复请求已忽略' },
      updated: current.updated,
      revision: current.revision,
      mutation: { duplicate: true, operationId: inspection.event?.id || '' }
    });
  }
  const workingRecords = Array.isArray(body?.publishedRecords) && body.publishedRecords.length
    ? cleanWorkflowPublishedRecords(body.publishedRecords)
    : current.publishedRecords;

  const result = await refreshPublishedRecords(workingRecords, {
    recordId: String(body?.recordId || '').trim(),
    fetchImpl: fetch,
    now: new Date()
  });
  const persistedCovers = await persistPublishedRecordCovers(result.records, env, {
    recordId: String(body?.recordId || '').trim(),
    fetchImpl: fetch,
    nowIso: new Date().toISOString()
  });

  const merged = mergeWorkflow(current, {
    publishedRecords: cleanWorkflowPublishedRecords(persistedCovers.records),
    updated: new Date().toISOString()
  });
  const mutation = await commitWorkflowMutation(env, key, merged, {
    ...mutationMetadata,
    summary: `成功 ${result.summary.successCount}，失败 ${result.summary.failureCount}`
  }, { strategy: 'merge' });
  if (mutation.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '发布记录已被其他人更新，请刷新后重试', retryable: true },
      currentRevision: mutation.currentRevision
    }, 409);
  }
  const nextData = mutation.workflow;

  return respond({
    ok: true,
    publishedRecords: nextData.publishedRecords,
    summary: result.summary,
    coverSummary: persistedCovers.summary,
    updated: nextData.updated,
    revision: nextData.revision,
    mutation: { duplicate: mutation.duplicate, operationId: mutation.event?.id || '' }
  });
}

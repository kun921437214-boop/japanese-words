import {
  addDays,
  buildRankingForDate,
  cleanRankingsDays,
  cleanStoredRanking,
  dateKey
} from '../shared/rankings.mjs';
import { refreshPublishedRecords } from '../shared/published-refresh.mjs';
import {
  cleanStoredWorkflow,
  mergeWorkflow,
  mergeWorkflowForFullSave
} from '../shared/workflow-schema.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const DAILY_REFRESH_CRON = '0 16 * * *';
const AI_CARD_BATCH_CRONS = new Set([
  '10,20,30,40,50 16 * * *',
  '0 17 * * *'
]);
const AI_CARD_BATCH_MAX_WORDS = 5;
const GLOBAL_FAVORITES_KEY = 'favorites:global';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

async function readLimitedText(response, maxLength = 500) {
  const text = await response.text().catch(() => '');
  return text.slice(0, maxLength);
}

async function writeDailyRefreshTriggerState(env, patch = {}) {
  if (!env.FAVORITES) return;
  try {
    const now = new Date().toISOString();
    const current = cleanStoredWorkflow(await env.FAVORITES.get(GLOBAL_FAVORITES_KEY, 'json'));
    const next = cleanStoredWorkflow({
      ...current,
      dailyRefreshTrigger: {
        ...(current.dailyRefreshTrigger || {}),
        ...patch,
        updatedAt: now
      },
      updated: current.updated || now
    });
    await env.FAVORITES.put(GLOBAL_FAVORITES_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('daily refresh trigger state write failed', error?.message || error);
  }
}

async function triggerDailyRefresh(env, options = {}) {
  const siteUrl = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  const autoRefreshSecret = String(env.AUTO_REFRESH_SECRET || '').trim();
  const triggeredAt = new Date().toISOString();
  const triggerBase = {
    dateKey: dateKey(new Date()),
    triggeredAt,
    cron: String(options.cron || DAILY_REFRESH_CRON),
    siteUrlConfigured: Boolean(siteUrl),
    autoRefreshSecretConfigured: Boolean(autoRefreshSecret)
  };
  if (!siteUrl || !autoRefreshSecret) {
    console.warn('daily refresh trigger skipped because SITE_URL or AUTO_REFRESH_SECRET is missing');
    await writeDailyRefreshTriggerState(env, {
      ...triggerBase,
      status: 'skipped',
      reason: 'missing_config',
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const refreshUrl = new URL(`${siteUrl}/daily-refresh`);
  refreshUrl.searchParams.set('mode', 'manual');
  refreshUrl.searchParams.set('skipCards', 'true');
  await writeDailyRefreshTriggerState(env, {
    ...triggerBase,
    status: 'running',
    endpoint: refreshUrl.toString()
  });
  try {
    const response = await fetch(refreshUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${autoRefreshSecret}`
      }
    });
    const text = await readLimitedText(response);
    if (!response.ok) {
      console.warn('daily refresh trigger returned non-OK', response.status, text);
      await writeDailyRefreshTriggerState(env, {
        ...triggerBase,
        status: 'failed',
        reason: 'non_ok_response',
        endpoint: refreshUrl.toString(),
        httpStatus: response.status,
        responseText: text,
        finishedAt: new Date().toISOString()
      });
      return;
    }
    await writeDailyRefreshTriggerState(env, {
      ...triggerBase,
      status: 'accepted',
      reason: 'request_accepted',
      endpoint: refreshUrl.toString(),
      httpStatus: response.status,
      responseText: text,
      finishedAt: new Date().toISOString()
    });
    console.log('daily refresh trigger completed', response.status);
  } catch (error) {
    await writeDailyRefreshTriggerState(env, {
      ...triggerBase,
      status: 'failed',
      reason: 'request_error',
      endpoint: refreshUrl.toString(),
      error: error?.message || 'daily refresh trigger failed',
      finishedAt: new Date().toISOString()
    });
    throw error;
  }
}

async function triggerTodayAiCardBatch(env) {
  const siteUrl = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (!siteUrl) {
    console.warn('ai card batch skipped because SITE_URL is missing');
    return;
  }

  const cardsUrl = new URL(`${siteUrl}/ai-cards`);
  const statusResponse = await fetch(cardsUrl.toString());
  if (!statusResponse.ok) {
    const text = await readLimitedText(statusResponse);
    console.warn('ai card batch status returned non-OK', statusResponse.status, text);
    return;
  }

  const status = await statusResponse.json().catch(() => null);
  const readyCount = Number.parseInt(status?.readyCount, 10) || 0;
  const missingCount = Number.parseInt(status?.missingCount, 10) || 0;
  const pendingCount = Number.parseInt(status?.pendingCount, 10) || 0;
  console.log('ai card batch status', {
    readyCount,
    missingCount,
    pendingCount,
    currentDateKey: status?.currentDateKey || '',
    todaySnapshotDateKey: status?.todaySnapshot?.dateKey || '',
    isStaleTodaySnapshot: Boolean(status?.isStaleTodaySnapshot)
  });

  if (status?.isStaleTodaySnapshot) {
    console.warn('ai card batch skipped because todaySnapshot is stale', {
      currentDateKey: status.currentDateKey || '',
      todaySnapshotDateKey: status.todaySnapshot?.dateKey || '',
      staleDays: Number.parseInt(status.staleDays, 10) || 0
    });
    return;
  }
  if (missingCount <= 0) return;
  if (pendingCount > 0) {
    console.warn('ai card batch skipped because cards are pending', { missingCount, pendingCount });
    return;
  }

  const response = await fetch(cardsUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mode: 'today',
      maxWords: AI_CARD_BATCH_MAX_WORDS
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
    missingCount,
    readyCount
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

function cleanStatuses(statuses, words) {
  const allowedWords = new Set(cleanWords(words));
  return Object.entries(statuses || {}).reduce((result, [word, status]) => {
    const cleanWord = String(word || '').trim().slice(0, 80);
    const cleanStatusValue = cleanStatus(status);
    if (allowedWords.has(cleanWord) && cleanStatusValue !== 'none') {
      result[cleanWord] = cleanStatusValue;
    }
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
  const nextData = mergeWorkflow(data, {
    publishedRecords: cleanPublishedRecords(result.records),
    updated: new Date().toISOString()
  });
  await env.FAVORITES.put(key, JSON.stringify(nextData));
  return {
    data: nextData,
    summary: result.summary
  };
}

async function readStoredSelections(env, startDateKey, endDateKey) {
  const selections = new Map();
  let cursor = startDateKey;
  while (cursor) {
    const stored = await env.FAVORITES.get(getRankingStorageKey(cursor), 'json');
    const ranking = cleanStoredRanking(stored, cursor);
    if (ranking.words.length === 20) selections.set(cursor, ranking.words);
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
    if (!words || words.length !== 20) {
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

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!env.FAVORITES) {
      return jsonResponse({ error: 'KV namespace FAVORITES is not configured' }, 500);
    }

    const url = new URL(request.url);
    if (url.pathname === '/rankings') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }
      const requestedDays = cleanRankingsDays(url.searchParams.get('days'), 8);
      const data = await ensureRankings(env, requestedDays);
      return jsonResponse(data);
    }

    if (url.pathname === '/published-refresh') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }
      const body = await readJson(request);
      const key = getStorageKey(url);
      const stored = await env.FAVORITES.get(key, 'json');
      const current = cleanStoredData(stored);
      const workingRecords = Array.isArray(body?.publishedRecords) && body.publishedRecords.length
        ? cleanPublishedRecords(body.publishedRecords)
        : current.publishedRecords;
      const refreshed = await refreshWorkflowPublishedData(env, key, {
        ...current,
        publishedRecords: workingRecords
      }, {
        recordId: String(body?.recordId || '').trim()
      });
      return jsonResponse({
        publishedRecords: refreshed.data.publishedRecords,
        summary: refreshed.summary,
        updated: refreshed.data.updated
      });
    }

    if (url.pathname !== '/favorites') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    const key = getStorageKey(url);

    if (request.method === 'GET') {
      const stored = await env.FAVORITES.get(key, 'json');
      return jsonResponse(cleanStoredData(stored));
    }

    if (request.method === 'PUT') {
      const body = await readJson(request);
      if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);

      const stored = await env.FAVORITES.get(key, 'json');
      const current = cleanStoredWorkflow(stored);
      const data = mergeWorkflowForFullSave(current, {
        ...body,
        updated: new Date().toISOString()
      });

      await env.FAVORITES.put(key, JSON.stringify(data));
      return jsonResponse(data);
    }

    if (request.method === 'POST') {
      const body = await readJson(request);
      if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);

      const word = cleanWords([body.word])[0];
      if (!word) return jsonResponse({ error: 'Invalid word' }, 400);

      const stored = await env.FAVORITES.get(key, 'json');
      const current = cleanStoredData(stored);
      const currentWords = current.words;
      let words = currentWords;
      if (body.action === 'add') words = cleanWords([word, ...currentWords]);
      if (body.action === 'remove') words = currentWords.filter(item => item !== word);
      const statuses = cleanStatuses(current.statuses, words);
      if (body.action === 'remove') delete statuses[word];
      if (body.action === 'status' && currentWords.includes(word)) {
        const status = cleanStatus(body.status);
        if (status === 'none') delete statuses[word];
        else statuses[word] = status;
      }
      const data = cleanStoredWorkflow({
        ...current,
        words,
        statuses,
        feedback: body.feedback || current.feedback,
        publishedRecords: body.publishedRecords || current.publishedRecords,
        candidatePool: body.candidatePool || current.candidatePool,
        aiBatches: body.aiBatches || current.aiBatches,
        aiPreview: body.aiPreview || current.aiPreview,
        todaySnapshot: body.todaySnapshot || current.todaySnapshot,
        todayDismissed: body.todayDismissed || body.teamDismissed || current.todayDismissed,
        historySnapshots: body.historySnapshots || current.historySnapshots,
        todaySnapshotHistory: body.todaySnapshotHistory || current.todaySnapshotHistory,
        updated: new Date().toISOString()
      });

      await env.FAVORITES.put(key, JSON.stringify(data));
      return jsonResponse(data);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  },

  async scheduled(controller, env, ctx) {
    const cron = String(controller?.cron || '').trim();
    if (cron === DAILY_REFRESH_CRON) {
      ctx.waitUntil(
        triggerDailyRefresh(env, { cron }).catch(error => console.warn('daily refresh trigger failed', error?.message || error))
      );
    }

    if (AI_CARD_BATCH_CRONS.has(cron)) {
      ctx.waitUntil(
        triggerTodayAiCardBatch(env).catch(error => console.warn('ai card batch failed', error?.message || error))
      );
    }

    if (!env.FAVORITES || cron !== DAILY_REFRESH_CRON) return;
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

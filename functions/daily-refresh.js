import { dateKey } from '../shared/rankings.mjs';
import { cleanStoredWorkflow, generateTodaySnapshot } from '../shared/today-snapshot.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function buildCandidatePayload(workflow) {
  return {
    action: 'stable_today',
    input: '',
    count: 50,
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

async function callJsonEndpoint(origin, path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
  return data;
}

async function generateCandidates(origin, workflow) {
  const payload = buildCandidatePayload(workflow);
  const data = await callJsonEndpoint(origin, '/ai-candidates', payload);
  const batchId = `daily_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = getAiTraceFromUsage(data.usage || {}, payload);
  const items = safeArray(data.items).map(item => ({
    ...item,
    sourceType: 'deepseek_generated',
    sourcePromptType: 'stable_today',
    sourcePromptVersion: trace.promptVersion,
    sourceText: '',
    sourceTags: uniqueWords([...(item.sourceTags || []), 'DeepSeek', 'AI候选', '自动日更']),
    aiBatchId: batchId,
    updatedAt: nowIso()
  }));
  const batch = {
    id: batchId,
    action: 'stable_today',
    model: data.usage?.model || 'deepseek-v4-flash',
    createdAt: data.usage?.createdAt || nowIso(),
    itemCount: items.length,
    importedCount: 0,
    skippedCount: 0,
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
  return {
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(String(record.dateKey || '')) ? String(record.dateKey) : '',
    status: ['running', 'success', 'failed'].includes(record.status) ? record.status : '',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : '',
    error: cleanText(record.error, 500),
    generatedCandidates: Number.parseInt(record.generatedCandidates, 10) || 0,
    importedCandidates: Number.parseInt(record.importedCandidates, 10) || 0,
    todayCount: Number.parseInt(record.todayCount, 10) || 0,
    generatedCards: Number.parseInt(record.generatedCards, 10) || 0,
    queuedCards: Number.parseInt(record.queuedCards, 10) || 0
  };
}

async function readRefreshRunState(env, today) {
  return cleanRefreshRunState(await env.FAVORITES.get(getRefreshStateKey(today), 'json'));
}

async function writeRefreshRunState(env, today, state) {
  const cleanState = cleanRefreshRunState({
    ...state,
    dateKey: today
  });
  await env.FAVORITES.put(getRefreshStateKey(today), JSON.stringify(cleanState), { expirationTtl: 3 * 24 * 60 * 60 });
  return cleanState;
}

function isFreshRunningState(state) {
  if (state.status !== 'running' || !state.startedAt) return false;
  const startedAt = Date.parse(state.startedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt < 20 * 60 * 1000;
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

async function runDailyRefreshJob({ origin, env, key, today }) {
  try {
    const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    if (stored.todaySnapshot?.dateKey === today && safeArray(stored.todaySnapshot.words).length > 0) {
      return writeRefreshRunState(env, today, {
        status: 'success',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        generatedCandidates: 0,
        importedCandidates: 0,
        todayCount: stored.todaySnapshot.words.length,
        generatedCards: 0,
        queuedCards: 0
      });
    }

    const generated = await generateCandidates(origin, stored);
    const workflowWithBatch = cleanStoredWorkflow({
      ...stored,
      aiBatches: [generated.batch, ...safeArray(stored.aiBatches)].slice(0, 100)
    });
    const imported = importAiCandidates(workflowWithBatch, generated.items, generated.batch);
    const snapshot = generateTodaySnapshot(imported.workflow, { mode: 'create' });
    const finalWorkflow = cleanStoredWorkflow({ ...snapshot.workflow, updated: nowIso() });

    await env.FAVORITES.put(key, JSON.stringify(finalWorkflow));
    const cardTargets = safeArray(finalWorkflow.todaySnapshot.words).filter(kanji => cleanAiCard(finalWorkflow.candidatePool?.[kanji]?.aiCard || {}).cardStatus !== 'ready');
    let generatedCards = 0;
    if (cardTargets.length) {
      generatedCards = await generateCardsAndSave(origin, finalWorkflow, env, key);
    }
    return writeRefreshRunState(env, today, {
      status: 'success',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      generatedCandidates: generated.items.length,
      importedCandidates: imported.stats.imported,
      todayCount: finalWorkflow.todaySnapshot.words.length,
      generatedCards,
      queuedCards: cardTargets.length
    });
  } catch (error) {
    console.warn('daily-refresh background job failed', error?.message || error);
    return writeRefreshRunState(env, today, {
      status: 'failed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      error: error.message || 'daily refresh failed'
    });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
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
    const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    if (stored.todaySnapshot?.dateKey === today && safeArray(stored.todaySnapshot.words).length > 0) {
      return jsonResponse({
        ok: true,
        status: 'skipped',
        generatedCandidates: 0,
        importedCandidates: 0,
        todayCount: stored.todaySnapshot.words.length,
        generatedCards: 0,
        dateKey: today
      });
    }

    const runState = await readRefreshRunState(env, today);
    if (isFreshRunningState(runState)) {
      return jsonResponse({
        ok: true,
        status: 'running',
        generatedCandidates: runState.generatedCandidates,
        importedCandidates: runState.importedCandidates,
        todayCount: runState.todayCount,
        generatedCards: runState.generatedCards,
        queuedCards: runState.queuedCards,
        dateKey: today
      });
    }
    await writeRefreshRunState(env, today, {
      status: 'running',
      startedAt: nowIso(),
      finishedAt: '',
      error: ''
    });

    const job = runDailyRefreshJob({ origin, env, key, today });
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(job);
    } else {
      await job;
    }
    return jsonResponse({
      ok: true,
      status: 'queued',
      generatedCandidates: 0,
      importedCandidates: 0,
      todayCount: 0,
      generatedCards: 0,
      queuedCards: 0,
      dateKey: today
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

import {
  cleanAiBatch,
  cleanAiBatches,
  cleanAiCard,
  cleanCandidatePoolEntry,
  cleanStoredWorkflow,
  cleanWords
} from '../shared/workflow-schema.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const MAX_WORDS_PER_REQUEST = 5;
export const AI_CARD_PENDING_TTL_MS = 10 * 60 * 1000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function nowIso() {
  return new Date().toISOString();
}

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getStorageKey(url) {
  const code = cleanSyncCode(url.searchParams.get('code'));
  return code.length >= 8 ? `favorites:${code}` : 'favorites:global';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return null;
  }
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
  if (!response.ok || data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data;
}

function getCardStatus(workflow, kanji) {
  const card = cleanAiCard(workflow.candidatePool?.[kanji]?.aiCard || {});
  return card.cardStatus || 'none';
}

function parseTimeMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isAiCardStalePending(entry = {}, nowMs = Date.now()) {
  const aiCard = cleanAiCard(entry.aiCard || entry || {});
  if (aiCard.cardStatus !== 'pending') return false;
  const startedAtMs = parseTimeMs(aiCard.generatedAt || entry.updatedAt);
  return Boolean(startedAtMs && Number.isFinite(nowMs) && nowMs - startedAtMs > AI_CARD_PENDING_TTL_MS);
}

export function summarizeTodayAiCards(workflow = {}, options = {}) {
  const cleanWorkflow = cleanStoredWorkflow(workflow);
  const words = cleanWords(cleanWorkflow.todaySnapshot?.words).slice(0, 20);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const items = words.map(kanji => {
    const entry = cleanWorkflow.candidatePool?.[kanji] || {};
    const aiCard = cleanAiCard(entry.aiCard || {});
    const status = aiCard.cardStatus || 'none';
    const stalePending = isAiCardStalePending(entry, nowMs);
    return {
      kanji,
      cardStatus: status,
      stalePending,
      generatedAt: aiCard.generatedAt || '',
      summary: aiCard.summary || ''
    };
  });
  const readyCount = items.filter(item => item.cardStatus === 'ready').length;
  const failedCount = items.filter(item => item.cardStatus === 'failed').length;
  const pendingCount = items.filter(item => item.cardStatus === 'pending').length;
  const stalePendingCount = items.filter(item => item.stalePending).length;
  return {
    todaySnapshot: {
      dateKey: cleanWorkflow.todaySnapshot?.dateKey || '',
      words
    },
    items,
    readyCount,
    missingCount: Math.max(0, items.length - readyCount - failedCount - pendingCount),
    failedCount,
    pendingCount,
    stalePendingCount
  };
}

export function selectTodayAiCardTargets(workflow = {}, options = {}) {
  return selectAiCardTargets(workflow, { ...options, mode: 'today' });
}

export function selectAiCardTargets(workflow = {}, options = {}) {
  const cleanWorkflow = cleanStoredWorkflow(workflow);
  const mode = cleanText(options.mode || 'today', 40);
  if (!['today', 'words'].includes(mode)) throw new Error('Only mode=today or mode=words is supported');

  const todayWords = cleanWords(cleanWorkflow.todaySnapshot?.words).slice(0, 20);
  const todaySet = new Set(todayWords);
  const requestedWords = cleanWords(options.words || []).slice(0, 50);
  const force = Boolean(options.force);
  const retryFailed = Boolean(options.retryFailed);
  const retryStalePending = Boolean(options.retryStalePending);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxWords = clamp(toInt(options.maxWords, MAX_WORDS_PER_REQUEST), 1, MAX_WORDS_PER_REQUEST);
  const skipped = {
    notToday: mode === 'today' ? requestedWords.filter(word => !todaySet.has(word)) : [],
    ready: [],
    failed: [],
    pending: [],
    stalePending: [],
    missingEntry: [],
    limited: []
  };
  const targets = [];
  const candidateWords = mode === 'today'
    ? (requestedWords.length ? requestedWords.filter(word => todaySet.has(word)) : todayWords)
    : requestedWords.filter(word => {
      const exists = Boolean(cleanWorkflow.candidatePool?.[word]);
      if (!exists) skipped.missingEntry.push(word);
      return exists;
    });

  candidateWords.forEach(kanji => {
    const entry = cleanWorkflow.candidatePool?.[kanji];
    const status = getCardStatus(cleanWorkflow, kanji);
    if (!entry) {
      skipped.missingEntry.push(kanji);
      return;
    }
    if (status === 'pending') {
      const stalePending = isAiCardStalePending(entry, nowMs);
      if (stalePending && retryStalePending) {
        targets.push(kanji);
        return;
      }
      skipped.pending.push(kanji);
      if (stalePending) skipped.stalePending.push(kanji);
      return;
    }
    if (status === 'ready' && !force) {
      skipped.ready.push(kanji);
      return;
    }
    if (status === 'failed' && !retryFailed && !force) {
      skipped.failed.push(kanji);
      return;
    }
    targets.push(kanji);
  });

  const selected = targets.slice(0, maxWords);
  skipped.limited = targets.slice(maxWords);
  return {
    targets: selected,
    skipped,
    todayWords,
    maxWords,
    force,
    retryFailed,
    retryStalePending
  };
}

function buildWordCardPayloadItems(workflow, kanjis) {
  const cleanWorkflow = cleanStoredWorkflow(workflow);
  return cleanWords(kanjis).map(kanji => {
    const entry = cleanCandidatePoolEntry(kanji, cleanWorkflow.candidatePool?.[kanji] || {});
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
      sourceTags: safeArray(entry.sourceTags).slice(0, 12),
      sourceType: entry.sourceType || '',
      discoverySource: entry.discoverySource || '',
      discoveryContext: entry.discoveryContext || '',
      reviewReason: entry.reviewReason || '',
      examples: safeArray(entry.examples).slice(0, 2),
      suggestedTitles: safeArray(entry.suggestedTitles),
      coverSuggestion: entry.coverSuggestion || {}
    };
  }).filter(Boolean);
}

function buildWordCardRequestPayload(workflow, targets) {
  const cleanWorkflow = cleanStoredWorkflow(workflow);
  const words = buildWordCardPayloadItems(cleanWorkflow, targets).slice(0, MAX_WORDS_PER_REQUEST);
  return {
    action: 'generate_word_card',
    input: JSON.stringify(words).slice(0, 12000),
    count: words.length,
    preferences: {
      includeMemes: true,
      includeHighRisk: 'review_only',
      readingFormat: 'romaji_kana'
    },
    context: {
      favorites: cleanWorkflow.words,
      negativeFeedback: cleanWorkflow.feedback,
      publishedWords: safeArray(cleanWorkflow.publishedRecords).map(record => record.word).filter(Boolean),
      existingCandidates: words,
      words,
      accountLearningSummary: getAccountLearningSummary()
    }
  };
}

export function applyAiCardGenerationResult(workflow = {}, result = {}) {
  const current = cleanStoredWorkflow(workflow);
  const pool = { ...(current.candidatePool || {}) };
  const targetSet = new Set(cleanWords(result.targets || []));
  const usage = result.usage || {};
  const force = Boolean(result.force);
  const generatedAt = usage.createdAt || nowIso();
  let savedCount = 0;
  const savedWords = [];

  safeArray(result.items).forEach((item, itemIndex) => {
    const kanji = cleanText(item?.kanji || safeArray(result.targets)[itemIndex], 80);
    if (!kanji || !targetSet.has(kanji) || !pool[kanji]) return;
    const previousCard = cleanAiCard(pool[kanji].aiCard || {});
    const previousHistory = safeArray(pool[kanji].aiCardHistory).map(cleanAiCard).filter(card => card.cardStatus !== 'none');
    const nextHistory = force && previousCard.cardStatus === 'ready'
      ? [previousCard, ...previousHistory].slice(0, 10)
      : previousHistory.slice(0, 10);
    const nextCard = cleanAiCard({
      ...(item.aiCard || item.card || item),
      cardStatus: 'ready',
      cardSource: 'deepseek_api',
      cardModel: item.aiCard?.cardModel || usage.model || 'deepseek-v4-flash',
      generatedAt: item.aiCard?.generatedAt || generatedAt
    });
    pool[kanji] = cleanCandidatePoolEntry(kanji, {
      ...pool[kanji],
      aiCard: nextCard,
      aiCardHistory: nextHistory,
      updatedAt: nowIso()
    });
    savedCount += 1;
    savedWords.push(kanji);
  });

  const failedWords = cleanWords(result.failedWords || []).filter(kanji => targetSet.has(kanji) && !savedWords.includes(kanji) && pool[kanji]);
  failedWords.forEach(kanji => {
    const previousCard = cleanAiCard(pool[kanji].aiCard || {});
    if (previousCard.cardStatus === 'ready' && !force) return;
    pool[kanji] = cleanCandidatePoolEntry(kanji, {
      ...pool[kanji],
      aiCard: {
        cardStatus: 'failed',
        cardSource: 'deepseek_api',
        cardModel: usage.model || '',
        generatedAt,
        summary: cleanText(result.error || '生成失败', 300)
      },
      updatedAt: nowIso()
    });
  });

  const batch = cleanAiBatch({
    id: `today_card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    action: 'generate_word_card',
    model: usage.model || 'deepseek-v4-flash',
    createdAt: usage.createdAt || generatedAt,
    itemCount: targetSet.size,
    importedCount: savedCount,
    skippedCount: Math.max(0, targetSet.size - savedCount),
    promptSummary: [...targetSet].join('、'),
    trendNotes: result.summary?.trendNotes || ''
  });

  return {
    workflow: cleanStoredWorkflow({
      ...current,
      candidatePool: pool,
      aiBatches: [batch, ...cleanAiBatches(current.aiBatches)].filter(Boolean).slice(0, 100),
      updated: nowIso()
    }),
    savedCount,
    savedWords,
    failedWords
  };
}

export async function generateTodayAiCards({ origin, workflow, options = {}, callEndpoint = callJsonEndpoint }) {
  const selection = selectAiCardTargets(workflow, options);
  if (!selection.targets.length) {
    return {
      workflow: cleanStoredWorkflow(workflow),
      selection,
      savedCount: 0,
      savedWords: [],
      failedWords: [],
      summary: summarizeTodayAiCards(workflow)
    };
  }

  const payload = buildWordCardRequestPayload(workflow, selection.targets);
  if (!payload.context.words.length) {
    return {
      workflow: cleanStoredWorkflow(workflow),
      selection: {
        ...selection,
        skipped: {
          ...selection.skipped,
          missingEntry: [...selection.skipped.missingEntry, ...selection.targets]
        },
        targets: []
      },
      savedCount: 0,
      savedWords: [],
      failedWords: [],
      summary: summarizeTodayAiCards(workflow)
    };
  }

  try {
    const data = await callEndpoint(origin, '/ai-candidates', payload);
    const applied = applyAiCardGenerationResult(workflow, {
      targets: selection.targets,
      items: safeArray(data.items),
      usage: data.usage || {},
      summary: data.summary || {},
      force: selection.force
    });
    return {
      ...applied,
      selection,
      summary: summarizeTodayAiCards(applied.workflow)
    };
  } catch (error) {
    const applied = applyAiCardGenerationResult(workflow, {
      targets: selection.targets,
      failedWords: selection.targets,
      usage: {},
      force: selection.force,
      error: error.message || '生成失败'
    });
    return {
      ...applied,
      selection,
      error: error.message || '生成失败',
      summary: summarizeTodayAiCards(applied.workflow)
    };
  }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!env.FAVORITES) {
    return jsonResponse({ error: 'KV namespace FAVORITES is not configured' }, 500);
  }

  const url = new URL(request.url);
  const key = getStorageKey(url);

  if (request.method === 'GET') {
    const workflow = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    return jsonResponse({
      ok: true,
      ...summarizeTodayAiCards(workflow)
    });
  }

  if (request.method === 'POST') {
    const body = await readJson(request);
    if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);

    const workflow = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
    const result = await generateTodayAiCards({
      origin: url.origin,
      workflow,
      options: body
    });

    if (result.selection.targets.length || result.failedWords.length || result.savedWords.length) {
      const storedAfterGeneration = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
      const mergedPool = { ...(storedAfterGeneration.candidatePool || {}) };
      result.selection.targets.forEach(kanji => {
        const generatedEntry = result.workflow.candidatePool?.[kanji];
        if (!generatedEntry || !mergedPool[kanji]) return;
        mergedPool[kanji] = cleanCandidatePoolEntry(kanji, {
          ...mergedPool[kanji],
          aiCard: generatedEntry.aiCard,
          aiCardHistory: generatedEntry.aiCardHistory,
          updatedAt: generatedEntry.updatedAt
        });
      });
      const batchIds = new Set();
      const mergedBatches = [];
      [...cleanAiBatches(result.workflow.aiBatches), ...cleanAiBatches(storedAfterGeneration.aiBatches)].forEach(batch => {
        if (!batch?.id || batchIds.has(batch.id)) return;
        batchIds.add(batch.id);
        mergedBatches.push(batch);
      });
      const nextWorkflow = cleanStoredWorkflow({
        ...storedAfterGeneration,
        candidatePool: mergedPool,
        aiBatches: mergedBatches.slice(0, 100),
        updated: nowIso()
      });
      await env.FAVORITES.put(key, JSON.stringify(nextWorkflow));
      result.workflow = nextWorkflow;
      result.summary = summarizeTodayAiCards(nextWorkflow);
    }

    return jsonResponse({
      ok: !result.error,
      error: result.error || '',
      selectedWords: result.selection.targets,
      skipped: result.selection.skipped,
      savedCount: result.savedCount,
      savedWords: result.savedWords,
      failedWords: result.failedWords,
      ...result.summary
    }, result.error ? 502 : 200);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

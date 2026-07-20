import { cleanCandidatePool, cleanPublishedRecords } from '../shared/workflow-schema.mjs';

function uniqueStrings(values = []) {
  return [...new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [])];
}

export function buildAutoAiCandidatePayload(state = {}) {
  const existingCandidates = Object.values(cleanCandidatePool(state.candidatePool || {})).map(entry => ({
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
  }));
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
      favorites: uniqueStrings(state.favorites),
      negativeFeedback: state.negativeFeedback && typeof state.negativeFeedback === 'object' ? state.negativeFeedback : {},
      publishedWords: cleanPublishedRecords(state.publishedRecords || []).map(record => record.word).filter(Boolean),
      existingCandidates
    }
  };
}

export async function requestAutoAiCandidateBatch(options = {}) {
  const {
    request,
    endpoint,
    payload,
    normalizeItem,
    buildBatchItems,
    buildTrace,
    cleanBatch
  } = options;
  if (typeof request !== 'function') throw new TypeError('request is required');
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }, { timeoutMs: 100000 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);

  const batchId = typeof options.createBatchId === 'function'
    ? options.createBatchId()
    : `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .map(item => normalizeItem(item, batchId, payload.input, payload.action))
    .filter(Boolean);
  const trace = buildTrace(data.usage || {}, payload);
  const batch = cleanBatch({
    id: batchId,
    action: payload.action,
    model: data.usage?.model || 'deepseek-v4-flash',
    createdAt: data.usage?.createdAt || (typeof options.nowIso === 'function' ? options.nowIso() : new Date().toISOString()),
    itemCount: items.length,
    promptType: payload.action,
    rawCount: rawItems.length,
    normalizedCount: items.length,
    acceptedCount: 0,
    rejectedCount: Math.max(0, rawItems.length - items.length),
    importedCount: 0,
    skippedCount: 0,
    items: buildBatchItems(rawItems, items, batchId, payload.action),
    ...trace,
    promptSummary: '自动日更生成',
    trendNotes: data.summary?.trendNotes || ''
  });
  return { items, batch, usage: data.usage || {}, summary: data.summary || {} };
}

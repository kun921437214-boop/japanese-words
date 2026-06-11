import {
  archiveTodaySnapshotIntoHistory as archiveWorkflowTodaySnapshotIntoHistory,
  cleanHistorySnapshots as cleanWorkflowHistorySnapshots,
  cleanStoredWorkflow as cleanWorkflowSchema,
  cleanTodaySnapshot as cleanWorkflowTodaySnapshot,
  mergeWorkflowForFullSave,
  stripInvalidCurrentTodaySnapshot
} from '../shared/workflow-schema.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
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
  const allowedReasons = ['uninterested', 'tooBasic', 'tooTextbook', 'notForXhs', 'inaccurate', 'tooRisky', 'tooNiche', 'notFresh', 'tooMeme', 'badVisual', 'badTitle', 'notMyTone'];
  return Object.entries(feedback || {}).reduce((result, [word, record]) => {
    const cleanWord = String(word || '').trim().slice(0, 80);
    if (!cleanWord) return result;
    const reasons = Object.entries(record?.reasons || {}).reduce((reasonResult, [reason, count]) => {
      if (!allowedReasons.includes(reason)) return reasonResult;
      const cleanCount = Math.max(0, Math.min(50, Number.parseInt(count, 10) || 0));
      if (cleanCount > 0) reasonResult[reason] = cleanCount;
      return reasonResult;
    }, {});
    result[cleanWord] = {
      reasons,
      lastReason: allowedReasons.includes(record?.lastReason) ? record.lastReason : '',
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
const CANDIDATE_TYPE_OPTIONS = ['稳定候选', '新鲜梗词', '审美氛围词', '美妆穿搭词', '追星兴趣词', '生活方式词', '网络口语词', '圈层词', '高风险话题词'];
const FRESHNESS_OPTIONS = ['长期', '中期', '短期', '需要尽快判断'];
const SUGGESTED_ACTION_OPTIONS = ['优先收藏观察', '可以收藏观察', '尽快判断', '暂缓', '不建议'];
const RISK_LEVEL_OPTIONS = ['low', 'medium', 'high'];
const AI_ACTION_OPTIONS = ['stable_today', 'wild_ideas', 'generate_candidates', 'extract_from_materials', 'enrich_words', 'generate_word_card', 'rerank_candidates', 'audit_library_for_delete', 'audit_missing_library_words'];
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
const CONFIDENCE_LEVEL_OPTIONS = ['high', 'medium', 'low', 'review'];
const EVIDENCE_TYPE_OPTIONS = ['common_usage', 'ai_inferred', 'user_material', 'trend_claim', 'unknown'];
const DISPLAY_BUCKET_OPTIONS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked'];
const EMOTION_TONE_OPTIONS = ['positive', 'neutral', 'negative', 'aesthetic', 'lifestyle', 'fandom'];
const REVIEW_REASON_TYPE_OPTIONS = ['uncertain_usage', 'too_niche', 'possible_wrong_meaning', 'ip_brand_role', 'privacy_sensitive', 'offensive', 'too_basic'];
const TODAY_SNAPSHOT_VERSION = 1;

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v3';
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

function cleanEnum(value, options, fallback = '') {
  const cleanValue = cleanText(value, 80);
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function cleanAiExample(example = {}) {
  const jp = cleanText(example?.jp, 220);
  const cn = cleanText(example?.cn, 220);
  if (!jp && !cn) return null;
  return {
    jp,
    kana: cleanText(example?.kana, 220),
    romaji: cleanText(example?.romaji, 220),
    cn,
    note: cleanText(example?.note, 220),
    source: cleanText(example?.source || example?.note || 'AI 候选例句', 120)
  };
}

function cleanCoverSuggestion(coverSuggestion = {}) {
  return {
    coverText: cleanText(coverSuggestion?.coverText, 120),
    mainVisual: cleanText(coverSuggestion?.mainVisual, 240),
    style: cleanText(coverSuggestion?.style, 160),
    avoid: cleanText(coverSuggestion?.avoid, 240)
  };
}

function cleanAiCard(card = {}) {
  card = card || {};
  const status = cleanEnum(card.cardStatus, ['none', 'pending', 'ready', 'failed', 'stale'], '');
  if (!status && !card.summary && !card.explanation) return null;
  return {
    cardStatus: status || 'ready',
    cardSource: card.cardSource === 'deepseek_api' ? 'deepseek_api' : '',
    cardModel: cleanText(card.cardModel, 120),
    cardVersion: Math.max(1, Math.min(99, Number.parseInt(card.cardVersion, 10) || 1)),
    generatedAt: typeof card.generatedAt === 'string' ? card.generatedAt : '',
    summary: cleanText(card.summary, 500),
    explanation: cleanText(card.explanation, 1600),
    usageScenes: Array.isArray(card.usageScenes) ? [...new Set(card.usageScenes.map(item => cleanText(item, 120)).filter(Boolean))].slice(0, 8) : [],
    examples: Array.isArray(card.examples) ? card.examples.map(cleanAiExample).filter(Boolean).slice(0, 5) : [],
    suggestedTitles: Array.isArray(card.suggestedTitles) ? [...new Set(card.suggestedTitles.map(item => cleanText(item, 140)).filter(Boolean))].slice(0, 8) : [],
    coverSuggestion: cleanCoverSuggestion(card.coverSuggestion || {}),
    contentAngles: Array.isArray(card.contentAngles) ? [...new Set(card.contentAngles.map(item => cleanText(item, 180)).filter(Boolean))].slice(0, 8) : [],
    targetAudience: cleanText(card.targetAudience, 400),
    referenceDirection: cleanText(card.referenceDirection, 600),
    riskWarning: cleanText(card.riskWarning, 500),
    wrongUsage: cleanText(card.wrongUsage, 600),
    similarWords: Array.isArray(card.similarWords) ? card.similarWords.map(item => ({
      word: cleanText(item.word || item.kanji, 80),
      romaji: cleanText(item.romaji, 120),
      meaning: cleanText(item.meaning, 240),
      difference: cleanText(item.difference || item.note, 500)
    })).filter(item => item.word || item.meaning).slice(0, 8) : [],
    interactionPrompts: Array.isArray(card.interactionPrompts) ? [...new Set(card.interactionPrompts.map(item => cleanText(item, 220)).filter(Boolean))].slice(0, 8) : []
  };
}

function cleanCandidatePoolEntry(kanji, entry = {}) {
  const cleanWord = String(kanji || '').trim().slice(0, 80);
  let sourceType = String(entry.sourceType || '').trim();
  if (sourceType === 'deepseek_api') sourceType = 'deepseek_generated';
  else if (sourceType === 'manual') sourceType = 'manual_keep';
  else if (sourceType === 'original' || sourceType === 'audit_missing') sourceType = 'deepseek_reviewed';
  else if (!['deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(sourceType)) sourceType = '';
  const hasAiLexicalFields = Boolean(entry.kana || entry.romaji || entry.meaning || ['deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(sourceType));
  if (!cleanWord || (PURE_KANJI_RE.test(cleanWord) && !hasAiLexicalFields)) return null;
  const riskLevel = cleanEnum(entry.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  const confidenceLevel = cleanEnum(entry.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium');
  const evidenceType = cleanEnum(entry.evidenceType, EVIDENCE_TYPE_OPTIONS, sourceType === 'deepseek_generated' ? 'unknown' : 'common_usage');
  const freshness = cleanEnum(entry.freshness, FRESHNESS_OPTIONS, '');
  const candidateType = cleanEnum(entry.candidateType, CANDIDATE_TYPE_OPTIONS, sourceType === 'deepseek_generated' ? '网络口语词' : '稳定候选');
  const displayBucket = cleanEnum(entry.displayBucket, DISPLAY_BUCKET_OPTIONS, sourceType === 'deepseek_generated' ? 'long_term' : 'today');
  const emotionTone = cleanEnum(entry.emotionTone, EMOTION_TONE_OPTIONS, 'neutral');
  const reviewReasonType = cleanEnum(entry.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, '');
  let sourceTags = Array.isArray(entry.sourceTags) ? [...new Set(entry.sourceTags.map(item => cleanText(item, 80)).filter(Boolean))].slice(0, 12) : [];
  if (sourceType === 'deepseek_generated' && !sourceTags.includes('DeepSeek生成')) sourceTags.unshift('DeepSeek生成');
  if (sourceType === 'deepseek_reviewed' && !sourceTags.includes('DeepSeek审核')) sourceTags.unshift('DeepSeek审核');
  if (sourceType === 'manual_keep' && !sourceTags.includes('受保护')) sourceTags.unshift('受保护');
  if (displayBucket === 'meme_fast' && !sourceTags.includes('梗词快看')) sourceTags.push('梗词快看');
  if (displayBucket === 'review' && !sourceTags.includes('人工复核')) sourceTags.push('人工复核');
  if (displayBucket === 'blocked' && !sourceTags.includes('不建议')) sourceTags.push('不建议');
  sourceTags = [...new Set(sourceTags)].slice(0, 12);
  return {
    kanji: cleanWord,
    romaji: cleanText(entry.romaji, 120),
    kana: cleanText(entry.kana || entry.reading, 120),
    meaning: cleanText(entry.meaning, 240),
    category: cleanText(entry.category, 80),
    candidateType,
    freshness,
    xhsFitScore: Math.max(0, Math.min(100, Number.parseInt(entry.xhsFitScore ?? entry.lastScore, 10) || 0)),
    riskLevel,
    riskWarning: cleanText(entry.riskWarning, 500),
    emotionTone,
    confidenceLevel,
    evidenceType,
    reviewReason: cleanText(entry.reviewReason, 500),
    reviewReasonType,
    displayBucket,
    reason: cleanText(entry.reason, 1000),
    suggestedAction: cleanEnum(entry.suggestedAction, SUGGESTED_ACTION_OPTIONS, riskLevel === 'high' ? '暂缓' : '可以收藏观察'),
    aiCard: cleanAiCard(entry.aiCard || {}),
    aiCardHistory: Array.isArray(entry.aiCardHistory) ? entry.aiCardHistory.map(cleanAiCard).filter(Boolean).slice(0, 3) : [],
    examples: Array.isArray(entry.examples) ? entry.examples.map(cleanAiExample).filter(Boolean).slice(0, 5) : [],
    suggestedTitles: Array.isArray(entry.suggestedTitles) ? [...new Set(entry.suggestedTitles.map(item => cleanText(item, 140)).filter(Boolean))].slice(0, 8) : [],
    coverSuggestion: cleanCoverSuggestion(entry.coverSuggestion),
    sourceType,
    reviewSource: cleanText(entry.reviewSource, 120) || (sourceType === 'deepseek_reviewed' ? 'deepseek_library_audit' : ''),
    libraryReviewStatus: cleanEnum(entry.libraryReviewStatus || entry.libraryAuditAction, ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'], '') || (sourceType === 'deepseek_reviewed' ? 'approved' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditStatus: cleanEnum(entry.libraryAuditStatus, ['reviewed', 'missing', 'removed', 'protected', 'not_legacy'], '') || (sourceType === 'deepseek_reviewed' ? 'reviewed' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditAction: cleanEnum(entry.libraryAuditAction || entry.libraryReviewStatus, ['approve', 'keep', 'watch', 'review', 'delete', 'protect'], '') || (sourceType === 'deepseek_reviewed' ? 'approve' : sourceType === 'manual_keep' ? 'protect' : ''),
    libraryAuditReason: cleanText(entry.libraryAuditReason || entry.reviewReason, 800),
    libraryAuditReviewedAt: typeof entry.libraryAuditReviewedAt === 'string' ? entry.libraryAuditReviewedAt : '',
    libraryAuditScore: Math.max(0, Math.min(100, Number.parseInt(entry.libraryAuditScore ?? entry.xhsFitScore, 10) || 0)),
    libraryAuditBucket: cleanEnum(entry.libraryAuditBucket || entry.suggestedBucket || entry.displayBucket, [...DISPLAY_BUCKET_OPTIONS, 'deleted'], ''),
    libraryAuditConfidenceLevel: cleanEnum(entry.libraryAuditConfidenceLevel || entry.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, ''),
    libraryAuditRiskLevel: cleanEnum(entry.libraryAuditRiskLevel || entry.riskLevel, RISK_LEVEL_OPTIONS, ''),
    protected: Boolean(entry.protected || sourceType === 'manual_keep'),
    sourcePromptType: AI_ACTION_OPTIONS.includes(entry.sourcePromptType) ? entry.sourcePromptType : '',
    sourcePromptVersion: cleanText(entry.sourcePromptVersion || (entry.sourcePromptType ? getPromptVersion(entry.sourcePromptType) : ''), 80),
    sourceText: cleanText(entry.sourceText, 12000),
    sourceTags,
    discoverySource: cleanText(entry.discoverySource, 80),
    discoveryContext: cleanText(entry.discoveryContext, 1200),
    aiBatchId: cleanText(entry.aiBatchId, 120),
    importedAt: typeof entry.importedAt === 'string' ? entry.importedAt : null,
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
    lastReviewState: displayBucket === 'review' || displayBucket === 'blocked' ? 'review' : (['ready', 'watch', 'review'].includes(entry?.lastReviewState) ? entry.lastReviewState : 'watch'),
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

function cleanAiBatches(batches) {
  if (!Array.isArray(batches)) return [];
  return batches.slice(0, 100).map((batch, index) => ({
    id: cleanText(batch?.id || `batch_${index}`, 120),
    action: AI_ACTION_OPTIONS.includes(batch?.action) ? batch.action : 'generate_candidates',
    model: cleanText(batch?.model, 120),
    createdAt: typeof batch?.createdAt === 'string' ? batch.createdAt : '',
    promptVersion: cleanText(batch?.promptVersion || getPromptVersion(batch?.action), 80),
    inputHash: cleanText(batch?.inputHash, 120),
    rawOutput: cleanTraceText(batch?.rawOutput, 8000),
    normalizedOutput: cleanTraceText(batch?.normalizedOutput, 8000),
    reviewResult: ['accepted', 'rejected', 'edited'].includes(batch?.reviewResult) ? batch.reviewResult : '',
    itemCount: Math.max(0, Math.min(100, Number.parseInt(batch?.itemCount, 10) || 0)),
    importedCount: Math.max(0, Math.min(100, Number.parseInt(batch?.importedCount, 10) || 0)),
    skippedCount: Math.max(0, Math.min(100, Number.parseInt(batch?.skippedCount, 10) || 0)),
    promptSummary: cleanText(batch?.promptSummary, 500),
    trendNotes: cleanText(batch?.trendNotes, 1000)
  })).filter(batch => batch.id);
}

function cleanTodaySnapshot(snapshot = {}) {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot?.dateKey || '')) ? String(snapshot.dateKey) : '';
  const words = cleanWords(snapshot?.words).slice(0, 20);
  return {
    dateKey,
    words,
    generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : '',
    source: 'candidatePool',
    batchIds: Array.isArray(snapshot?.batchIds)
      ? [...new Set(snapshot.batchIds.map(item => cleanText(item, 120)).filter(Boolean))].slice(0, 30)
      : [],
    version: Math.max(0, Math.min(999, Number.parseInt(snapshot?.version, 10) || (words.length ? TODAY_SNAPSHOT_VERSION : 0)))
  };
}

function cleanHistorySnapshot(snapshot = {}, fallbackDateKey = '') {
  const record = snapshot || {};
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(record?.dateKey || ''))
    ? String(record.dateKey)
    : (/^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDateKey || '')) ? String(fallbackDateKey) : '');
  const words = cleanWords(record?.words).slice(0, 20);
  return {
    dateKey,
    words,
    generatedAt: typeof record?.generatedAt === 'string' ? record.generatedAt : '',
    source: 'todaySnapshot',
    batchIds: Array.isArray(record?.batchIds)
      ? [...new Set(record.batchIds.map(item => cleanText(item, 120)).filter(Boolean))].slice(0, 30)
      : [],
    version: Math.max(1, Math.min(999, Number.parseInt(record?.version, 10) || 1)),
    archivedAt: typeof record?.archivedAt === 'string' ? record.archivedAt : '',
    title: cleanText(record?.title || '今日 AI 候选归档', 120)
  };
}

function cleanHistorySnapshots(snapshots) {
  return Object.entries(snapshots || {}).reduce((result, [dateKey, snapshot]) => {
    const cleanSnapshot = cleanHistorySnapshot(snapshot, dateKey);
    if (cleanSnapshot.dateKey && cleanSnapshot.words.length) result[cleanSnapshot.dateKey] = cleanSnapshot;
    return result;
  }, {});
}

function archiveTodaySnapshotIntoHistory(historySnapshots, snapshot) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return cleanHistorySnapshots(historySnapshots);
  return cleanHistorySnapshots({
    ...historySnapshots,
    [cleanSnapshot.dateKey]: {
      dateKey: cleanSnapshot.dateKey,
      words: cleanSnapshot.words,
      generatedAt: cleanSnapshot.generatedAt,
      source: 'todaySnapshot',
      batchIds: cleanSnapshot.batchIds,
      version: cleanSnapshot.version || 1,
      archivedAt: new Date().toISOString(),
      title: '今日 AI 候选归档'
    }
  });
}

function cleanStoredData(data) {
  return stripInvalidCurrentTodaySnapshot(cleanWorkflowSchema(data));
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
    const stored = await env.FAVORITES.get(key, 'json');
    return jsonResponse(cleanStoredData(stored));
  }

  if (request.method === 'PUT') {
    const body = await readJson(request);
    if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);

    const stored = await env.FAVORITES.get(key, 'json');
    const current = cleanWorkflowSchema(stored);
    const data = stripInvalidCurrentTodaySnapshot(mergeWorkflowForFullSave(current, {
      ...body,
      updated: new Date().toISOString()
    }));

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
      let data = cleanWorkflowSchema({
        ...current,
        words,
        statuses,
        feedback: body.feedback || current.feedback,
        publishedRecords: body.publishedRecords || current.publishedRecords,
        candidatePool: body.candidatePool || current.candidatePool,
        aiBatches: body.aiBatches || current.aiBatches,
        aiPreview: body.aiPreview || current.aiPreview,
        todaySnapshot: body.todaySnapshot ? cleanWorkflowTodaySnapshot(body.todaySnapshot) : current.todaySnapshot,
        todayDismissed: body.todayDismissed || body.teamDismissed || current.todayDismissed,
        historySnapshots: body.historySnapshots ? cleanWorkflowHistorySnapshots(body.historySnapshots) : current.historySnapshots,
        todaySnapshotHistory: body.todaySnapshotHistory || current.todaySnapshotHistory,
        updated: new Date().toISOString()
      });
      data.historySnapshots = archiveWorkflowTodaySnapshotIntoHistory(data.historySnapshots, data.todaySnapshot);
      data = stripInvalidCurrentTodaySnapshot(data);

    await env.FAVORITES.put(key, JSON.stringify(data));
    return jsonResponse(data);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

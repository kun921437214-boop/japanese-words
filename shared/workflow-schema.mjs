const SCHEMA_VERSION = 1;
const WORDS_LIMIT = 500;
const PUBLISHED_RECORDS_LIMIT = 1000;
const AI_BATCHES_LIMIT = 100;
const HISTORY_SNAPSHOTS_LIMIT = 120;
const TODAY_SNAPSHOT_HISTORY_LIMIT = 45;
const AI_PREVIEW_ITEMS_LIMIT = 100;
const TEAM_DISMISSED_WORDS_LIMIT = 100;
const TODAY_SNAPSHOT_VERSION = 1;
export const TODAY_SNAPSHOT_GENERATOR_VERSION = 'daily-v4-dedup30-server';
const APP_TIME_ZONE = 'Asia/Shanghai';
const DATE_KEY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const STATUS_OPTIONS = ['none', 'pending', 'published'];
const NEGATIVE_FEEDBACK_REASONS = [
  'uninterested',
  'tooBasic',
  'tooTextbook',
  'notForXhs',
  'inaccurate',
  'tooRisky',
  'tooNiche',
  'notFresh',
  'tooMeme',
  'badVisual',
  'badTitle',
  'notMyTone'
];
const CONTENT_TYPE_OPTIONS = ['图文', '视频', '其他'];
const PERFORMANCE_REASON_OPTIONS = ['wordMismatch', 'titleProblem', 'coverProblem', 'contentProblem', 'timingProblem', 'lowExposure', 'dataAbnormal', 'observing'];
const SNAPSHOT_NODE_ORDER = ['1h', '2h', '4h', '24h', '72h'];
const CANDIDATE_TYPE_OPTIONS = ['稳定候选', '新鲜梗词', '审美氛围词', '美妆穿搭词', '追星兴趣词', '生活方式词', '网络口语词', '圈层词', '高风险话题词'];
const FRESHNESS_OPTIONS = ['长期', '中期', '短期', '需要尽快判断'];
const SUGGESTED_ACTION_OPTIONS = ['优先收藏观察', '可以收藏观察', '尽快判断', '暂缓', '不建议'];
const RISK_LEVEL_OPTIONS = ['low', 'medium', 'high'];
const CONFIDENCE_LEVEL_OPTIONS = ['high', 'medium', 'low', 'review'];
const EVIDENCE_TYPE_OPTIONS = ['common_usage', 'ai_inferred', 'user_material', 'trend_claim', 'unknown'];
const DISPLAY_BUCKET_OPTIONS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked'];
const EMOTION_TONE_OPTIONS = ['positive', 'neutral', 'negative', 'aesthetic', 'lifestyle', 'fandom'];
const REVIEW_REASON_TYPE_OPTIONS = ['uncertain_usage', 'too_niche', 'possible_wrong_meaning', 'ip_brand_role', 'privacy_sensitive', 'offensive', 'too_basic'];
const SOURCE_TYPE_OPTIONS = ['deepseek_generated', 'deepseek_reviewed', 'manual_keep', 'audit_missing'];
const SOURCE_PROMPT_OPTIONS = ['stable_today', 'wild_ideas', 'generate_candidates', 'extract_from_materials', 'enrich_words', 'generate_word_card', 'rerank_candidates', 'audit_library_for_delete', 'audit_missing_library_words'];
const RECOMMENDATION_ORIGIN_TYPES = ['deepseek_new', 'candidate_pool', 'history_fallback', 'local_word_bank', 'manual_added', 'today_backfill', 'dedup_relaxed', 'unknown'];
const RECOMMENDATION_LEVEL_OPTIONS = ['S', 'A', 'B', 'C', ''];
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanEnum(value, options, fallback = '') {
  const cleanValue = cleanText(value, 120);
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function uniqueStrings(values, maxLength = 80, limit = 500) {
  return [...new Set(safeArray(values).map(item => cleanText(item, maxLength)).filter(Boolean))].slice(0, limit);
}

function isIsoLike(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function workflowDateKey(date = new Date()) {
  const parts = DATE_KEY_FORMATTER.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function latestString(...values) {
  return values.filter(Boolean).sort().pop() || null;
}

function earliestString(...values) {
  return values.filter(Boolean).sort()[0] || null;
}

function nonEmptyText(preferred, fallback, maxLength = 1000) {
  const cleanPreferred = cleanText(preferred, maxLength);
  return cleanPreferred || cleanText(fallback, maxLength);
}

function newerByDate(left = {}, right = {}, field = 'updatedAt') {
  const leftDate = cleanText(left?.[field], 80);
  const rightDate = cleanText(right?.[field], 80);
  if (!leftDate) return right || {};
  if (!rightDate) return left || {};
  return rightDate >= leftDate ? right : left;
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

export function cleanWords(words) {
  return uniqueStrings(words, 80, WORDS_LIMIT);
}

export function cleanStatuses(statuses = {}, words = []) {
  const allowedWords = new Set(cleanWords(words));
  return Object.entries(statuses || {}).reduce((result, [word, status]) => {
    const cleanWord = cleanText(word, 80);
    const cleanStatus = cleanEnum(status, STATUS_OPTIONS, 'none');
    if (allowedWords.has(cleanWord) && cleanStatus !== 'none') result[cleanWord] = cleanStatus;
    return result;
  }, {});
}

export function cleanFeedback(feedback = {}) {
  return Object.entries(feedback || {}).reduce((result, [word, record]) => {
    const cleanWord = cleanText(word, 80);
    if (!cleanWord) return result;
    const reasons = Object.entries(record?.reasons || {}).reduce((reasonResult, [reason, count]) => {
      if (!NEGATIVE_FEEDBACK_REASONS.includes(reason)) return reasonResult;
      const cleanCount = clamp(toInt(count, 0), 0, 999);
      if (cleanCount > 0) reasonResult[reason] = cleanCount;
      return reasonResult;
    }, {});
    result[cleanWord] = {
      ...record,
      reasons,
      lastReason: NEGATIVE_FEEDBACK_REASONS.includes(record?.lastReason) ? record.lastReason : '',
      updatedAt: isIsoLike(record?.updatedAt) ? record.updatedAt : null,
      needsReview: Boolean(record?.needsReview || reasons.inaccurate)
    };
    return result;
  }, {});
}

export function cleanStats(stats = {}) {
  return {
    likes: clamp(toInt(stats?.likes, 0), 0, 99999999),
    favorites: clamp(toInt(stats?.favorites, 0), 0, 99999999),
    comments: clamp(toInt(stats?.comments, 0), 0, 99999999),
    shares: clamp(toInt(stats?.shares, 0), 0, 99999999),
    views: clamp(toInt(stats?.views, 0), 0, 999999999)
  };
}

export function cleanAutoRefreshState(state = {}) {
  return {
    ...state,
    status: cleanEnum(state?.status, ['idle', 'success', 'failed', 'partial'], 'idle'),
    lastAttemptAt: isIsoLike(state?.lastAttemptAt) ? state.lastAttemptAt : '',
    lastSuccessAt: isIsoLike(state?.lastSuccessAt) ? state.lastSuccessAt : '',
    lastMessage: cleanText(state?.lastMessage, 1000),
    source: cleanEnum(state?.source, ['remote', 'text'], ''),
    updatedFields: uniqueStrings(state?.updatedFields, 80, 20)
  };
}

export function cleanSnapshot(snapshot = {}, nodeType = '') {
  return {
    ...snapshot,
    nodeType: cleanText(snapshot?.nodeType || nodeType, 20),
    ...cleanStats(snapshot),
    capturedAt: isIsoLike(snapshot?.capturedAt) ? snapshot.capturedAt : '',
    source: snapshot?.source === 'auto' ? 'auto' : 'manual'
  };
}

export function cleanSnapshots(snapshots = []) {
  const safeSnapshots = safeArray(snapshots);
  return SNAPSHOT_NODE_ORDER.map(nodeType => {
    const matched = safeSnapshots.find(snapshot => snapshot?.nodeType === nodeType);
    return cleanSnapshot(matched || { nodeType }, nodeType);
  });
}

export function cleanPublishedRecord(record = {}, index = 0) {
  const id = cleanText(record?.id || `record_${cleanText(record?.word, 80) || 'unknown'}_${index}`, 120);
  return {
    ...record,
    id,
    word: cleanText(record?.word, 80),
    link: cleanText(record?.link, 1000),
    title: cleanText(record?.title, 200),
    description: cleanText(record?.description, 4000),
    contentType: cleanEnum(record?.contentType, CONTENT_TYPE_OPTIONS, '图文'),
    authorName: cleanText(record?.authorName, 120),
    publishedAt: isIsoLike(record?.publishedAt) ? record.publishedAt : '',
    latestStats: cleanStats(record?.latestStats || record),
    snapshots: cleanSnapshots(record?.snapshots),
    updatedAt: isIsoLike(record?.updatedAt) ? record.updatedAt : null,
    rating: cleanText(record?.rating, 40),
    performanceReason: uniqueStrings(safeArray(record?.performanceReason).filter(item => PERFORMANCE_REASON_OPTIONS.includes(item)), 80, 8),
    performanceNote: cleanText(record?.performanceNote, 1000),
    remarks: cleanText(record?.remarks, 2000),
    sourceStatus: record?.sourceStatus === 'placeholder' ? 'placeholder' : 'record',
    autoRefresh: cleanAutoRefreshState(record?.autoRefresh)
  };
}

export function cleanPublishedRecords(records = []) {
  return safeArray(records)
    .slice(0, PUBLISHED_RECORDS_LIMIT)
    .map((record, index) => cleanPublishedRecord(record, index))
    .filter(record => record.word || record.link || record.title);
}

function cleanAiExample(example = {}) {
  const jp = cleanText(example?.jp, 220);
  const cn = cleanText(example?.cn, 220);
  if (!jp && !cn) return null;
  return {
    ...example,
    jp,
    kana: cleanText(example?.kana, 220),
    romaji: cleanText(example?.romaji, 220),
    cn,
    note: cleanText(example?.note, 220),
    source: cleanText(example?.source || example?.note || '', 120)
  };
}

function cleanCoverSuggestion(coverSuggestion = {}) {
  return {
    ...coverSuggestion,
    coverText: cleanText(coverSuggestion?.coverText, 120),
    mainVisual: cleanText(coverSuggestion?.mainVisual, 240),
    style: cleanText(coverSuggestion?.style, 160),
    avoid: cleanText(coverSuggestion?.avoid, 240)
  };
}

export function cleanAiCard(card = {}) {
  const hasContent = Boolean(card && Object.keys(card || {}).length);
  const status = cleanEnum(card?.cardStatus, ['none', 'pending', 'ready', 'failed', 'stale'], hasContent ? 'ready' : 'none');
  return {
    ...(card || {}),
    cardStatus: status,
    cardSource: cleanText(card?.cardSource, 80),
    cardModel: cleanText(card?.cardModel, 120),
    cardVersion: clamp(toInt(card?.cardVersion, 1), 1, 99),
    generatedAt: isIsoLike(card?.generatedAt) ? card.generatedAt : '',
    summary: cleanText(card?.summary, 500),
    explanation: cleanText(card?.explanation, 1600),
    usageScenes: uniqueStrings(card?.usageScenes, 120, 8),
    examples: safeArray(card?.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: uniqueStrings(card?.suggestedTitles, 140, 8),
    coverSuggestion: cleanCoverSuggestion(card?.coverSuggestion || {}),
    contentAngles: uniqueStrings(card?.contentAngles, 180, 8),
    targetAudience: cleanText(card?.targetAudience, 400),
    referenceDirection: cleanText(card?.referenceDirection, 600),
    riskWarning: cleanText(card?.riskWarning, 500),
    wrongUsage: cleanText(card?.wrongUsage, 600),
    similarWords: safeArray(card?.similarWords).map(item => ({
      ...item,
      word: cleanText(item?.word || item?.kanji, 80),
      romaji: cleanText(item?.romaji, 120),
      meaning: cleanText(item?.meaning, 240),
      difference: cleanText(item?.difference || item?.note, 500)
    })).filter(item => item.word || item.meaning).slice(0, 8),
    interactionPrompts: uniqueStrings(card?.interactionPrompts, 220, 8)
  };
}

export function cleanCandidateScoreBreakdown(breakdown = {}) {
  return {
    ...breakdown,
    platformHeatScore: clamp(toInt(breakdown?.platformHeatScore, 0), 0, 100),
    accountFitScore: clamp(toInt(breakdown?.accountFitScore, 0), 0, 100),
    contentValueScore: clamp(toInt(breakdown?.contentValueScore, 0), 0, 100),
    dataFeedbackScore: clamp(toInt(breakdown?.dataFeedbackScore, 0), 0, 100),
    referenceQualityScore: clamp(toInt(breakdown?.referenceQualityScore, 0), 0, 100),
    confidenceWeightScore: clamp(toInt(breakdown?.confidenceWeightScore, 0), 0, 100),
    extensionBoost: clamp(toInt(breakdown?.extensionBoost, 0), -30, 30),
    freshnessBonus: clamp(toInt(breakdown?.freshnessBonus, 0), -30, 30),
    candidateTypeBonus: clamp(toInt(breakdown?.candidateTypeBonus, 0), -30, 30),
    expressionValueScore: clamp(toInt(breakdown?.expressionValueScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(breakdown?.accountLearningBonus, 0), -30, 30),
    riskPenalty: clamp(toInt(breakdown?.riskPenalty, 0), 0, 100),
    feedbackPenalty: clamp(toInt(breakdown?.feedbackPenalty, 0), 0, 100),
    duplicatePenalty: clamp(toInt(breakdown?.duplicatePenalty, 0), 0, 100),
    finalScore: clamp(toInt(breakdown?.finalScore, 0), 0, 100)
  };
}

function cleanRecommendationAuditTrace(trace = {}) {
  return {
    ...(trace || {}),
    originType: cleanEnum(trace?.originType, RECOMMENDATION_ORIGIN_TYPES, 'unknown'),
    originLabel: cleanText(trace?.originLabel, 80),
    sourceAction: cleanText(trace?.sourceAction, 120),
    sourceBatchId: cleanText(trace?.sourceBatchId, 120),
    fromDeepSeekNew: Boolean(trace?.fromDeepSeekNew),
    fromCandidatePool: Boolean(trace?.fromCandidatePool),
    fromHistoryFallback: Boolean(trace?.fromHistoryFallback),
    fromLocalFallback: Boolean(trace?.fromLocalFallback),
    fromManual: Boolean(trace?.fromManual),
    isBackfill: Boolean(trace?.isBackfill),
    isDedupRelaxed: Boolean(trace?.isDedupRelaxed),
    dedupDaysUsed: clamp(toInt(trace?.dedupDaysUsed, 0), 0, 365),
    selectedReason: cleanText(trace?.selectedReason, 1000),
    selectedAt: isIsoLike(trace?.selectedAt) ? trace.selectedAt : ''
  };
}

function cleanRecommendationAuditItem(item = {}) {
  const kanji = cleanText(item?.kanji, 80);
  if (!kanji) return null;
  return {
    ...(item || {}),
    kanji,
    meaning: cleanText(item?.meaning, 240),
    recommendationLevel: cleanEnum(item?.recommendationLevel, RECOMMENDATION_LEVEL_OPTIONS, ''),
    riskLevel: cleanText(item?.riskLevel, 80),
    originType: cleanEnum(item?.originType, RECOMMENDATION_ORIGIN_TYPES, 'unknown'),
    originLabel: cleanText(item?.originLabel, 80),
    isBackfill: Boolean(item?.isBackfill),
    isDedupRelaxed: Boolean(item?.isDedupRelaxed),
    dedupDaysUsed: clamp(toInt(item?.dedupDaysUsed, 0), 0, 365),
    finalScore: clamp(toInt(item?.finalScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(item?.accountLearningBonus, 0), -50, 50),
    accountLearningPenalty: clamp(toInt(item?.accountLearningPenalty, 0), 0, 100),
    expressionValueScore: clamp(toInt(item?.expressionValueScore, 0), 0, 100),
    chineseTransparencyScore: clamp(toInt(item?.chineseTransparencyScore, 0), 0, 100),
    genericTopicPenalty: clamp(toInt(item?.genericTopicPenalty, 0), 0, 100),
    selectedReason: cleanText(item?.selectedReason, 1000),
    diagnosis: safeArray(item?.diagnosis).map(text => cleanText(text, 240)).filter(Boolean).slice(0, 8)
  };
}

function cleanNumberSummary(summary = {}, keys = [], min = 0, max = 1000) {
  return keys.reduce((result, key) => {
    result[key] = clamp(toInt(summary?.[key], 0), min, max);
    return result;
  }, {});
}

function cleanCountMap(summary = {}, limit = 40) {
  return Object.entries(summary || {}).reduce((result, [key, value]) => {
    const cleanKey = cleanText(key, 80);
    if (!cleanKey || Object.keys(result).length >= limit) return result;
    result[cleanKey] = clamp(toInt(value, 0), 0, 1000);
    return result;
  }, {});
}

function cleanNoveltySummary(summary = {}) {
  const countKeys = [
    'generatedUniqueCount',
    'importedUniqueCount',
    'recentHistoryRejectedCount',
    'favoriteProtectedRejectedCount',
    'currentBatchDuplicateRejectedCount',
    'reviewRejectedCount'
  ];
  return {
    ...cleanNumberSummary(summary, countKeys, 0, 10000),
    duplicateRate: clamp(toInt(summary?.duplicateRate, 0), 0, 100),
    historyCollisionRate: clamp(toInt(summary?.historyCollisionRate, 0), 0, 100)
  };
}

function cleanRecommendationAuditSummary(audit = {}) {
  const sourceSummaryKeys = [...RECOMMENDATION_ORIGIN_TYPES];
  const qualitySummaryKeys = [
    'averageFinalScore',
    'averageExpressionValueScore',
    'averageChineseTransparencyScore',
    'genericTopicCount',
    'highTransparencyCount',
    'sLevelCount',
    'aLevelCount',
    'bLevelCount',
    'cLevelCount',
    'score'
  ];
  const qualitySummary = audit?.qualitySummary || {};
  return {
    ...(audit || {}),
    date: cleanText(audit?.date, 20),
    total: clamp(toInt(audit?.total, 0), 0, 100),
    sourceSummary: cleanNumberSummary(audit?.sourceSummary, sourceSummaryKeys, 0, 1000),
    qualitySummary: {
      ...cleanNumberSummary(qualitySummary, qualitySummaryKeys, 0, 1000),
      categoryCounts: cleanCountMap(qualitySummary?.categoryCounts, 20),
      clusterCounts: cleanCountMap(qualitySummary?.clusterCounts, 50),
      warnings: uniqueStrings(qualitySummary?.warnings, 240, 12),
      relaxed: Boolean(qualitySummary?.relaxed),
      relaxedReasons: uniqueStrings(qualitySummary?.relaxedReasons, 120, 12)
    },
    noveltySummary: cleanNoveltySummary(audit?.noveltySummary || {}),
    diagnosis: safeArray(audit?.diagnosis).map(text => cleanText(text, 300)).filter(Boolean).slice(0, 12),
    items: safeArray(audit?.items).map(cleanRecommendationAuditItem).filter(Boolean).slice(0, 100),
    createdAt: isIsoLike(audit?.createdAt) ? audit.createdAt : ''
  };
}

function normalizeSourceType(value) {
  const cleanValue = cleanText(value, 80);
  if (cleanValue === 'deepseek_api') return 'deepseek_generated';
  if (cleanValue === 'manual') return 'manual_keep';
  if (cleanValue === 'original') return 'deepseek_reviewed';
  return cleanEnum(cleanValue, SOURCE_TYPE_OPTIONS, cleanValue ? 'deepseek_reviewed' : 'deepseek_generated');
}

export function cleanCandidatePoolEntry(kanji, entry = {}) {
  const cleanKanji = cleanText(kanji || entry?.kanji, 80);
  if (!cleanKanji) return null;
  const sourceType = normalizeSourceType(entry?.sourceType);
  const sourcePromptType = cleanEnum(entry?.sourcePromptType, SOURCE_PROMPT_OPTIONS, '');
  const riskLevel = cleanEnum(entry?.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  const displayBucket = cleanEnum(entry?.displayBucket, DISPLAY_BUCKET_OPTIONS, riskLevel === 'high' ? 'review' : 'long_term');
  return {
    ...(entry || {}),
    kanji: cleanKanji,
    romaji: cleanText(entry?.romaji, 120),
    kana: cleanText(entry?.kana || entry?.reading, 120),
    meaning: cleanText(entry?.meaning, 240),
    category: cleanText(entry?.category, 80),
    candidateType: cleanEnum(entry?.candidateType, CANDIDATE_TYPE_OPTIONS, '稳定候选'),
    freshness: cleanEnum(entry?.freshness, FRESHNESS_OPTIONS, ''),
    xhsFitScore: clamp(toInt(entry?.xhsFitScore ?? entry?.lastScore, 60), 0, 100),
    riskLevel,
    riskWarning: cleanText(entry?.riskWarning, 500),
    emotionTone: cleanEnum(entry?.emotionTone, EMOTION_TONE_OPTIONS, 'neutral'),
    confidenceLevel: cleanEnum(entry?.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    evidenceType: cleanEnum(entry?.evidenceType, EVIDENCE_TYPE_OPTIONS, 'common_usage'),
    reviewReason: cleanText(entry?.reviewReason, 500),
    reviewReasonType: cleanEnum(entry?.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, ''),
    displayBucket,
    reason: cleanText(entry?.reason, 1000),
    suggestedAction: cleanEnum(entry?.suggestedAction, SUGGESTED_ACTION_OPTIONS, riskLevel === 'high' ? '暂缓' : '可以收藏观察'),
    aiCard: cleanAiCard(entry?.aiCard || {}),
    aiCardHistory: safeArray(entry?.aiCardHistory).map(cleanAiCard).filter(Boolean).slice(0, 10),
    examples: safeArray(entry?.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: uniqueStrings(entry?.suggestedTitles, 140, 8),
    coverSuggestion: cleanCoverSuggestion(entry?.coverSuggestion || {}),
    sourceType,
    reviewSource: cleanText(entry?.reviewSource, 120),
    libraryReviewStatus: cleanEnum(entry?.libraryReviewStatus || entry?.libraryAuditAction, ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'], '') || (sourceType === 'deepseek_reviewed' ? 'approved' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditStatus: cleanEnum(entry?.libraryAuditStatus, ['reviewed', 'missing', 'removed', 'protected', 'not_legacy'], ''),
    libraryAuditAction: cleanEnum(entry?.libraryAuditAction || entry?.libraryReviewStatus, ['approve', 'keep', 'watch', 'review', 'delete', 'protect'], ''),
    libraryAuditReason: cleanText(entry?.libraryAuditReason || entry?.reviewReason, 800),
    libraryAuditReviewedAt: isIsoLike(entry?.libraryAuditReviewedAt) ? entry.libraryAuditReviewedAt : '',
    libraryAuditScore: clamp(toInt(entry?.libraryAuditScore ?? entry?.xhsFitScore, 0), 0, 100),
    libraryAuditBucket: cleanEnum(entry?.libraryAuditBucket || entry?.suggestedBucket || entry?.displayBucket, [...DISPLAY_BUCKET_OPTIONS, 'deleted'], ''),
    libraryAuditConfidenceLevel: cleanEnum(entry?.libraryAuditConfidenceLevel || entry?.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, ''),
    libraryAuditRiskLevel: cleanEnum(entry?.libraryAuditRiskLevel || entry?.riskLevel, RISK_LEVEL_OPTIONS, ''),
    protected: Boolean(entry?.protected || sourceType === 'manual_keep'),
    sourcePromptType,
    sourcePromptVersion: cleanText(entry?.sourcePromptVersion || (sourcePromptType ? getPromptVersion(sourcePromptType) : ''), 80),
    sourceText: cleanText(entry?.sourceText, 12000),
    sourceTags: uniqueStrings(entry?.sourceTags, 80, 12),
    discoverySource: cleanText(entry?.discoverySource, 80),
    discoveryContext: cleanText(entry?.discoveryContext, 1200),
    aiBatchId: cleanText(entry?.aiBatchId, 120),
    importedAt: isIsoLike(entry?.importedAt) ? entry.importedAt : null,
    extensionFrom: uniqueStrings(entry?.extensionFrom, 80, 12),
    firstSeenAt: isIsoLike(entry?.firstSeenAt) ? entry.firstSeenAt : null,
    lastScoredAt: isIsoLike(entry?.lastScoredAt) ? entry.lastScoredAt : null,
    lastRecommendedAt: isIsoLike(entry?.lastRecommendedAt) ? entry.lastRecommendedAt : null,
    lastScore: clamp(toInt(entry?.lastScore, 0), 0, 100),
    recommendationCount: clamp(toInt(entry?.recommendationCount, 0), 0, 9999),
    ignoredCount: clamp(toInt(entry?.ignoredCount, 0), 0, 9999),
    expressionValueScore: clamp(toInt(entry?.expressionValueScore, 0), 0, 100),
    accountLearningTone: cleanText(entry?.accountLearningTone, 80),
    accountLearningBonus: clamp(toInt(entry?.accountLearningBonus, 0), -30, 30),
    recommendationAudit: cleanRecommendationAuditTrace(entry?.recommendationAudit || {}),
    wasRecommended: Boolean(entry?.wasRecommended),
    historicalBackfill: Boolean(entry?.historicalBackfill),
    lastDecayAt: isIsoLike(entry?.lastDecayAt) ? entry.lastDecayAt : '',
    removedAt: isIsoLike(entry?.removedAt) ? entry.removedAt : '',
    lastOrigin: cleanEnum(entry?.lastOrigin, ['today', 'history', 'pool', 'favorite', 'lookup'], 'pool'),
    lastConfidenceLevel: cleanEnum(entry?.lastConfidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    lastReviewState: displayBucket === 'review' || displayBucket === 'blocked'
      ? 'review'
      : cleanEnum(entry?.lastReviewState, ['ready', 'watch', 'review'], 'watch'),
    lastReviewNote: cleanText(entry?.lastReviewNote, 240),
    manualReviewState: cleanEnum(entry?.manualReviewState, ['ready', 'watch', 'review', ''], ''),
    manualReviewNote: cleanText(entry?.manualReviewNote, 240),
    lastBreakdown: cleanCandidateScoreBreakdown(entry?.lastBreakdown || {}),
    updatedAt: isIsoLike(entry?.updatedAt) ? entry.updatedAt : null
  };
}

export function cleanCandidatePool(pool = {}) {
  return Object.entries(pool || {}).reduce((result, [kanji, entry]) => {
    const cleanEntry = cleanCandidatePoolEntry(kanji, entry);
    if (cleanEntry) result[cleanEntry.kanji] = cleanEntry;
    return result;
  }, {});
}

export function cleanAiBatch(batch = {}, index = 0) {
  const action = cleanEnum(batch?.action, SOURCE_PROMPT_OPTIONS, 'generate_candidates');
  const id = cleanText(batch?.id || `batch_${index}`, 120);
  if (!id) return null;
  return {
    ...(batch || {}),
    id,
    action,
    promptType: cleanText(batch?.promptType || action, 120),
    model: cleanText(batch?.model, 120),
    createdAt: isIsoLike(batch?.createdAt) ? batch.createdAt : '',
    promptVersion: cleanText(batch?.promptVersion || getPromptVersion(action), 80),
    inputHash: cleanText(batch?.inputHash, 120),
    rawOutput: cleanTraceText(batch?.rawOutput, 8000),
    normalizedOutput: cleanTraceText(batch?.normalizedOutput, 8000),
    reviewResult: cleanEnum(batch?.reviewResult, ['accepted', 'rejected', 'edited'], ''),
    rawCount: clamp(toInt(batch?.rawCount ?? batch?.itemCount, 0), 0, 1000),
    normalizedCount: clamp(toInt(batch?.normalizedCount ?? batch?.itemCount, 0), 0, 1000),
    acceptedCount: clamp(toInt(batch?.acceptedCount ?? batch?.importedCount, 0), 0, 1000),
    rejectedCount: clamp(toInt(batch?.rejectedCount ?? batch?.skippedCount, 0), 0, 1000),
    itemCount: clamp(toInt(batch?.itemCount, 0), 0, 1000),
    importedCount: clamp(toInt(batch?.importedCount, 0), 0, 1000),
    skippedCount: clamp(toInt(batch?.skippedCount, 0), 0, 1000),
    promptSummary: cleanText(batch?.promptSummary, 500),
    trendNotes: cleanText(batch?.trendNotes, 1000),
    items: safeArray(batch?.items).map((item, itemIndex) => cleanAiBatchItem(item, itemIndex, action, id)).filter(Boolean).slice(0, 200)
  };
}

function cleanAiBatchItem(item = {}, index = 0, fallbackAction = '', fallbackBatchId = '') {
  const kanji = cleanText(item?.kanji, 80);
  if (!kanji) return null;
  return {
    ...(item || {}),
    kanji,
    kana: cleanText(item?.kana || item?.reading, 120),
    romaji: cleanText(item?.romaji, 120),
    meaning: cleanText(item?.meaning, 240),
    candidateType: cleanEnum(item?.candidateType, CANDIDATE_TYPE_OPTIONS, '稳定候选'),
    displayBucket: cleanEnum(item?.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term'),
    riskLevel: cleanEnum(item?.riskLevel, RISK_LEVEL_OPTIONS, 'low'),
    confidenceLevel: cleanEnum(item?.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    sourceAction: cleanText(item?.sourceAction || fallbackAction, 120),
    sourceBatchId: cleanText(item?.sourceBatchId || fallbackBatchId, 120),
    rawRank: clamp(toInt(item?.rawRank, index + 1), 0, 9999),
    rejectedReason: cleanText(item?.rejectedReason, 500),
    selectedForToday: Boolean(item?.selectedForToday)
  };
}

export function cleanAiBatches(batches = []) {
  return safeArray(batches)
    .map((batch, index) => cleanAiBatch(batch, index))
    .filter(Boolean)
    .sort((left, right) => cleanText(right.createdAt, 80).localeCompare(cleanText(left.createdAt, 80)))
    .slice(0, AI_BATCHES_LIMIT);
}

export function cleanAiPreviewItem(item = {}, index = 0) {
  const kanji = cleanText(item?.kanji, 80);
  if (!kanji) return null;
  return {
    ...(item || {}),
    kanji,
    romaji: cleanText(item?.romaji, 120),
    kana: cleanText(item?.kana || item?.reading, 120),
    meaning: cleanText(item?.meaning, 240),
    category: cleanText(item?.category, 80),
    candidateType: cleanEnum(item?.candidateType, CANDIDATE_TYPE_OPTIONS, '稳定候选'),
    freshness: cleanEnum(item?.freshness, FRESHNESS_OPTIONS, ''),
    xhsFitScore: clamp(toInt(item?.xhsFitScore ?? item?.lastScore, 60), 0, 100),
    riskLevel: cleanEnum(item?.riskLevel, RISK_LEVEL_OPTIONS, 'low'),
    riskWarning: cleanText(item?.riskWarning, 500),
    emotionTone: cleanEnum(item?.emotionTone, EMOTION_TONE_OPTIONS, 'neutral'),
    confidenceLevel: cleanEnum(item?.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    evidenceType: cleanEnum(item?.evidenceType, EVIDENCE_TYPE_OPTIONS, 'common_usage'),
    reviewReason: cleanText(item?.reviewReason, 500),
    reviewReasonType: cleanEnum(item?.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, ''),
    displayBucket: cleanEnum(item?.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term'),
    reason: cleanText(item?.reason, 1000),
    suggestedAction: cleanEnum(item?.suggestedAction, SUGGESTED_ACTION_OPTIONS, '可以收藏观察'),
    examples: safeArray(item?.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: uniqueStrings(item?.suggestedTitles, 140, 8),
    coverSuggestion: cleanCoverSuggestion(item?.coverSuggestion || {}),
    sourceType: normalizeSourceType(item?.sourceType || 'deepseek_generated'),
    sourcePromptType: cleanEnum(item?.sourcePromptType, SOURCE_PROMPT_OPTIONS, ''),
    sourceText: cleanText(item?.sourceText, 12000),
    sourceTags: uniqueStrings(item?.sourceTags, 80, 12),
    aiBatchId: cleanText(item?.aiBatchId, 120),
    importState: cleanEnum(item?.importState, ['new', 'imported', 'skipped'], item?.imported ? 'imported' : item?.skipped ? 'skipped' : 'new'),
    importedAt: isIsoLike(item?.importedAt) ? item.importedAt : '',
    skippedAt: isIsoLike(item?.skippedAt) ? item.skippedAt : '',
    updatedAt: isIsoLike(item?.updatedAt) ? item.updatedAt : '',
    previewIndex: clamp(toInt(item?.previewIndex, index), 0, 9999)
  };
}

export function cleanAiPreview(preview = {}) {
  const rawItems = safeArray(preview?.items)
    .map((item, index) => cleanAiPreviewItem(item, index))
    .filter(Boolean)
    .slice(0, AI_PREVIEW_ITEMS_LIMIT);
  const itemSet = new Set(rawItems.map(item => item.kanji));
  const selected = uniqueStrings(preview?.selected, 80, AI_PREVIEW_ITEMS_LIMIT)
    .filter(kanji => itemSet.has(kanji));
  return {
    ...(preview || {}),
    items: rawItems,
    selected,
    savedAt: isIsoLike(preview?.savedAt) ? preview.savedAt : '',
    batchId: cleanText(preview?.batchId, 120),
    createdBy: cleanText(preview?.createdBy || 'team', 120)
  };
}

export function cleanTeamDismissed(dismissed = {}) {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(dismissed?.dateKey, 20)) ? cleanText(dismissed.dateKey, 20) : '';
  return {
    ...(dismissed || {}),
    dateKey,
    words: uniqueStrings(dismissed?.words, 80, TEAM_DISMISSED_WORDS_LIMIT),
    updatedAt: isIsoLike(dismissed?.updatedAt) ? dismissed.updatedAt : ''
  };
}

export function cleanTodaySnapshot(snapshot = {}) {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(snapshot?.dateKey, 20)) ? cleanText(snapshot.dateKey, 20) : '';
  const words = cleanWords(snapshot?.words).slice(0, 20);
  return {
    ...(snapshot || {}),
    dateKey,
    words,
    generatedAt: isIsoLike(snapshot?.generatedAt) ? snapshot.generatedAt : '',
    source: cleanText(snapshot?.source || 'candidatePool', 80) || 'candidatePool',
    batchIds: uniqueStrings(snapshot?.batchIds, 120, 30),
    version: clamp(toInt(snapshot?.version, words.length ? TODAY_SNAPSHOT_VERSION : 0), 0, 999),
    generatorVersion: cleanText(snapshot?.generatorVersion, 80),
    createdBy: cleanEnum(snapshot?.createdBy, ['server', 'frontend', 'worker', 'manual'], ''),
    dedupDaysUsed: clamp(toInt(snapshot?.dedupDaysUsed, 0), 0, 365),
    relaxedDedup: Boolean(snapshot?.relaxedDedup),
    shortage: Boolean(snapshot?.shortage),
    repeated30Count: clamp(toInt(snapshot?.repeated30Count, 0), 0, 20),
    repeated30Words: uniqueStrings(snapshot?.repeated30Words, 80, 20),
    recommendationAudit: cleanRecommendationAuditSummary(snapshot?.recommendationAudit || {})
  };
}

export function cleanHistorySnapshot(snapshot = {}, fallbackDateKey = '') {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(snapshot?.dateKey, 20))
    ? cleanText(snapshot.dateKey, 20)
    : (/^\d{4}-\d{2}-\d{2}$/.test(cleanText(fallbackDateKey, 20)) ? cleanText(fallbackDateKey, 20) : '');
  const words = cleanWords(snapshot?.words).slice(0, 20);
  return {
    ...(snapshot || {}),
    dateKey,
    words,
    generatedAt: isIsoLike(snapshot?.generatedAt) ? snapshot.generatedAt : '',
    source: cleanText(snapshot?.source || 'todaySnapshot', 80) || 'todaySnapshot',
    batchIds: uniqueStrings(snapshot?.batchIds, 120, 30),
    version: clamp(toInt(snapshot?.version, words.length ? TODAY_SNAPSHOT_VERSION : 1), 1, 999),
    generatorVersion: cleanText(snapshot?.generatorVersion, 80),
    createdBy: cleanEnum(snapshot?.createdBy, ['server', 'frontend', 'worker', 'manual'], ''),
    dedupDaysUsed: clamp(toInt(snapshot?.dedupDaysUsed, 0), 0, 365),
    relaxedDedup: Boolean(snapshot?.relaxedDedup),
    shortage: Boolean(snapshot?.shortage),
    repeated30Count: clamp(toInt(snapshot?.repeated30Count, 0), 0, 20),
    repeated30Words: uniqueStrings(snapshot?.repeated30Words, 80, 20),
    archivedAt: isIsoLike(snapshot?.archivedAt) ? snapshot.archivedAt : '',
    title: cleanText(snapshot?.title || '今日 AI 候选归档', 120),
    recommendationAudit: cleanRecommendationAuditSummary(snapshot?.recommendationAudit || {})
  };
}

export function cleanHistorySnapshots(snapshots = {}) {
  return Object.entries(snapshots || {}).reduce((result, [dateKey, snapshot]) => {
    const cleanSnapshot = cleanHistorySnapshot(snapshot, dateKey);
    if (cleanSnapshot.dateKey && cleanSnapshot.words.length) result[cleanSnapshot.dateKey] = cleanSnapshot;
    return result;
  }, {});
}

export function cleanTodaySnapshotHistory(history = []) {
  const byDate = new Map();
  safeArray(history).forEach(snapshot => {
    const cleanSnapshot = cleanHistorySnapshot(snapshot, snapshot?.dateKey);
    if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return;
    const current = byDate.get(cleanSnapshot.dateKey);
    if (!current) {
      byDate.set(cleanSnapshot.dateKey, cleanSnapshot);
      return;
    }
    if (cleanSnapshot.version !== current.version) {
      byDate.set(cleanSnapshot.dateKey, cleanSnapshot.version > current.version ? cleanSnapshot : current);
      return;
    }
    byDate.set(cleanSnapshot.dateKey, cleanText(cleanSnapshot.generatedAt || cleanSnapshot.archivedAt, 80) >= cleanText(current.generatedAt || current.archivedAt, 80) ? cleanSnapshot : current);
  });
  return [...byDate.values()]
    .sort((left, right) => cleanText(right.dateKey, 20).localeCompare(cleanText(left.dateKey, 20)))
    .slice(0, TODAY_SNAPSHOT_HISTORY_LIMIT);
}

export function archiveTodaySnapshotIntoSnapshotHistory(history = [], snapshot = {}) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return cleanTodaySnapshotHistory(history);
  return cleanTodaySnapshotHistory([
    {
      dateKey: cleanSnapshot.dateKey,
      words: cleanSnapshot.words,
      generatedAt: cleanSnapshot.generatedAt,
      source: 'todaySnapshot',
      batchIds: cleanSnapshot.batchIds,
      version: cleanSnapshot.version || TODAY_SNAPSHOT_VERSION,
      generatorVersion: cleanSnapshot.generatorVersion,
      createdBy: cleanSnapshot.createdBy,
      dedupDaysUsed: cleanSnapshot.dedupDaysUsed,
      relaxedDedup: cleanSnapshot.relaxedDedup,
      shortage: cleanSnapshot.shortage,
      repeated30Count: cleanSnapshot.repeated30Count,
      repeated30Words: cleanSnapshot.repeated30Words,
      recommendationAudit: cleanSnapshot.recommendationAudit,
      archivedAt: new Date().toISOString(),
      title: '每日热门归档'
    },
    ...safeArray(history)
  ]);
}

export function archiveTodaySnapshotIntoHistory(historySnapshots = {}, snapshot = {}) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return cleanHistorySnapshots(historySnapshots);
  const current = cleanHistorySnapshots(historySnapshots)[cleanSnapshot.dateKey];
  const archivedAt = new Date().toISOString();
  return cleanHistorySnapshots({
    ...historySnapshots,
    [cleanSnapshot.dateKey]: {
      ...(current || {}),
      dateKey: cleanSnapshot.dateKey,
      words: cleanSnapshot.words,
      generatedAt: cleanSnapshot.generatedAt,
      source: 'todaySnapshot',
      batchIds: cleanSnapshot.batchIds,
      version: cleanSnapshot.version || TODAY_SNAPSHOT_VERSION,
      generatorVersion: cleanSnapshot.generatorVersion,
      createdBy: cleanSnapshot.createdBy,
      dedupDaysUsed: cleanSnapshot.dedupDaysUsed,
      relaxedDedup: cleanSnapshot.relaxedDedup,
      shortage: cleanSnapshot.shortage,
      repeated30Count: cleanSnapshot.repeated30Count,
      repeated30Words: cleanSnapshot.repeated30Words,
      recommendationAudit: cleanSnapshot.recommendationAudit,
      archivedAt,
      title: '今日 AI 候选归档'
    }
  });
}

export function cleanStoredWorkflow(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  const words = cleanWords(source.words);
  const todaySnapshot = cleanTodaySnapshot(source.todaySnapshot);
  const historySnapshots = archiveTodaySnapshotIntoHistory(cleanHistorySnapshots(source.historySnapshots), todaySnapshot);
  const todaySnapshotHistory = archiveTodaySnapshotIntoSnapshotHistory(cleanTodaySnapshotHistory(source.todaySnapshotHistory), todaySnapshot);
  return {
    words,
    statuses: cleanStatuses(source.statuses, words),
    feedback: cleanFeedback(source.feedback),
    publishedRecords: cleanPublishedRecords(source.publishedRecords),
    candidatePool: cleanCandidatePool(source.candidatePool),
    aiBatches: cleanAiBatches(source.aiBatches),
    aiPreview: cleanAiPreview(source.aiPreview),
    todaySnapshot,
    todayDismissed: cleanTeamDismissed(source.todayDismissed || source.teamDismissed),
    historySnapshots,
    todaySnapshotHistory,
    updated: isIsoLike(source.updated) ? source.updated : null,
    schemaVersion: clamp(toInt(source.schemaVersion, SCHEMA_VERSION), 1, 999)
  };
}

export function isCurrentGeneratorSnapshot(snapshot = {}, now = new Date()) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  return cleanSnapshot.dateKey === workflowDateKey(now)
    && cleanSnapshot.words.length > 0
    && cleanSnapshot.generatorVersion === TODAY_SNAPSHOT_GENERATOR_VERSION;
}

export function stripInvalidCurrentTodaySnapshot(workflow = {}, now = new Date()) {
  const cleanWorkflow = cleanStoredWorkflow(workflow);
  const snapshot = cleanTodaySnapshot(cleanWorkflow.todaySnapshot);
  if (
    snapshot.dateKey === workflowDateKey(now)
    && snapshot.words.length > 0
    && snapshot.generatorVersion !== TODAY_SNAPSHOT_GENERATOR_VERSION
  ) {
    return cleanStoredWorkflow({
      ...cleanWorkflow,
      todaySnapshot: cleanTodaySnapshot({}),
      historySnapshots: archiveTodaySnapshotIntoHistory(cleanWorkflow.historySnapshots, snapshot),
      todaySnapshotHistory: archiveTodaySnapshotIntoSnapshotHistory(cleanWorkflow.todaySnapshotHistory, snapshot)
    });
  }
  return cleanWorkflow;
}

function statusRank(status) {
  return { none: 0, pending: 1, published: 2 }[status] || 0;
}

function mergeStatuses(localStatuses = {}, remoteStatuses = {}, words = []) {
  const allWords = new Set(cleanWords(words));
  const merged = {};
  [...Object.keys(localStatuses || {}), ...Object.keys(remoteStatuses || {})].forEach(word => {
    const cleanWord = cleanText(word, 80);
    if (!cleanWord || !allWords.has(cleanWord)) return;
    const localStatus = cleanEnum(localStatuses?.[cleanWord], STATUS_OPTIONS, 'none');
    const remoteStatus = cleanEnum(remoteStatuses?.[cleanWord], STATUS_OPTIONS, 'none');
    const status = statusRank(localStatus) >= statusRank(remoteStatus) ? localStatus : remoteStatus;
    if (status !== 'none') merged[cleanWord] = status;
  });
  return merged;
}

function mergeFeedback(localFeedback = {}, remoteFeedback = {}) {
  const local = cleanFeedback(localFeedback);
  const remote = cleanFeedback(remoteFeedback);
  const merged = { ...local };
  Object.entries(remote).forEach(([word, remoteRecord]) => {
    const localRecord = merged[word];
    if (!localRecord) {
      merged[word] = remoteRecord;
      return;
    }
    const reasons = { ...(localRecord.reasons || {}) };
    Object.entries(remoteRecord.reasons || {}).forEach(([reason, count]) => {
      reasons[reason] = Math.max(toInt(reasons[reason], 0), toInt(count, 0));
    });
    const winner = newerByDate(localRecord, remoteRecord, 'updatedAt');
    merged[word] = {
      ...localRecord,
      ...remoteRecord,
      reasons,
      lastReason: winner.lastReason || localRecord.lastReason || remoteRecord.lastReason || '',
      updatedAt: latestString(localRecord.updatedAt, remoteRecord.updatedAt),
      needsReview: Boolean(localRecord.needsReview || remoteRecord.needsReview || reasons.inaccurate)
    };
  });
  return cleanFeedback(merged);
}

function mergeStats(left = {}, right = {}) {
  const cleanLeft = cleanStats(left);
  const cleanRight = cleanStats(right);
  return Object.keys(cleanLeft).reduce((result, key) => {
    result[key] = cleanRight[key] > 0 || cleanLeft[key] === 0 ? cleanRight[key] : cleanLeft[key];
    return result;
  }, {});
}

function mergeSnapshots(leftSnapshots = [], rightSnapshots = []) {
  const merged = new Map();
  [...cleanSnapshots(leftSnapshots), ...cleanSnapshots(rightSnapshots)].forEach(snapshot => {
    const current = merged.get(snapshot.nodeType);
    if (!current) {
      merged.set(snapshot.nodeType, snapshot);
      return;
    }
    const winner = newerByDate(current, snapshot, 'capturedAt');
    merged.set(snapshot.nodeType, {
      ...current,
      ...winner,
      ...mergeStats(current, winner),
      capturedAt: latestString(current.capturedAt, snapshot.capturedAt) || ''
    });
  });
  return SNAPSHOT_NODE_ORDER.map(nodeType => merged.get(nodeType) || cleanSnapshot({ nodeType }, nodeType));
}

function mergePublishedRecord(localRecord = {}, remoteRecord = {}) {
  const local = cleanPublishedRecord(localRecord);
  const remote = cleanPublishedRecord(remoteRecord);
  const winner = newerByDate(local, remote, 'updatedAt');
  const fallback = winner === remote ? local : remote;
  return cleanPublishedRecord({
    ...fallback,
    ...winner,
    id: winner.id || fallback.id,
    word: nonEmptyText(winner.word, fallback.word, 80),
    link: nonEmptyText(winner.link, fallback.link, 1000),
    title: nonEmptyText(winner.title, fallback.title, 200),
    description: nonEmptyText(winner.description, fallback.description, 4000),
    authorName: nonEmptyText(winner.authorName, fallback.authorName, 120),
    publishedAt: winner.publishedAt || fallback.publishedAt,
    latestStats: mergeStats(fallback.latestStats, winner.latestStats),
    snapshots: mergeSnapshots(fallback.snapshots, winner.snapshots),
    rating: nonEmptyText(winner.rating, fallback.rating, 40),
    performanceReason: uniqueStrings([...(fallback.performanceReason || []), ...(winner.performanceReason || [])], 80, 8),
    performanceNote: nonEmptyText(winner.performanceNote, fallback.performanceNote, 1000),
    remarks: nonEmptyText(winner.remarks, fallback.remarks, 2000),
    autoRefresh: {
      ...fallback.autoRefresh,
      ...winner.autoRefresh,
      lastAttemptAt: latestString(fallback.autoRefresh?.lastAttemptAt, winner.autoRefresh?.lastAttemptAt) || '',
      lastSuccessAt: latestString(fallback.autoRefresh?.lastSuccessAt, winner.autoRefresh?.lastSuccessAt) || ''
    },
    updatedAt: latestString(local.updatedAt, remote.updatedAt)
  });
}

function mergePublishedRecords(localRecords = [], remoteRecords = []) {
  const merged = new Map();
  [...cleanPublishedRecords(localRecords), ...cleanPublishedRecords(remoteRecords)].forEach(record => {
    const key = record.id || `${record.word}:${record.link || record.title}`;
    const current = merged.get(key);
    merged.set(key, current ? mergePublishedRecord(current, record) : record);
  });
  return [...merged.values()]
    .sort((left, right) => cleanText(right.publishedAt || right.updatedAt, 80).localeCompare(cleanText(left.publishedAt || left.updatedAt, 80)))
    .slice(0, PUBLISHED_RECORDS_LIMIT);
}

function isMeaningfulAiCard(card = {}) {
  const cleanCard = cleanAiCard(card);
  return cleanCard.cardStatus !== 'none'
    || Boolean(cleanCard.summary || cleanCard.explanation || cleanCard.examples.length || cleanCard.suggestedTitles.length);
}

function chooseAiCard(localCard = {}, remoteCard = {}) {
  const local = cleanAiCard(localCard);
  const remote = cleanAiCard(remoteCard);
  const localMeaningful = isMeaningfulAiCard(local);
  const remoteMeaningful = isMeaningfulAiCard(remote);
  if (local.cardStatus === 'ready' && remote.cardStatus !== 'ready') return local;
  if (remote.cardStatus === 'ready' && local.cardStatus !== 'ready') return remote;
  if (!remoteMeaningful) return local;
  if (!localMeaningful) return remote;
  return cleanText(remote.generatedAt, 80) >= cleanText(local.generatedAt, 80) ? remote : local;
}

function mergeAiCardHistory(left = [], right = []) {
  const seen = new Set();
  return [...safeArray(left), ...safeArray(right)]
    .map(cleanAiCard)
    .filter(isMeaningfulAiCard)
    .filter(card => {
      const key = `${card.cardVersion}:${card.generatedAt}:${card.summary}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => cleanText(b.generatedAt, 80).localeCompare(cleanText(a.generatedAt, 80)))
    .slice(0, 10);
}

function chooseSourceType(local = {}, remote = {}) {
  const localType = normalizeSourceType(local.sourceType);
  const remoteType = normalizeSourceType(remote.sourceType);
  if (localType === 'manual_keep' || remoteType === 'manual_keep') return 'manual_keep';
  if (localType === 'deepseek_generated' || remoteType === 'deepseek_generated') return 'deepseek_generated';
  if (localType === 'deepseek_reviewed' || remoteType === 'deepseek_reviewed') return 'deepseek_reviewed';
  return remoteType || localType || 'deepseek_generated';
}

function mergeCandidateEntry(localEntry = {}, remoteEntry = {}) {
  const local = cleanCandidatePoolEntry(localEntry.kanji || remoteEntry.kanji, localEntry);
  const remote = cleanCandidatePoolEntry(remoteEntry.kanji || localEntry.kanji, remoteEntry);
  if (!local) return remote;
  if (!remote) return local;
  const newer = newerByDate(local, remote, 'updatedAt');
  const older = newer === remote ? local : remote;
  const scoreSource = cleanText(remote.lastScoredAt, 80) >= cleanText(local.lastScoredAt, 80) ? remote : local;
  const recommendedSource = cleanText(remote.lastRecommendedAt, 80) >= cleanText(local.lastRecommendedAt, 80) ? remote : local;
  const manualSource = local.manualReviewState || local.manualReviewNote ? local : remote;
  const merged = {
    ...older,
    ...newer,
    kanji: local.kanji || remote.kanji,
    romaji: nonEmptyText(newer.romaji, older.romaji, 120),
    kana: nonEmptyText(newer.kana, older.kana, 120),
    meaning: nonEmptyText(newer.meaning, older.meaning, 240),
    category: nonEmptyText(newer.category, older.category, 80),
    riskWarning: nonEmptyText(newer.riskWarning, older.riskWarning, 500),
    reviewReason: nonEmptyText(newer.reviewReason, older.reviewReason, 500),
    reason: nonEmptyText(newer.reason, older.reason, 1000),
    aiCard: chooseAiCard(local.aiCard, remote.aiCard),
    aiCardHistory: mergeAiCardHistory(local.aiCardHistory, remote.aiCardHistory),
    examples: [...safeArray(local.examples), ...safeArray(remote.examples)].map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: uniqueStrings([...(local.suggestedTitles || []), ...(remote.suggestedTitles || [])], 140, 8),
    coverSuggestion: {
      ...local.coverSuggestion,
      ...remote.coverSuggestion,
      coverText: nonEmptyText(newer.coverSuggestion?.coverText, older.coverSuggestion?.coverText, 120),
      mainVisual: nonEmptyText(newer.coverSuggestion?.mainVisual, older.coverSuggestion?.mainVisual, 240),
      style: nonEmptyText(newer.coverSuggestion?.style, older.coverSuggestion?.style, 160),
      avoid: nonEmptyText(newer.coverSuggestion?.avoid, older.coverSuggestion?.avoid, 240)
    },
    sourceType: chooseSourceType(local, remote),
    sourceTags: uniqueStrings([...(local.sourceTags || []), ...(remote.sourceTags || [])], 80, 12),
    discoverySource: nonEmptyText(newer.discoverySource, older.discoverySource, 80),
    discoveryContext: nonEmptyText(newer.discoveryContext, older.discoveryContext, 1200),
    extensionFrom: uniqueStrings([...(local.extensionFrom || []), ...(remote.extensionFrom || [])], 80, 12),
    importedAt: earliestString(local.importedAt, remote.importedAt),
    firstSeenAt: earliestString(local.firstSeenAt, remote.firstSeenAt),
    lastScore: scoreSource.lastScore,
    lastScoredAt: latestString(local.lastScoredAt, remote.lastScoredAt),
    lastRecommendedAt: latestString(local.lastRecommendedAt, remote.lastRecommendedAt),
    recommendationCount: Math.max(toInt(local.recommendationCount, 0), toInt(remote.recommendationCount, 0)),
    ignoredCount: Math.max(toInt(local.ignoredCount, 0), toInt(remote.ignoredCount, 0)),
    recommendationAudit: cleanRecommendationAuditTrace(recommendedSource.recommendationAudit || newer.recommendationAudit || older.recommendationAudit || {}),
    wasRecommended: Boolean(local.wasRecommended || remote.wasRecommended),
    lastOrigin: recommendedSource.lastOrigin || newer.lastOrigin,
    lastConfidenceLevel: recommendedSource.lastConfidenceLevel || newer.lastConfidenceLevel,
    manualReviewState: manualSource.manualReviewState || '',
    manualReviewNote: manualSource.manualReviewNote || '',
    lastBreakdown: {
      ...(older.lastBreakdown || {}),
      ...(newer.lastBreakdown || {})
    },
    updatedAt: latestString(local.updatedAt, remote.updatedAt)
  };
  return cleanCandidatePoolEntry(merged.kanji, merged);
}

function mergeCandidatePool(localPool = {}, remotePool = {}) {
  const merged = new Map();
  Object.values(cleanCandidatePool(localPool)).forEach(entry => merged.set(entry.kanji, entry));
  Object.values(cleanCandidatePool(remotePool)).forEach(entry => {
    const current = merged.get(entry.kanji);
    merged.set(entry.kanji, current ? mergeCandidateEntry(current, entry) : entry);
  });
  return [...merged.values()].reduce((result, entry) => {
    result[entry.kanji] = entry;
    return result;
  }, {});
}

function mergeAiBatches(localBatches = [], remoteBatches = []) {
  const merged = new Map();
  [...cleanAiBatches(localBatches), ...cleanAiBatches(remoteBatches)].forEach(batch => {
    const current = merged.get(batch.id);
    if (!current) {
      merged.set(batch.id, batch);
      return;
    }
    const winner = cleanText(batch.createdAt, 80) >= cleanText(current.createdAt, 80) ? batch : current;
    const fallback = winner === batch ? current : batch;
    merged.set(batch.id, cleanAiBatch({
      ...fallback,
      ...winner,
      rawCount: Math.max(toInt(fallback.rawCount, 0), toInt(winner.rawCount, 0)),
      normalizedCount: Math.max(toInt(fallback.normalizedCount, 0), toInt(winner.normalizedCount, 0)),
      acceptedCount: Math.max(toInt(fallback.acceptedCount, 0), toInt(winner.acceptedCount, 0)),
      rejectedCount: Math.max(toInt(fallback.rejectedCount, 0), toInt(winner.rejectedCount, 0)),
      importedCount: Math.max(toInt(fallback.importedCount, 0), toInt(winner.importedCount, 0)),
      skippedCount: Math.max(toInt(fallback.skippedCount, 0), toInt(winner.skippedCount, 0)),
      rawOutput: winner.rawOutput || fallback.rawOutput,
      normalizedOutput: winner.normalizedOutput || fallback.normalizedOutput,
      items: safeArray(winner.items).length >= safeArray(fallback.items).length ? winner.items : fallback.items
    }));
  });
  return [...merged.values()]
    .sort((left, right) => cleanText(right.createdAt, 80).localeCompare(cleanText(left.createdAt, 80)))
    .slice(0, AI_BATCHES_LIMIT);
}

function chooseAiPreview(localPreview = {}, remotePreview = {}) {
  const local = cleanAiPreview(localPreview);
  const remote = cleanAiPreview(remotePreview);
  if (!local.items.length) return remote;
  if (!remote.items.length) return local;
  return cleanText(remote.savedAt, 80) >= cleanText(local.savedAt, 80) ? remote : local;
}

function mergeTeamDismissed(localDismissed = {}, remoteDismissed = {}) {
  const local = cleanTeamDismissed(localDismissed);
  const remote = cleanTeamDismissed(remoteDismissed);
  if (!local.dateKey) return remote;
  if (!remote.dateKey) return local;
  if (local.dateKey !== remote.dateKey) return cleanText(local.dateKey, 20) >= cleanText(remote.dateKey, 20) ? local : remote;
  return cleanTeamDismissed({
    dateKey: local.dateKey,
    words: uniqueStrings([...(local.words || []), ...(remote.words || [])], 80, TEAM_DISMISSED_WORDS_LIMIT),
    updatedAt: latestString(local.updatedAt, remote.updatedAt) || ''
  });
}

function chooseTodaySnapshot(localSnapshot = {}, remoteSnapshot = {}) {
  const local = cleanTodaySnapshot(localSnapshot);
  const remote = cleanTodaySnapshot(remoteSnapshot);
  if (!local.words.length) return remote;
  if (!remote.words.length) return local;
  if (local.dateKey !== remote.dateKey) return cleanText(local.dateKey, 20) >= cleanText(remote.dateKey, 20) ? local : remote;
  if (local.version !== remote.version) return local.version > remote.version ? local : remote;
  return cleanText(local.generatedAt, 80) >= cleanText(remote.generatedAt, 80) ? local : remote;
}

function mergeHistorySnapshots(localSnapshots = {}, remoteSnapshots = {}) {
  const merged = new Map();
  [...Object.values(cleanHistorySnapshots(localSnapshots)), ...Object.values(cleanHistorySnapshots(remoteSnapshots))].forEach(snapshot => {
    const current = merged.get(snapshot.dateKey);
    if (!current) {
      merged.set(snapshot.dateKey, snapshot);
      return;
    }
    if (snapshot.version !== current.version) {
      merged.set(snapshot.dateKey, snapshot.version > current.version ? snapshot : current);
      return;
    }
    merged.set(snapshot.dateKey, cleanText(snapshot.archivedAt || snapshot.generatedAt, 80) >= cleanText(current.archivedAt || current.generatedAt, 80) ? snapshot : current);
  });
  return [...merged.values()]
    .sort((left, right) => cleanText(right.dateKey, 20).localeCompare(cleanText(left.dateKey, 20)))
    .slice(0, HISTORY_SNAPSHOTS_LIMIT)
    .reduce((result, snapshot) => {
      result[snapshot.dateKey] = snapshot;
      return result;
    }, {});
}

function mergeTodaySnapshotHistory(localHistory = [], remoteHistory = []) {
  return cleanTodaySnapshotHistory([...safeArray(localHistory), ...safeArray(remoteHistory)]);
}

export function mergeWorkflow(localWorkflow = {}, remoteWorkflow = {}) {
  const local = cleanStoredWorkflow(localWorkflow);
  const remote = cleanStoredWorkflow(remoteWorkflow);
  const words = cleanWords([...local.words, ...remote.words]);
  const todaySnapshot = chooseTodaySnapshot(local.todaySnapshot, remote.todaySnapshot);
  const historySnapshots = archiveTodaySnapshotIntoHistory(mergeHistorySnapshots(local.historySnapshots, remote.historySnapshots), todaySnapshot);
  const todaySnapshotHistory = archiveTodaySnapshotIntoSnapshotHistory(mergeTodaySnapshotHistory(local.todaySnapshotHistory, remote.todaySnapshotHistory), todaySnapshot);
  return cleanStoredWorkflow({
    words,
    statuses: mergeStatuses(local.statuses, remote.statuses, words),
    feedback: mergeFeedback(local.feedback, remote.feedback),
    publishedRecords: mergePublishedRecords(local.publishedRecords, remote.publishedRecords),
    candidatePool: mergeCandidatePool(local.candidatePool, remote.candidatePool),
    aiBatches: mergeAiBatches(local.aiBatches, remote.aiBatches),
    aiPreview: chooseAiPreview(local.aiPreview, remote.aiPreview),
    todaySnapshot,
    todayDismissed: mergeTeamDismissed(local.todayDismissed, remote.todayDismissed),
    historySnapshots,
    todaySnapshotHistory,
    updated: latestString(local.updated, remote.updated),
    schemaVersion: Math.max(local.schemaVersion || SCHEMA_VERSION, remote.schemaVersion || SCHEMA_VERSION)
  });
}

export function mergeWorkflowForFullSave(currentWorkflow = {}, incomingWorkflow = {}) {
  const current = cleanStoredWorkflow(currentWorkflow);
  const incomingRaw = incomingWorkflow && typeof incomingWorkflow === 'object' ? incomingWorkflow : {};
  const incoming = cleanStoredWorkflow({ ...current, ...incomingRaw });
  const merged = mergeWorkflow(current, incoming);
  return stripInvalidCurrentTodaySnapshot(cleanStoredWorkflow({
    ...merged,
    words: Array.isArray(incomingRaw.words) ? incoming.words : current.words,
    statuses: incomingRaw.statuses ? incoming.statuses : current.statuses,
    feedback: incomingRaw.feedback ? mergeFeedback(current.feedback, incoming.feedback) : current.feedback,
    publishedRecords: incomingRaw.publishedRecords ? mergePublishedRecords(current.publishedRecords, incoming.publishedRecords) : current.publishedRecords,
    candidatePool: incomingRaw.candidatePool ? mergeCandidatePool(current.candidatePool, incoming.candidatePool) : current.candidatePool,
    aiBatches: incomingRaw.aiBatches ? mergeAiBatches(current.aiBatches, incoming.aiBatches) : current.aiBatches,
    aiPreview: incomingRaw.aiPreview ? cleanAiPreview(incoming.aiPreview) : current.aiPreview,
    todaySnapshot: incomingRaw.todaySnapshot ? chooseTodaySnapshot(current.todaySnapshot, incoming.todaySnapshot) : current.todaySnapshot,
    todayDismissed: incomingRaw.todayDismissed || incomingRaw.teamDismissed ? mergeTeamDismissed(current.todayDismissed, incoming.todayDismissed) : current.todayDismissed,
    historySnapshots: incomingRaw.historySnapshots ? mergeHistorySnapshots(current.historySnapshots, incoming.historySnapshots) : current.historySnapshots,
    todaySnapshotHistory: incomingRaw.todaySnapshotHistory ? mergeTodaySnapshotHistory(current.todaySnapshotHistory, incoming.todaySnapshotHistory) : current.todaySnapshotHistory,
    updated: isIsoLike(incomingRaw.updated) ? incomingRaw.updated : new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION
  }));
}

export {
  SCHEMA_VERSION,
  SOURCE_PROMPT_OPTIONS,
  PROMPT_VERSION_BY_ACTION
};

import { getAccountLearningSummary } from './account-learning.mjs';
import { DAILY_WORD_COUNT, MAX_DAILY_S_LEVEL_COUNT } from './daily-config.mjs';
import { addDays, cleanDateKey, dateKey } from './rankings.mjs';
import { buildPublishedLearningSummary } from './published-import.mjs';
import { buildTodayRecommendationAudit } from './today-snapshot.mjs';
import {
  DAILY_CONTENT_MIX_TARGETS,
  DAILY_EXPRESSION_FORM_MAXIMA,
  getDailyContentMixLane
} from './today-quality.mjs';
import {
  archiveTodaySnapshotIntoHistory,
  archiveTodaySnapshotIntoSnapshotHistory,
  cleanAiCard,
  cleanCandidatePoolEntry,
  cleanStoredWorkflow,
  cleanTodaySnapshot,
  TODAY_SNAPSHOT_GENERATOR_VERSION
} from './workflow-schema.mjs';

export const CODEX_DAILY_DRAFT_VERSION = 1;
export const CODEX_DAILY_GENERATOR_VERSION = 'codex-daily-v1';
export const CODEX_DAILY_WORD_COUNT = DAILY_WORD_COUNT;
export const CODEX_DAILY_DRAFT_TTL_SECONDS = 8 * 24 * 60 * 60;
export const CODEX_DAILY_DRAFT_TARGET_GRACE_SECONDS = 8 * 24 * 60 * 60;
export const CODEX_DAILY_MAX_BACKFILL_COUNT = 2;
export const CODEX_DAILY_BACKFILL_RECHECK_DAYS = 180;
export const CODEX_DAILY_STRICT_QUALITY_GATE_START_DATE = '2026-08-17';
export const CODEX_Z_GENERATION_DISCOVERY_SOURCE = Object.freeze({
  id: 'z_generation',
  label: 'Z 世代趋势来源',
  sourceTag: 'z世代',
  requiredCheck: true,
  hardQuota: false,
  minimumAccepted: 0,
  checkInstruction: '每次周计划开始前检索并查看当期公开的 Z 世代流行语或趋势榜单；没有通过质量门的词时允许采用 0 个。',
  sourceExamples: ['Simeji 排名', 'Z 总研 / alpha 世代研究', 'JC・JK 流行语大赏', 'Trepo', 'SHIBUYA109 lab.'],
  qualityGates: [
    '先进入可复核候选，不因来源直接进入每日推荐或正式发布。',
    '排除已收藏、待发布、已发布、近 30 天出现及本周计划重复词。',
    '核实词义、真实用例、时间证据、风险、稳定度和账号收藏价值。',
    '不为凑数量降低现有内容结构、证据、置信度、风险或可视化质量门。',
    '最终采用的词在 sourceTags 中保留精确标签 z世代；标签本身不提供排名加分。'
  ]
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function isIsoLike(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function dateDistance(targetDateKey, previousDateKey) {
  const target = cleanDateKey(targetDateKey);
  const previous = cleanDateKey(previousDateKey);
  if (!target || !previous) return Infinity;
  return Math.round((Date.parse(`${target}T00:00:00.000Z`) - Date.parse(`${previous}T00:00:00.000Z`)) / 86400000);
}

export function getCodexDraftStorageKey(targetDateKey, scope = 'global') {
  const cleanTarget = cleanDateKey(targetDateKey);
  const cleanScope = cleanText(scope, 64).replace(/[^a-zA-Z0-9_-]/g, '') || 'global';
  return cleanTarget ? `codex-draft:${cleanScope}:${cleanTarget}` : '';
}

export function getCodexDailyDraftTtlSeconds(targetDateKey, now = new Date()) {
  const cleanTarget = cleanDateKey(targetDateKey);
  const nowTimestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!cleanTarget || !Number.isFinite(nowTimestamp)) return CODEX_DAILY_DRAFT_TTL_SECONDS;

  const targetStartTimestamp = Date.parse(`${cleanTarget}T00:00:00+08:00`);
  if (!Number.isFinite(targetStartTimestamp)) return CODEX_DAILY_DRAFT_TTL_SECONDS;

  const secondsUntilTargetGraceEnds = Math.ceil(
    (targetStartTimestamp - nowTimestamp) / 1000
  ) + CODEX_DAILY_DRAFT_TARGET_GRACE_SECONDS;
  return Math.max(CODEX_DAILY_DRAFT_TTL_SECONDS, secondsUntilTargetGraceEnds);
}

function cleanDraftItem(item = {}, index = 0) {
  const generatedAt = isIsoLike(item?.generatedAt) ? item.generatedAt : new Date().toISOString();
  const aiCard = cleanAiCard({
    ...(item?.aiCard || {}),
    cardStatus: item?.aiCard?.cardStatus || 'ready',
    cardSource: 'codex',
    cardModel: cleanText(item?.aiCard?.cardModel || item?.model || 'codex', 120),
    generatedAt: item?.aiCard?.generatedAt || generatedAt
  });
  const entry = cleanCandidatePoolEntry(item?.kanji || item?.word, {
    ...(item || {}),
    aiCard,
    sourceType: 'codex_generated',
    sourcePromptVersion: cleanText(item?.sourcePromptVersion || CODEX_DAILY_GENERATOR_VERSION, 80),
    displayBucket: item?.displayBucket || 'today',
    riskLevel: item?.riskLevel || 'low',
    confidenceLevel: item?.confidenceLevel || 'high',
    evidenceType: item?.evidenceType || 'common_usage',
    lastReviewState: item?.lastReviewState || 'ready',
    importedAt: item?.importedAt || generatedAt,
    updatedAt: generatedAt
  });
  if (!entry) return null;
  const score = clamp(item?.finalScore ?? item?.lastScore ?? item?.xhsFitScore ?? 82, 0, 100);
  return {
    ...entry,
    order: index,
    xhsFitScore: score,
    lastScore: score,
    finalScore: score,
    sourceType: 'codex_generated',
    aiCard
  };
}

export function cleanCodexDailyDraft(input = {}) {
  const targetDateKey = cleanDateKey(input?.targetDateKey || input?.dateKey);
  const seen = new Set();
  const items = safeArray(input?.items)
    .slice(0, 40)
    .map(cleanDraftItem)
    .filter(item => item && !seen.has(item.kanji) && seen.add(item.kanji));
  const imageReadyCount = items.filter(item => (
    item.aiCard?.referenceImage?.status === 'ready' && item.aiCard.referenceImage.url
  )).length;
  const cardReadyCount = items.filter(item => item.aiCard?.cardStatus === 'ready').length;
  const publishedAt = isIsoLike(input?.publishedAt) ? input.publishedAt : '';
  return {
    schemaVersion: CODEX_DAILY_DRAFT_VERSION,
    targetDateKey,
    status: publishedAt ? 'published' : 'draft',
    generatedBy: 'codex',
    generatorVersion: cleanText(input?.generatorVersion || CODEX_DAILY_GENERATOR_VERSION, 80),
    threadId: cleanText(input?.threadId, 120),
    createdAt: isIsoLike(input?.createdAt) ? input.createdAt : new Date().toISOString(),
    updatedAt: isIsoLike(input?.updatedAt) ? input.updatedAt : new Date().toISOString(),
    submittedAt: isIsoLike(input?.submittedAt) ? input.submittedAt : '',
    publishedAt,
    operationId: cleanText(input?.operationId, 120),
    notes: cleanText(input?.notes, 2000),
    items,
    wordCount: items.length,
    cardReadyCount,
    imageReadyCount,
    validation: {
      valid: false,
      errors: [],
      warnings: [],
      qualitySummary: null,
      recommendationAudit: null,
      repeated30Words: []
    }
  };
}

function collectCardQualityIssues(card = {}) {
  const cleanCard = cleanAiCard(card);
  const issues = [];
  if (cleanCard.cardStatus !== 'ready') issues.push('cardStatus 不是 ready');
  if (!cleanCard.summary) issues.push('缺少 summary');
  if (!cleanCard.explanation) issues.push('缺少 explanation');
  if (!cleanCard.usageScenes.length) issues.push('缺少 usageScenes');
  if (cleanCard.examples.length < 2 || cleanCard.examples.length > 4) {
    issues.push(`例句数量应为 2-4 条，当前 ${cleanCard.examples.length}`);
  }
  cleanCard.examples.forEach((example, index) => {
    const missing = ['jp', 'kana', 'romaji', 'cn'].filter(field => !cleanText(example?.[field], 500));
    if (!cleanText(example?.note || example?.source, 500)) missing.push('note/source');
    if (missing.length) issues.push(`例句 ${index + 1} 缺少 ${missing.join('/')}`);
  });
  if (cleanCard.suggestedTitles.length < 3 || cleanCard.suggestedTitles.length > 6) {
    issues.push(`推荐标题应为 3-6 条，当前 ${cleanCard.suggestedTitles.length}`);
  }
  if (!cleanCard.coverSuggestion.coverText) issues.push('缺少 coverSuggestion.coverText');
  if (!cleanCard.coverSuggestion.mainVisual) issues.push('缺少 coverSuggestion.mainVisual');
  if (!cleanCard.coverSuggestion.style) issues.push('缺少 coverSuggestion.style');
  if (!cleanCard.coverSuggestion.avoid) issues.push('缺少 coverSuggestion.avoid');
  if (cleanCard.contentAngles.length < 3 || cleanCard.contentAngles.length > 6) {
    issues.push(`内容角度应为 3-6 条，当前 ${cleanCard.contentAngles.length}`);
  }
  if (!cleanCard.targetAudience) issues.push('缺少 targetAudience');
  if (!cleanCard.referenceDirection) issues.push('缺少 referenceDirection');
  if (!cleanCard.riskWarning) issues.push('缺少 riskWarning');
  if (!cleanCard.wrongUsage) issues.push('缺少 wrongUsage');
  if (!cleanCard.similarWords.length) issues.push('缺少 similarWords');
  cleanCard.similarWords.forEach((similar, index) => {
    if (!similar.word || !similar.difference) issues.push(`相近词 ${index + 1} 缺少词或语感差异`);
  });
  if (cleanCard.interactionPrompts.length < 2 || cleanCard.interactionPrompts.length > 4) {
    issues.push(`互动引导应为 2-4 条，当前 ${cleanCard.interactionPrompts.length}`);
  }
  return [...new Set(issues)];
}

function hasLegacyCompleteCard(card = {}) {
  const cleanCard = cleanAiCard(card);
  return cleanCard.cardStatus === 'ready'
    && Boolean(cleanCard.summary)
    && Boolean(cleanCard.explanation)
    && cleanCard.examples.length >= 2
    && cleanCard.suggestedTitles.length >= 2
    && Boolean(cleanCard.coverSuggestion.coverText)
    && Boolean(cleanCard.coverSuggestion.mainVisual);
}

function collectRecentWords(workflowInput = {}, targetDateKey = '') {
  const workflow = cleanStoredWorkflow(workflowInput);
  const records = new Map();
  const add = snapshot => {
    const snapshotDateKey = cleanDateKey(snapshot?.dateKey);
    const distance = dateDistance(targetDateKey, snapshotDateKey);
    if (!snapshotDateKey || distance < 1 || distance > 30) return;
    safeArray(snapshot?.words).forEach(word => {
      const cleanWord = cleanText(word, 80);
      if (cleanWord && !records.has(cleanWord)) records.set(cleanWord, snapshotDateKey);
    });
  };
  add(workflow.todaySnapshot);
  Object.values(workflow.historySnapshots || {}).forEach(add);
  workflow.todaySnapshotHistory.forEach(add);
  return records;
}

function countByLane(entries = []) {
  return entries.reduce((result, entry) => {
    const lane = getDailyContentMixLane(entry);
    result[lane] = (result[lane] || 0) + 1;
    return result;
  }, Object.keys(DAILY_CONTENT_MIX_TARGETS).reduce((result, lane) => ({ ...result, [lane]: 0 }), {}));
}

function isPrimaryDailyCandidate(entry = {}) {
  const lane = getDailyContentMixLane(entry);
  return entry.displayBucket === 'today'
    || (lane === 'verified_trend' && entry.displayBucket === 'meme_fast');
}

export function buildCodexCandidateSupplySummary(workflowInput = {}, targetDateKey = '') {
  const workflow = cleanStoredWorkflow(workflowInput);
  const target = cleanDateKey(targetDateKey);
  const strictQualityGateEnabled = target >= CODEX_DAILY_STRICT_QUALITY_GATE_START_DATE;
  const recentWords = collectRecentWords(workflow, targetDateKey);
  const favoriteWords = new Set(workflow.words);
  const publishedWords = new Set(workflow.publishedRecords.map(record => record.word).filter(Boolean));
  const exclusionCounts = {
    favorited: 0,
    pending_or_published: 0,
    published_record: 0,
    recent_30_days: 0,
    risk_or_review: 0,
    unknown_evidence: 0,
    incomplete: 0
  };
  const eligible = [];
  Object.values(workflow.candidatePool).forEach(entry => {
    let reason = '';
    const lane = getDailyContentMixLane(entry);
    if (favoriteWords.has(entry.kanji)) reason = 'favorited';
    else if (['pending', 'published'].includes(workflow.statuses[entry.kanji])) reason = 'pending_or_published';
    else if (publishedWords.has(entry.kanji)) reason = 'published_record';
    else if (recentWords.has(entry.kanji)) reason = 'recent_30_days';
    else if (
      entry.riskLevel === 'high'
      || ['low', 'review'].includes(entry.confidenceLevel)
      || ['review', 'blocked'].includes(entry.displayBucket)
      || ['watch', 'review', 'rejected'].includes(entry.qualityGateStatus)
      || entry.stabilityLevel === 'review'
    ) reason = 'risk_or_review';
    else if (entry.evidenceType === 'unknown') reason = 'unknown_evidence';
    else if (!entry.kanji || !entry.kana || !entry.meaning) reason = 'incomplete';
    else if (strictQualityGateEnabled && collectItemConsistencyIssues(entry, lane).length) reason = 'incomplete';
    else if (strictQualityGateEnabled && lane === 'verified_trend' && collectTrendProofIssues(entry, target).length) {
      reason = 'incomplete';
    } else if (
      strictQualityGateEnabled
      && !isPrimaryDailyCandidate(entry)
      && collectEvidenceProofIssues(entry, target, {
        subject: '补位词',
        requireHistoricalBackfill: false,
        requireTrendPeriod: lane === 'verified_trend'
      }).length
    ) reason = 'incomplete';
    if (reason) {
      exclusionCounts[reason] += 1;
      return;
    }
    eligible.push(entry);
  });
  const primaryEligible = eligible.filter(isPrimaryDailyCandidate);
  const secondaryEligible = eligible.filter(entry => !isPrimaryDailyCandidate(entry));
  const primaryLaneCounts = countByLane(primaryEligible);
  const eligibleLaneCounts = countByLane(eligible);
  const primaryShortfalls = Object.entries(DAILY_CONTENT_MIX_TARGETS).reduce((result, [lane, target]) => {
    result[lane] = Math.max(0, target - (primaryLaneCounts[lane] || 0));
    return result;
  }, {});
  const discoveryShortfalls = Object.entries(DAILY_CONTENT_MIX_TARGETS).reduce((result, [lane, target]) => {
    result[lane] = Math.max(0, target - (eligibleLaneCounts[lane] || 0));
    return result;
  }, {});
  return {
    totalCandidateCount: Object.keys(workflow.candidatePool).length,
    eligibleCount: eligible.length,
    primaryEligibleCount: primaryEligible.length,
    secondaryEligibleCount: secondaryEligible.length,
    exclusionCounts,
    primaryLaneCounts,
    eligibleLaneCounts,
    contentMixTargets: { ...DAILY_CONTENT_MIX_TARGETS },
    primaryShortfalls,
    discoveryShortfalls,
    needsPrimaryExpansion: Object.values(primaryShortfalls).some(Boolean),
    needsNewDiscovery: Object.values(discoveryShortfalls).some(Boolean)
  };
}

function daysSinceEvidenceCheck(targetDateKey = '', evidenceCheckedAt = '') {
  const target = cleanDateKey(targetDateKey);
  if (!target || !isIsoLike(evidenceCheckedAt)) return Infinity;
  const checked = new Date(evidenceCheckedAt);
  if (Number.isNaN(checked.getTime())) return Infinity;
  return Math.floor((Date.parse(`${target}T23:59:59.999Z`) - checked.getTime()) / 86400000);
}

function hasAbbreviationFullForm(item = {}) {
  const text = [
    item.meaning,
    item.reason,
    item.aiCard?.summary,
    item.aiCard?.explanation,
    ...safeArray(item.aiCard?.usageScenes)
  ].map(value => cleanText(value, 2000)).join(' ');
  const hasAbbreviationMarker = /缩略|縮略|缩写|縮寫|略称|略語|完整形式|完整说法|完整說法/i.test(text);
  const hasNamedFullForm = /「[^」]{3,}」|『[^』]{3,}』|“[^”]{3,}”|"[^"]{3,}"|（[^）]{3,}）|\([^)]{3,}\)|[ァ-ヶー]{6,}/.test(text);
  return hasAbbreviationMarker && hasNamedFullForm;
}

function collectItemConsistencyIssues(item = {}, derivedLane = '') {
  const issues = [];
  if (item.freshness === '需要尽快判断') issues.push('freshness 仍为“需要尽快判断”');
  if (item.stabilityLevel === 'review') issues.push('stabilityLevel 仍为 review');
  if (['watch', 'review', 'rejected'].includes(item.qualityGateStatus)) {
    issues.push(`qualityGateStatus=${item.qualityGateStatus}`);
  }
  if (item.displayBucket === 'meme_fast' && item.evidenceType !== 'trend_claim') {
    issues.push(`meme_fast 必须使用 trend_claim 证据，当前为 ${item.evidenceType || '空'}`);
  }
  if (item.candidateType === '稳定候选' && item.freshness === '需要尽快判断') {
    issues.push('“稳定候选”与“需要尽快判断”互相矛盾');
  }
  if (item.stabilityLevel === 'stable' && ['短期', '需要尽快判断'].includes(item.freshness)) {
    issues.push(`stabilityLevel=stable 与 freshness=${item.freshness} 不一致`);
  }
  if (item.stabilityLevel === 'short_term' && item.freshness === '长期') {
    issues.push('stabilityLevel=short_term 与 freshness=长期 不一致');
  }
  if (item.contentMixLane && item.contentMixLane !== derivedLane) {
    issues.push(`声明分桶 ${item.contentMixLane} 与系统推断 ${derivedLane} 不一致`);
  }
  if (derivedLane === 'daily_abbreviation' && !hasAbbreviationFullForm(item)) {
    issues.push('成熟缩略语未明确说明完整形式');
  }
  return issues;
}

function collectEvidenceProofIssues(item = {}, targetDateKey = '', options = {}) {
  const subject = options.subject || '候选词';
  const issues = [];
  if (options.requireHistoricalBackfill && !item.historicalBackfill) {
    issues.push(`${subject}缺少 historicalBackfill=true 标记`);
  }
  if (item.qualityGateStatus !== 'ready') issues.push(`${subject}缺少 qualityGateStatus=ready 的复核结论`);
  const evidenceAgeDays = daysSinceEvidenceCheck(targetDateKey, item.evidenceCheckedAt);
  if (!Number.isFinite(evidenceAgeDays)) issues.push(`${subject}缺少 evidenceCheckedAt`);
  else if (evidenceAgeDays < 0) issues.push('evidenceCheckedAt 晚于目标日期');
  else if (evidenceAgeDays > CODEX_DAILY_BACKFILL_RECHECK_DAYS) {
    issues.push(`${subject}证据已超过 ${CODEX_DAILY_BACKFILL_RECHECK_DAYS} 天未复核`);
  }
  if (!safeArray(item.evidenceSources).length) issues.push(`${subject}缺少 evidenceSources`);
  if (safeArray(item.realUsageExamples).length < 2) issues.push(`${subject}至少需要 2 条真实用例`);
  if (!item.usageScope) issues.push(`${subject}缺少 usageScope`);
  if (!item.stabilityLevel) issues.push(`${subject}缺少 stabilityLevel`);
  if (options.requireTrendPeriod && !item.trendPeriod) issues.push(`${subject}缺少 trendPeriod`);
  return issues;
}

function collectBackfillProofIssues(item = {}, targetDateKey = '', derivedLane = '') {
  return collectEvidenceProofIssues(item, targetDateKey, {
    subject: '补位词',
    requireHistoricalBackfill: true,
    requireTrendPeriod: derivedLane === 'verified_trend'
  });
}

function collectTrendProofIssues(item = {}, targetDateKey = '') {
  return collectEvidenceProofIssues(item, targetDateKey, {
    subject: '流行词',
    requireHistoricalBackfill: false,
    requireTrendPeriod: true
  });
}

export function validateCodexDailyDraft(input = {}, options = {}) {
  const draft = cleanCodexDailyDraft(input);
  const expectedDateKey = cleanDateKey(options.expectedDateKey);
  const strictQualityGateEnabled = draft.targetDateKey >= CODEX_DAILY_STRICT_QUALITY_GATE_START_DATE;
  const errors = [];
  const warnings = [];
  if (!draft.targetDateKey) errors.push('targetDateKey 必须是有效的 YYYY-MM-DD 日期');
  if (expectedDateKey && draft.targetDateKey !== expectedDateKey) {
    errors.push(`草稿日期 ${draft.targetDateKey || '为空'} 与目标日期 ${expectedDateKey} 不一致`);
  }
  if (draft.wordCount !== CODEX_DAILY_WORD_COUNT) {
    errors.push(`必须恰好提供 ${CODEX_DAILY_WORD_COUNT} 个不重复词，当前为 ${draft.wordCount}`);
  }

  const incompleteWords = draft.items
    .filter(item => !item.kanji || !item.kana || !item.meaning)
    .map(item => item.kanji || '(空词)');
  if (incompleteWords.length) errors.push(`词条基础字段不完整：${incompleteWords.join('、')}`);

  const cardQualityIssues = draft.items.map(item => ({
    kanji: item.kanji,
    issues: collectCardQualityIssues(item.aiCard)
  })).filter(item => item.issues.length);
  const incompleteCardWords = strictQualityGateEnabled
    ? cardQualityIssues.map(item => item.kanji)
    : draft.items.filter(item => !hasLegacyCompleteCard(item.aiCard)).map(item => item.kanji);
  if (incompleteCardWords.length) errors.push(`词卡字段不完整：${incompleteCardWords.join('、')}`);
  if (strictQualityGateEnabled) {
    cardQualityIssues.forEach(item => errors.push(`词卡质量门未通过 ${item.kanji}：${item.issues.join('；')}`));
  }

  const unsafeWords = draft.items
    .filter(item => strictQualityGateEnabled
      ? (
          item.riskLevel === 'high'
          || ['low', 'review'].includes(item.confidenceLevel)
          || item.lastReviewState === 'review'
          || ['review', 'blocked'].includes(item.displayBucket)
          || item.evidenceType === 'unknown'
        )
      : item.riskLevel === 'high' || item.confidenceLevel === 'review' || item.lastReviewState === 'review')
    .map(item => item.kanji);
  if (unsafeWords.length) errors.push(`高风险或待复核词不能自动发布：${unsafeWords.join('、')}`);

  const derivedLaneByWord = new Map(draft.items.map(item => [item.kanji, getDailyContentMixLane(item)]));
  const metadataConflicts = draft.items.map(item => ({
    kanji: item.kanji,
    issues: collectItemConsistencyIssues(item, derivedLaneByWord.get(item.kanji))
  })).filter(item => item.issues.length);
  if (strictQualityGateEnabled) {
    metadataConflicts.forEach(item => errors.push(`候选元数据冲突 ${item.kanji}：${item.issues.join('；')}`));
  }
  const trendProofIssues = draft.items
    .filter(item => derivedLaneByWord.get(item.kanji) === 'verified_trend')
    .map(item => ({
      kanji: item.kanji,
      issues: collectTrendProofIssues(item, draft.targetDateKey)
    }))
    .filter(item => item.issues.length);
  if (strictQualityGateEnabled) {
    trendProofIssues.forEach(item => errors.push(`流行词证据未通过 ${item.kanji}：${item.issues.join('；')}`));
  }

  const recentWords = collectRecentWords(options.workflow || {}, draft.targetDateKey);
  const repeated30Words = draft.items.filter(item => recentWords.has(item.kanji)).map(item => item.kanji);
  if (repeated30Words.length) errors.push(`命中近 30 天重复词：${repeated30Words.join('、')}`);

  const generatedAt = draft.updatedAt || new Date().toISOString();
  const recommendationAudit = buildTodayRecommendationAudit(draft.items, {
    date: draft.targetDateKey,
    mode: 'codex_draft',
    generatedAt,
    dedupDaysUsed: 30,
    relaxedDedup: false
  });
  const qualitySummary = recommendationAudit.qualitySummary || {};
  const auditItemsByWord = new Map(recommendationAudit.items.map(item => [item.kanji, item]));
  const backfillItems = draft.items
    .filter(item => item.historicalBackfill || !isPrimaryDailyCandidate(item))
    .map(item => auditItemsByWord.get(item.kanji) || { kanji: item.kanji });
  qualitySummary.backfillCount = backfillItems.length;
  qualitySummary.metadataConflictCount = metadataConflicts.length;
  qualitySummary.cardQualityIssueCount = cardQualityIssues.length;
  qualitySummary.trendProofIssueCount = trendProofIssues.length;
  const draftItemsByWord = new Map(draft.items.map(item => [item.kanji, item]));
  const backfillProofIssues = backfillItems.map(auditItem => {
    const item = draftItemsByWord.get(auditItem.kanji) || {};
    return {
      kanji: auditItem.kanji,
      issues: collectBackfillProofIssues(item, draft.targetDateKey, derivedLaneByWord.get(auditItem.kanji))
    };
  }).filter(item => item.issues.length);
  if (strictQualityGateEnabled) {
    if (backfillItems.length > CODEX_DAILY_MAX_BACKFILL_COUNT) {
      errors.push(`补位词过多：${backfillItems.length}/${CODEX_DAILY_MAX_BACKFILL_COUNT}，必须继续扩充和筛选候选，不能硬凑 10 个`);
    } else if (backfillItems.length === CODEX_DAILY_MAX_BACKFILL_COUNT) {
      warnings.push(`补位词达到人工复核阈值：${backfillItems.length}/${CODEX_DAILY_MAX_BACKFILL_COUNT}`);
    }
    backfillProofIssues.forEach(item => errors.push(`补位词复核未通过 ${item.kanji}：${item.issues.join('；')}`));
  }
  if (qualitySummary.duplicateClusterCount > 0) {
    errors.push(`存在 ${qualitySummary.duplicateClusterCount} 组同日语义重复`);
  }
  if (qualitySummary.beautyCategoryCount > 1) errors.push('泛美妆品类词同日最多 1 个');
  if (qualitySummary.basicPoliteCount > 1) errors.push('基础寒暄或教材礼貌词同日最多 1 个');
  const missingCoverage = safeArray(qualitySummary.relaxedReasons).filter(reason => reason.endsWith('_below_target'));
  if (missingCoverage.length) errors.push(`账号核心方向覆盖不足：${missingCoverage.join('、')}`);
  const contentMixMismatches = Object.entries(DAILY_CONTENT_MIX_TARGETS)
    .filter(([lane, target]) => (qualitySummary.contentMixLaneCounts?.[lane] || 0) !== target)
    .map(([lane, target]) => `${lane}=${qualitySummary.contentMixLaneCounts?.[lane] || 0}/${target}`);
  if (contentMixMismatches.length) errors.push(`每日内容结构不符合目标：${contentMixMismatches.join('、')}`);
  if ((qualitySummary.fullPhraseCount || 0) > DAILY_EXPRESSION_FORM_MAXIMA.full_phrase) {
    errors.push(`完整词组同日最多 ${DAILY_EXPRESSION_FORM_MAXIMA.full_phrase} 个`);
  }
  if ((qualitySummary.longIdiomCount || 0) > DAILY_EXPRESSION_FORM_MAXIMA.long_idiom) {
    errors.push(`长句式/惯用语同日最多 ${DAILY_EXPRESSION_FORM_MAXIMA.long_idiom} 个`);
  }
  if (qualitySummary.sLevelCount > MAX_DAILY_S_LEVEL_COUNT) {
    errors.push(`S 级数量过多：${qualitySummary.sLevelCount}/${MAX_DAILY_S_LEVEL_COUNT}`);
  }
  if (qualitySummary.estimatedHumanQualityScore < 75) {
    errors.push(`人工质量估分过低：${qualitySummary.estimatedHumanQualityScore}/75`);
  }
  warnings.push(...safeArray(qualitySummary.healthWarnings));
  if (draft.imageReadyCount < CODEX_DAILY_WORD_COUNT) {
    warnings.push(`参考图片未全部就绪：${draft.imageReadyCount}/${CODEX_DAILY_WORD_COUNT}，发布时将对缺图词使用现有兜底图`);
  }

  const valid = errors.length === 0;
  return {
    ...draft,
    status: draft.publishedAt ? 'published' : valid ? 'valid' : 'draft',
    validation: {
      valid,
      errors,
      warnings: [...new Set(warnings)].slice(0, 30),
      strictQualityGateEnabled,
      strictQualityGateStartDate: CODEX_DAILY_STRICT_QUALITY_GATE_START_DATE,
      qualitySummary,
      recommendationAudit,
      repeated30Words,
      candidateSupply: buildCodexCandidateSupplySummary(options.workflow || {}, draft.targetDateKey),
      backfillWords: backfillItems.map(item => item.kanji),
      metadataConflicts,
      trendProofIssues,
      cardQualityIssues
    }
  };
}

export function buildCodexDailyContext(workflowInput = {}, targetDateKey = '') {
  const workflow = cleanStoredWorkflow(workflowInput);
  const target = cleanDateKey(targetDateKey) || addDays(dateKey(), 1);
  const recentSnapshots = Object.values(workflow.historySnapshots || {})
    .filter(snapshot => {
      const distance = dateDistance(target, snapshot?.dateKey);
      return distance >= 1 && distance <= 30;
    })
    .sort((left, right) => String(right.dateKey).localeCompare(String(left.dateKey)))
    .slice(0, 30)
    .map(snapshot => ({ dateKey: snapshot.dateKey, words: snapshot.words }));
  if (workflow.todaySnapshot?.dateKey && dateDistance(target, workflow.todaySnapshot.dateKey) >= 1) {
    recentSnapshots.unshift({ dateKey: workflow.todaySnapshot.dateKey, words: workflow.todaySnapshot.words });
  }
  return {
    targetDateKey: target,
    wordCount: CODEX_DAILY_WORD_COUNT,
    positioning: getAccountLearningSummary(),
    favorites: workflow.words,
    feedback: workflow.feedback,
    publishedWords: workflow.publishedRecords.map(record => record.word).filter(Boolean),
    publishedLearning: buildPublishedLearningSummary(workflow.publishedRecords, new Date(), {
      targetDateKey: target
    }),
    recentSnapshots: recentSnapshots.slice(0, 30),
    candidatePool: Object.values(workflow.candidatePool || {}).map(entry => ({
      kanji: entry.kanji,
      kana: entry.kana,
      romaji: entry.romaji,
      meaning: entry.meaning,
      category: entry.category,
      candidateType: entry.candidateType,
      lastScore: entry.lastScore,
      lastRecommendedAt: entry.lastRecommendedAt,
      ignoredCount: entry.ignoredCount,
      recommendationCount: entry.recommendationCount,
      riskLevel: entry.riskLevel,
      displayBucket: entry.displayBucket,
      sourceTags: safeArray(entry.sourceTags).slice(0, 12),
      discoverySource: entry.discoverySource,
      discoveryContext: entry.discoveryContext,
      evidenceCheckedAt: entry.evidenceCheckedAt,
      evidenceSources: safeArray(entry.evidenceSources).slice(0, 8),
      realUsageExamples: safeArray(entry.realUsageExamples).slice(0, 8),
      usageScope: entry.usageScope,
      stabilityLevel: entry.stabilityLevel,
      trendPeriod: entry.trendPeriod,
      qualityGateStatus: entry.qualityGateStatus
    })),
    candidateSupply: buildCodexCandidateSupplySummary(workflow, target),
    discoverySources: {
      zGeneration: {
        ...CODEX_Z_GENERATION_DISCOVERY_SOURCE,
        sourceExamples: [...CODEX_Z_GENERATION_DISCOVERY_SOURCE.sourceExamples],
        qualityGates: [...CODEX_Z_GENERATION_DISCOVERY_SOURCE.qualityGates]
      }
    },
    qualityRules: {
      exactWords: CODEX_DAILY_WORD_COUNT,
      recentDedupDays: 30,
      maxSLevel: MAX_DAILY_S_LEVEL_COUNT,
      contentMixTargets: { ...DAILY_CONTENT_MIX_TARGETS },
      expressionFormMaxima: { ...DAILY_EXPRESSION_FORM_MAXIMA },
      maxBeautyCategory: 1,
      maxGenericBeautyCategory: 1,
      maxBasicPolite: 1,
      maxBackfillCount: CODEX_DAILY_MAX_BACKFILL_COUNT,
      backfillRecheckDays: CODEX_DAILY_BACKFILL_RECHECK_DAYS,
      strictQualityGateStartDate: CODEX_DAILY_STRICT_QUALITY_GATE_START_DATE,
      backfillRequiresQualityGateReady: true,
      backfillRequiresTwoRealUsageExamples: true,
      imagesRequiredForPublish: false,
      cardsRequiredForPublish: true,
      publishedReviewRationale: [
        '保留情绪状态与人际语感主轴；收藏率和互动率优先于单纯浏览量。',
        '泛“流行词”标题不自动加权，只有带时间证据的稳定流行表达进入流行词配额。',
        '成熟日常缩略语补足表达密度；来源不明或疑似自造缩写仍进入复核。',
        '泛美妆/时尚标签继续受限，具体、可视化、能讲清语感的专有表达进入正向配额。',
        'publishedLearning.topic 只影响选词；cover 与 content 分别只影响图片和词卡。'
      ]
    }
  };
}

export function promoteCodexDailyDraft(workflowInput = {}, draftInput = {}, options = {}) {
  const current = cleanStoredWorkflow(workflowInput);
  const validated = validateCodexDailyDraft(draftInput, {
    workflow: current,
    expectedDateKey: options.expectedDateKey
  });
  if (!validated.validation.valid) return { ok: false, draft: validated, workflow: current };

  const promotedAt = options.promotedAt || new Date().toISOString();
  const candidatePool = { ...current.candidatePool };
  const auditItems = new Map(validated.validation.recommendationAudit.items.map(item => [item.kanji, item]));
  validated.items.forEach(item => {
    const existing = candidatePool[item.kanji] || {};
    candidatePool[item.kanji] = cleanCandidatePoolEntry(item.kanji, {
      ...existing,
      ...item,
      sourceType: 'codex_generated',
      aiCard: item.aiCard,
      recommendationAudit: auditItems.get(item.kanji) || {},
      lastRecommendedAt: promotedAt,
      lastScoredAt: promotedAt,
      recommendationCount: clamp((existing.recommendationCount || 0) + 1, 0, 9999),
      wasRecommended: true,
      updatedAt: promotedAt
    });
  });

  const previousSnapshot = cleanTodaySnapshot(current.todaySnapshot);
  const sameDay = previousSnapshot.dateKey === validated.targetDateKey;
  const todaySnapshot = cleanTodaySnapshot({
    dateKey: validated.targetDateKey,
    words: validated.items.map(item => item.kanji),
    generatedAt: promotedAt,
    source: 'codex_draft',
    batchIds: [],
    version: sameDay ? previousSnapshot.version + 1 : 1,
    generatorVersion: `${TODAY_SNAPSHOT_GENERATOR_VERSION}+${CODEX_DAILY_GENERATOR_VERSION}`,
    createdBy: 'codex',
    dedupDaysUsed: 30,
    relaxedDedup: false,
    shortage: false,
    repeated30Count: 0,
    repeated30Words: [],
    recommendationAudit: validated.validation.recommendationAudit
  });
  const workflow = cleanStoredWorkflow({
    ...current,
    candidatePool,
    todaySnapshot,
    todaySnapshotHistory: archiveTodaySnapshotIntoSnapshotHistory(current.todaySnapshotHistory, todaySnapshot),
    historySnapshots: archiveTodaySnapshotIntoHistory(current.historySnapshots, todaySnapshot),
    updated: promotedAt
  });
  return {
    ok: true,
    workflow,
    draft: {
      ...validated,
      status: 'published',
      publishedAt: promotedAt,
      updatedAt: promotedAt
    }
  };
}

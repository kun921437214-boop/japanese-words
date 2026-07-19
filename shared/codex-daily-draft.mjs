import { getAccountLearningSummary } from './account-learning.mjs';
import { DAILY_WORD_COUNT, MAX_DAILY_S_LEVEL_COUNT } from './daily-config.mjs';
import { addDays, cleanDateKey, dateKey } from './rankings.mjs';
import { buildTodayRecommendationAudit } from './today-snapshot.mjs';
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
    displayBucket: 'today',
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

function isCompleteCard(card = {}) {
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

export function validateCodexDailyDraft(input = {}, options = {}) {
  const draft = cleanCodexDailyDraft(input);
  const expectedDateKey = cleanDateKey(options.expectedDateKey);
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

  const incompleteCardWords = draft.items.filter(item => !isCompleteCard(item.aiCard)).map(item => item.kanji);
  if (incompleteCardWords.length) errors.push(`词卡字段不完整：${incompleteCardWords.join('、')}`);

  const unsafeWords = draft.items
    .filter(item => item.riskLevel === 'high' || item.confidenceLevel === 'review' || item.lastReviewState === 'review')
    .map(item => item.kanji);
  if (unsafeWords.length) errors.push(`高风险或待复核词不能自动发布：${unsafeWords.join('、')}`);

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
  if (qualitySummary.duplicateClusterCount > 0) {
    errors.push(`存在 ${qualitySummary.duplicateClusterCount} 组同日语义重复`);
  }
  if (qualitySummary.beautyCategoryCount > 1) errors.push('美妆品类同日最多 1 个');
  if (qualitySummary.basicPoliteCount > 1) errors.push('基础寒暄或教材礼貌词同日最多 1 个');
  const missingCoverage = safeArray(qualitySummary.relaxedReasons).filter(reason => reason.endsWith('_below_target'));
  if (missingCoverage.length) errors.push(`账号核心方向覆盖不足：${missingCoverage.join('、')}`);
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
      qualitySummary,
      recommendationAudit,
      repeated30Words
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
      displayBucket: entry.displayBucket
    })),
    qualityRules: {
      exactWords: CODEX_DAILY_WORD_COUNT,
      recentDedupDays: 30,
      maxSLevel: MAX_DAILY_S_LEVEL_COUNT,
      maxBeautyCategory: 1,
      maxBasicPolite: 1,
      imagesRequiredForPublish: false,
      cardsRequiredForPublish: true
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

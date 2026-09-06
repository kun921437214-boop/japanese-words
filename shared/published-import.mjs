import {
  extractXiaohongshuNoteId,
  normalizeXiaohongshuUrl
} from './xiaohongshu-url.mjs';

export const PUBLISHED_METRIC_UPDATE_DAYS = 15;
export const PUBLISHED_METRIC_SNAPSHOT_LIMIT = 16;
export const PUBLISHED_EXPORT_WINDOW_DAYS = 180;
export const PUBLISHED_LEARNING_GUIDANCE_VERSION = 'published-learning-guidance-v1';
export const PUBLISHED_LEARNING_GUIDANCE_EFFECTIVE_FROM = '2026-08-10';

const APP_TIME_ZONE = 'Asia/Shanghai';
const SELECTION_SOURCE_TYPES = [
  'daily_hot_codex',
  'daily_hot_deepseek',
  'daily_hot_unknown',
  'self_selected',
  'unknown'
];
const PUBLISHED_CONTENT_CATEGORIES = ['word_card', 'non_word', 'unknown'];
const DATE_KEY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function toInt(value, max = 999999999) {
  const number = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.round(number))) : 0;
}

function toRate(value) {
  const number = Number.parseFloat(String(value ?? '').replace('%', ''));
  if (!Number.isFinite(number)) return 0;
  const normalized = number > 1 ? number / 100 : number;
  return Math.min(1, Math.max(0, normalized));
}

/** @param {Date|string|number} date */
function toDateKey(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return '';
  const parts = DATE_KEY_FORMATTER.formatToParts(parsed);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
}

function normalizePublishedAt(value) {
  const raw = cleanText(value, 80);
  if (!raw) return '';
  const chineseMatch = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分(?:(\d{1,2})秒)?$/);
  if (chineseMatch) {
    const [, year, month, day, hour, minute, second = '00'] = chineseMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}+08:00`;
  }
  const normalized = raw.replace(/\//g, '-').replace(' ', 'T');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? '' : normalized;
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function samePublishedIdentity(left = {}, right = {}) {
  if (left.noteId && right.noteId && left.noteId === right.noteId) return true;
  if (left.link && right.link && left.link === right.link) return true;
  if (left.sourceKey && right.sourceKey && left.sourceKey === right.sourceKey) return true;
  return Boolean(left.title && right.title && left.publishedAt && right.publishedAt
    && left.title === right.title && left.publishedAt === right.publishedAt);
}

function cleanSelectionSource(input = {}) {
  const type = SELECTION_SOURCE_TYPES.includes(input?.type) ? input.type : 'unknown';
  const defaultLabel = {
    daily_hot_codex: '每日热门 · Codex',
    daily_hot_deepseek: '每日热门 · DeepSeek',
    daily_hot_unknown: '每日热门 · 待确认',
    self_selected: '自选',
    unknown: '来源待确认'
  }[type];
  return {
    type,
    label: cleanText(input?.label || defaultLabel, 80),
    isDailyHot: type.startsWith('daily_hot_'),
    matchedDateKey: cleanText(input?.matchedDateKey, 20),
    sourceBatchId: cleanText(input?.sourceBatchId, 120),
    confidence: ['high', 'medium', 'low'].includes(input?.confidence) ? input.confidence : 'low'
  };
}

export function cleanPublishedContentCategory(value, word = '') {
  const category = cleanText(value, 40);
  if (PUBLISHED_CONTENT_CATEGORIES.includes(category)) return category;
  return cleanText(word, 80) ? 'word_card' : 'unknown';
}

export function cleanPublishedMetrics(metrics = {}) {
  return {
    impressions: toInt(metrics?.impressions ?? metrics?.exposure),
    views: toInt(metrics?.views),
    coverClickRate: toRate(metrics?.coverClickRate ?? metrics?.ctr),
    likes: toInt(metrics?.likes, 99999999),
    comments: toInt(metrics?.comments, 99999999),
    favorites: toInt(metrics?.favorites, 99999999),
    follows: toInt(metrics?.follows, 99999999),
    shares: toInt(metrics?.shares, 99999999),
    avgWatchSeconds: toInt(metrics?.avgWatchSeconds ?? metrics?.watch, 86400),
    danmaku: toInt(metrics?.danmaku, 99999999)
  };
}

export function cleanPublishedMetricSnapshot(snapshot = {}, fallbackDateKey = '') {
  const capturedAt = cleanText(snapshot?.capturedAt, 80);
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(snapshot?.dateKey, 20))
    ? cleanText(snapshot.dateKey, 20)
    : (toDateKey(capturedAt) || cleanText(fallbackDateKey, 20));
  return {
    dateKey,
    capturedAt,
    capturedAtSource: ['official_export', 'file_modified_time', 'remote_page', 'manual'].includes(snapshot?.capturedAtSource)
      ? snapshot.capturedAtSource
      : 'official_export',
    source: cleanText(snapshot?.source || 'xiaohongshu_creator_export', 80),
    batchId: cleanText(snapshot?.batchId, 120),
    ...cleanPublishedMetrics(snapshot)
  };
}

export function cleanPublishedMetricSnapshots(snapshots = []) {
  const byDate = new Map();
  safeArray(snapshots).forEach(snapshot => {
    const cleaned = cleanPublishedMetricSnapshot(snapshot);
    if (!cleaned.dateKey) return;
    const current = byDate.get(cleaned.dateKey);
    if (!current || cleaned.capturedAt >= current.capturedAt) byDate.set(cleaned.dateKey, cleaned);
  });
  return [...byDate.values()]
    .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
    .slice(0, PUBLISHED_METRIC_SNAPSHOT_LIMIT);
}

export function mergePublishedMetricSnapshots(left = [], right = []) {
  return cleanPublishedMetricSnapshots([...safeArray(left), ...safeArray(right)]);
}

export function buildPublishedSourceKey(title, publishedAt) {
  const cleanTitle = cleanText(title, 200).replace(/\s+/g, ' ');
  const cleanTime = normalizePublishedAt(publishedAt);
  return cleanTitle && cleanTime ? `xhs-title-time:${hashText(`${cleanTitle}|${cleanTime}`)}` : '';
}

export function extractPublishedWordFromTitle(title = '') {
  const text = cleanText(title, 200);
  const bracketMatch = text.match(/[「『](.+?)[」』]/);
  if (bracketMatch?.[1]) return cleanText(bracketMatch[1], 80);
  return '';
}

export function normalizePublishedImportRow(row = {}, wordMappings = {}) {
  const title = cleanText(row?.title ?? row?.['笔记标题'], 200);
  const publishedAt = normalizePublishedAt(row?.publishedAt ?? row?.['首次发布时间']);
  const mappedWord = cleanText(wordMappings[title] || row?.word, 80);
  const inferredWord = mappedWord || extractPublishedWordFromTitle(title);
  const contentCategory = cleanPublishedContentCategory(row?.contentCategory, inferredWord);
  const noteId = extractXiaohongshuNoteId(row?.link, row?.noteId);
  return {
    title,
    publishedAt,
    contentType: cleanText(row?.contentType ?? row?.['体裁'], 20) === '视频' ? '视频' : '图文',
    contentCategory,
    word: contentCategory === 'non_word' ? '' : inferredWord,
    noteId,
    link: normalizeXiaohongshuUrl(row?.link, noteId),
    description: cleanText(row?.description, 12000),
    coverUrl: cleanText(row?.coverUrl, 1000),
    sourceKey: buildPublishedSourceKey(title, publishedAt),
    metrics: cleanPublishedMetrics({
      impressions: row?.impressions ?? row?.['曝光'],
      views: row?.views ?? row?.['观看量'],
      coverClickRate: row?.coverClickRate ?? row?.['封面点击率'],
      likes: row?.likes ?? row?.['点赞'],
      comments: row?.comments ?? row?.['评论'],
      favorites: row?.favorites ?? row?.['收藏'],
      follows: row?.follows ?? row?.['涨粉'],
      shares: row?.shares ?? row?.['分享'],
      avgWatchSeconds: row?.avgWatchSeconds ?? row?.['人均观看时长'],
      danmaku: row?.danmaku ?? row?.['弹幕']
    })
  };
}

export function getPublishedAgeDays(record = {}, now = new Date()) {
  const publishedAt = new Date(record?.publishedAt || 0).getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(publishedAt) || !Number.isFinite(current) || !record?.publishedAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, (current - publishedAt) / 86400000);
}

export function isPublishedMetricUpdateActive(record = {}, now = new Date()) {
  return getPublishedAgeDays(record, now) <= PUBLISHED_METRIC_UPDATE_DAYS;
}

function collectRecommendationSnapshots(workflow = {}) {
  const byDate = new Map();
  const add = snapshot => {
    const dateKey = cleanText(snapshot?.dateKey, 20);
    if (!dateKey || !safeArray(snapshot?.words).length) return;
    const current = byDate.get(dateKey);
    const currentItems = safeArray(current?.recommendationAudit?.items).length;
    const nextItems = safeArray(snapshot?.recommendationAudit?.items).length;
    if (!current || nextItems >= currentItems) byDate.set(dateKey, snapshot);
  };
  Object.values(workflow?.historySnapshots || {}).forEach(add);
  safeArray(workflow?.todaySnapshotHistory).forEach(add);
  add(workflow?.todaySnapshot);
  return [...byDate.values()];
}

function providerForRecommendation(word, snapshot = {}, candidate = {}) {
  const auditItem = safeArray(snapshot?.recommendationAudit?.items).find(item => item?.kanji === word) || {};
  const trace = candidate?.recommendationAudit || {};
  const originType = cleanText(auditItem?.originType || trace?.originType, 80);
  const source = `${snapshot?.source || ''} ${snapshot?.createdBy || ''} ${originType} ${candidate?.sourceType || ''}`.toLowerCase();
  if (trace?.fromCodex || originType === 'codex_generated' || source.includes('codex')) return 'codex';
  if (originType === 'deepseek_new' || source.includes('deepseek')) return 'deepseek';
  return '';
}

export function inferPublishedSelectionSource(word, publishedAt, workflow = {}) {
  const cleanWord = cleanText(word, 80);
  if (!cleanWord) return cleanSelectionSource({ type: 'unknown' });
  const publishedDateKey = cleanText(publishedAt, 10);
  const candidates = collectRecommendationSnapshots(workflow)
    .filter(snapshot => safeArray(snapshot?.words).includes(cleanWord))
    .filter(snapshot => !publishedDateKey || snapshot.dateKey <= publishedDateKey)
    .map(snapshot => ({
      snapshot,
      distanceDays: publishedDateKey
        ? Math.max(0, (new Date(`${publishedDateKey}T00:00:00+08:00`).getTime() - new Date(`${snapshot.dateKey}T00:00:00+08:00`).getTime()) / 86400000)
        : 0
    }))
    .filter(item => item.distanceDays <= 90)
    .sort((left, right) => right.snapshot.dateKey.localeCompare(left.snapshot.dateKey));
  const candidate = workflow?.candidatePool?.[cleanWord] || {};
  const matched = candidates[0]?.snapshot;
  if (matched) {
    const provider = providerForRecommendation(cleanWord, matched, candidate);
    return cleanSelectionSource({
      type: provider === 'codex' ? 'daily_hot_codex' : provider === 'deepseek' ? 'daily_hot_deepseek' : 'daily_hot_unknown',
      matchedDateKey: matched.dateKey,
      sourceBatchId: safeArray(matched.batchIds)[0] || candidate?.aiBatchId || '',
      confidence: provider ? 'high' : 'medium'
    });
  }
  const recommendedAt = cleanText(candidate?.lastRecommendedAt, 80);
  if (candidate?.wasRecommended && recommendedAt && (!publishedAt || recommendedAt <= publishedAt)) {
    const provider = providerForRecommendation(cleanWord, {}, candidate);
    return cleanSelectionSource({
      type: provider === 'codex' ? 'daily_hot_codex' : provider === 'deepseek' ? 'daily_hot_deepseek' : 'daily_hot_unknown',
      matchedDateKey: recommendedAt.slice(0, 10),
      sourceBatchId: candidate?.aiBatchId || '',
      confidence: 'medium'
    });
  }
  return cleanSelectionSource({ type: 'self_selected', confidence: 'high' });
}

export function computePublishedThirtyDayMedians(records = [], now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const eligible = safeArray(records).filter(record => {
    if (!record || record.sourceStatus === 'placeholder') return false;
    const age = getPublishedAgeDays(record, current);
    return age >= 0 && age <= 30 && record.latestMetrics;
  });
  const metrics = eligible.map(record => cleanPublishedMetrics(record.latestMetrics));
  return {
    sampleSize: metrics.length,
    impressions: median(metrics.map(item => item.impressions)),
    views: median(metrics.map(item => item.views)),
    coverClickRate: median(metrics.map(item => item.coverClickRate)),
    viewRate: median(metrics.map(item => rate(item.views, item.impressions))),
    likeRate: median(metrics.map(item => rate(item.likes, item.views))),
    comments: median(metrics.map(item => item.comments)),
    commentRate: median(metrics.map(item => rate(item.comments, item.views))),
    favoriteRate: median(metrics.map(item => rate(item.favorites, item.views))),
    shareRate: median(metrics.map(item => rate(item.shares, item.views))),
    followRate: median(metrics.map(item => rate(item.follows, item.views))),
    avgWatchSeconds: median(metrics.map(item => item.avgWatchSeconds))
  };
}

function weightedRelativeScore(items = []) {
  let weightedScore = 0;
  let totalWeight = 0;
  items.forEach(item => {
    const baseline = Number(item?.baseline) || 0;
    const value = Number(item?.value) || 0;
    const weight = Number(item?.weight) || 0;
    if (baseline <= 0 || weight <= 0) return;
    weightedScore += Math.min(2, Math.max(0, value / baseline)) * weight;
    totalWeight += weight;
  });
  return totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;
}

function buildPerformanceDimension(score = 0, sampleSize = 0, label = '') {
  if (sampleSize < 3 || !score) {
    return { score: 0, level: 'insufficient', label: '数据不足', reason: `${label}需要至少 3 篇近30天内容作为参照。` };
  }
  if (score >= 115) return { score, level: 'strong', label: '表现较强', reason: `${label}高于账号近期常态。` };
  if (score >= 75) return { score, level: 'normal', label: '表现正常', reason: `${label}处于账号近期正常区间。` };
  return { score, level: 'weak', label: '表现偏弱', reason: `${label}低于账号近期常态，建议结合其他维度判断。` };
}

function getPublishedMetricAgeDays(record = {}, now = new Date()) {
  const publishedAt = Date.parse(record.publishedAt || '');
  const current = new Date(now).getTime();
  const validCapture = value => {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) && timestamp >= publishedAt && timestamp <= current ? timestamp : NaN;
  };
  const importedAt = validCapture(record.lastMetricsImportedAt);
  const capturedAt = Number.isFinite(importedAt) ? importedAt : Math.max(
    ...safeArray(record.metricSnapshots).map(snapshot => validCapture(snapshot?.capturedAt)).filter(Number.isFinite)
  );
  return Number.isFinite(capturedAt) ? (capturedAt - publishedAt) / 86400000 : -1;
}

export function buildPublishedPerformanceAssessment(record = {}, records = [], now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const metrics = cleanPublishedMetrics(record?.latestMetrics || {});
  const comparisonRecords = safeArray(records).filter(item => (
    item && item.id !== record?.id && getPublishedMetricAgeDays(item, current) >= 3
  ));
  const medians = computePublishedThirtyDayMedians(comparisonRecords, current);
  const metricAgeDays = getPublishedMetricAgeDays(record, current);
  const stage = metricAgeDays < 3
    ? 'collecting'
    : (metricAgeDays >= PUBLISHED_METRIC_UPDATE_DAYS ? 'final' : 'early');
  const coverScore = weightedRelativeScore([
    { value: metrics.coverClickRate, baseline: medians.coverClickRate, weight: 0.75 },
    { value: rate(metrics.views, metrics.impressions), baseline: medians.viewRate, weight: 0.25 }
  ]);
  const topicScore = weightedRelativeScore([
    { value: rate(metrics.favorites, metrics.views), baseline: medians.favoriteRate, weight: 0.4 },
    { value: rate(metrics.shares, metrics.views), baseline: medians.shareRate, weight: 0.25 },
    { value: rate(metrics.follows, metrics.views), baseline: medians.followRate, weight: 0.2 },
    { value: rate(metrics.comments, metrics.views), baseline: medians.commentRate, weight: 0.15 }
  ]);
  const contentScore = weightedRelativeScore([
    { value: metrics.avgWatchSeconds, baseline: medians.avgWatchSeconds, weight: 0.55 },
    { value: rate(metrics.likes, metrics.views), baseline: medians.likeRate, weight: 0.2 },
    { value: rate(metrics.comments, metrics.views), baseline: medians.commentRate, weight: 0.15 },
    { value: rate(metrics.shares, metrics.views), baseline: medians.shareRate, weight: 0.1 }
  ]);
  const stageLabel = stage === 'collecting' ? '数据收集中' : stage === 'early' ? '72小时初评' : '15天定评';
  const sampleSize = stage === 'collecting' ? 0 : medians.sampleSize;
  const topic = buildPerformanceDimension(topicScore, sampleSize, '选题价值');
  const cover = buildPerformanceDimension(coverScore, sampleSize, '封面包装');
  const content = buildPerformanceDimension(contentScore, sampleSize, '内容承接');
  const summary = stage === 'collecting'
    ? (metricAgeDays < 0 ? '尚无有效指标采集时间，暂不用于调整后续推荐。' : '指标采集时发布未满72小时，暂不用于调整后续推荐。')
    : `选题${topic.label}，封面${cover.label}，内容${content.label}；${stage === 'final' ? '已有发布满15天的指标，可用于最终复盘。' : `最新指标覆盖发布后${metricAgeDays.toFixed(1)}天，尚未取得15天数据，保留初评。`}`;
  return {
    stage,
    stageLabel,
    assessedAt: current.toISOString(),
    baselineSampleSize: medians.sampleSize,
    topic,
    cover,
    content,
    summary
  };
}

const PUBLISHED_LEARNING_ROUTE_CONFIG = Object.freeze({
  topic: {
    destination: 'topic_selection_only',
    purpose: '只用于下一轮选词方向；不直接改数值排名，也不接收封面或内容维度的好坏信号。',
    weakSignalBoundary: '只降低相似选题方向的优先级；封面或内容偏弱不得惩罚词本身。'
  },
  cover: {
    destination: 'visual_brief_only',
    purpose: '只用于参考图与封面视觉 Brief；不得改变选词分数或 aiCard 内容。',
    weakSignalBoundary: '只调整相似封面包装；不得据此降低词本身的优先级。'
  },
  content: {
    destination: 'card_structure_only',
    purpose: '只用于词卡讲解结构、开场与例句组织；不得改变选词分数或 aiCard 字段结构。',
    weakSignalBoundary: '只调整相似内容承接方式；不得据此降低词本身的优先级。'
  }
});

function guidanceWeight(stage = '') {
  if (stage === 'final') return 1;
  if (stage === 'early') return 0.5;
  return 0;
}

function buildPublishedLearningRoute(assessed = [], dimension = 'topic', enabled = false) {
  const config = PUBLISHED_LEARNING_ROUTE_CONFIG[dimension];
  const signals = safeArray(assessed)
    .filter(item => ['early', 'final'].includes(item?.assessment?.stage))
    .filter(item => ['strong', 'weak'].includes(item?.assessment?.[dimension]?.level))
    .map(item => ({
      word: item.word,
      title: item.title,
      level: item.assessment[dimension].level,
      score: item.assessment[dimension].score,
      stage: item.assessment.stage,
      guidanceWeight: guidanceWeight(item.assessment.stage)
    }))
    .sort((left, right) => (
      right.guidanceWeight - left.guidanceWeight
      || right.score - left.score
      || left.word.localeCompare(right.word, 'ja')
    ));
  const strongSignals = signals.filter(item => item.level === 'strong').slice(0, 8);
  const weakSignals = signals.filter(item => item.level === 'weak').slice(0, 8);
  const repeatedStrongPattern = strongSignals.length >= 2;
  const repeatedWeakPattern = weakSignals.length >= 2;
  const actionableSignals = [
    ...(repeatedStrongPattern ? strongSignals : []),
    ...(repeatedWeakPattern ? weakSignals : [])
  ];
  const state = !enabled
    ? 'disabled'
    : !actionableSignals.length
      ? 'neutral'
      : actionableSignals.some(item => item.stage === 'early')
        ? 'early'
        : 'final';
  const instruction = state === 'disabled'
    ? '目标日期尚未启用发布表现 guidance，沿用既有账号定位与质量门。'
    : state === 'neutral'
      ? '尚无至少 2 篇同方向成熟信号，不形成新结论，保持中性。'
      : state === 'early'
        ? '仅把重复出现的 72 小时初评作为半权重定性提示，并继续用账号定位、近30天去重和内容适配复核。'
        : '可把重复出现的 15 天定评作为完整定性 guidance，但仍不得转成数值排名加权或照搬单篇结论。';
  return {
    destination: config.destination,
    purpose: config.purpose,
    weakSignalBoundary: config.weakSignalBoundary,
    state,
    actionable: enabled && actionableSignals.length > 0,
    minimumDistinctPosts: 2,
    strongSignals,
    weakSignals,
    instruction
  };
}

export function buildPublishedLearningSummary(records = [], now = new Date(), options = {}) {
  const assessed = safeArray(records)
    .filter(record => record?.word && record?.sourceStatus !== 'placeholder')
    .map(record => ({
      word: cleanText(record.word, 80),
      title: cleanText(record.title, 200),
      assessment: buildPublishedPerformanceAssessment(record, records, now)
    }))
    .filter(item => item.assessment.stage !== 'collecting');
  const pick = (dimension, level) => assessed
    .filter(item => item.assessment?.[dimension]?.level === level)
    .sort((left, right) => right.assessment[dimension].score - left.assessment[dimension].score)
    .slice(0, 8)
    .map(item => ({ word: item.word, title: item.title, score: item.assessment[dimension].score }));
  const targetDateKey = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(options?.targetDateKey, 20))
    ? cleanText(options.targetDateKey, 20)
    : '';
  const guidanceEnabled = Boolean(
    targetDateKey && targetDateKey >= PUBLISHED_LEARNING_GUIDANCE_EFFECTIVE_FROM
  );
  return {
    sampleSize: assessed.length,
    strongTopics: pick('topic', 'strong'),
    weakTopics: pick('topic', 'weak'),
    strongCovers: pick('cover', 'strong'),
    weakCovers: pick('cover', 'weak'),
    strongContent: pick('content', 'strong'),
    weakContent: pick('content', 'weak'),
    rule: '选题表现只用于学习词和内容方向；封面表现只用于学习包装；内容表现只用于学习讲解与结构。',
    guidanceVersion: PUBLISHED_LEARNING_GUIDANCE_VERSION,
    guidanceEffectiveFrom: PUBLISHED_LEARNING_GUIDANCE_EFFECTIVE_FROM,
    guidanceTargetDateKey: targetDateKey,
    guidanceEnabled,
    guidance: {
      topic: buildPublishedLearningRoute(assessed, 'topic', guidanceEnabled),
      cover: buildPublishedLearningRoute(assessed, 'cover', guidanceEnabled),
      content: buildPublishedLearningRoute(assessed, 'content', guidanceEnabled)
    },
    safeguards: [
      'collecting 与 insufficient 信号保持中性',
      'early 信号仅作半权重定性提示，final 才作完整定性 guidance',
      '少于 2 篇同方向成熟信号不得形成新结论',
      'topic 只服务选词，cover 只服务视觉 Brief，content 只服务词卡结构',
      '封面或内容偏弱不得惩罚词本身',
      '当前不做真实数值排名加权，也不改变 aiCard 字段结构'
    ]
  };
}

export function buildPublicationCreativeSnapshot(workflow = {}, word = '', capturedAt = '') {
  const cleanWord = cleanText(word, 80);
  const entry = workflow?.candidatePool?.[cleanWord] || {};
  const prepared = entry?.publicationSnapshot;
  if (prepared?.capturedAt) return { ...prepared };
  const card = entry?.aiCard || {};
  if (!cleanWord || (!card?.generatedAt && !card?.cardVersion)) return null;
  return {
    capturedAt: cleanText(capturedAt, 80) || new Date().toISOString(),
    cardVersion: Math.max(0, Math.min(99, Number.parseInt(card?.cardVersion, 10) || 0)),
    cardGeneratedAt: cleanText(card?.generatedAt, 80),
    suggestedTitle: cleanText(safeArray(card?.suggestedTitles)[0], 200),
    coverVersion: Math.max(0, Math.min(99, Number.parseInt(card?.coverVersion, 10) || 0)),
    coverSuggestion: {
      coverText: cleanText(card?.coverSuggestion?.coverText, 120),
      mainVisual: cleanText(card?.coverSuggestion?.mainVisual, 240),
      style: cleanText(card?.coverSuggestion?.style, 160),
      avoid: cleanText(card?.coverSuggestion?.avoid, 240)
    },
    referenceImage: {
      status: ['missing', 'ready', 'failed'].includes(card?.referenceImage?.status) ? card.referenceImage.status : 'missing',
      url: cleanText(card?.referenceImage?.url, 1000),
      key: cleanText(card?.referenceImage?.key, 500),
      visualBrief: cleanText(card?.referenceImage?.visualBrief, 1000),
      prompt: cleanText(card?.referenceImage?.prompt, 4000),
      provider: cleanText(card?.referenceImage?.provider, 80),
      generatedAt: cleanText(card?.referenceImage?.generatedAt, 80)
    }
  };
}

function buildMetricSnapshot(row, batch) {
  return cleanPublishedMetricSnapshot({
    ...row.metrics,
    dateKey: toDateKey(batch.capturedAt),
    capturedAt: batch.capturedAt,
    capturedAtSource: batch.capturedAtSource,
    source: batch.source,
    batchId: batch.id
  });
}

function buildLatestStats(metrics = {}) {
  const clean = cleanPublishedMetrics(metrics);
  return {
    likes: clean.likes,
    favorites: clean.favorites,
    comments: clean.comments,
    shares: clean.shares,
    views: clean.views
  };
}

function buildRecordId(row) {
  if (row.noteId) return `xhs-note:${row.noteId}`;
  if (row.sourceKey) return row.sourceKey.replace('xhs-title-time:', 'xhs-export:');
  return `xhs-export:${hashText(`${row.title}|${row.publishedAt}`)}`;
}

function contentPatch(existing = {}, row = {}, batch = {}) {
  const locked = Boolean(existing?.contentLocked || existing?.contentImportedAt);
  if (locked) return {};
  const hasCapturableContent = Boolean(row.description || row.coverUrl);
  if (!hasCapturableContent) return {
    title: existing.title || row.title,
    contentStatus: existing.contentStatus || 'pending'
  };
  return {
    title: existing.title || row.title,
    description: row.description || existing.description || '',
    coverUrl: row.coverUrl || existing.coverUrl || '',
    link: row.link || existing.link || '',
    noteId: row.noteId || existing.noteId || '',
    contentStatus: 'complete',
    contentLocked: true,
    contentImportedAt: cleanText(batch.capturedAt, 80),
    contentSource: cleanText(batch.source, 80)
  };
}

export function applyPublishedImport(workflowInput = {}, batchInput = {}, options = {}) {
  const workflow = /** @type {Record<string, any>} */ (
    workflowInput && typeof workflowInput === 'object' ? workflowInput : {}
  );
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const capturedAt = cleanText(batchInput?.capturedAt, 80) || now.toISOString();
  const capturedDateKey = toDateKey(capturedAt) || toDateKey(now);
  const rawRows = safeArray(batchInput?.rows);
  const batch = {
    id: cleanText(batchInput?.id, 120) || `xhs-export:${capturedDateKey}:${hashText(rawRows.map(row => `${row?.title || row?.['笔记标题'] || ''}|${row?.publishedAt || row?.['首次发布时间'] || ''}`).join('\n'))}`,
    capturedAt,
    capturedAtSource: ['official_export', 'file_modified_time', 'remote_page', 'manual'].includes(batchInput?.capturedAtSource)
      ? batchInput.capturedAtSource
      : 'official_export',
    source: cleanText(batchInput?.source || 'xiaohongshu_creator_export', 80),
    sourceFileName: cleanText(batchInput?.sourceFileName, 240),
    wordMappings: batchInput?.wordMappings && typeof batchInput.wordMappings === 'object' ? batchInput.wordMappings : {}
  };
  const rows = rawRows.map(row => normalizePublishedImportRow(row, batch.wordMappings)).filter(row => row.title && row.publishedAt);
  const duplicateKeys = new Map();
  rows.forEach(row => duplicateKeys.set(row.sourceKey, (duplicateKeys.get(row.sourceKey) || 0) + 1));
  const records = safeArray(workflow?.publishedRecords).map(record => ({ ...record }));
  const existingRecordCount = records.length;
  const matchedExistingIndexes = new Set();
  const previewRows = [];
  const summary = {
    totalRows: rows.length,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    frozenCount: 0,
    skippedOlderCount: 0,
    unmappedCount: 0,
    nonWordCount: 0,
    ambiguousCount: 0,
    activeCount: 0,
    missingActiveCount: 0,
    retainedAbsentCount: 0,
    outsideExportWindowCount: 0
  };

  rows.forEach(row => {
    const existingIndex = records.findIndex(record => samePublishedIdentity(record, row));
    const existing = existingIndex >= 0 ? records[existingIndex] : null;
    if (existingIndex >= 0 && existingIndex < existingRecordCount) matchedExistingIndexes.add(existingIndex);
    const identity = {
      id: existing?.id || buildRecordId(row),
      sourceKey: row.sourceKey,
      word: existing?.word || row.word,
      noteId: existing?.noteId || row.noteId,
      link: existing?.link || row.link,
      title: existing?.title || row.title,
      description: existing?.description || '',
      coverUrl: existing?.coverUrl || '',
      contentType: existing?.contentType || row.contentType,
      contentCategory: existing?.contentCategory && existing.contentCategory !== 'unknown'
        ? existing.contentCategory
        : row.contentCategory,
      publishedAt: existing?.publishedAt || row.publishedAt,
      sourceStatus: 'record'
    };
    if (identity.contentCategory === 'non_word') summary.nonWordCount += 1;
    else if (!identity.word) summary.unmappedCount += 1;
    if (duplicateKeys.get(row.sourceKey) > 1) {
      summary.ambiguousCount += 1;
      previewRows.push({
        id: identity.id,
        title: identity.title,
        publishedAt: identity.publishedAt,
        word: identity.word,
        contentCategory: identity.contentCategory,
        status: 'ambiguous'
      });
      return;
    }
    const existingSelectionType = cleanText(existing?.selectionSource?.type, 40);
    const selectionSource = identity.contentCategory === 'non_word'
      ? cleanSelectionSource({ type: 'self_selected', confidence: 'high' })
      : existingSelectionType && existingSelectionType !== 'unknown'
        ? cleanSelectionSource(existing.selectionSource)
        : inferPublishedSelectionSource(identity.word, identity.publishedAt, workflow);
    const creativeSnapshot = existing?.creativeSnapshot
      || buildPublicationCreativeSnapshot(workflow, identity.word, capturedAt);
    const ageDays = getPublishedAgeDays(identity, now);
    const updateActive = ageDays <= PUBLISHED_METRIC_UPDATE_DAYS;
    const metricSnapshot = buildMetricSnapshot(row, batch);
    const previousSnapshots = cleanPublishedMetricSnapshots(existing?.metricSnapshots);
    const nextSnapshots = !existing || updateActive
      ? mergePublishedMetricSnapshots(previousSnapshots, [metricSnapshot])
      : previousSnapshots;
    const latestMetrics = !existing || updateActive
      ? cleanPublishedMetrics(metricSnapshot)
      : cleanPublishedMetrics(existing?.latestMetrics);
    const next = {
      ...(existing || {}),
      ...identity,
      ...contentPatch(existing || {}, row, batch),
      selectionSource,
      creativeSnapshot,
      latestMetrics,
      latestStats: buildLatestStats(latestMetrics),
      metricSnapshots: nextSnapshots,
      metricsUpdateUntil: new Date(new Date(identity.publishedAt).getTime() + PUBLISHED_METRIC_UPDATE_DAYS * 86400000).toISOString(),
      metricsFrozen: !updateActive,
      firstImportedAt: existing?.firstImportedAt || capturedAt,
      lastMetricsImportedAt: !existing || updateActive ? capturedAt : existing?.lastMetricsImportedAt || '',
      importBatchIds: [...new Set([...(safeArray(existing?.importBatchIds)), batch.id])].slice(-20),
      importSource: batch.source,
      updatedAt: !existing || updateActive || Object.keys(contentPatch(existing || {}, row, batch)).length
        ? capturedAt
        : existing?.updatedAt || capturedAt,
      sourceFileName: batch.sourceFileName || existing?.sourceFileName || ''
    };
    const changed = !existing || JSON.stringify(next) !== JSON.stringify(existing);
    if (!existing) summary.createdCount += 1;
    else if (!updateActive) summary.skippedOlderCount += 1;
    else if (changed) summary.updatedCount += 1;
    else summary.unchangedCount += 1;
    if (updateActive) summary.activeCount += 1;
    else summary.frozenCount += 1;
    if (existingIndex >= 0) records[existingIndex] = next;
    else records.push(next);
    previewRows.push({
      id: next.id,
      title: next.title,
      publishedAt: next.publishedAt,
      word: next.word,
      contentCategory: next.contentCategory,
      status: !existing ? 'create' : !updateActive ? 'skip_older' : changed ? 'update' : 'unchanged',
      selectionSource: next.selectionSource,
      metricsFrozen: next.metricsFrozen
    });
  });

  records.slice(0, existingRecordCount).forEach((record, index) => {
    if (matchedExistingIndexes.has(index) || record?.sourceStatus === 'placeholder') return;
    const ageDays = getPublishedAgeDays(record, now);
    const updateActive = ageDays <= PUBLISHED_METRIC_UPDATE_DAYS;
    const outsideExportWindow = Number.isFinite(ageDays) && ageDays >= PUBLISHED_EXPORT_WINDOW_DAYS;
    if (updateActive) summary.missingActiveCount += 1;
    else summary.retainedAbsentCount += 1;
    if (outsideExportWindow) summary.outsideExportWindowCount += 1;
    previewRows.push({
      id: record.id,
      title: record.title,
      publishedAt: record.publishedAt,
      word: record.word,
      contentCategory: record.contentCategory,
      status: updateActive ? 'missing_active' : outsideExportWindow ? 'retained_outside_window' : 'retained_absent',
      selectionSource: record.selectionSource,
      metricsFrozen: Boolean(record.metricsFrozen || !updateActive)
    });
  });

  const assessedRecords = records.map(record => ({
    ...record,
    performanceAssessment: buildPublishedPerformanceAssessment(record, records, now)
  }));

  return {
    batch,
    records: assessedRecords.sort((left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''))),
    previewRows,
    summary
  };
}

export { cleanSelectionSource };

import {
  computePublishedThirtyDayMedians,
  getPublishedAgeDays
} from '../shared/published-import.mjs';

export const PUBLISHED_PAGE_SIZE = 10;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizePublishedCoverUrl(value) {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) return '';
  if (/^\/published-cover\?key=published-covers%2Fv1%2F[a-f0-9]{32}$/i.test(rawUrl)
    || /^\/published-cover\?key=published-covers\/v1\/[a-f0-9]{32}$/i.test(rawUrl)) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password || (parsed.port && !['80', '443'].includes(parsed.port))) return '';
    const hostname = parsed.hostname.toLowerCase();
    const isXhsImageHost = hostname === 'xhscdn.com' || hostname.endsWith('.xhscdn.com');
    if (isXhsImageHost) {
      parsed.protocol = 'https:';
      parsed.port = '';
      return parsed.href;
    }
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function getPublishedCoverCandidates(value, options = {}) {
  const primaryUrl = normalizePublishedCoverUrl(value);
  if (!primaryUrl) return [];
  if (primaryUrl.startsWith('/published-cover?')) return [primaryUrl];
  try {
    const parsed = new URL(primaryUrl);
    const hostname = parsed.hostname.toLowerCase();
    const isXhsImageHost = hostname === 'xhscdn.com' || hostname.endsWith('.xhscdn.com');
    if (!isXhsImageHost) return [primaryUrl];
    const assetMatch = parsed.pathname.match(/\/([a-z0-9_-]{30,160})(?:![^/]*)?$/i);
    if (!assetMatch) return [primaryUrl];
    const assetKey = assetMatch[1];
    const sourceUsesNotesNamespace = parsed.pathname.split('/').includes('notes_pre_post');
    const stablePaths = sourceUsesNotesNamespace
      ? [`notes_pre_post/${assetKey}`, assetKey]
      : [assetKey, `notes_pre_post/${assetKey}`];
    const requestedWidth = Number.parseInt(options.width, 10);
    const width = Number.isFinite(requestedWidth)
      ? Math.max(240, Math.min(1600, requestedWidth))
      : 1080;
    const stableUrls = stablePaths.map(path => `https://sns-na-i6.xhscdn.com/${path}?imageView2/2/w/${width}/format/jpg&origin=0`);

    // Dated sns-webpic URLs expire with a 403. Prefer the namespace-aware
    // stable CDN URL so every cover does not begin with a failed request.
    return [...new Set([...stableUrls, primaryUrl])];
  } catch {
    return [];
  }
}

function toMetric(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function getMetrics(record = {}) {
  const metrics = record?.latestMetrics || {};
  const legacy = record?.latestStats || {};
  return {
    impressions: toMetric(metrics.impressions),
    views: toMetric(metrics.views ?? legacy.views),
    coverClickRate: toMetric(metrics.coverClickRate),
    likes: toMetric(metrics.likes ?? legacy.likes),
    comments: toMetric(metrics.comments ?? legacy.comments),
    favorites: toMetric(metrics.favorites ?? legacy.favorites),
    follows: toMetric(metrics.follows),
    shares: toMetric(metrics.shares ?? legacy.shares),
    avgWatchSeconds: toMetric(metrics.avgWatchSeconds),
    danmaku: toMetric(metrics.danmaku)
  };
}

export function getPublishedPerformanceScore(record = {}) {
  const metrics = getMetrics(record);
  if (!metrics.views) return 0;
  return Math.round((
    rate(metrics.favorites, metrics.views) * 35
    + rate(metrics.shares, metrics.views) * 30
    + rate(metrics.follows, metrics.views) * 20
    + rate(metrics.comments, metrics.views) * 10
    + rate(metrics.likes, metrics.views) * 5
  ) * 10000) / 100;
}

export function getPublishedRecordAgeHours(record = {}, now = Date.now()) {
  const publishedTime = new Date(record?.publishedAt || 0).getTime();
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  if (!record?.publishedAt || !Number.isFinite(publishedTime) || !Number.isFinite(currentTime)) return 0;
  return Math.max(0, (currentTime - publishedTime) / 3600000);
}

export function getRecentPublishedAverage(records = [], limit = 20) {
  const recentRecords = safeArray(records)
    .filter(record => record?.sourceStatus !== 'placeholder')
    .sort((left, right) => String(right?.publishedAt || '').localeCompare(String(left?.publishedAt || '')))
    .slice(0, Math.max(1, Number.parseInt(limit, 10) || 20));
  if (!recentRecords.length) return 0;
  return recentRecords.reduce((sum, record) => sum + getPublishedPerformanceScore(record), 0) / recentRecords.length;
}

// Compatibility output for the existing recommendation feedback path. The new
// Published page does not show this rating or store it as a primary field.
export function ratePublishedRecord(record = {}, options = {}) {
  const performanceScore = getPublishedPerformanceScore(record);
  const recentAverage = Number.isFinite(options.recentAverage)
    ? options.recentAverage
    : getRecentPublishedAverage(options.records);
  const average = recentAverage || performanceScore;
  const ratio = average > 0 ? performanceScore / average : 1;
  const ageHours = getPublishedRecordAgeHours(record, options.now ?? Date.now());
  let level = '待评估';
  if (ageHours >= 72) {
    if (ratio >= 1.35) level = '优秀';
    else if (ratio >= 0.75) level = '正常';
    else if (ratio >= 0.4) level = '偏弱';
    else level = '异常差';
  }
  return {
    level,
    reason: '按收藏、分享、涨粉、评论和点赞效率综合判断。',
    performanceScore,
    recentAverage: average,
    ratio,
    ageHours,
    saveRate: rate(getMetrics(record).favorites, getMetrics(record).views)
  };
}

export function getPublishedSourceLabel(record = {}) {
  return record?.selectionSource?.label || '来源待确认';
}

const INTERNAL_WORKFLOW_COPY_PATTERN = /(?:AI\s*候选词|等待人工确认|用户已进入工作流|禁止自动删除)/i;
const PUBLISHED_BODY_READING_PATTERN = /^[（(].+[）)](?:\s*[⓪①②③④⑤⑥⑦⑧⑨0-9]+)?$/u;
const PUBLISHED_BODY_META_PATTERN = /^(?:[=＝]|全称(?:是|为)|[➡👉💡🥯🥖💅])/u;
const PUBLISHED_BODY_CONTINUATION_PATTERN = /[；;、，,:：]$/u;

function cleanPublishedBodyLine(value = '') {
  return String(value || '').replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractPublishedMeaningFromDescription(record = {}) {
  if (!record?.contentLocked || record?.contentCategory === 'non_word') return '';
  const word = String(record?.word || '').trim();
  if (!word) return '';
  const lines = String(record?.description || '')
    .split(/[\r\n\u2028\u2029]+/u)
    .map(cleanPublishedBodyLine)
    .filter(Boolean);
  const wordLineIndex = lines.findIndex(line => line.replace(/^[🍞\s]+/u, '').startsWith(word));
  if (wordLineIndex < 0) return '';

  function nextMeaningLine(startIndex) {
    for (let index = startIndex; index < Math.min(lines.length, wordLineIndex + 10); index += 1) {
      const line = lines[index];
      if (!line || line.startsWith('⬇')) continue;
      if (line.startsWith('🍞') || line.startsWith('#')) return null;
      if (PUBLISHED_BODY_READING_PATTERN.test(line) || PUBLISHED_BODY_META_PATTERN.test(line)) continue;
      if (!/[\u3400-\u9fff]/u.test(line)) continue;
      return { index, line: line.slice(0, 240) };
    }
    return null;
  }

  const first = nextMeaningLine(wordLineIndex + 1);
  if (!first) return '';
  const meaningLines = [first.line];
  let current = first;
  while (PUBLISHED_BODY_CONTINUATION_PATTERN.test(current.line) && meaningLines.length < 3) {
    const next = nextMeaningLine(current.index + 1);
    if (!next) break;
    meaningLines.push(next.line);
    current = next;
  }
  return meaningLines.join(' ').slice(0, 240);
}

export function getPublishedContentSubLabel(record = {}, options = {}) {
  if (record?.contentCategory === 'non_word') return '宣传、活动或其他自选内容';
  const meaning = String(options?.meaning || '').trim().slice(0, 240);
  if (meaning && !INTERNAL_WORKFLOW_COPY_PATTERN.test(meaning)) return meaning;
  const publishedMeaning = extractPublishedMeaningFromDescription(record);
  if (publishedMeaning && !INTERNAL_WORKFLOW_COPY_PATTERN.test(publishedMeaning)) return publishedMeaning;
  if (record?.word) return '释义待补充';
  return record?.contentLocked ? '正文已获取，主词待确认' : '等待从「笔记管理」点封面读取详情';
}

export function getPublishedUpdateState(record = {}, now = new Date()) {
  const ageDays = getPublishedAgeDays(record, now);
  const active = ageDays <= 15 && !record?.metricsFrozen;
  return {
    active,
    ageDays,
    label: active ? '每日更新中' : '数据已定格',
    description: active
      ? `发布后第 ${Math.max(1, Math.floor(ageDays) + 1)} 天，数据每天 14:30 更新`
      : '发布超过 15 天，保留最后一次累计数据'
  };
}

export function buildPublishedMetricRows(record = {}, medians = {}) {
  const metrics = getMetrics(record);
  const metricRows = [
    { key: 'impressions', label: '曝光', value: metrics.impressions, median: medians.impressions, kind: 'number' },
    { key: 'views', label: '观看量', value: metrics.views, median: medians.views, kind: 'number' },
    { key: 'coverClickRate', label: '封面点击率', value: metrics.coverClickRate, median: medians.coverClickRate, kind: 'rate' },
    { key: 'comments', label: '评论', value: metrics.comments, median: medians.comments, kind: 'number' },
    { key: 'favoriteRate', label: '收藏率', value: rate(metrics.favorites, metrics.views), median: medians.favoriteRate, kind: 'rate' },
    { key: 'shareRate', label: '分享率', value: rate(metrics.shares, metrics.views), median: medians.shareRate, kind: 'rate' },
    { key: 'followRate', label: '涨粉率', value: rate(metrics.follows, metrics.views), median: medians.followRate, kind: 'rate' }
  ];
  return metricRows.map(item => ({
    ...item,
    belowMedian: Number(medians.sampleSize || 0) > 0 && item.value < item.median
  }));
}

export function buildPublishedPageModel(items = [], options = {}) {
  const visibleItems = safeArray(items).filter(Boolean);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const records = visibleItems.map(item => item.record || item).filter(Boolean);
  const medians = computePublishedThirtyDayMedians(records, now);
  const activeCount = records.filter(record => getPublishedUpdateState(record, now).active).length;
  const pageSize = Math.max(1, Number.parseInt(options.pageSize, 10) || PUBLISHED_PAGE_SIZE);
  const visibleLimit = Math.max(pageSize, Number.parseInt(options.visibleLimit, 10) || pageSize);
  const renderItems = visibleItems.slice(0, visibleLimit);
  return {
    items: visibleItems,
    renderItems,
    medians,
    count: visibleItems.length,
    renderedCount: renderItems.length,
    remainingCount: Math.max(0, visibleItems.length - renderItems.length),
    hasMore: renderItems.length < visibleItems.length,
    nextLimit: Math.min(visibleItems.length, renderItems.length + pageSize),
    pageSize,
    activeCount,
    frozenCount: Math.max(0, visibleItems.length - activeCount),
    isEmpty: visibleItems.length === 0,
    countText: visibleItems.length
      ? `${visibleItems.length} 篇已发布 · ${activeCount} 篇仍在更新`
      : '等待首次导入小红书官方内容数据'
  };
}

export function createPublishedPageController(options = {}) {
  const root = options.root;
  if (!root?.addEventListener) return { destroy() {} };

  function invoke(handler, ...args) {
    if (typeof handler !== 'function') return;
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') result.catch(error => options.onError?.(error));
    } catch (error) {
      options.onError?.(error);
    }
  }

  function handleClick(event) {
    const actionElement = event.target?.closest?.('[data-published-action]');
    if (!actionElement || !root.contains(actionElement)) return;
    const action = actionElement.dataset?.publishedAction;
    if (!action) return;
    event.preventDefault?.();
    if (action === 'open-detail') invoke(options.onOpenDetail, actionElement.dataset.recordId || '');
    else if (action === 'load-more') invoke(options.onLoadMore);
    else if (action === 'refresh') invoke(options.onRefresh, actionElement.dataset.recordId || '');
    else if (action === 'render') invoke(options.onRender);
  }

  function handleKeydown(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    const actionElement = event.target?.closest?.('[data-published-action]');
    if (!actionElement || !root.contains(actionElement)) return;
    event.preventDefault?.();
    actionElement.click?.();
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('keydown', handleKeydown);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
      root.removeEventListener?.('keydown', handleKeydown);
    }
  };
}

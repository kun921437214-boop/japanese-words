const DEFAULT_STATUS_LABELS = {
  idle: '待自动更新',
  success: '自动更新成功',
  partial: '部分更新',
  failed: '自动更新失败'
};

function toMetric(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function getStats(record = {}) {
  const stats = record?.latestStats || record || {};
  return {
    likes: toMetric(stats.likes),
    favorites: toMetric(stats.favorites),
    comments: toMetric(stats.comments),
    shares: toMetric(stats.shares),
    views: toMetric(stats.views)
  };
}

export function getPublishedPerformanceScore(record = {}) {
  const stats = getStats(record);
  return stats.likes + stats.favorites * 2 + stats.comments * 3 + stats.shares * 3;
}

export function getPublishedRecordAgeHours(record = {}, now = Date.now()) {
  if (!record?.publishedAt) return 0;
  const publishedTime = new Date(record.publishedAt).getTime();
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(publishedTime) || !Number.isFinite(currentTime)) return 0;
  return Math.max(0, (currentTime - publishedTime) / 3600000);
}

export function getRecentPublishedAverage(records = [], limit = 20) {
  const recentRecords = (Array.isArray(records) ? records : [])
    .filter(record => record?.sourceStatus !== 'placeholder')
    .sort((left, right) => String(right?.publishedAt || right?.updatedAt || '').localeCompare(String(left?.publishedAt || left?.updatedAt || '')))
    .slice(0, Math.max(1, Number.parseInt(limit, 10) || 20));
  if (!recentRecords.length) return 0;
  return recentRecords.reduce((sum, record) => sum + getPublishedPerformanceScore(record), 0) / recentRecords.length;
}

export function ratePublishedRecord(record = {}, options = {}) {
  const performanceScore = getPublishedPerformanceScore(record);
  const recentAverage = Number.isFinite(options.recentAverage)
    ? options.recentAverage
    : getRecentPublishedAverage(options.records);
  const average = recentAverage || performanceScore;
  const ratio = average > 0 ? performanceScore / average : 1;
  const ageHours = getPublishedRecordAgeHours(record, options.now ?? Date.now());
  const stats = getStats(record);
  const exposure = stats.views;
  const saveRate = exposure > 0 ? stats.favorites / exposure : 0;

  let level = '待评估';
  let reason = '还没满 72 小时，先继续观察。';

  if (ageHours >= 72) {
    if (exposure > 0 && saveRate >= 0.04 && performanceScore < average * 0.7) {
      level = '正常';
      reason = '曝光不算高，但收藏率不错，更像流量不足，不一定是词方向问题。';
    } else if (ratio >= 1.5) {
      level = '优秀';
      reason = '综合互动明显高于最近已发布内容的平均水平。';
    } else if (ratio >= 0.7) {
      level = '正常';
      reason = '综合表现处于近期内容的正常区间。';
    } else if (ratio >= 0.3) {
      level = '偏弱';
      reason = '综合互动低于近期平均，需要结合标题、封面和发布时间判断。';
    } else {
      level = '异常差';
      reason = '综合互动显著低于近期平均，建议重点复盘词方向和内容包装。';
    }

    if (exposure >= 1000 && stats.likes + stats.favorites + stats.comments <= 10) {
      level = '偏弱';
      reason = '有一定曝光但互动偏低，说明这个词或选题包装当前不够适配。';
    }
  }

  return { level, reason, performanceScore, recentAverage: average, ratio, ageHours, saveRate };
}

export function getPublishedAutoRefreshSummary(record = {}, options = {}) {
  const state = record?.autoRefresh || record || {};
  const statusLabels = options.statusLabels || DEFAULT_STATUS_LABELS;
  const sourceLabels = options.sourceLabels || {};
  const status = Object.prototype.hasOwnProperty.call(statusLabels, state.status) ? state.status : 'idle';
  return {
    label: statusLabels[status] || DEFAULT_STATUS_LABELS.idle,
    message: String(state.lastMessage || '系统会在每天 09:00（北京时间）尝试更新一次，失败时保留上次数据。'),
    sourceLabel: sourceLabels[state.source] || '',
    timeLabel: state.lastAttemptAt ? String(state.lastAttemptAt).slice(0, 16).replace('T', ' ') : '尚未自动更新'
  };
}

export function buildPublishedPageModel(items = []) {
  const visibleItems = Array.isArray(items) ? items.filter(Boolean) : [];
  return {
    items: visibleItems,
    count: visibleItems.length,
    isEmpty: visibleItems.length === 0,
    countText: visibleItems.length
      ? `当前共 ${visibleItems.length} 条已发布记录 / 占位项`
      : '管理已经发到小红书的内容和表现'
  };
}

export function createPublishedPageController(options = {}) {
  const root = options.root;
  if (!root?.addEventListener) return { destroy() {} };

  function belongsToRoot(element) {
    return !element || typeof root.contains !== 'function' || root.contains(element);
  }

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
    const target = event.target;
    if (!target?.closest) return;
    const stopElement = target.closest('[data-published-stop]');
    if (stopElement && belongsToRoot(stopElement)) event.stopPropagation?.();
    const actionElement = target.closest('[data-published-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    if (stopElement && typeof stopElement.contains === 'function' && !stopElement.contains(actionElement)) return;
    const action = actionElement.dataset?.publishedAction;
    if (!action) return;
    event.preventDefault?.();

    if (action === 'open-detail') invoke(options.onOpenDetail, actionElement.dataset.recordId || '');
    else if (action === 'edit-record') invoke(options.onEditRecord, actionElement.dataset.recordId || '', actionElement.dataset.presetKanji || '');
    else if (action === 'add-record') invoke(options.onAddRecord);
    else if (action === 'refresh') invoke(options.onRefresh, actionElement.dataset.recordId || '');
    else if (action === 'render') invoke(options.onRender);
  }

  root.addEventListener('click', handleClick);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
    }
  };
}

export { DEFAULT_STATUS_LABELS };

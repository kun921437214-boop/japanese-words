const FAVORITE_STATUSES = ['none', 'pending', 'published'];
const FAVORITE_STATUS_FILTERS = ['all', 'none', 'pending'];
export const FAVORITES_PAGE_SIZE = 12;

function uniqueWords(words = []) {
  const seen = new Set();
  return (Array.isArray(words) ? words : []).reduce((result, word) => {
    const cleanWord = String(word || '').trim();
    if (!cleanWord || seen.has(cleanWord)) return result;
    seen.add(cleanWord);
    result.push(cleanWord);
    return result;
  }, []);
}

export function normalizeFavoriteStatus(status = '') {
  return FAVORITE_STATUSES.includes(status) ? status : 'none';
}

export function normalizeFavoriteStatusFilter(status = '') {
  return FAVORITE_STATUS_FILTERS.includes(status) ? status : 'all';
}

export function buildFavoritesPageModel(options = {}) {
  const allWords = Array.isArray(options.words) ? options.words.filter(Boolean) : [];
  const sourceFilter = String(options.sourceFilter || 'all');
  const statusFilter = normalizeFavoriteStatusFilter(options.statusFilter);
  const getStatus = typeof options.getStatus === 'function'
    ? options.getStatus
    : word => word?.status;
  const sourceFilteredWords = sourceFilter === 'all'
    ? allWords
    : allWords.filter(word => word?.source === sourceFilter);
  const visibleWords = statusFilter === 'all'
    ? sourceFilteredWords
    : sourceFilteredWords.filter(word => normalizeFavoriteStatus(getStatus(word)) === statusFilter);
  const total = allWords.length;
  const visible = visibleWords.length;
  const pageSize = Math.max(1, Number.parseInt(options.pageSize, 10) || FAVORITES_PAGE_SIZE);
  const visibleLimit = Math.max(pageSize, Number.parseInt(options.visibleLimit, 10) || pageSize);
  const renderedWords = visibleWords.slice(0, visibleLimit);
  const rendered = renderedWords.length;

  return {
    allWords,
    visibleWords,
    renderedWords,
    total,
    visible,
    rendered,
    remaining: Math.max(0, visible - rendered),
    hasMore: rendered < visible,
    nextLimit: Math.min(visible, rendered + pageSize),
    pageSize,
    isEmpty: visible === 0,
    countText: visible === 0
      ? (total ? '当前筛选条件下没有词' : '保存你感兴趣、准备发布和已进入工作流的词')
      : (visible === total ? `当前选题池 ${visible} 个词` : `筛选显示 ${visible} / ${total} 个词`),
    autoGenerateWords: visibleWords.map(word => word?.kanji).filter(Boolean),
    renderedAutoGenerateWords: renderedWords.map(word => word?.kanji).filter(Boolean)
  };
}

export function transitionFavoriteToggle(options = {}) {
  const kanji = String(options.kanji || '').trim();
  const favorites = uniqueWords(options.favorites);
  const statuses = { ...(options.statuses || {}) };
  if (!kanji) return { action: '', favorites, statuses, changed: false };

  const exists = favorites.includes(kanji);
  const shouldFavorite = options.forceState === null || options.forceState === undefined
    ? !exists
    : Boolean(options.forceState);
  if (shouldFavorite === exists) {
    return { action: '', favorites, statuses, changed: false };
  }
  if (shouldFavorite) {
    return {
      action: 'add',
      favorites: [kanji, ...favorites.filter(word => word !== kanji)],
      statuses,
      changed: true
    };
  }

  delete statuses[kanji];
  return {
    action: 'remove',
    favorites: favorites.filter(word => word !== kanji),
    statuses,
    changed: true
  };
}

export function transitionFavoriteStatus(options = {}) {
  const kanji = String(options.kanji || '').trim();
  const favorites = uniqueWords(options.favorites);
  const statuses = { ...(options.statuses || {}) };
  const status = normalizeFavoriteStatus(options.status);
  if (!kanji) return { favorites, statuses, status };

  const nextFavorites = favorites.includes(kanji) ? favorites : [kanji, ...favorites];
  if (status === 'none') delete statuses[kanji];
  else statuses[kanji] = status;
  return { favorites: nextFavorites, statuses, status };
}

function parseForceState(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function createFavoritesPageController(options = {}) {
  const root = options.root;
  if (!root?.addEventListener) return { destroy() {} };

  function belongsToRoot(element) {
    return !element || typeof root.contains !== 'function' || root.contains(element);
  }

  function invoke(handler, ...args) {
    if (typeof handler !== 'function') return;
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') {
        result.catch(error => options.onError?.(error));
      }
    } catch (error) {
      options.onError?.(error);
    }
  }

  function handleClick(event) {
    const target = event.target;
    if (!target?.closest) return;
    const stopElement = target.closest('[data-favorites-stop]');
    if (stopElement && belongsToRoot(stopElement)) event.stopPropagation?.();
    const actionElement = target.closest('[data-favorites-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    if (stopElement && typeof stopElement.contains === 'function' && !stopElement.contains(actionElement)) return;
    const action = actionElement.dataset?.favoritesAction;
    if (!action || ['source-filter', 'status-filter'].includes(action)) return;
    event.preventDefault?.();

    if (action === 'open-detail') invoke(options.onOpenDetail, actionElement.dataset.wordId || actionElement.dataset.kanji || '');
    else if (action === 'load-more') invoke(options.onLoadMore);
    else if (action === 'toggle-favorite') invoke(options.onToggleFavorite, actionElement.dataset.kanji || '', parseForceState(actionElement.dataset.forceState));
    else if (action === 'toggle-status') invoke(options.onToggleStatus, actionElement.dataset.kanji || '');
    else if (action === 'select-status') invoke(options.onSelectStatus, actionElement.dataset.kanji || '', actionElement.dataset.status || 'none');
    else if (action === 'add-manual-word') invoke(options.onAddManualWord);
    else if (action === 'export') invoke(options.onExport);
  }

  function handleChange(event) {
    const target = event.target;
    if (!target?.closest) return;
    const actionElement = target.closest('[data-favorites-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    const action = actionElement.dataset?.favoritesAction;
    if (action === 'source-filter') invoke(options.onSourceFilter, actionElement.value || 'all');
    else if (action === 'status-filter') invoke(options.onStatusFilter, actionElement.value || 'all');
  }

  function handleDetailIntent(event) {
    const target = event.target;
    if (!target?.closest) return;
    const actionElement = target.closest('[data-favorites-action="open-detail"]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    invoke(options.onPrefetchDetail, actionElement.dataset.wordId || actionElement.dataset.kanji || '');
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('pointerover', handleDetailIntent);
  root.addEventListener('pointerdown', handleDetailIntent);
  root.addEventListener('focusin', handleDetailIntent);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
      root.removeEventListener?.('change', handleChange);
      root.removeEventListener?.('pointerover', handleDetailIntent);
      root.removeEventListener?.('pointerdown', handleDetailIntent);
      root.removeEventListener?.('focusin', handleDetailIntent);
    }
  };
}

export { FAVORITE_STATUSES, FAVORITE_STATUS_FILTERS };

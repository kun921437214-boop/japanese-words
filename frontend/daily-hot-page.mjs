const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function uniqueStrings(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue || seen.has(cleanValue)) return result;
    seen.add(cleanValue);
    result.push(cleanValue);
    return result;
  }, []);
}

export function buildDailyHotDateOptions(options = {}) {
  const todayDateKey = String(options.todayDateKey || '').trim();
  const formatWeekday = typeof options.formatWeekday === 'function' ? options.formatWeekday : () => '';
  const historyDates = uniqueStrings(options.historyDates)
    .filter(dateKey => DATE_KEY_PATTERN.test(dateKey) && (!todayDateKey || dateKey < todayDateKey))
    .sort((left, right) => right.localeCompare(left));
  return [
    { value: 'today', label: `今天 · ${todayDateKey}` },
    ...historyDates.map(dateKey => ({
      value: dateKey,
      label: `${dateKey} · ${formatWeekday(dateKey)}`
    }))
  ].filter(option => option.value);
}

export function normalizeDailyHotDateSelection(value = 'today', dateOptions = []) {
  const cleanValue = value === 'today' ? 'today' : String(value || '').trim();
  return (Array.isArray(dateOptions) ? dateOptions : []).some(option => option?.value === cleanValue)
    ? cleanValue
    : 'today';
}

export function buildDailyHotSourceFilterModel(options = {}) {
  const words = Array.isArray(options.words) ? options.words.filter(Boolean) : [];
  const sources = uniqueStrings(words.map(word => word?.source))
    .sort((left, right) => left.localeCompare(right, 'zh-Hans'));
  const requestedSource = String(options.sourceFilter || 'all');
  const sourceFilter = sources.includes(requestedSource) ? requestedSource : 'all';
  const visibleWords = sourceFilter === 'all'
    ? words
    : words.filter(word => word?.source === sourceFilter);
  return {
    words,
    visibleWords,
    sources,
    sourceFilter,
    total: words.length,
    visible: visibleWords.length,
    options: [
      { value: 'all', label: '全部来源' },
      ...sources.map(source => ({ value: source, label: source }))
    ]
  };
}

export function buildHistoryNavigationModel(options = {}) {
  const dates = uniqueStrings(options.dates)
    .filter(dateKey => DATE_KEY_PATTERN.test(dateKey))
    .sort((left, right) => right.localeCompare(left));
  const requestedDate = String(options.currentDate || '').trim();
  const currentDate = dates.includes(requestedDate) ? requestedDate : (dates[0] || '');
  const currentIndex = currentDate ? dates.indexOf(currentDate) : -1;
  return {
    dates,
    currentDate,
    currentIndex,
    earlierDisabled: currentIndex < 0 || currentIndex >= dates.length - 1,
    laterDisabled: currentIndex <= 0,
    shift(step = 0) {
      if (currentIndex < 0) return '';
      const offset = Number.parseInt(step, 10) || 0;
      const nextIndex = Math.min(dates.length - 1, Math.max(0, currentIndex + offset));
      return dates[nextIndex] || currentDate;
    }
  };
}

function parseIndex(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : -1;
}

export function createDailyHotPageController(options = {}) {
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

  function routeAction(actionElement) {
    const action = actionElement?.dataset?.dailyHotAction;
    if (!action) return;
    const kanji = actionElement.dataset.kanji || '';
    if (action === 'refresh') invoke(options.onRefresh);
    else if (action === 'toggle-manage') invoke(options.onToggleManage);
    else if (action === 'manage') invoke(options.onManage, actionElement.dataset.manageAction || '');
    else if (action === 'generate-cards') invoke(options.onGenerateCards);
    else if (action === 'export') invoke(options.onExport);
    else if (action === 'shift-history') invoke(options.onShiftHistory, Number.parseInt(actionElement.dataset.step, 10) || 0);
    else if (action === 'open-detail') invoke(options.onOpenDetail, actionElement.dataset.wordId || kanji);
    else if (action === 'toggle-favorite') invoke(options.onToggleFavorite, kanji);
    else if (action === 'dismiss') invoke(options.onDismiss, kanji);
    else if (action === 'generate-card') invoke(options.onGenerateCard, kanji);
    else if (action === 'generate-today') invoke(options.onGenerateToday);
    else if (action === 'open-codex-preview') invoke(options.onOpenCodexPreview, parseIndex(actionElement.dataset.index));
    else if (action === 'toggle-codex-favorite') invoke(options.onToggleCodexFavorite, kanji);
    else if (action === 'codex-feedback') invoke(options.onCodexFeedback, kanji, actionElement.dataset.reason || 'uninterested');
  }

  function handleClick(event) {
    const target = event.target;
    if (!target?.closest) return;
    const stopElement = target.closest('[data-daily-hot-stop]');
    if (stopElement && belongsToRoot(stopElement)) event.stopPropagation?.();
    const actionElement = target.closest('[data-daily-hot-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    if (stopElement && typeof stopElement.contains === 'function' && !stopElement.contains(actionElement)) return;
    if (['date', 'source'].includes(actionElement.dataset?.dailyHotAction)) return;
    event.preventDefault?.();
    routeAction(actionElement);
  }

  function handleChange(event) {
    const target = event.target;
    if (!target?.closest) return;
    const actionElement = target.closest('[data-daily-hot-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    const action = actionElement.dataset?.dailyHotAction;
    if (action === 'date') invoke(options.onDateChange, actionElement.value || 'today');
    else if (action === 'source') invoke(options.onSourceChange, actionElement.dataset.scope || 'today', actionElement.value || 'all');
  }

  function handleKeydown(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    const target = event.target;
    if (!target?.closest) return;
    const actionElement = target.closest('[data-daily-hot-action]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    if (!['open-detail', 'open-codex-preview'].includes(actionElement.dataset?.dailyHotAction)) return;
    event.preventDefault?.();
    routeAction(actionElement);
  }

  function handleDetailIntent(event) {
    const target = event.target;
    if (!target?.closest) return;
    const actionElement = target.closest('[data-daily-hot-action="open-detail"]');
    if (!actionElement || !belongsToRoot(actionElement)) return;
    invoke(options.onPrefetchDetail, actionElement.dataset.wordId || actionElement.dataset.kanji || '');
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('keydown', handleKeydown);
  root.addEventListener('pointerover', handleDetailIntent);
  root.addEventListener('pointerdown', handleDetailIntent);
  root.addEventListener('focusin', handleDetailIntent);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
      root.removeEventListener?.('change', handleChange);
      root.removeEventListener?.('keydown', handleKeydown);
      root.removeEventListener?.('pointerover', handleDetailIntent);
      root.removeEventListener?.('pointerdown', handleDetailIntent);
      root.removeEventListener?.('focusin', handleDetailIntent);
    }
  };
}

export { DATE_KEY_PATTERN };

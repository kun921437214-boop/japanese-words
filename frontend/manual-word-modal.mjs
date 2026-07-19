const MANUAL_WORD_ACTION_ATTRIBUTE = 'data-manual-word-action';

export function createManualWordModalController(options = {}) {
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
    const actionElement = target.closest(`[${MANUAL_WORD_ACTION_ATTRIBUTE}]`);
    if (!actionElement || !belongsToRoot(actionElement)) return;
    const action = actionElement.dataset?.manualWordAction;
    if (action === 'close') invoke(options.onClose);
    else if (action === 'submit') invoke(options.onSubmit);
    else if (action === 'confirm-existing') {
      invoke(
        options.onConfirmExisting,
        actionElement.dataset.kanji || '',
        actionElement.dataset.manualOptions || '{}'
      );
    } else if (action === 'open-detail') {
      invoke(options.onOpenDetail, actionElement.dataset.kanji || '');
    }
  }

  root.addEventListener('click', handleClick);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
    }
  };
}

export { MANUAL_WORD_ACTION_ATTRIBUTE };

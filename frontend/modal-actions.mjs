const MODAL_ACTION_ATTRIBUTE = 'data-modal-action';

export function createModalActionsController(options = {}) {
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
    const actionElement = event.target?.closest?.(`[${MODAL_ACTION_ATTRIBUTE}]`);
    if (!actionElement || !belongsToRoot(actionElement)) return;
    event.stopPropagation?.();
    const dataset = actionElement.dataset || {};
    const action = dataset.modalAction;
    if (action === 'close') invoke(options.onClose);
    else if (action === 'toggle-codex-favorite') {
      invoke(options.onClose);
      invoke(options.onToggleCodexFavorite, dataset.kanji || '');
    } else if (action === 'export-recommendation-audit') invoke(options.onExportRecommendationAudit);
    else if (action === 'mark-pending') invoke(options.onMarkPending, dataset.kanji || '');
    else if (action === 'open-regeneration-reasons') invoke(options.onOpenRegenerationReasons, dataset.kanji || '', dataset.target || 'card');
    else if (action === 'select-regeneration-reason') invoke(options.onSelectRegenerationReason, dataset.kanji || '', dataset.target || 'card', dataset.reason || '');
    else if (action === 'back-to-word-detail') invoke(options.onOpenWordDetail, dataset.kanji || '');
    else if (action === 'open-published-record') {
      invoke(options.onOpenPublishedRecord, dataset.recordId || '', dataset.presetKanji || '');
    } else if (action === 'copy-library-cleanup') invoke(options.onCopyLibraryCleanup, dataset.mode || 'run');
    else if (action === 'autofill-published-record') invoke(options.onAutofillPublishedRecord);
    else if (action === 'save-published-record') invoke(options.onSavePublishedRecord);
    else if (action === 'open-published-detail') invoke(options.onOpenPublishedDetail, dataset.recordId || '');
    else if (action === 'refresh-published-record') invoke(options.onRefreshPublishedRecord, dataset.recordId || '');
  }

  root.addEventListener('click', handleClick);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
    }
  };
}

export { MODAL_ACTION_ATTRIBUTE };

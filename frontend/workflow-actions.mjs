const WORKFLOW_ACTION_ATTRIBUTE = 'data-workflow-action';
const WORKFLOW_STOP_ATTRIBUTE = 'data-workflow-stop';

export function createWorkflowActionsController(options = {}) {
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

  function findBoundary(target) {
    if (!target?.closest) return null;
    return target.closest(`[${WORKFLOW_ACTION_ATTRIBUTE}], [${WORKFLOW_STOP_ATTRIBUTE}]`);
  }

  function handleClick(event) {
    const actionElement = findBoundary(event.target);
    if (!actionElement || !belongsToRoot(actionElement)) return;
    event.stopPropagation?.();
    const dataset = actionElement.dataset || {};
    const action = dataset.workflowAction;
    if (!action) return;
    if (action === 'generate-today-card') invoke(options.onGenerateTodayCard, dataset.kanji || '');
    else if (action === 'generate-deepseek-card') invoke(options.onGenerateDeepSeekCard, dataset.kanji || '', dataset.force === 'true');
    else if (action === 'toggle-status') invoke(options.onToggleStatus, dataset.kanji || '');
    else if (action === 'select-status') invoke(options.onSelectStatus, dataset.kanji || '', dataset.status || 'none');
    else if (action === 'toggle-feedback') invoke(options.onToggleFeedback, dataset.kanji || '');
    else if (action === 'apply-feedback') {
      const handler = dataset.context === 'codex-preview' ? options.onCodexFeedback : options.onNegativeFeedback;
      invoke(handler, dataset.kanji || '', dataset.reason || '');
    } else if (action === 'candidate-open-detail') invoke(options.onOpenDetail, dataset.wordId || dataset.kanji || '');
    else if (action === 'candidate-toggle') invoke(options.onToggleCandidate, dataset.kanji || '');
    else if (action === 'candidate-state') invoke(options.onSetCandidateState, dataset.kanji || '', dataset.state || '');
  }

  function handleChange(event) {
    const actionElement = event.target?.closest?.(`[${WORKFLOW_ACTION_ATTRIBUTE}]`);
    if (!actionElement || !belongsToRoot(actionElement)) return;
    if (actionElement.dataset?.workflowAction === 'ai-preview-selection') {
      invoke(options.onToggleAiPreviewSelection, actionElement.dataset.kanji || '');
    }
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
      root.removeEventListener?.('change', handleChange);
    }
  };
}

export { WORKFLOW_ACTION_ATTRIBUTE, WORKFLOW_STOP_ATTRIBUTE };

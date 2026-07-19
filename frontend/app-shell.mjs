const APP_SHELL_ACTION_ATTRIBUTE = 'data-app-shell-action';

export function createAppShellController(options = {}) {
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

  function findActionElement(target) {
    if (!target?.closest) return null;
    const actionElement = target.closest(`[${APP_SHELL_ACTION_ATTRIBUTE}]`);
    return actionElement && belongsToRoot(actionElement) ? actionElement : null;
  }

  function routeAction(actionElement, event) {
    const action = actionElement?.dataset?.appShellAction;
    if (!action) return;
    if (action === 'toggle-sidebar') invoke(options.onToggleSidebar);
    else if (action === 'switch-tab') invoke(options.onSwitchTab, actionElement.dataset.tab || 'today');
    else if (action === 'open-settings') invoke(options.onOpenSettings);
    else if (action === 'close-settings') invoke(options.onCloseSettings);
    else if (action === 'export-backup') invoke(options.onExportBackup);
    else if (action === 'select-restore') invoke(options.onSelectRestore);
    else if (action === 'close-modal-outside' && event?.target === actionElement) invoke(options.onCloseModal);
    else if (action === 'close-settings-outside' && event?.target === actionElement) invoke(options.onCloseSettings);
  }

  function handleClick(event) {
    const actionElement = findActionElement(event.target);
    if (!actionElement) return;
    if (actionElement.dataset.appShellAction === 'restore-workflow') return;
    routeAction(actionElement, event);
  }

  function handleChange(event) {
    const actionElement = findActionElement(event.target);
    if (actionElement?.dataset?.appShellAction !== 'restore-workflow') return;
    invoke(options.onRestoreWorkflow, event);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      invoke(options.onEscape);
      return;
    }
    if (!['Enter', ' '].includes(event.key)) return;
    const actionElement = findActionElement(event.target);
    if (actionElement?.dataset?.appShellAction !== 'switch-tab') return;
    event.preventDefault?.();
    routeAction(actionElement, event);
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('keydown', handleKeydown);
  return {
    destroy() {
      root.removeEventListener?.('click', handleClick);
      root.removeEventListener?.('change', handleChange);
      root.removeEventListener?.('keydown', handleKeydown);
    }
  };
}

export { APP_SHELL_ACTION_ATTRIBUTE };

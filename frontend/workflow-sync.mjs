export function isRetryableWorkflowReadError(error) {
  if (error?.code === 'REQUEST_ABORTED') return false;
  if (error?.code === 'REQUEST_TIMEOUT') return true;
  const status = Number(error?.status) || 0;
  return !status || status === 408 || status === 429 || status >= 500;
}

export function isRetryableWorkflowMutationError(error) {
  if (error?.code === 'REQUEST_ABORTED') return false;
  if (error?.status === 409 || error?.code === 'REQUEST_TIMEOUT') return true;
  const status = Number(error?.status) || 0;
  return !status || status === 408 || status === 429 || status >= 500;
}

export function createWorkflowSync(options = {}) {
  const request = options.request;
  const createError = options.createError;
  const loadRemote = options.loadRemote;
  const delay = options.delay || (milliseconds => new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  }));

  if (typeof request !== 'function' || typeof createError !== 'function') {
    throw new TypeError('workflow sync requires request and createError functions');
  }

  async function mutate(config = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await request(config.endpoint, {
          method: config.method || 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(config.headers || {})
          },
          body: JSON.stringify(config.payload || {})
        }, {
          workflowMutation: true,
          operationId: config.operationId,
          operationPrefix: config.operationPrefix || 'workflow-mutation',
          timeoutMs: config.timeoutMs || 30000
        });
        const responseData = await response.json().catch(() => ({}));
        if (!response.ok) throw createError(responseData, response.status);
        return responseData;
      } catch (error) {
        lastError = error;
        if (attempt > 0 || !isRetryableWorkflowMutationError(error)) break;
        const reconcile = typeof config.reconcile === 'function' ? config.reconcile : loadRemote;
        const reconciled = typeof reconcile === 'function' ? await reconcile() : false;
        if (reconciled && config.isSatisfied?.(reconciled)) {
          return config.buildReconciledResponse?.(reconciled) || { ok: true, reconciled: true };
        }
        if (error?.status === 409 && !reconciled) break;
        await delay(config.retryDelayMs || 250);
      }
    }
    throw lastError || new Error('工作流同步失败');
  }

  async function read(config = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (config.isCurrent && !config.isCurrent()) {
        const canceledError = new Error('请求已被新的同步替代');
        canceledError.code = 'REQUEST_ABORTED';
        throw canceledError;
      }
      try {
        const response = await request(config.endpoint, {
          cache: 'no-store',
          headers: { Accept: 'application/json', ...(config.headers || {}) }
        }, {
          cancelKey: config.cancelKey || 'workflow-load',
          timeoutMs: config.timeoutMs || 45000
        });
        const responseData = await response.json().catch(() => ({}));
        if (!response.ok) throw createError(responseData, response.status);
        return responseData;
      } catch (error) {
        lastError = error;
        if (attempt > 0 || !isRetryableWorkflowReadError(error)) throw error;
        await delay(config.retryDelayMs || 300);
      }
    }
    throw lastError || new Error('工作流读取失败');
  }

  return { mutate, read };
}

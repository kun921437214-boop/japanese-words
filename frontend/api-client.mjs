function cleanText(value, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, number));
}

export function createOperationId(prefix = 'web', cryptoImpl = globalThis.crypto) {
  const randomId = cryptoImpl?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${cleanText(prefix, 80) || 'web'}-${randomId}`.slice(0, 120);
}

export function getApiErrorMessage(data, status = 0) {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  if (status === 401) return '团队身份验证失败，请重新登录';
  if (status === 409) return '团队数据已更新，请刷新后重试';
  if (status === 429) return '请求过于频繁，请稍后重试';
  return status ? `HTTP ${status}` : '网络请求失败';
}

export function createApiError(data, status = 0) {
  const error = new Error(getApiErrorMessage(data, status));
  error.status = status;
  error.code = data?.error?.code || '';
  error.retryable = Boolean(data?.error?.retryable);
  error.requestId = cleanText(data?.requestId, 160);
  return error;
}

export function createApiClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getWorkflowRevision = typeof options.getWorkflowRevision === 'function'
    ? options.getWorkflowRevision
    : () => 0;
  const activeControllers = new Map();
  const operationsInFlight = new Set();

  async function request(endpoint, requestOptions = {}, config = {}) {
    const timeoutMs = clampInteger(config.timeoutMs, 20000, 1000, 120000);
    const cancelKey = cleanText(config.cancelKey, 120);
    if (cancelKey) activeControllers.get(cancelKey)?.abort();
    const controller = new AbortController();
    if (cancelKey) activeControllers.set(cancelKey, controller);
    const externalSignal = requestOptions.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, timeoutMs);
    const headers = new Headers(requestOptions.headers || {});
    if (config.workflowMutation) {
      headers.set('X-Operation-Id', config.operationId || createOperationId(config.operationPrefix || 'workflow'));
      headers.set('X-Workflow-Revision', String(getWorkflowRevision()));
    }

    try {
      return await fetchImpl(endpoint, {
        ...requestOptions,
        credentials: requestOptions.credentials || 'same-origin',
        headers,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const abortError = new Error(timedOut ? '请求超时' : '请求已取消');
        abortError.code = timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED';
        throw abortError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      if (cancelKey && activeControllers.get(cancelKey) === controller) activeControllers.delete(cancelKey);
    }
  }

  async function runExclusive(key, operation, onDuplicate) {
    const cleanKey = cleanText(key, 160);
    if (operationsInFlight.has(cleanKey)) {
      onDuplicate?.(cleanKey);
      return false;
    }
    operationsInFlight.add(cleanKey);
    try {
      return await operation();
    } finally {
      operationsInFlight.delete(cleanKey);
    }
  }

  function abortAll() {
    activeControllers.forEach(controller => controller.abort());
    activeControllers.clear();
  }

  return {
    activeControllers,
    operationsInFlight,
    request,
    runExclusive,
    abortAll,
    createOperationId,
    getApiErrorMessage,
    createApiError
  };
}

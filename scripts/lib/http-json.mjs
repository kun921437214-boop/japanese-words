// Callers own HTTP-status and JSON-error policy, authentication, and retries.
// A configured timeout covers both response headers and the complete body.
export async function fetchJsonResponse(url, options = {}, { timeoutMs, checkResponse } = {}) {
  let timeout;
  let requestOptions = options;
  if (timeoutMs !== undefined) {
    const controller = new AbortController();
    requestOptions = {
      ...options,
      signal: options.signal
        ? globalThis.AbortSignal.any([options.signal, controller.signal])
        : controller.signal
    };
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const response = await fetch(url, requestOptions);
    checkResponse?.(response);
    const text = await response.text();
    try {
      return { response, text, data: JSON.parse(text), parseError: null };
    } catch (parseError) {
      return { response, text, data: undefined, parseError };
    }
  } finally {
    clearTimeout(timeout);
  }
}

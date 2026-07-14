import { errorResponse, getRequestId } from '../shared/api-security.mjs';

function cleanLogText(value, maxLength = 120) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

export async function onRequest(context) {
  const { request, env } = context;
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const url = new URL(request.url);
  try {
    const response = await context.next();
    const headers = new Headers(response.headers);
    const responseRequestId = cleanLogText(headers.get('X-Request-Id'), 120) || requestId;
    headers.set('X-Request-Id', responseRequestId);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Server-Timing', `app;dur=${Date.now() - startedAt}`);
    console.log(JSON.stringify({
      event: 'http_request',
      requestId: responseRequestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt
    }));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'http_error',
      requestId,
      method: request.method,
      path: url.pathname,
      durationMs: Date.now() - startedAt,
      errorName: cleanLogText(error?.name || 'Error')
    }));
    return errorResponse(request, env, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', {
      requestId,
      retryable: true
    });
  }
}

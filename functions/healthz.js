import { getRequestId, jsonResponse, optionsResponse } from '../shared/api-security.mjs';

export async function onRequest({ request, env }) {
  const methods = ['GET', 'HEAD', 'OPTIONS'];
  if (request.method === 'OPTIONS') return optionsResponse(request, env, methods);
  if (!['GET', 'HEAD'].includes(request.method)) {
    return jsonResponse(request, env, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', retryable: false }
    }, 405, { methods });
  }

  const requestId = getRequestId(request);
  const storageConfigured = Boolean(env.FAVORITES);
  const workflowCoordinatorConfigured = Boolean(env.WORKFLOW_COORDINATOR);
  const imageStorageConfigured = Boolean(env.REFERENCE_IMAGES || env.REFERENCE_IMAGES_KV);
  const response = jsonResponse(request, env, {
    ok: storageConfigured,
    service: 'japanese-words-pages',
    storageConfigured,
    workflowCoordinatorConfigured,
    imageStorageConfigured,
    checkedAt: new Date().toISOString()
  }, storageConfigured ? 200 : 503, { methods, requestId });
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

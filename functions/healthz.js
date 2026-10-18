import { getRequestId, jsonResponse, optionsResponse } from '../shared/api-security.mjs';
import { addDays, dateKey } from '../shared/rankings.mjs';
import { getWeeklyContentWindow, getWeeklyContentHealthStorageKey } from '../shared/weekly-content-health.mjs';

function summarizeDailyHealth(record, targetDateKey) {
  return {
    targetDateKey,
    status: ['healthy', 'unhealthy'].includes(record?.status) ? record.status : 'unknown',
    checkedAt: String(record?.checkedAt || ''),
    notificationConfigured: Boolean(record?.notification?.configured),
    notificationSent: Boolean(record?.notification?.sent)
  };
}

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
  const currentDateKey = dateKey(new Date());
  const tomorrowDateKey = addDays(currentDateKey, 1);
  const healthStorageReadable = storageConfigured && typeof env.FAVORITES.get === 'function';
  const weeklyWindow = getWeeklyContentWindow();
  const [snapshotHealth, draftHealth, weeklyHealth] = healthStorageReadable
    ? await Promise.all([
      env.FAVORITES.get(`operations-health:daily:today-snapshot:${currentDateKey}`, 'json'),
      env.FAVORITES.get(`operations-health:daily:tomorrow-draft:${tomorrowDateKey}`, 'json'),
      env.FAVORITES.get(getWeeklyContentHealthStorageKey(weeklyWindow.runWeekStart), 'json')
    ])
    : [null, null, null];
  const response = jsonResponse(request, env, {
    ok: storageConfigured,
    service: 'japanese-words-pages',
    storageConfigured,
    workflowCoordinatorConfigured,
    imageStorageConfigured,
    weeklyOperations: {
      runWeekStart: weeklyWindow.runWeekStart,
      targetWeekStart: weeklyWindow.targetWeekStart,
      targetWeekEnd: weeklyWindow.targetWeekEnd,
      status: ['healthy', 'unhealthy'].includes(weeklyHealth?.status) ? weeklyHealth.status : 'unknown',
      checkedAt: String(weeklyHealth?.checkedAt || ''),
      notificationConfigured: Boolean(weeklyHealth?.notification?.configured),
      notificationSent: Boolean(weeklyHealth?.notification?.sent)
    },
    dailyOperations: {
      todaySnapshot: summarizeDailyHealth(snapshotHealth, currentDateKey),
      tomorrowDraft: summarizeDailyHealth(draftHealth, tomorrowDateKey)
    },
    checkedAt: new Date().toISOString()
  }, storageConfigured ? 200 : 503, { methods, requestId });
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

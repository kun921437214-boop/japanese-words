import { getRequestId, jsonResponse, optionsResponse } from '../shared/api-security.mjs';
import { addDays, dateKey } from '../shared/rankings.mjs';
import {
  getWeeklyContentHealthStorageKey,
  getWeeklyContentWindow
} from '../shared/weekly-content-health.mjs';

function summarizeDailyHealth(record, targetDateKey) {
  return {
    targetDateKey,
    status: ['healthy', 'unhealthy'].includes(record?.status) ? record.status : 'unknown',
    checkedAt: String(record?.checkedAt || ''),
    notificationConfigured: Boolean(record?.notification?.configured),
    notificationSent: Boolean(record?.notification?.sent)
  };
}

function summarizeWeeklyHealth(record, window) {
  return {
    runWeekStart: window.runWeekStart,
    targetWeekStart: window.targetWeekStart,
    targetWeekEnd: window.targetWeekEnd,
    status: ['healthy', 'unhealthy'].includes(record?.status) ? record.status : 'unknown',
    checkedAt: String(record?.checkedAt || ''),
    totals: {
      words: Number(record?.totals?.words) || 0,
      cards: Number(record?.totals?.cards) || 0,
      images: Number(record?.totals?.images) || 0,
      storedImages: Number(record?.totals?.storedImages) || 0,
      errors: Number(record?.totals?.errors) || 0,
      warnings: Number(record?.totals?.warnings) || 0
    },
    reasons: Array.isArray(record?.reasons)
      ? record.reasons.map(reason => String(reason || '').slice(0, 160)).filter(Boolean).slice(0, 30)
      : [],
    days: Array.isArray(record?.days)
      ? record.days.slice(0, 7).map(day => ({
          targetDateKey: String(day?.targetDateKey || ''),
          status: String(day?.status || 'missing'),
          valid: Boolean(day?.valid),
          wordCount: Number(day?.wordCount) || 0,
          cardReadyCount: Number(day?.cardReadyCount) || 0,
          imageReadyCount: Number(day?.imageReadyCount) || 0,
          imageStorageReadyCount: Number(day?.imageStorageReadyCount) || 0,
          errorCount: Number(day?.errorCount) || 0,
          warningCount: Number(day?.warningCount) || 0,
          reasons: Array.isArray(day?.reasons)
            ? day.reasons.map(reason => String(reason || '').slice(0, 120)).filter(Boolean).slice(0, 8)
            : []
        }))
      : [],
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
  const weeklyWindow = getWeeklyContentWindow(new Date());
  const healthStorageReadable = storageConfigured && typeof env.FAVORITES.get === 'function';
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
    dailyOperations: {
      todaySnapshot: summarizeDailyHealth(snapshotHealth, currentDateKey),
      tomorrowDraft: summarizeDailyHealth(draftHealth, tomorrowDateKey)
    },
    weeklyOperations: {
      nextWeek: summarizeWeeklyHealth(weeklyHealth, weeklyWindow)
    },
    checkedAt: new Date().toISOString()
  }, storageConfigured ? 200 : 503, { methods, requestId });
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

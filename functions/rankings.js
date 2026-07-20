import {
  addDays,
  buildRankingForDate,
  cleanRankingsDays,
  cleanStoredRanking,
  dateKey
} from '../shared/rankings.mjs';
import { isStoredDailyWordCount } from '../shared/daily-config.mjs';
import {
  authorizeRequest,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  unauthorizedResponse
} from '../shared/api-security.mjs';

function getRankingStorageKey(dateKeyValue) {
  return `rankings:${dateKeyValue}`;
}

async function readStoredSelections(env, startDateKey, endDateKey) {
  const selections = new Map();
  let cursor = startDateKey;
  while (cursor) {
    const stored = await env.FAVORITES.get(getRankingStorageKey(cursor), 'json');
    const ranking = cleanStoredRanking(stored, cursor);
    if (isStoredDailyWordCount(ranking.words.length)) selections.set(cursor, ranking.words);
    if (cursor === endDateKey) break;
    cursor = addDays(cursor, 1);
  }
  return selections;
}

async function ensureRankings(env, requestedDays) {
  const todayDateKey = dateKey();
  const earliestRequestedDateKey = addDays(todayDateKey, -(requestedDays - 1));
  const generationStartDateKey = addDays(earliestRequestedDateKey, -15);
  const cachedSelections = await readStoredSelections(env, generationStartDateKey, todayDateKey);
  const responseDays = [];
  let cursor = generationStartDateKey;

  while (cursor) {
    let words = cachedSelections.get(cursor);
    if (!words || !isStoredDailyWordCount(words.length)) {
      words = buildRankingForDate(cursor, cachedSelections);
      cachedSelections.set(cursor, words);
      await env.FAVORITES.put(getRankingStorageKey(cursor), JSON.stringify({
        dateKey: cursor,
        words,
        updated: new Date().toISOString()
      }));
    }

    if (cursor >= earliestRequestedDateKey) {
      responseDays.push({
        dateKey: cursor,
        words,
        updated: null
      });
    }

    if (cursor === todayDateKey) break;
    cursor = addDays(cursor, 1);
  }

  return {
    todayKey: todayDateKey,
    days: responseDays.reverse()
  };
}

export async function onRequest({ request, env }) {
  const methods = ['GET', 'OPTIONS'];
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods, requestId });

  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env, methods);
  }

  if (request.method !== 'GET') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  if (!env.FAVORITES) {
    return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');
  }

  const authorization = await authorizeRequest(request, env);
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });

  const url = new URL(request.url);
  const requestedDays = cleanRankingsDays(url.searchParams.get('days'), 8);
  const data = await ensureRankings(env, requestedDays);
  return respond(data);
}

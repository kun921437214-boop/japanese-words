import {
  addDays,
  buildRankingForDate,
  cleanRankingsDays,
  cleanStoredRanking,
  dateKey
} from '../shared/rankings.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function getRankingStorageKey(dateKeyValue) {
  return `rankings:${dateKeyValue}`;
}

async function readStoredSelections(env, startDateKey, endDateKey) {
  const selections = new Map();
  let cursor = startDateKey;
  while (cursor) {
    const stored = await env.FAVORITES.get(getRankingStorageKey(cursor), 'json');
    const ranking = cleanStoredRanking(stored, cursor);
    if (ranking.words.length === 20) selections.set(cursor, ranking.words);
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
    if (!words || words.length !== 20) {
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
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!env.FAVORITES) {
    return jsonResponse({ error: 'KV namespace FAVORITES is not configured' }, 500);
  }

  const url = new URL(request.url);
  const requestedDays = cleanRankingsDays(url.searchParams.get('days'), 8);
  const data = await ensureRankings(env, requestedDays);
  return jsonResponse(data);
}

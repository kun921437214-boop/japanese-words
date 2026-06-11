import { cleanStoredWorkflow, generateTodaySnapshot } from '../shared/today-snapshot.mjs';
import { addDays, buildRankingForDate, cleanStoredRanking, dateKey } from '../shared/rankings.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getStorageKey(url) {
  const code = cleanSyncCode(url.searchParams.get('code'));
  return code.length >= 8 ? `favorites:${code}` : 'favorites:global';
}

function getRankingStorageKey(dateKeyValue) {
  return `rankings:${dateKeyValue}`;
}

async function readRankingHistoryWords(env, todayDateKey, days = 30) {
  const earliestDateKey = addDays(todayDateKey, -days);
  const generationStartDateKey = addDays(earliestDateKey, -15);
  const cachedSelections = new Map();
  let cursor = generationStartDateKey;

  while (cursor) {
    const stored = await env.FAVORITES.get(getRankingStorageKey(cursor), 'json');
    const ranking = cleanStoredRanking(stored, cursor);
    if (ranking.words.length === 20) cachedSelections.set(cursor, ranking.words);
    if (cursor === todayDateKey) break;
    cursor = addDays(cursor, 1);
  }

  const rankingHistoryWords = {};
  cursor = generationStartDateKey;
  while (cursor) {
    let words = cachedSelections.get(cursor);
    if (!words || words.length !== 20) {
      words = buildRankingForDate(cursor, cachedSelections);
      cachedSelections.set(cursor, words);
    }
    if (cursor >= earliestDateKey && cursor < todayDateKey) {
      rankingHistoryWords[cursor] = words;
    }
    if (cursor === todayDateKey) break;
    cursor = addDays(cursor, 1);
  }

  return rankingHistoryWords;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function isAuthorized(request, env, url) {
  const token = String(env.TODAY_ADMIN_TOKEN || '').trim();
  if (!token) return true;
  const header = request.headers.get('Authorization') || '';
  const queryToken = String(url.searchParams.get('token') || '').trim();
  return header === `Bearer ${token}` || queryToken === token;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!env.FAVORITES) {
    return jsonResponse({ error: 'KV namespace FAVORITES is not configured' }, 500);
  }

  const url = new URL(request.url);
  if (!isAuthorized(request, env, url)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const key = getStorageKey(url);
  const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));

  if (request.method === 'GET') {
    return jsonResponse({
      todaySnapshot: stored.todaySnapshot,
      candidateCount: Object.keys(stored.candidatePool || {}).length,
      favoriteCount: stored.words.length,
      publishedCount: stored.publishedRecords.length
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await readJson(request);
  const mode = ['create', 'fill', 'regenerate'].includes(body?.mode) ? body.mode : 'create';
  const rankingHistoryWords = await readRankingHistoryWords(env, dateKey(), 30);
  const { workflow, result } = generateTodaySnapshot({ ...stored, rankingHistoryWords }, { mode, createdBy: 'server' });

  await env.FAVORITES.put(key, JSON.stringify(workflow));
  return jsonResponse(result);
}

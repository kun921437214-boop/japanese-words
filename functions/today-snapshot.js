import { cleanStoredWorkflow, generateTodaySnapshot } from '../shared/today-snapshot.mjs';

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
  const { workflow, result } = generateTodaySnapshot(stored, { mode });

  await env.FAVORITES.put(key, JSON.stringify(workflow));
  return jsonResponse(result);
}

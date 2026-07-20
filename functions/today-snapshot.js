import { cleanStoredWorkflow, generateTodaySnapshot } from '../shared/today-snapshot.mjs';
import { isStoredDailyWordCount } from '../shared/daily-config.mjs';
import { addDays, buildRankingForDate, cleanStoredRanking, dateKey, WORDS_PER_DAY } from '../shared/rankings.mjs';
import {
  API_LIMITS,
  authorizeRequest,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  readJsonBody,
  unauthorizedResponse
} from '../shared/api-security.mjs';
import {
  getWorkflowMutationMetadata,
  inspectWorkflowMutation
} from '../shared/workflow-mutation.mjs';
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';

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
    if (isStoredDailyWordCount(ranking.words.length)) cachedSelections.set(cursor, ranking.words);
    if (cursor === todayDateKey) break;
    cursor = addDays(cursor, 1);
  }

  const rankingHistoryWords = {};
  cursor = generationStartDateKey;
  while (cursor) {
    let words = cachedSelections.get(cursor);
    if (!words || !isStoredDailyWordCount(words.length)) {
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

export async function onRequest({ request, env }) {
  const methods = ['GET', 'POST', 'OPTIONS'];
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods, requestId });

  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env, methods);
  }

  if (!env.FAVORITES) {
    return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');
  }

  const url = new URL(request.url);
  const authorization = await authorizeRequest(request, env, { allowAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });

  const key = getStorageKey(url);
  const stored = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));

  if (request.method === 'GET') {
    return respond({
      todaySnapshot: stored.todaySnapshot,
      candidateCount: Object.keys(stored.candidatePool || {}).length,
      favoriteCount: stored.words.length,
      publishedCount: stored.publishedRecords.length
    });
  }

  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.command });
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
  const body = parsed.value;
  const mode = ['create', 'fill', 'regenerate'].includes(body?.mode) ? body.mode : 'create';
  const mutationMetadata = getWorkflowMutationMetadata(request, body, {
    action: `today.${mode}`,
    actor: authorization.actor,
    target: dateKey()
  });
  const inspection = inspectWorkflowMutation(stored, mutationMetadata);
  if (inspection.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '今日推荐已被其他人更新，请刷新后重试', retryable: true },
      currentRevision: inspection.currentRevision
    }, 409);
  }
  if (inspection.duplicate) {
    const selectedCount = stored.todaySnapshot?.words?.length || 0;
    return respond({
      ok: true,
      mode,
      selectedCount,
      shortage: selectedCount < WORDS_PER_DAY,
      todaySnapshot: stored.todaySnapshot,
      recommendationAudit: stored.todaySnapshot?.recommendationAudit || null,
      revision: stored.revision,
      mutation: { duplicate: true, operationId: inspection.event?.id || '' }
    });
  }
  const rankingHistoryWords = await readRankingHistoryWords(env, dateKey(), 30);
  const generated = generateTodaySnapshot({ ...stored, rankingHistoryWords }, { mode, createdBy: 'server' });
  const mutation = await commitWorkflowMutation(env, key, generated.workflow, {
    ...mutationMetadata,
    summary: `今日推荐 ${generated.result.todaySnapshot?.words?.length || 0} 个词`
  }, { strategy: 'replace' });
  if (mutation.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '今日推荐已被其他人更新，请刷新后重试', retryable: true },
      currentRevision: mutation.currentRevision
    }, 409);
  }

  return respond({
    ...generated.result,
    revision: mutation.workflow.revision,
    mutation: { duplicate: mutation.duplicate, operationId: mutation.event?.id || '' }
  });
}

import {
  buildCodexDailyContext,
  CODEX_DAILY_DRAFT_TTL_SECONDS,
  cleanCodexDailyDraft,
  getCodexDraftStorageKey,
  promoteCodexDailyDraft,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
import { cleanDateKey, dateKey } from '../shared/rankings.mjs';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';
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
import { prepareWorkflowMutation } from '../shared/workflow-mutation.mjs';

const METHODS = ['GET', 'PUT', 'POST', 'OPTIONS'];

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getScope(url) {
  const code = cleanSyncCode(url.searchParams.get('code'));
  return code.length >= 8 ? code : 'global';
}

function getWorkflowStorageKey(scope) {
  return scope === 'global' ? 'favorites:global' : `favorites:${scope}`;
}

function summarizeDraft(draft = {}) {
  return {
    targetDateKey: draft.targetDateKey || '',
    status: draft.status || 'missing',
    generatedBy: draft.generatedBy || '',
    generatorVersion: draft.generatorVersion || '',
    threadId: draft.threadId || '',
    wordCount: draft.wordCount || 0,
    cardReadyCount: draft.cardReadyCount || 0,
    imageReadyCount: draft.imageReadyCount || 0,
    createdAt: draft.createdAt || '',
    updatedAt: draft.updatedAt || '',
    submittedAt: draft.submittedAt || '',
    publishedAt: draft.publishedAt || '',
    validation: draft.validation || null
  };
}

export async function onRequest({ request, env }) {
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods: METHODS, requestId });
  const fail = (status, code, message, retryable = false) => errorResponse(request, env, status, code, message, {
    methods: METHODS,
    requestId,
    retryable
  });
  if (request.method === 'OPTIONS') return optionsResponse(request, env, METHODS);
  if (!env.FAVORITES) return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');

  const url = new URL(request.url);
  const scope = getScope(url);
  const targetDateKey = cleanDateKey(url.searchParams.get('date')) || dateKey();

  if (request.method === 'POST') {
    const authorization = await authorizeRequest(request, env, { allowAutomation: true });
    if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods: METHODS, requestId });
    if (!['automation_secret', 'local_dev'].includes(authorization.method)) {
      return fail(403, 'PROMOTION_FORBIDDEN', '只有午夜定时 Worker 可以发布 Codex 草稿');
    }
    const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.command });
    if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
    if (parsed.value?.action !== 'promote') return fail(400, 'INVALID_ACTION', 'action 必须是 promote');
    const expectedDateKey = cleanDateKey(parsed.value?.targetDateKey) || dateKey();
    const workflowKey = getWorkflowStorageKey(scope);
    const draftKey = getCodexDraftStorageKey(expectedDateKey, scope);
    const workflow = cleanStoredWorkflow(await env.FAVORITES.get(workflowKey, 'json'));
    const storedDraft = await env.FAVORITES.get(draftKey, 'json');

    if (workflow.todaySnapshot?.dateKey === expectedDateKey && workflow.todaySnapshot?.words?.length === 20) {
      if (storedDraft) {
        const publishedDraft = {
          ...validateCodexDailyDraft(storedDraft, { workflow, expectedDateKey }),
          status: 'published',
          publishedAt: storedDraft.publishedAt || new Date().toISOString()
        };
        await env.FAVORITES.put(draftKey, JSON.stringify(publishedDraft), { expirationTtl: CODEX_DAILY_DRAFT_TTL_SECONDS });
      }
      return respond({ ok: true, published: true, alreadyPublished: true, source: workflow.todaySnapshot.source });
    }
    if (!storedDraft) return fail(404, 'CODEX_DRAFT_MISSING', `未找到 ${expectedDateKey} 的 Codex 草稿`, true);

    const promoted = promoteCodexDailyDraft(workflow, storedDraft, { expectedDateKey });
    if (!promoted.ok) {
      return respond({
        ok: false,
        published: false,
        error: { code: 'CODEX_DRAFT_INVALID', message: 'Codex 草稿未通过发布门', retryable: true },
        draft: summarizeDraft(promoted.draft)
      }, 422);
    }
    const operationId = `codex-promote-${scope}-${expectedDateKey}`;
    const mutation = prepareWorkflowMutation(workflow, promoted.workflow, {
      operationId,
      expectedRevision: null,
      action: 'codex-daily.promote',
      actor: authorization.actor,
      target: expectedDateKey,
      summary: `发布 Codex 次日草稿 ${promoted.draft.wordCount} 个词`
    });
    if (!mutation.duplicate) await env.FAVORITES.put(workflowKey, JSON.stringify(mutation.workflow));
    await env.FAVORITES.put(draftKey, JSON.stringify(promoted.draft), { expirationTtl: CODEX_DAILY_DRAFT_TTL_SECONDS });
    return respond({
      ok: true,
      published: true,
      alreadyPublished: mutation.duplicate,
      source: 'codex_draft',
      revision: mutation.workflow.revision,
      draft: summarizeDraft(promoted.draft)
    });
  }

  const authorization = await authorizeRequest(request, env, { allowCodexAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods: METHODS, requestId });
  const workflowKey = getWorkflowStorageKey(scope);
  const workflow = cleanStoredWorkflow(await env.FAVORITES.get(workflowKey, 'json'));

  if (request.method === 'GET') {
    const view = String(url.searchParams.get('view') || 'status').trim();
    if (view === 'context') return respond({ ok: true, context: buildCodexDailyContext(workflow, targetDateKey) });
    const draftKey = getCodexDraftStorageKey(targetDateKey, scope);
    const storedDraft = await env.FAVORITES.get(draftKey, 'json');
    if (!storedDraft) return respond({ ok: true, draft: summarizeDraft({ targetDateKey, status: 'missing' }) });
    const draft = validateCodexDailyDraft(storedDraft, { workflow, expectedDateKey: targetDateKey });
    return respond({ ok: true, draft: view === 'draft' ? draft : summarizeDraft(draft) });
  }

  if (request.method !== 'PUT') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  if (!['codex_automation_secret', 'admin_token', 'local_dev'].includes(authorization.method)) {
    return fail(403, 'DRAFT_WRITE_FORBIDDEN', '当前身份只能查看 Codex 草稿状态');
  }
  const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.codexDraft });
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
  const draft = validateCodexDailyDraft({
    ...cleanCodexDailyDraft(parsed.value),
    targetDateKey: parsed.value?.targetDateKey || targetDateKey,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, { workflow, expectedDateKey: targetDateKey });
  const draftKey = getCodexDraftStorageKey(targetDateKey, scope);
  await env.FAVORITES.put(draftKey, JSON.stringify(draft), { expirationTtl: CODEX_DAILY_DRAFT_TTL_SECONDS });
  return respond({ ok: draft.validation.valid, accepted: true, draft: summarizeDraft(draft) }, draft.validation.valid ? 200 : 422);
}

import {
  buildCodexDailyContext,
  cleanCodexDailyDraft,
  getCodexDailyDraftTtlSeconds,
  getCodexDraftStorageKey,
  promoteCodexDailyDraft,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
import { isExpectedDailyWordCount } from '../shared/daily-config.mjs';
import { addDays, cleanDateKey, dateKey } from '../shared/rankings.mjs';
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
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';
import {
  codexOperationFailure,
  codexOperationIdFromHeader,
  codexValueSha256,
  executeCodexOperation,
  lookupCodexOperation,
  requireCodexOperationId,
  withCodexWrite
} from '../shared/codex-operation.mjs';

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

async function readDraftDocument(env, key) {
  const raw = await env.FAVORITES.get(key);
  return raw === null || raw === undefined ? null : JSON.parse(raw);
}

async function inspectDraftEffect(env, record) {
  const current = await readDraftDocument(env, record.effect.key);
  const currentSha256 = await codexValueSha256(current);
  if (currentSha256 === record.effect.documentSha256) return 'complete';
  if (currentSha256 !== record.effect.priorSha256) return 'conflict';
  const workflow = await readDraftDocument(env, record.effect.workflowKey);
  return await codexValueSha256(workflow) === record.effect.workflowSha256 ? 'absent' : 'conflict';
}

function cleanPreviewImageUrl(value) {
  try {
    const url = new URL(String(value || ''), 'https://preview.invalid');
    if (url.origin !== 'https://preview.invalid' || url.pathname !== '/codex-image' || !url.searchParams.get('key')) return '';
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

function buildPublicPreviewDraft(draft = {}, options = {}) {
  const includeItems = options.includeItems !== false;
  const qualitySummary = draft.validation?.qualitySummary || {};
  const auditItems = Array.isArray(draft.validation?.recommendationAudit?.items)
    ? draft.validation.recommendationAudit.items
    : [];
  return {
    targetDateKey: draft.targetDateKey || '',
    status: draft.status || 'missing',
    wordCount: draft.wordCount || 0,
    cardReadyCount: draft.cardReadyCount || 0,
    imageReadyCount: draft.imageReadyCount || 0,
    updatedAt: draft.updatedAt || '',
    submittedAt: draft.submittedAt || '',
    ...(includeItems ? {
      items: (Array.isArray(draft.items) ? draft.items : []).map(item => ({
        kanji: item.kanji || '',
        kana: item.kana || item.reading || '',
        romaji: item.romaji || '',
        meaning: item.meaning || '',
        category: item.category || '',
        candidateType: item.candidateType || '',
        reason: item.reason || '',
        riskLevel: item.riskLevel || 'low',
        confidenceLevel: item.confidenceLevel || 'medium',
        evidenceType: item.evidenceType || 'common_usage',
        aiCard: {
          cardStatus: item.aiCard?.cardStatus || 'ready',
          cardSource: 'codex',
          summary: item.aiCard?.summary || '',
          explanation: item.aiCard?.explanation || '',
          usageScenes: Array.isArray(item.aiCard?.usageScenes) ? item.aiCard.usageScenes : [],
          examples: (Array.isArray(item.aiCard?.examples) ? item.aiCard.examples : []).map(example => ({
            jp: example.jp || '',
            kana: example.kana || '',
            romaji: example.romaji || '',
            cn: example.cn || '',
            note: example.note || '',
            source: example.source || ''
          })),
          suggestedTitles: Array.isArray(item.aiCard?.suggestedTitles) ? item.aiCard.suggestedTitles : [],
          coverSuggestion: {
            coverText: item.aiCard?.coverSuggestion?.coverText || '',
            mainVisual: item.aiCard?.coverSuggestion?.mainVisual || '',
            style: item.aiCard?.coverSuggestion?.style || '',
            avoid: item.aiCard?.coverSuggestion?.avoid || ''
          },
          contentAngles: Array.isArray(item.aiCard?.contentAngles) ? item.aiCard.contentAngles : [],
          targetAudience: item.aiCard?.targetAudience || '',
          referenceDirection: item.aiCard?.referenceDirection || '',
          riskWarning: item.aiCard?.riskWarning || '',
          wrongUsage: item.aiCard?.wrongUsage || '',
          similarWords: (Array.isArray(item.aiCard?.similarWords) ? item.aiCard.similarWords : []).map(similar => ({
            word: similar.word || similar.kanji || '',
            romaji: similar.romaji || '',
            meaning: similar.meaning || '',
            difference: similar.difference || similar.note || ''
          })),
          interactionPrompts: Array.isArray(item.aiCard?.interactionPrompts) ? item.aiCard.interactionPrompts : [],
          referenceImage: {
            status: item.aiCard?.referenceImage?.status || 'missing',
            url: cleanPreviewImageUrl(item.aiCard?.referenceImage?.url)
          }
        }
      }))
    } : {}),
    validation: {
      valid: Boolean(draft.validation?.valid),
      qualitySummary: {
        estimatedHumanQualityScore: qualitySummary.estimatedHumanQualityScore || 0,
        sLevelCount: qualitySummary.sLevelCount || 0,
        aLevelCount: qualitySummary.aLevelCount || 0,
        bLevelCount: qualitySummary.bLevelCount || 0,
        cLevelCount: qualitySummary.cLevelCount || 0
      },
      recommendationAudit: {
        items: auditItems.map(item => ({
          kanji: item.kanji || '',
          recommendationLevel: item.recommendationLevel || '',
          qualityCategory: item.qualityCategory || ''
        }))
      }
    }
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
  const view = String(url.searchParams.get('view') || 'status').trim();

  if (request.method === 'GET' && ['preview', 'preview-status'].includes(view)) {
    const previewDateKey = addDays(dateKey(), 1);
    if (targetDateKey !== previewDateKey) {
      return fail(404, 'PREVIEW_NOT_AVAILABLE', '只提供明日草稿预览');
    }
    const workflowKey = getWorkflowStorageKey(scope);
    const draftKey = getCodexDraftStorageKey(targetDateKey, scope);
    const workflow = cleanStoredWorkflow(await env.FAVORITES.get(workflowKey, 'json'));
    const storedDraft = await env.FAVORITES.get(draftKey, 'json');
    if (!storedDraft) {
      return respond({
        ok: true,
        draft: buildPublicPreviewDraft({ targetDateKey, status: 'missing' }, { includeItems: view === 'preview' })
      });
    }
    const draft = validateCodexDailyDraft(storedDraft, { workflow, expectedDateKey: targetDateKey });
    return respond({ ok: true, draft: buildPublicPreviewDraft(draft, { includeItems: view === 'preview' }) });
  }

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

    const existingSnapshotIsCodex = workflow.todaySnapshot?.dateKey === expectedDateKey
      && isExpectedDailyWordCount(workflow.todaySnapshot?.words?.length, expectedDateKey)
      && workflow.todaySnapshot?.source === 'codex_draft';
    if (existingSnapshotIsCodex) {
      if (storedDraft) {
        const publishedDraft = {
          ...validateCodexDailyDraft(storedDraft, { workflow, expectedDateKey }),
          status: 'published',
          publishedAt: storedDraft.publishedAt || new Date().toISOString()
        };
        await env.FAVORITES.put(draftKey, JSON.stringify(publishedDraft), {
          expirationTtl: getCodexDailyDraftTtlSeconds(expectedDateKey)
        });
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
    const mutation = await commitWorkflowMutation(env, workflowKey, promoted.workflow, {
      operationId,
      expectedRevision: null,
      action: 'codex-daily.promote',
      actor: authorization.actor,
      target: expectedDateKey,
      summary: `发布 Codex 周计划草稿 ${promoted.draft.wordCount} 个词`
    }, { strategy: 'automated' });
    await env.FAVORITES.put(draftKey, JSON.stringify(promoted.draft), {
      expirationTtl: getCodexDailyDraftTtlSeconds(expectedDateKey)
    });
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

  if (request.method === 'GET' && url.searchParams.has('operationId')) {
    if (!['codex_automation_secret', 'admin_token', 'local_dev'].includes(authorization.method)) {
      return fail(403, 'OPERATION_LOOKUP_FORBIDDEN', '当前身份不能查询草稿提交操作');
    }
    try {
      const identity = { scope, kind: 'draft', operationId: requireCodexOperationId(url.searchParams.get('operationId')) };
      const operation = await lookupCodexOperation(env, identity, record => inspectDraftEffect(env, record));
      return respond({ ok: true, operation });
    } catch (error) {
      const failure = codexOperationFailure(error);
      return fail(failure.status, failure.code, '草稿提交操作状态无法确认', failure.status === 503);
    }
  }

  if (request.method === 'GET') {
    const workflow = cleanStoredWorkflow(await env.FAVORITES.get(workflowKey, 'json'));
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
  const draftKey = getCodexDraftStorageKey(targetDateKey, scope);
  try {
    const operationId = codexOperationIdFromHeader(request, parsed.value);
    const prepare = async () => {
      const storedWorkflow = await readDraftDocument(env, workflowKey);
      const workflow = cleanStoredWorkflow(storedWorkflow);
      const now = new Date().toISOString();
      const draft = validateCodexDailyDraft({
        ...cleanCodexDailyDraft(parsed.value), ...(operationId ? { operationId } : {}),
        targetDateKey: parsed.value?.targetDateKey || targetDateKey, submittedAt: now, updatedAt: now
      }, { workflow, expectedDateKey: targetDateKey });
      return { effect: { key: draftKey, document: draft,
        documentSha256: await codexValueSha256(draft),
        priorSha256: await codexValueSha256(await readDraftDocument(env, draftKey)),
        workflowKey, workflowSha256: await codexValueSha256(storedWorkflow),
        ttlSeconds: getCodexDailyDraftTtlSeconds(targetDateKey) },
      response: { status: draft.validation.valid ? 200 : 422,
        body: { ok: draft.validation.valid, accepted: true, draft: summarizeDraft(draft) } } };
    };
    const apply = record => env.FAVORITES.put(record.effect.key, JSON.stringify(record.effect.document), {
      expirationTtl: record.effect.ttlSeconds
    });
    if (!operationId) {
      return await withCodexWrite(env, scope, async () => {
        const prepared = await prepare();
        await apply(prepared);
        return respond(prepared.response.body, prepared.response.status);
      });
    }
    const payload = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? Object.fromEntries(Object.entries(parsed.value).filter(([key]) => key !== 'operationId'))
      : parsed.value;
    const inputSha256 = await codexValueSha256({ targetDateKey, payload });
    const identity = { scope, kind: 'draft', operationId, target: targetDateKey, inputSha256 };
    const result = await executeCodexOperation(env, identity, {
      prepare, apply, inspect: record => inspectDraftEffect(env, record)
    });
    return respond({ ...result.body, operation: result.operation }, result.status);
  } catch (error) {
    const failure = codexOperationFailure(error);
    return fail(failure.status, failure.code, '草稿提交未能确认完成', failure.status === 503);
  }
}

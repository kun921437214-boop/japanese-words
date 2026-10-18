import {
  buildCodexDailyContext,
  cleanCodexDailyDraft,
  getCodexDailyDraftTtlSeconds,
  getCodexDraftStorageKey,
  promoteCodexDailyDraft,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
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
import { buildCoordinatedWorkflowMutation, commitWorkflowMutationDirect } from '../shared/workflow-coordinator.mjs';
import {
  CodexOperationError,
  codexOperationStorageKey,
  codexOperationFailure,
  codexOperationIdFromHeader,
  codexValueSha256,
  executeCodexOperation,
  lookupCodexOperation,
  requireCodexOperationId,
  withCodexWrite
} from '../shared/codex-operation.mjs';

// Called only by the authenticated business route. No environment discovery,
// identity creation, direct filesystem access, or scheduled work lives here.

const MARKER = 'codex-promotion-v1 ';
const fail = (code, status = 409) => { throw new CodexOperationError(code, status); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasWords = value => Array.isArray(value?.words) && value.words.length > 0;

function targetOccupied(workflow, target) {
  return (workflow?.todaySnapshot?.dateKey === target && hasWords(workflow.todaySnapshot))
    || hasWords(workflow?.historySnapshots?.[target])
    || (Array.isArray(workflow?.todaySnapshotHistory) ? workflow.todaySnapshotHistory : [])
      .some(row => row?.dateKey === target && hasWords(row));
}

// These are server-owned lifecycle fields, not the frozen request payload.
// All other stored fields (including operation ID, items, cards and image URLs)
// remain bound even when a workflow commit succeeded before the status write.
function immutableDraft(document) {
  const { status, publishedAt, updatedAt, validation, ...content } = document;
  return content;
}

async function verifyDraftReceipt(env, scope, draft, target, draftSha256) {
  if (!draft.operationId) return ''; // Existing legacy drafts did not opt into the ID protocol.
  const record = await env.FAVORITES.get(codexOperationStorageKey(scope, draft.operationId), 'json');
  if (!record || record.schemaVersion !== 1 || record.kind !== 'draft' || record.scope !== scope
      || record.operationId !== draft.operationId || record.target !== target
      || record.status !== 'complete' || record.response?.status !== 200 || record.response?.body?.ok !== true
      || !/^[a-f0-9]{64}$/.test(record.inputSha256 || '') || !record.effect?.document
      || record.effect.key !== getCodexDraftStorageKey(target, scope)) {
    fail('CODEX_PROMOTION_DRAFT_RECEIPT_CONFLICT');
  }
  const { journalSha256, ...content } = record;
  if (journalSha256 !== await codexValueSha256(content)
      || record.resultSha256 !== await codexValueSha256(record.response.body)
      || record.effect.documentSha256 !== await codexValueSha256(record.effect.document)
      || draftSha256 !== await codexValueSha256(immutableDraft(record.effect.document))) {
    fail('CODEX_PROMOTION_DRAFT_RECEIPT_CONFLICT');
  }
  return record.inputSha256;
}

function effectProjection(workflow, target) {
  const snapshot = workflow.todaySnapshot;
  if (snapshot?.dateKey !== target || snapshot.source !== 'codex_draft' || !hasWords(snapshot)) {
    fail('CODEX_PROMOTION_EFFECT_CONFLICT');
  }
  return { snapshot, candidates: snapshot.words.map(word => ({ word, entry: workflow.candidatePool?.[word] || null })) };
}

function readBinding(event) {
  if (!event || !String(event.summary || '').startsWith(MARKER)) return null;
  try { return JSON.parse(event.summary.slice(MARKER.length)); } catch { return null; }
}

async function verifyCompleted(workflow, draft, target, operationId, draftSha256, draftInputSha256) {
  const event = workflow.auditLog.find(row => row.id === operationId);
  const binding = readBinding(event);
  const words = cleanCodexDailyDraft(draft).items.map(item => item.kanji);
  if (!binding || event.action !== 'codex-daily.promote' || event.target !== target
      || binding.draftId !== String(draft.operationId || '') || binding.draftSha256 !== draftSha256
      || binding.draftInputSha256 !== draftInputSha256
      || !same(workflow.todaySnapshot?.words, words)
      || binding.effectSha256 !== await codexValueSha256(effectProjection(workflow, target))) {
    fail('CODEX_PROMOTION_EFFECT_CONFLICT');
  }
  // Both representations must still contain the same published word sequence.
  if (!same(workflow.historySnapshots?.[target]?.words, words)
      || !workflow.todaySnapshotHistory.some(row => row.dateKey === target && same(row.words, words))) {
    fail('CODEX_PROMOTION_EFFECT_CONFLICT');
  }
  return event;
}

async function markPublished(env, draftKey, storedDraft, target, event, validation) {
  if (storedDraft.status === 'published' && storedDraft.publishedAt) return storedDraft;
  const publishedAt = event.at;
  if (!publishedAt) fail('CODEX_PROMOTION_EVENT_INVALID', 503);
  const draft = { ...storedDraft, status: 'published', publishedAt, updatedAt: publishedAt,
    ...(validation ? { validation } : {}) };
  await env.FAVORITES.put(draftKey, JSON.stringify(draft), {
    expirationTtl: getCodexDailyDraftTtlSeconds(target)
  });
  return draft;
}

export function promoteCodexDraftWithoutReplacement(env, { scope, targetDateKey, actor }) {
  // Tencent's existing queue serializes draft operation writes and every normal
  // workflow mutation on this same key. No unlocked fallback is permitted.
  return withCodexWrite(env, scope, async () => {
    const workflowKey = `favorites:${scope}`;
    const draftKey = getCodexDraftStorageKey(targetDateKey, scope);
    const rawWorkflow = await env.FAVORITES.get(workflowKey, 'json');
    const workflow = cleanStoredWorkflow(rawWorkflow);
    const storedDraft = await env.FAVORITES.get(draftKey, 'json');
    if (!storedDraft) fail('CODEX_DRAFT_MISSING', 404);
    if (storedDraft.targetDateKey !== targetDateKey) fail('CODEX_PROMOTION_DRAFT_IDENTITY_CONFLICT');
    const draftSha256 = await codexValueSha256(immutableDraft(storedDraft));
    const draftInputSha256 = await verifyDraftReceipt(env, scope, storedDraft, targetDateKey, draftSha256);
    const operationId = `codex-promote-${scope}-${targetDateKey}`;
    const priorEvent = workflow.auditLog.find(row => row.id === operationId);

    if (targetOccupied(rawWorkflow, targetDateKey) || targetOccupied(workflow, targetDateKey) || priorEvent) {
      const event = await verifyCompleted(workflow, storedDraft, targetDateKey, operationId, draftSha256, draftInputSha256);
      const draft = await markPublished(env, draftKey, storedDraft, targetDateKey, event);
      return { httpStatus: 200, body: { ok: true, published: true, alreadyPublished: true,
        source: 'codex_draft', revision: workflow.revision, draft } };
    }
    if (hasWords(workflow.todaySnapshot) && workflow.todaySnapshot.dateKey > targetDateKey) {
      fail('CODEX_PROMOTION_NEWER_SNAPSHOT_PRESENT');
    }
    const promoted = promoteCodexDailyDraft(workflow, storedDraft, { expectedDateKey: targetDateKey });
    if (!promoted.ok) return { httpStatus: 422, body: { ok: false, published: false,
      error: { code: 'CODEX_DRAFT_INVALID', message: 'Codex 草稿未通过发布门', retryable: true }, draft: promoted.draft } };
    const metadata = { operationId, expectedRevision: workflow.revision,
      action: 'codex-daily.promote', actor, target: targetDateKey, summary: '' };
    // Preview the existing automated merge, so the proof binds the actual
    // stored snapshot and cards, including its normal merge semantics.
    const preview = buildCoordinatedWorkflowMutation(workflow, promoted.workflow, metadata, { strategy: 'automated' });
    if (!preview.ok || preview.duplicate || preview.conflict) fail('CODEX_PROMOTION_PREVIEW_CONFLICT');
    metadata.summary = MARKER + JSON.stringify({ draftId: String(storedDraft.operationId || ''), draftSha256, draftInputSha256,
      effectSha256: await codexValueSha256(effectProjection(preview.workflow, targetDateKey)) });
    if (metadata.summary.length > 500) fail('CODEX_PROMOTION_BINDING_TOO_LONG', 503);

    // We already hold the coordinator queue: calling its fetch/enqueue again
    // would deadlock. Reuse the official commit helper inside this critical
    // section, with a revision check for unexpected non-coordinated writers.
    const mutation = await commitWorkflowMutationDirect(env.FAVORITES, {
      key: workflowKey, candidateWorkflow: promoted.workflow, metadata, strategy: 'automated'
    });
    if (mutation.conflict) fail('WORKFLOW_REVISION_CONFLICT');
    if (!mutation.ok) fail('CODEX_PROMOTION_COMMIT_UNCONFIRMED', 503);
    const event = await verifyCompleted(mutation.workflow, storedDraft, targetDateKey, operationId, draftSha256, draftInputSha256);
    const draft = await markPublished(env, draftKey, storedDraft, targetDateKey, event, promoted.draft.validation);
    return { httpStatus: 200, body: { ok: true, published: true, alreadyPublished: mutation.duplicate,
      source: 'codex_draft', revision: mutation.workflow.revision, draft } };
  }, true);
}

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
    try {
      const result = await promoteCodexDraftWithoutReplacement(env, {
        scope, targetDateKey: expectedDateKey, actor: authorization.actor
      });
      return respond({ ...result.body,
        ...(result.body.draft ? { draft: summarizeDraft(result.body.draft) } : {}) }, result.httpStatus);
    } catch (error) {
      const failure = codexOperationFailure(error);
      return fail(failure.status, failure.code, '草稿发布未能确认完成', failure.status === 503);
    }
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

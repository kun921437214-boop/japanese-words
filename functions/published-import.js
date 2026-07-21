import { applyPublishedImport } from '../shared/published-import.mjs';
import {
  cleanPublishedRecords,
  cleanStoredWorkflow,
  mergeWorkflow
} from '../shared/workflow-schema.mjs';
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
import { persistPublishedRecordCovers } from './published-cover.js';

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getStorageKey(url) {
  const code = cleanSyncCode(url.searchParams.get('code'));
  return code.length >= 8 ? `favorites:${code}` : 'favorites:global';
}

function buildPublishedWorkflow(current, imported) {
  const publishedRecords = cleanPublishedRecords(imported.records);
  const mappedWords = publishedRecords.map(record => record.word).filter(Boolean);
  const words = [...new Set([...(current.words || []), ...mappedWords])];
  const statuses = { ...(current.statuses || {}) };
  mappedWords.forEach(word => {
    statuses[word] = 'published';
  });
  return mergeWorkflow(current, {
    ...current,
    words,
    statuses,
    publishedRecords,
    updated: new Date().toISOString()
  });
}

export async function onRequest({ request, env }) {
  const methods = ['POST', 'OPTIONS'];
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods, requestId });

  if (request.method === 'OPTIONS') return optionsResponse(request, env, methods);
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  if (!env.FAVORITES) return fail(500, 'STORAGE_NOT_CONFIGURED', 'KV namespace FAVORITES is not configured');

  const authorization = await authorizeRequest(request, env, { allowAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });

  const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.published });
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
  const body = parsed.value || {};
  const mode = body.mode === 'commit' ? 'commit' : 'preview';
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return fail(400, 'EMPTY_IMPORT', '导入数据不能为空');

  const url = new URL(request.url);
  const key = getStorageKey(url);
  const current = cleanStoredWorkflow(await env.FAVORITES.get(key, 'json'));
  const imported = applyPublishedImport(current, {
    id: body.batchId,
    rows,
    capturedAt: body.capturedAt,
    capturedAtSource: body.capturedAtSource,
    source: body.source,
    sourceFileName: body.sourceFileName,
    wordMappings: body.wordMappings
  });

  if (mode === 'preview') {
    return respond({
      ok: true,
      mode,
      batch: imported.batch,
      summary: imported.summary,
      rows: imported.previewRows,
      revision: current.revision
    });
  }
  if (imported.summary.ambiguousCount > 0) {
    return fail(422, 'AMBIGUOUS_IMPORT', '导入中存在重复的“标题＋发布时间”，请先处理后再提交');
  }

  const mutationMetadata = getWorkflowMutationMetadata(request, body, {
    action: 'published.import',
    actor: authorization.actor,
    target: imported.batch.id,
    summary: `导入 ${imported.summary.createdCount} 条，更新 ${imported.summary.updatedCount} 条，冻结 ${imported.summary.frozenCount} 条`
  });
  const inspection = inspectWorkflowMutation(current, mutationMetadata);
  if (inspection.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '团队数据已被其他人更新，请重新预览后再导入', retryable: true },
      currentRevision: inspection.currentRevision
    }, 409);
  }
  if (inspection.duplicate) {
    return respond({
      ok: true,
      mode,
      duplicate: true,
      batch: imported.batch,
      summary: imported.summary,
      publishedRecords: current.publishedRecords,
      revision: current.revision
    });
  }

  const persistedCovers = await persistPublishedRecordCovers(imported.records, env, {
    fetchImpl: fetch,
    nowIso: new Date().toISOString()
  });
  const candidateWorkflow = buildPublishedWorkflow(current, {
    ...imported,
    records: persistedCovers.records
  });
  const mutation = await commitWorkflowMutation(env, key, candidateWorkflow, mutationMetadata, { strategy: 'merge' });
  if (mutation.conflict) {
    return respond({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: '团队数据已被其他人更新，请重新预览后再导入', retryable: true },
      currentRevision: mutation.currentRevision
    }, 409);
  }

  return respond({
    ok: true,
    mode,
    batch: imported.batch,
    summary: imported.summary,
    coverSummary: persistedCovers.summary,
    publishedRecords: mutation.workflow.publishedRecords,
    updated: mutation.workflow.updated,
    revision: mutation.workflow.revision,
    mutation: { duplicate: mutation.duplicate, operationId: mutation.event?.id || '' }
  });
}

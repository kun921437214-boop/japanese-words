import { cleanAuditLog, cleanStoredWorkflow, mergeWorkflow } from './workflow-schema.mjs';

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function parseRevision(value) {
  if (value === null || value === undefined || value === '') return null;
  const revision = Number.parseInt(value, 10);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

function summarizeWorkflowState(workflowInput = {}) {
  const workflow = cleanStoredWorkflow(workflowInput);
  return {
    favoriteCount: workflow.words.length,
    candidateCount: Object.keys(workflow.candidatePool || {}).length,
    publishedCount: workflow.publishedRecords.length,
    aiBatchCount: workflow.aiBatches.length,
    todaySnapshotDateKey: workflow.todaySnapshot?.dateKey || '',
    todaySnapshotCount: workflow.todaySnapshot?.words?.length || 0
  };
}

export function getWorkflowMutationMetadata(request, body = {}, options = {}) {
  const operationId = cleanText(
    request?.headers?.get('X-Operation-Id') || body?.operationId || crypto.randomUUID(),
    120
  );
  const expectedRevision = parseRevision(
    request?.headers?.get('X-Workflow-Revision') ?? body?.baseRevision
  );
  return {
    operationId,
    expectedRevision,
    action: cleanText(options.action || body?.action || 'workflow.update', 120),
    actor: cleanText(options.actor || 'unknown', 320),
    target: cleanText(options.target || body?.word || body?.recordId || '', 240),
    summary: cleanText(options.summary || '', 500)
  };
}

export function inspectWorkflowMutation(currentInput = {}, metadata = {}) {
  const current = cleanStoredWorkflow(currentInput);
  const operationId = cleanText(metadata.operationId || crypto.randomUUID(), 120);
  const previousEvent = current.auditLog.find(event => event.id === operationId);
  if (previousEvent) {
    return {
      ok: true,
      duplicate: true,
      conflict: false,
      workflow: current,
      event: previousEvent
    };
  }

  if (metadata.expectedRevision !== null && metadata.expectedRevision !== undefined && metadata.expectedRevision !== current.revision) {
    return {
      ok: false,
      duplicate: false,
      conflict: true,
      currentRevision: current.revision,
      workflow: current,
      event: null
    };
  }
  return {
    ok: true,
    duplicate: false,
    conflict: false,
    workflow: current,
    event: null
  };
}

export function prepareWorkflowMutation(currentInput = {}, nextInput = {}, metadata = {}) {
  const inspection = inspectWorkflowMutation(currentInput, metadata);
  if (inspection.duplicate || inspection.conflict) return inspection;
  const current = inspection.workflow;
  const operationId = cleanText(metadata.operationId || crypto.randomUUID(), 120);

  const now = new Date().toISOString();
  const revision = current.revision + 1;
  const event = {
    id: operationId,
    action: cleanText(metadata.action || 'workflow.update', 120),
    actor: cleanText(metadata.actor || 'unknown', 320),
    at: now,
    target: cleanText(metadata.target, 240),
    summary: cleanText(metadata.summary, 500),
    before: summarizeWorkflowState(current),
    after: summarizeWorkflowState(nextInput),
    revision
  };
  const workflow = cleanStoredWorkflow({
    ...nextInput,
    revision,
    auditLog: cleanAuditLog([event, ...current.auditLog]),
    updated: now,
    schemaVersion: 2
  });
  return {
    ok: true,
    duplicate: false,
    conflict: false,
    workflow,
    event
  };
}

export function mergeAutomatedWorkflowUpdate(currentInput = {}, automatedInput = {}) {
  const current = cleanStoredWorkflow(currentInput);
  const merged = mergeWorkflow(current, automatedInput);
  return cleanStoredWorkflow({
    ...merged,
    words: current.words,
    statuses: current.statuses,
    feedback: current.feedback,
    publishedRecords: current.publishedRecords,
    aiPreview: current.aiPreview,
    todayDismissed: current.todayDismissed,
    revision: current.revision,
    auditLog: current.auditLog,
    updated: new Date().toISOString(),
    schemaVersion: 2
  });
}

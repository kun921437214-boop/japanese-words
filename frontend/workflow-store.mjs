const WORKFLOW_SCOPES = new Set(['today', 'favorites', 'published']);

const PAYLOAD_FIELDS = [
  'words',
  'statuses',
  'feedback',
  'publishedRecords',
  'candidatePool',
  'aiBatches',
  'aiPreview',
  'todaySnapshot',
  'todayDismissed',
  'historySnapshots',
  'todaySnapshotHistory',
  'revision',
  'auditLog',
  'updated',
  'schemaVersion'
];

export function createWorkflowStore(options = {}) {
  const cleanWorkflow = options.cleanWorkflow;
  const mergeCandidatePool = options.mergeCandidatePool;
  const mergePublishedRecords = options.mergePublishedRecords;
  const mergeHistorySnapshots = options.mergeHistorySnapshots;
  const mergeTodaySnapshotHistory = options.mergeTodaySnapshotHistory;
  if (typeof cleanWorkflow !== 'function') {
    throw new TypeError('workflow store requires a cleanWorkflow function');
  }

  let revision = 0;
  let auditLog = [];
  const loadedScopes = new Set();
  const scopeLoads = new Map();

  function normalizeScope(scope = '') {
    return WORKFLOW_SCOPES.has(scope) ? scope : 'today';
  }

  function getScopeKey(scope = 'today', historyDate = '') {
    const cleanScope = normalizeScope(scope);
    return cleanScope === 'today' ? `today:${historyDate || 'today'}` : cleanScope;
  }

  function isScopeLoaded(scope = 'today', historyDate = '') {
    return loadedScopes.has('all') || loadedScopes.has(getScopeKey(scope, historyDate));
  }

  function markScopeLoaded(scope = 'today', historyDate = '') {
    if (scope === 'all') loadedScopes.add('all');
    else loadedScopes.add(getScopeKey(scope, historyDate));
  }

  function hasLoadedScopes() {
    return loadedScopes.size > 0;
  }

  function loadScope(scopeKey, loader) {
    if (scopeLoads.has(scopeKey)) return scopeLoads.get(scopeKey);
    const request = Promise.resolve().then(loader);
    const tracked = request.finally(() => {
      if (scopeLoads.get(scopeKey) === tracked) scopeLoads.delete(scopeKey);
    });
    scopeLoads.set(scopeKey, tracked);
    return tracked;
  }

  function replaceMetadata(workflow = {}) {
    const cleaned = cleanWorkflow({
      revision: workflow?.revision,
      auditLog: workflow?.auditLog
    });
    revision = cleaned.revision;
    auditLog = cleaned.auditLog;
    return getMetadata();
  }

  function getMetadata() {
    return { revision, auditLog: [...auditLog] };
  }

  function getRevision() {
    return revision;
  }

  function getAuditLog() {
    return [...auditLog];
  }

  function acceptRevision(value) {
    const cleaned = cleanWorkflow({ revision: value });
    revision = Math.max(revision, cleaned.revision);
    return revision;
  }

  function applyCommandMetadata(response = {}) {
    acceptRevision(response?.revision);
    if (response?.auditEvent) {
      auditLog = cleanWorkflow({
        auditLog: [response.auditEvent, ...auditLog]
      }).auditLog;
    }
    return getMetadata();
  }

  function prepareRemoteState(remoteWorkflow = {}, currentState = {}, config = {}) {
    const data = cleanWorkflow(remoteWorkflow);
    if (!config.allowOlderRevision && data.revision < revision) {
      return { applied: false, stale: true, data, state: currentState };
    }

    const mergePartialState = Boolean(config.mergeCandidatePool || data.appView?.partialCandidatePool);
    const state = {
      ...data,
      publishedRecords: data.appView?.partialPublishedRecords && typeof mergePublishedRecords === 'function'
        ? mergePublishedRecords(currentState.publishedRecords, data.publishedRecords)
        : data.publishedRecords,
      candidatePool: mergePartialState && typeof mergeCandidatePool === 'function'
        ? mergeCandidatePool(currentState.candidatePool, data.candidatePool)
        : data.candidatePool,
      historySnapshots: mergePartialState && typeof mergeHistorySnapshots === 'function'
        ? mergeHistorySnapshots(currentState.historySnapshots, data.historySnapshots)
        : data.historySnapshots,
      todaySnapshotHistory: mergePartialState && typeof mergeTodaySnapshotHistory === 'function'
        ? mergeTodaySnapshotHistory(currentState.todaySnapshotHistory, data.todaySnapshotHistory)
        : data.todaySnapshotHistory
    };
    replaceMetadata(data);
    return { applied: true, stale: false, data, state, mergePartialState };
  }

  function buildPayload(state = {}, updatedAt = new Date().toISOString()) {
    const cleaned = cleanWorkflow({
      ...state,
      revision,
      auditLog,
      updated: updatedAt,
      schemaVersion: 2
    });
    return PAYLOAD_FIELDS.reduce((payload, field) => {
      payload[field] = cleaned[field];
      return payload;
    }, {});
  }

  return {
    normalizeScope,
    getScopeKey,
    isScopeLoaded,
    markScopeLoaded,
    hasLoadedScopes,
    loadScope,
    replaceMetadata,
    getMetadata,
    getRevision,
    getAuditLog,
    acceptRevision,
    applyCommandMetadata,
    prepareRemoteState,
    buildPayload
  };
}

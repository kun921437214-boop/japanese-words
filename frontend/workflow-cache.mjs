export const DEFAULT_CANDIDATE_LIMIT = 120;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function createWorkflowCache(options = {}) {
  const storage = options.storage;
  const cleanWorkflow = options.cleanWorkflow;
  const keys = options.keys || {};
  const logger = options.logger || console;
  const candidateLimit = Number.isFinite(options.candidateLimit)
    ? Math.max(1, options.candidateLimit)
    : DEFAULT_CANDIDATE_LIMIT;

  if (!storage || typeof storage.setItem !== 'function') {
    throw new TypeError('workflow cache requires a storage implementation');
  }
  if (typeof cleanWorkflow !== 'function') {
    throw new TypeError('workflow cache requires a cleanWorkflow function');
  }

  function buildPayload(payload = {}) {
    const cleaned = cleanWorkflow(payload);
    const prioritizedWords = [
      ...safeArray(cleaned.todaySnapshot?.words),
      ...safeArray(cleaned.words)
    ];
    const cachedCandidateWords = [...new Set(prioritizedWords
      .map(word => String(word || '').trim())
      .filter(Boolean))]
      .slice(0, candidateLimit);
    const compactCandidatePool = cachedCandidateWords.reduce((result, word) => {
      if (cleaned.candidatePool?.[word]) result[word] = cleaned.candidatePool[word];
      return result;
    }, {});

    return {
      ...cleaned,
      candidatePool: compactCandidatePool,
      aiBatches: []
    };
  }

  function setItemSafely(key, value) {
    if (!key) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch (error) {
      logger.warn('本地缓存写入失败，已保留当前云端数据', key, error?.name || 'Error');
      return false;
    }
  }

  function write(payload = {}) {
    const cachePayload = buildPayload(payload);
    const workflowCached = setItemSafely(keys.workflow, JSON.stringify(cachePayload));
    setItemSafely(keys.favorites, JSON.stringify(cachePayload.words));
    setItemSafely(keys.statuses, JSON.stringify(cachePayload.statuses));
    setItemSafely(keys.aiPreview, JSON.stringify(cachePayload.aiPreview));
    setItemSafely(keys.todayDismissed, JSON.stringify(cachePayload.todayDismissed));
    return workflowCached;
  }

  return { buildPayload, setItemSafely, write };
}

import {
  cleanStoredWorkflow,
  mergeWorkflow,
  mergeWorkflowForFullSave
} from './workflow-schema.mjs';
import {
  mergeAutomatedWorkflowUpdate,
  prepareWorkflowMutation
} from './workflow-mutation.mjs';
import { applyFavoriteAction } from './favorite-command.mjs';

const WORKFLOW_KEY_PATTERN = /^favorites:(?:global|[a-zA-Z0-9_-]{8,64})$/;
const MUTATION_STRATEGIES = new Set(['replace', 'merge', 'full-save', 'automated', 'favorite-command']);
const KV_WRITE_RETRY_DELAY_MS = 1100;
const KV_WRITE_MAX_ATTEMPTS = 3;

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function delay(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function isKvWriteRateLimit(error) {
  const message = cleanText(error?.message || error, 1000).toLowerCase();
  return message.includes('429')
    || message.includes('rate limit')
    || message.includes('write rate');
}

export function cleanWorkflowStorageKey(value) {
  const key = cleanText(value, 80);
  return WORKFLOW_KEY_PATTERN.test(key) ? key : '';
}

export function buildCoordinatedWorkflowMutation(currentInput = {}, candidateInput = {}, metadata = {}, options = {}) {
  const current = cleanStoredWorkflow(currentInput);
  const strategy = MUTATION_STRATEGIES.has(options.strategy) ? options.strategy : 'replace';
  let nextWorkflow;
  if (strategy === 'full-save') {
    nextWorkflow = mergeWorkflowForFullSave(current, candidateInput);
  } else if (strategy === 'favorite-command') {
    nextWorkflow = applyFavoriteAction(current, candidateInput);
  } else if (strategy === 'automated') {
    nextWorkflow = mergeAutomatedWorkflowUpdate(current, candidateInput);
  } else if (strategy === 'merge') {
    nextWorkflow = mergeWorkflow(current, candidateInput);
  } else {
    nextWorkflow = cleanStoredWorkflow(candidateInput);
  }
  return prepareWorkflowMutation(current, nextWorkflow, strategy === 'favorite-command'
    ? { ...metadata, expectedRevision: null }
    : metadata);
}

async function putWorkflowWithRetry(binding, key, workflow) {
  let lastError;
  for (let attempt = 1; attempt <= KV_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await binding.put(key, JSON.stringify(workflow));
      return;
    } catch (error) {
      lastError = error;
      if (!isKvWriteRateLimit(error) || attempt === KV_WRITE_MAX_ATTEMPTS) throw error;
      await delay(KV_WRITE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

export async function commitWorkflowMutationDirect(binding, request = {}) {
  const key = cleanWorkflowStorageKey(request.key);
  if (!key) throw new Error('Invalid workflow storage key');
  if (!binding?.get || !binding?.put) throw new Error('Workflow KV binding is not configured');
  const current = cleanStoredWorkflow(await binding.get(key, 'json'));
  const mutation = buildCoordinatedWorkflowMutation(
    current,
    request.candidateWorkflow,
    request.metadata,
    { strategy: request.strategy }
  );
  if (!mutation.duplicate && !mutation.conflict) {
    await putWorkflowWithRetry(binding, key, mutation.workflow);
  }
  return mutation;
}

function getCoordinatorStub(namespace, key) {
  if (typeof namespace?.getByName === 'function') return namespace.getByName(key);
  if (typeof namespace?.idFromName !== 'function' || typeof namespace?.get !== 'function') {
    throw new Error('Workflow coordinator binding is invalid');
  }
  return namespace.get(namespace.idFromName(key));
}

async function parseCoordinatorResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = Object.assign(
      new Error(cleanText(data?.error?.message, 1000) || `Workflow coordinator failed (${response.status})`),
      { code: cleanText(data?.error?.code, 120) || 'WORKFLOW_COORDINATOR_FAILED' }
    );
    throw error;
  }
  return data.mutation;
}

export async function commitWorkflowMutation(env = {}, keyValue = '', candidateWorkflow = {}, metadata = {}, options = {}) {
  const key = cleanWorkflowStorageKey(keyValue);
  if (!key) throw new Error('Invalid workflow storage key');
  const request = {
    key,
    candidateWorkflow,
    metadata,
    strategy: MUTATION_STRATEGIES.has(options.strategy) ? options.strategy : 'replace'
  };
  if (!env.WORKFLOW_COORDINATOR) {
    return commitWorkflowMutationDirect(env.FAVORITES, request);
  }
  const stub = getCoordinatorStub(env.WORKFLOW_COORDINATOR, key);
  const response = await stub.fetch('https://workflow-coordinator.internal/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  return parseCoordinatorResponse(response);
}

export { KV_WRITE_MAX_ATTEMPTS, KV_WRITE_RETRY_DELAY_MS, MUTATION_STRATEGIES };

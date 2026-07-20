import {
  cleanStoredWorkflow,
  cleanWords,
  mergeWorkflowForFullSave
} from './workflow-schema.mjs';

const FAVORITE_ACTIONS = new Set(['add', 'remove', 'status']);
const FAVORITE_STATUSES = new Set(['pending', 'published']);

export function cleanFavoriteCommand(input = {}) {
  const action = FAVORITE_ACTIONS.has(input?.action) ? input.action : '';
  const word = cleanWords([input?.word])[0] || '';
  const status = FAVORITE_STATUSES.has(input?.status) ? input.status : 'none';
  const candidate = word && input?.candidatePool?.[word]
    ? input.candidatePool[word]
    : null;
  return {
    action,
    word,
    status,
    candidatePool: candidate ? { [word]: candidate } : {}
  };
}

export function applyFavoriteAction(currentWorkflow = {}, input = {}) {
  const current = cleanStoredWorkflow(currentWorkflow);
  const command = cleanFavoriteCommand(input);
  if (!command.action || !command.word) return current;

  let words = current.words;
  if (command.action === 'add') {
    words = cleanWords([command.word, ...current.words]);
  } else if (command.action === 'remove') {
    words = current.words.filter(word => word !== command.word);
  } else if (!current.words.includes(command.word)) {
    words = cleanWords([command.word, ...current.words]);
  }

  const statuses = { ...current.statuses };
  if (command.action === 'remove') delete statuses[command.word];
  if (command.action === 'status') {
    if (command.status === 'none') delete statuses[command.word];
    else statuses[command.word] = command.status;
  }

  return mergeWorkflowForFullSave(current, {
    words,
    statuses,
    candidatePool: command.candidatePool,
    updated: new Date().toISOString()
  });
}

export function isFavoriteCommandSatisfied(workflow = {}, input = {}) {
  const current = cleanStoredWorkflow(workflow);
  const command = cleanFavoriteCommand(input);
  if (!command.action || !command.word) return false;
  const isFavorite = current.words.includes(command.word);
  if (command.action === 'add') return isFavorite;
  if (command.action === 'remove') return !isFavorite;
  return isFavorite && (current.statuses[command.word] || 'none') === command.status;
}

export { FAVORITE_ACTIONS, FAVORITE_STATUSES };

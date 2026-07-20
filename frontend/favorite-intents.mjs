const DEFAULT_STORAGE_KEY = 'kotoba_pending_favorite_operations_v1';
const INTENT_LIMIT = 100;

function cleanText(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanIntent(intent = {}) {
  const word = cleanText(intent?.word, 80);
  const operationId = cleanText(intent?.operationId, 120);
  if (!word || !operationId) return null;
  return {
    word,
    operationId,
    desiredFavorite: Boolean(intent?.desiredFavorite),
    action: intent?.desiredFavorite ? 'add' : 'remove',
    state: intent?.state === 'saving' ? 'saving' : 'waiting',
    attempts: Math.max(0, Math.min(99, Number.parseInt(intent?.attempts, 10) || 0)),
    createdAt: cleanText(intent?.createdAt, 80),
    updatedAt: cleanText(intent?.updatedAt, 80),
    lastError: cleanText(intent?.lastError, 500)
  };
}

function cleanIntents(value = []) {
  const latestByWord = new Map();
  (Array.isArray(value) ? value : []).forEach(rawIntent => {
    const intent = cleanIntent(rawIntent);
    if (intent) latestByWord.set(intent.word, intent);
  });
  return [...latestByWord.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, INTENT_LIMIT);
}

export function applyFavoriteIntents(words = [], statuses = {}, intents = []) {
  let nextWords = [...new Set((Array.isArray(words) ? words : []).map(word => cleanText(word, 80)).filter(Boolean))];
  const nextStatuses = { ...(statuses || {}) };
  cleanIntents(intents)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .forEach(intent => {
      if (intent.desiredFavorite) {
        nextWords = [intent.word, ...nextWords.filter(word => word !== intent.word)];
      } else {
        nextWords = nextWords.filter(word => word !== intent.word);
        delete nextStatuses[intent.word];
      }
    });
  return { words: nextWords, statuses: nextStatuses };
}

export function isFavoriteIntentSatisfied(intent = {}, words = []) {
  const clean = cleanIntent(intent);
  if (!clean) return false;
  const isFavorite = (Array.isArray(words) ? words : []).includes(clean.word);
  return clean.desiredFavorite ? isFavorite : !isFavorite;
}

export function createFavoriteIntentStore(options = {}) {
  const storage = options.storage;
  const storageKey = cleanText(options.storageKey || DEFAULT_STORAGE_KEY, 120) || DEFAULT_STORAGE_KEY;
  const createOperationId = typeof options.createOperationId === 'function'
    ? options.createOperationId
    : word => `favorite-${Date.now()}-${cleanText(word, 40)}`;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  let intents = [];

  function persist() {
    try {
      if (!intents.length) storage?.removeItem?.(storageKey);
      else storage?.setItem?.(storageKey, JSON.stringify({ version: 1, intents }));
      return true;
    } catch {
      return false;
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(storage?.getItem?.(storageKey) || '{}');
      intents = cleanIntents(parsed?.intents);
    } catch {
      intents = [];
    }
    return list();
  }

  function list() {
    return intents.map(intent => ({ ...intent }));
  }

  function get(word) {
    const cleanWord = cleanText(word, 80);
    const intent = intents.find(item => item.word === cleanWord);
    return intent ? { ...intent } : null;
  }

  function replace(intent) {
    intents = cleanIntents([intent, ...intents.filter(item => item.word !== intent.word)]);
    persist();
    return get(intent.word);
  }

  function stage(word, desiredFavorite) {
    const cleanWord = cleanText(word, 80);
    if (!cleanWord) return null;
    const timestamp = now();
    const current = get(cleanWord);
    if (current && current.desiredFavorite === Boolean(desiredFavorite)) return current;
    return replace({
      word: cleanWord,
      operationId: createOperationId(cleanWord),
      desiredFavorite: Boolean(desiredFavorite),
      state: 'saving',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: ''
    });
  }

  function markSaving(word, operationId) {
    const current = get(word);
    if (!current || current.operationId !== operationId) return current;
    return replace({
      ...current,
      state: 'saving',
      attempts: current.attempts + 1,
      updatedAt: now(),
      lastError: ''
    });
  }

  function markWaiting(word, operationId, error = '') {
    const current = get(word);
    if (!current || current.operationId !== operationId) return current;
    return replace({
      ...current,
      state: 'waiting',
      updatedAt: now(),
      lastError: cleanText(error, 500)
    });
  }

  function acknowledge(word, operationId) {
    const current = get(word);
    if (!current || current.operationId !== operationId) return false;
    intents = intents.filter(intent => intent.word !== current.word);
    persist();
    return true;
  }

  function reconcile(words = [], statuses = {}) {
    const acknowledged = [];
    intents.forEach(intent => {
      if (isFavoriteIntentSatisfied(intent, words, statuses)) acknowledged.push(intent.word);
    });
    if (acknowledged.length) {
      const acknowledgedSet = new Set(acknowledged);
      intents = intents.filter(intent => !acknowledgedSet.has(intent.word));
      persist();
    }
    return acknowledged;
  }

  function overlay(words = [], statuses = {}) {
    return applyFavoriteIntents(words, statuses, intents);
  }

  load();
  return {
    get,
    list,
    stage,
    markSaving,
    markWaiting,
    acknowledge,
    reconcile,
    overlay,
    reload: load,
    storageKey
  };
}

export { DEFAULT_STORAGE_KEY as FAVORITE_INTENTS_STORAGE_KEY, INTENT_LIMIT as FAVORITE_INTENT_LIMIT };

import { cleanAiCard } from '../shared/workflow-schema.mjs';

export const AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY = 2;
export const AI_CARD_PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_TODAY_AI_CARD_WORDS = 5;
export const MAX_WORD_CARD_REQUEST_WORDS = 20;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.parseInt(value, 10) || 0));
}

function getCardStatus(aiCard = {}) {
  return cleanAiCard(aiCard || {})?.cardStatus || 'none';
}

export function isAiCardStalePending(aiCard = {}, entry = {}, options = {}) {
  const card = cleanAiCard(aiCard || {});
  if (!card || card.cardStatus !== 'pending') return false;
  const startedAt = Date.parse(card.generatedAt || entry.updatedAt || '');
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : AI_CARD_PENDING_TTL_MS;
  return Boolean(Number.isFinite(startedAt) && nowMs - startedAt > ttlMs);
}

export function getTodayAiCardActionState({ aiCard = {}, entry = {}, inFlight = false, nowMs } = {}) {
  const status = getCardStatus(aiCard);
  const stalePending = isAiCardStalePending(aiCard, entry, { nowMs });
  const label = inFlight
    ? '生成中'
    : status === 'ready'
      ? '重新生成'
      : status === 'failed'
        ? '重试'
        : status === 'pending'
          ? (stalePending ? '重试' : '生成中')
          : status === 'stale'
            ? '重新生成'
            : '生成卡片';
  return {
    status,
    stalePending,
    label,
    disabled: Boolean(inFlight || (status === 'pending' && !stalePending))
  };
}

export function getSingleTodayAiCardGenerationOptions({ aiCard = {}, entry = {}, options = {}, nowMs } = {}) {
  const status = getCardStatus(aiCard);
  return {
    force: options.force ?? status === 'ready',
    retryFailed: options.retryFailed ?? status === 'failed',
    retryStalePending: options.retryStalePending ?? isAiCardStalePending(aiCard, entry, { nowMs }),
    maxWords: 1
  };
}

export function canAutoGenerateAiCard({
  aiCard = {},
  inFlight = false,
  attemptCount = 0,
  force = false,
  maxAttempts = AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY
} = {}) {
  if (inFlight) return false;
  const status = getCardStatus(aiCard);
  if (status === 'ready' || status === 'pending') return false;
  if (!force && clamp(attemptCount, 0, 20) >= clamp(maxAttempts, 1, 20)) return false;
  return true;
}

export function selectMissingTodayAiCardKanjis({ kanjis = [], candidatePool = {}, maxWords = MAX_TODAY_AI_CARD_WORDS } = {}) {
  const seen = new Set();
  const selected = [];
  safeArray(kanjis).forEach(value => {
    const kanji = String(value || '').trim().slice(0, 80);
    if (!kanji || seen.has(kanji)) return;
    seen.add(kanji);
    const status = getCardStatus(candidatePool?.[kanji]?.aiCard || {});
    if (!['ready', 'pending', 'failed'].includes(status)) selected.push(kanji);
  });
  return selected.slice(0, clamp(maxWords, 1, MAX_TODAY_AI_CARD_WORDS));
}

export function buildTodayAiCardsRequest(words = [], options = {}) {
  const uniqueWords = [...new Set(safeArray(words).map(value => String(value || '').trim()).filter(Boolean))]
    .slice(0, MAX_TODAY_AI_CARD_WORDS);
  return {
    mode: 'today',
    words: uniqueWords,
    force: Boolean(options.force),
    retryFailed: Boolean(options.retryFailed),
    retryStalePending: Boolean(options.retryStalePending),
    maxWords: clamp(options.maxWords ?? MAX_TODAY_AI_CARD_WORDS, 1, MAX_TODAY_AI_CARD_WORDS)
  };
}

export function buildWordCardRequestPayload({
  words = [],
  favorites = [],
  negativeFeedback = {},
  publishedWords = [],
  accountLearningSummary = {}
} = {}) {
  const requestWords = safeArray(words).slice(0, MAX_WORD_CARD_REQUEST_WORDS);
  return {
    action: 'generate_word_card',
    input: JSON.stringify(requestWords).slice(0, 12000),
    count: clamp(requestWords.length, 1, MAX_WORD_CARD_REQUEST_WORDS),
    preferences: {
      includeMemes: true,
      includeHighRisk: 'review_only',
      readingFormat: 'romaji_kana'
    },
    context: {
      favorites: safeArray(favorites),
      negativeFeedback: negativeFeedback && typeof negativeFeedback === 'object' ? negativeFeedback : {},
      publishedWords: safeArray(publishedWords),
      existingCandidates: requestWords,
      words: requestWords,
      accountLearningSummary: accountLearningSummary && typeof accountLearningSummary === 'object'
        ? accountLearningSummary
        : {}
    }
  };
}

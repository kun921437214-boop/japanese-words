const DEFAULT_EXCLUSION_LIMIT = 200;
const WORD_NORMALIZATION_MAP = {
  'オーバサイズ': 'オーバーサイズ'
};

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeKanjiSpelling(value) {
  const cleanValue = cleanText(value, 80);
  return WORD_NORMALIZATION_MAP[cleanValue] || cleanValue;
}

export function uniqueWords(words) {
  return [...new Set((Array.isArray(words) ? words : []).map(item => normalizeKanjiSpelling(item)).filter(Boolean))];
}

export function flattenWords(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value).flat();
  return [];
}

export function buildDeepSeekExclusionContext(input = {}, options = {}) {
  const limit = cleanInteger(options.limit, DEFAULT_EXCLUSION_LIMIT, 1, 500);
  const reasonLimit = cleanInteger(options.reasonLimit, 1000, limit, 5000);
  const excludedWords = [];
  const seen = new Set();
  const excludedReasons = {
    recent_history_30d: [],
    favorite_or_pending: [],
    published: [],
    selected_today: [],
    current_batch_duplicate: [],
    protected: [],
    existing_recent_candidate: []
  };
  const addWords = (reason, words) => {
    for (const word of uniqueWords(words)) {
      if (!word) continue;
      if (excludedReasons[reason] && excludedReasons[reason].length < reasonLimit) excludedReasons[reason].push(word);
      if (seen.has(word) || excludedWords.length >= limit) continue;
      seen.add(word);
      excludedWords.push(word);
    }
  };

  addWords('selected_today', input.selectedTodayWords);
  addWords('current_batch_duplicate', input.currentBatchWords);
  addWords('favorite_or_pending', [...flattenWords(input.favoriteWords), ...flattenWords(input.pendingWords)]);
  addWords('published', input.publishedWords);
  addWords('recent_history_30d', input.recentHistoryWords);
  addWords('protected', input.protectedWords);
  addWords('existing_recent_candidate', input.existingRecentCandidateWords);

  return { excludedWords, excludedReasons };
}

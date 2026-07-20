export const DAILY_WORD_COUNT = 10;
export const LEGACY_DAILY_WORD_LIMIT = 20;
export const DAILY_WORD_COUNT_EFFECTIVE_DATE = '2026-07-21';
export const MAX_DAILY_S_LEVEL_COUNT = 6;

export function isStoredDailyWordCount(value) {
  const count = Number(value) || 0;
  return count === DAILY_WORD_COUNT || count === LEGACY_DAILY_WORD_LIMIT;
}

export function getExpectedDailyWordCount(dateKey = '') {
  const cleanDateKey = String(dateKey || '').trim();
  return cleanDateKey && cleanDateKey < DAILY_WORD_COUNT_EFFECTIVE_DATE
    ? LEGACY_DAILY_WORD_LIMIT
    : DAILY_WORD_COUNT;
}

export function isExpectedDailyWordCount(value, dateKey = '') {
  return Number(value) === getExpectedDailyWordCount(dateKey);
}

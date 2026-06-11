import { ALL_WORDS } from './words-data.mjs';

export const APP_TIME_ZONE = 'Asia/Shanghai';
export const WORDS_PER_DAY = 20;
export const DEDUP_DAYS = 15;
const PURE_KANJI_RE = /^[\u3400-\u9fff々ヶ]+$/;

const KNOWN_WORDS = new Map(
  ALL_WORDS
    .filter(word => word && typeof word.kanji === 'string' && word.kanji.trim())
    .map(word => [word.kanji.trim(), word])
);

const DATE_KEY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function cleanRankingsDays(value, fallback = 8) {
  return clampInteger(value, 1, 30, fallback);
}

export function dateKey(date = new Date()) {
  const parts = DATE_KEY_FORMATTER.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function cleanDateKey(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[0] : '';
}

export function addDays(dateKeyValue, offset) {
  const key = cleanDateKey(dateKeyValue);
  if (!key) return '';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(date.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function formatDisplayDate(dateKeyValue, locale = 'zh-CN') {
  const key = cleanDateKey(dateKeyValue);
  if (!key) return '';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.toLocaleDateString(locale, {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
}

export function seededRNG(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = ((state << 5) - state) + seed.charCodeAt(index) | 0;
  }
  return function random() {
    state = (state * 16807 + 12345) % 2147483647;
    return (state & 0x7fffffff) / 2147483647;
  };
}

export function seededShuffle(list, rng) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function cleanRankingWords(words) {
  if (!Array.isArray(words)) return [];
  const uniqueWords = [];
  const seen = new Set();
  for (const word of words) {
    const kanji = String(word || '').trim().slice(0, 80);
    const knownWord = KNOWN_WORDS.get(kanji);
    if (!kanji || seen.has(kanji) || !knownWord || !isWordApproved(knownWord) || shouldFilterPureChineseCandidate(knownWord)) continue;
    seen.add(kanji);
    uniqueWords.push(kanji);
    if (uniqueWords.length >= WORDS_PER_DAY) break;
  }
  return uniqueWords;
}

export function cleanStoredRanking(data, fallbackDateKey = '') {
  const dateKeyValue = cleanDateKey(data?.dateKey) || cleanDateKey(fallbackDateKey);
  const words = cleanRankingWords(data?.words);
  return {
    dateKey: dateKeyValue,
    words,
    updated: typeof data?.updated === 'string' ? data.updated : null
  };
}

export function getWordByKanji(kanji) {
  return KNOWN_WORDS.get(String(kanji || '').trim()) || null;
}

export function isWordApproved(word) {
  const status = String(word?.status || 'approved').trim();
  return !status || status === 'approved';
}

export function isLikelyPureKanjiNoun(word) {
  const kanji = String(word?.kanji || '').trim();
  return PURE_KANJI_RE.test(kanji);
}

export function shouldFilterPureChineseCandidate(wordOrKanji) {
  const word = typeof wordOrKanji === 'string' ? getWordByKanji(String(wordOrKanji || '').trim()) : wordOrKanji;
  return Boolean(word && isLikelyPureKanjiNoun(word));
}

export function getRankingCandidates() {
  return ALL_WORDS.filter(word => isWordApproved(word) && !shouldFilterPureChineseCandidate(word));
}

export function hydrateRankingWords(dateKeyValue, rankingWords) {
  const words = cleanRankingWords(rankingWords);
  return words
    .map((kanji, index) => {
      const word = getWordByKanji(kanji);
      if (!word) return null;
      return {
        ...word,
        id: `${dateKeyValue}_${index}`,
        imageUrl: getImageUrl(kanji, index)
      };
    })
    .filter(Boolean);
}

export function buildRankingForDate(targetDateKey, cachedSelections = new Map()) {
  const dateKeyValue = cleanDateKey(targetDateKey);
  if (!dateKeyValue) return [];
  if (cachedSelections.has(dateKeyValue)) {
    return cleanRankingWords(cachedSelections.get(dateKeyValue));
  }

  const usedWords = new Set();
  for (let offset = 1; offset <= DEDUP_DAYS; offset += 1) {
    const previousDateKey = addDays(dateKeyValue, -offset);
    const previousWords = cleanRankingWords(cachedSelections.get(previousDateKey));
    previousWords.forEach(word => usedWords.add(word));
  }

  const rankingCandidates = getRankingCandidates();
  let availableWords = rankingCandidates.filter(word => !usedWords.has(word.kanji));
  if (availableWords.length < WORDS_PER_DAY) {
    availableWords = [...rankingCandidates];
  }

  const shuffledWords = seededShuffle(availableWords, seededRNG(dateKeyValue));
  const selectedWords = cleanRankingWords(shuffledWords.slice(0, WORDS_PER_DAY).map(word => word.kanji));
  cachedSelections.set(dateKeyValue, selectedWords);
  return selectedWords;
}

export function getImageUrl(word, index) {
  const seeds = [
    'sakura', 'cherry', 'japan', 'zen', 'matcha', 'blossom', 'temple', 'kyoto',
    'fuji', 'bamboo', 'lotus', 'wave', 'crane', 'moon', 'garden', 'petal',
    'ribbon', 'cloud', 'dusk', 'dawn'
  ];
  const seed = seeds[index % seeds.length] + word;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/520/390`;
}

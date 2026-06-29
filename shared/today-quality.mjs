const WORDS_PER_DAY = 20;

export const QUALITY_CATEGORIES = [
  'basic_greeting',
  'textbook_polite',
  'emotion_state',
  'social_nuance',
  'life_state',
  'fandom_circle',
  'beauty_product',
  'cute_slang',
  'generic_basic',
  'unknown'
];

export const DAILY_QUALITY_MAXIMA = {
  basicTextbook: 1,
  beauty_product: 1,
  cute_slang: 1,
  fandom_circle: 2
};

export const DAILY_QUALITY_MINIMA = {
  emotion_state: 4,
  social_nuance: 3,
  life_state: 4
};

const BASIC_GREETING_WORDS = new Set([
  'ありがとうございます',
  'おはようございます',
  'こんにちは',
  'こんばんは',
  'おやすみなさい',
  'ただいま',
  '行ってきます'
]);

const TEXTBOOK_POLITE_WORDS = new Set([
  'お願いします',
  'よろしくお願いします',
  'お疲れ様です',
  'お疲れ様',
  'ごちそうさま',
  'すみません',
  'いただきます',
  'お邪魔します',
  'お世話になります'
]);

const EMOTION_STATE_WORDS = new Set([
  'ぐっと',
  'しんみり',
  'ほのぼの',
  'わくわく',
  'お疲れ気味',
  'しょんぼり',
  'だるい',
  'モヤモヤ',
  'もにょる',
  '気が楽',
  '小確幸',
  '自己肯定感',
  '大正解',
  '木漏れ日',
  '清潔感',
  'ときめく',
  '胸きゅん',
  'ドキドキ',
  'そわそわ',
  'ぽかぽか'
]);

const SOCIAL_NUANCE_WORDS = new Set([
  '気が合う',
  '気が置けない',
  'かぶる',
  '気を遣う',
  '気遣い',
  '気配り',
  '距離感',
  '空気読む',
  '空気読める',
  '察する',
  'きまづい',
  '気が利く',
  '落ち合う',
  'ノリがいい',
  '甘え'
]);

const LIFE_STATE_WORDS = new Set([
  'だらける',
  '追い込み',
  '積みゲー',
  'やりくり',
  '煮詰まる',
  'お疲れ気味',
  '頑張りすぎ',
  '気分転換',
  '気が散る',
  'うつむく',
  'ファボる',
  'タピる'
]);

const FANDOM_WORDS = new Set([
  '推し',
  '尊すぎ',
  '尊み',
  '神回',
  '布教',
  '沼落ち',
  '解釈一致',
  '現場',
  '参戦',
  '同担',
  '推し増し',
  '推し変あるある',
  '推し活グッズ',
  '推しの尊さ',
  '激推し',
  'ガチ恋口上'
]);

const BEAUTY_PRODUCT_WORDS = new Set([
  'アイシャドウベース',
  'グロスリップ',
  'リップ',
  'チーク',
  'ファンデ',
  'ファンデーション',
  'マスカラ',
  'アイシャドウ',
  'ベースメイク',
  'ネイル'
]);

const CUTE_SLANG_WORDS = new Set([
  'ぴえん',
  'きゅん',
  '胸きゅん',
  'タピる',
  'メロい',
  'かわちい',
  'ちゅき'
]);

const GENERIC_BASIC_WORDS = new Set([
  '大丈夫',
  '夢中',
  '勉強',
  '仕事',
  '生活',
  '料理',
  '旅行',
  '買い物'
]);

const BEAUTY_PRODUCT_RE = /リップ|チーク|ファンデ|マスカラ|アイシャドウ|ネイル|ベースメイク|メイク用品|化粧品|美妆品类|美妝品類/;
const FANDOM_RE = /推し|尊|神回|布教|沼落ち|解釈一致|現場|参戦|同担|オタ|痛バ|追星|圈层|圈層/;
const EMOTION_RE = /しんみり|ほのぼの|わくわく|モヤ|もにょ|だるい|しょんぼり|ときめ|胸きゅん|ドキドキ|そわそわ|ぽかぽか|気持ち|心情|情绪|情緒|状态|狀態/;
const SOCIAL_RE = /気が合う|気が置けない|気を遣う|気遣い|気配り|距離感|空気|察する|きまづい|気が利く|人际|人際|社交|语感|語感|关系|關係/;
const LIFE_RE = /だらけ|追い込み|積みゲー|やりくり|煮詰まる|気分転換|気が散る|生活|日常|学习|學習|仕事|状态场景|狀態場景/;
const CUTE_SLANG_RE = /ぴえん|きゅん|メロい|タピる|かわちい|ちゅき|可爱网络语|可愛網路語/;
const TEXTBOOK_CONTEXT_RE = /教材|教科书|教科書|寒暄|礼貌表达|禮貌表達|基础问候|基礎問候/;
const TITLE_VALUE_RE = /收藏|封面|标题|標題|画面|場景|场景|共鸣|共鳴|中文不好直译|中文不好直譯|微妙|表达|表達/;
const LOW_TITLE_VALUE_RE = /太基础|太基礎|过于基础|過於基礎|教材|品类名|品類名|普通名词|普通名詞|不好做标题|不好做標題|内容价值低|內容價值低/;

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getWord(entry = {}) {
  return cleanText(typeof entry === 'string' ? entry : entry.kanji || entry.word, 80);
}

function getContextText(entry = {}) {
  if (typeof entry === 'string') return entry;
  return [
    entry.kanji,
    entry.word,
    entry.meaning,
    entry.category,
    entry.candidateType,
    entry.reason,
    entry.suggestedAction,
    entry.reviewReason,
    entry.riskWarning
  ].map(value => cleanText(value)).join(' ');
}

export function getDailyQualityCategory(entry = {}) {
  const word = getWord(entry);
  const text = `${word} ${getContextText(entry)}`;
  if (!word) return 'unknown';
  if (BASIC_GREETING_WORDS.has(word)) return 'basic_greeting';
  if (TEXTBOOK_POLITE_WORDS.has(word)) return 'textbook_polite';
  if (BEAUTY_PRODUCT_WORDS.has(word) || BEAUTY_PRODUCT_RE.test(text)) return 'beauty_product';
  if (CUTE_SLANG_WORDS.has(word) || CUTE_SLANG_RE.test(text)) return 'cute_slang';
  if (SOCIAL_NUANCE_WORDS.has(word)) return 'social_nuance';
  if (LIFE_STATE_WORDS.has(word)) return 'life_state';
  if (EMOTION_STATE_WORDS.has(word)) return 'emotion_state';
  if (SOCIAL_RE.test(text)) return 'social_nuance';
  if (LIFE_RE.test(text)) return 'life_state';
  if (EMOTION_RE.test(text)) return 'emotion_state';
  if (FANDOM_WORDS.has(word) || FANDOM_RE.test(text)) return 'fandom_circle';
  if (GENERIC_BASIC_WORDS.has(word) || TEXTBOOK_CONTEXT_RE.test(text)) return 'generic_basic';
  return 'unknown';
}

export function getDailySemanticCluster(entry = {}) {
  const word = getWord(entry);
  const text = `${word} ${getContextText(entry)}`;
  if (!word) return 'unknown';
  if (BASIC_GREETING_WORDS.has(word)) return 'basic_greeting_cluster';
  if (/お疲れ/.test(word)) return 'otsukare_cluster';
  if (TEXTBOOK_POLITE_WORDS.has(word) || TEXTBOOK_CONTEXT_RE.test(text)) return 'textbook_polite_cluster';
  if (BEAUTY_PRODUCT_WORDS.has(word) || BEAUTY_PRODUCT_RE.test(text)) return 'beauty_product_cluster';
  if (/^気[がを]/.test(word) || /気が|気を/.test(word)) return 'kiga_expression_cluster';
  if (FANDOM_WORDS.has(word) || FANDOM_RE.test(text)) return 'fandom_oshi_cluster';
  return `word:${word}`;
}

export function getDailyClusterLimit(cluster) {
  return {
    basic_greeting_cluster: 1,
    textbook_polite_cluster: 1,
    otsukare_cluster: 1,
    beauty_product_cluster: 1,
    kiga_expression_cluster: 2,
    fandom_oshi_cluster: 2
  }[cluster] || WORDS_PER_DAY;
}

function parseDateKey(value) {
  const cleanValue = cleanText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanValue)) return null;
  const date = new Date(`${cleanValue}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(leftDateKey, rightDateKey) {
  const left = parseDateKey(leftDateKey);
  const right = parseDateKey(rightDateKey);
  if (!left || !right) return Infinity;
  return Math.round(Math.abs(right.getTime() - left.getTime()) / 86400000);
}

function collectSnapshotRecords(workflow = {}) {
  const records = [];
  Object.entries(workflow.historySnapshots || {}).forEach(([dateKey, snapshot]) => {
    records.push({ dateKey, words: Array.isArray(snapshot?.words) ? snapshot.words : [] });
  });
  (Array.isArray(workflow.todaySnapshotHistory) ? workflow.todaySnapshotHistory : []).forEach(snapshot => {
    records.push({ dateKey: snapshot?.dateKey || '', words: Array.isArray(snapshot?.words) ? snapshot.words : [] });
  });
  return records.filter(record => record.dateKey && record.words.length);
}

export function buildDailyQualityContext(workflow = {}, options = {}) {
  const today = cleanText(options.today || '', 20);
  const recent15Clusters = new Set();
  const recent30Clusters = new Set();
  collectSnapshotRecords(workflow).forEach(record => {
    if (!today || record.dateKey === today) return;
    const distance = daysBetween(record.dateKey, today);
    if (distance > 30) return;
    record.words.forEach(word => {
      const cluster = getDailySemanticCluster(word);
      if (distance <= 15) recent15Clusters.add(cluster);
      recent30Clusters.add(cluster);
    });
  });
  return { today, recent15Clusters, recent30Clusters };
}

export function getDailyQualityScoreDelta(entry = {}, context = {}) {
  const category = getDailyQualityCategory(entry);
  const cluster = getDailySemanticCluster(entry);
  const text = `${getWord(entry)} ${getContextText(entry)}`;
  const categoryDelta = {
    basic_greeting: -46,
    textbook_polite: -42,
    beauty_product: -24,
    fandom_circle: -12,
    cute_slang: -10,
    generic_basic: -28,
    emotion_state: 24,
    social_nuance: 22,
    life_state: 20,
    unknown: 0
  }[category] || 0;
  const titleDelta = TITLE_VALUE_RE.test(text) ? 8 : LOW_TITLE_VALUE_RE.test(text) ? -14 : 0;
  const recentClusterDelta = context.recent15Clusters?.has(cluster)
    ? -18
    : context.recent30Clusters?.has(cluster)
      ? -10
      : 0;
  return clamp(categoryDelta + titleDelta + recentClusterDelta, -60, 36);
}

export function buildDailyQualitySummary(entries = [], options = {}) {
  const categoryCounts = QUALITY_CATEGORIES.reduce((result, category) => ({ ...result, [category]: 0 }), {});
  const clusterCounts = {};
  entries.forEach(entry => {
    const category = getDailyQualityCategory(entry);
    const cluster = getDailySemanticCluster(entry);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    clusterCounts[cluster] = (clusterCounts[cluster] || 0) + 1;
  });
  const warnings = [];
  const relaxedReasons = [];
  const basicTextbookCount = (categoryCounts.basic_greeting || 0) + (categoryCounts.textbook_polite || 0);
  const maxChecks = [
    ['basic_greeting_textbook_polite', basicTextbookCount, DAILY_QUALITY_MAXIMA.basicTextbook],
    ['beauty_product', categoryCounts.beauty_product || 0, DAILY_QUALITY_MAXIMA.beauty_product],
    ['cute_slang', categoryCounts.cute_slang || 0, DAILY_QUALITY_MAXIMA.cute_slang],
    ['fandom_circle', categoryCounts.fandom_circle || 0, DAILY_QUALITY_MAXIMA.fandom_circle]
  ];
  maxChecks.forEach(([name, count, max]) => {
    if (count > max) {
      warnings.push(`${name} quota exceeded: ${count}/${max}`);
      relaxedReasons.push(`${name}_quota_exceeded`);
    }
  });
  Object.entries(DAILY_QUALITY_MINIMA).forEach(([category, minimum]) => {
    const count = categoryCounts[category] || 0;
    if (count < minimum) {
      warnings.push(`${category} below target: ${count}/${minimum}`);
      relaxedReasons.push(`${category}_below_target`);
    }
  });
  Object.entries(clusterCounts).forEach(([cluster, count]) => {
    const limit = getDailyClusterLimit(cluster);
    if (count > limit) {
      warnings.push(`${cluster} cluster quota exceeded: ${count}/${limit}`);
      relaxedReasons.push(`${cluster}_cluster_exceeded`);
    }
  });
  const penalty = relaxedReasons.length * 8
    + Math.max(0, basicTextbookCount - DAILY_QUALITY_MAXIMA.basicTextbook) * 12
    + Math.max(0, (categoryCounts.beauty_product || 0) - DAILY_QUALITY_MAXIMA.beauty_product) * 8
    + Math.max(0, (categoryCounts.fandom_circle || 0) - DAILY_QUALITY_MAXIMA.fandom_circle) * 6;
  const positiveCoverage = Math.min(categoryCounts.emotion_state || 0, DAILY_QUALITY_MINIMA.emotion_state)
    + Math.min(categoryCounts.social_nuance || 0, DAILY_QUALITY_MINIMA.social_nuance)
    + Math.min(categoryCounts.life_state || 0, DAILY_QUALITY_MINIMA.life_state);
  const score = clamp(62 + positiveCoverage * 3 - penalty, 0, 100);
  const relaxed = Boolean(options.relaxed || relaxedReasons.length);
  return {
    score,
    categoryCounts,
    clusterCounts,
    warnings: warnings.slice(0, 12),
    relaxed,
    relaxedReasons: [...new Set([...(options.relaxedReasons || []), ...relaxedReasons])].slice(0, 12)
  };
}

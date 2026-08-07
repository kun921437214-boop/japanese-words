import { DAILY_WORD_COUNT } from './daily-config.mjs';

const WORDS_PER_DAY = DAILY_WORD_COUNT;

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
  emotion_state: 2,
  social_nuance: 2
};

export const DAILY_CONTENT_MIX_LANES = [
  'core_emotion_social',
  'daily_abbreviation',
  'verified_trend',
  'beauty_fashion_expression',
  'flexible'
];

export const DAILY_CONTENT_MIX_TARGETS = {
  core_emotion_social: 4,
  daily_abbreviation: 2,
  verified_trend: 1,
  beauty_fashion_expression: 2,
  flexible: 1
};

export const DAILY_EXPRESSION_FORM_MAXIMA = {
  full_phrase: 2,
  long_idiom: 1
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
  'お世話になります',
  '失礼します'
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
  'ネイル',
  'ツヤ肌',
  '涙袋メイク',
  'シェーディング',
  'ノーファンデ'
]);

const GENERIC_BEAUTY_FASHION_WORDS = new Set([
  ...BEAUTY_PRODUCT_WORDS,
  'コスメ',
  'メイク',
  'スキンケア',
  'ファッション',
  'コーデ',
  'デニム',
  'ワンピース',
  'スニーカー'
]);

const BEAUTY_FASHION_EXPRESSION_WORDS = new Set([
  'オーロラ肌',
  '粘膜カラー',
  '束感まつ毛',
  'ジュレ質感',
  'バレエコア',
  'ウェッジソール',
  'シアーレイヤード',
  'ボーホーシック',
  '抜け感',
  '透け感',
  'こなれ感',
  'ツヤ感',
  '血色感',
  '透明感'
]);

const DAILY_ABBREVIATION_WORDS = new Set([
  'コスパ',
  'タイパ',
  'サブスク',
  'リプ',
  'ファボ',
  'ファボる',
  '垢',
  '推し活',
  'ソロ活',
  '朝活',
  'ポイ活',
  'ヌン活',
  '宅飲み',
  'リモ飲み'
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
  '買い物',
  'テンション',
  '頑張る',
  '集中',
  '充実'
]);

const BEAUTY_PRODUCT_RE = /リップ|チーク|ファンデ|マスカラ|アイシャドウ|ネイル|ベースメイク|涙袋メイク|シェーディング|ノーファンデ|ツヤ肌|メイク用品|化粧品|美妆品类|美妝品類/;
const BEAUTY_FASHION_EXPRESSION_RE = /オーロラ肌|粘膜カラー|束感まつ毛|ジュレ質感|バレエコア|ウェッジソール|シアーレイヤード|ボーホーシック|抜け感|透け感|こなれ感|ツヤ感|血色感|透明感|具体(?:的)?(?:美妆|美妝|穿搭|时尚|時尚)(?:表达|表達)|可视化(?:美妆|美妝|穿搭)|审美表达|審美表達/;
const ABBREVIATION_CONTEXT_RE = /日常(?:缩略语|縮略語|缩写|縮寫|略语|略語)|常用(?:缩略语|縮略語|缩写|縮寫|略称)|固定略称|成熟缩略语|成熟縮略語|abbreviation/i;
const FULL_PHRASE_RE = /[\u30a0-\u30ff\u3400-\u9fff々ヶー]+(?:が|を|に|へ|と|で|は|も|から|まで)[\u3040-\u30ff\u3400-\u9fff々ヶー]+/;
const FULL_PHRASE_CONTEXT_RE = /完整词组|完整詞組|固定词组|固定詞組|短语|短語|句式|惯用语|慣用語|ことわざ|諺/;
const LONG_IDIOM_CONTEXT_RE = /长句式|長句式|惯用语|慣用語|ことわざ|諺/;
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
  if (GENERIC_BASIC_WORDS.has(word)) return 'generic_basic';
  if (SOCIAL_NUANCE_WORDS.has(word)) return 'social_nuance';
  if (LIFE_STATE_WORDS.has(word)) return 'life_state';
  if (EMOTION_STATE_WORDS.has(word)) return 'emotion_state';
  if (SOCIAL_RE.test(text)) return 'social_nuance';
  if (LIFE_RE.test(text)) return 'life_state';
  if (EMOTION_RE.test(text)) return 'emotion_state';
  if (FANDOM_WORDS.has(word) || FANDOM_RE.test(text)) return 'fandom_circle';
  if (TEXTBOOK_CONTEXT_RE.test(text)) return 'generic_basic';
  return 'unknown';
}

function isSpecificBeautyFashionExpression(entry = {}) {
  const word = getWord(entry);
  const text = `${word} ${getContextText(entry)}`;
  if (!word || GENERIC_BEAUTY_FASHION_WORDS.has(word)) return false;
  if (BEAUTY_FASHION_EXPRESSION_WORDS.has(word) || BEAUTY_FASHION_EXPRESSION_RE.test(text)) return true;
  return ['美妆穿搭词', '审美氛围词'].includes(entry?.candidateType)
    && !BEAUTY_PRODUCT_RE.test(word)
    && !LOW_TITLE_VALUE_RE.test(text);
}

function isEstablishedDailyAbbreviation(entry = {}) {
  const word = getWord(entry);
  const text = `${word} ${getContextText(entry)}`;
  if (!word) return false;
  if (!DAILY_ABBREVIATION_WORDS.has(word) && !ABBREVIATION_CONTEXT_RE.test(text)) return false;
  const evidenceType = cleanText(entry?.evidenceType, 40) || 'common_usage';
  const confidenceLevel = cleanText(entry?.confidenceLevel, 40) || 'medium';
  return ['common_usage', 'user_material', 'trend_claim'].includes(evidenceType)
    && ['high', 'medium'].includes(confidenceLevel);
}

function isVerifiedTrendExpression(entry = {}) {
  const confidenceLevel = cleanText(entry?.confidenceLevel, 40) || 'medium';
  return cleanText(entry?.evidenceType, 40) === 'trend_claim'
    && ['high', 'medium'].includes(confidenceLevel)
    && cleanText(entry?.riskLevel, 40) !== 'high'
    && cleanText(entry?.displayBucket, 40) === 'meme_fast';
}

export function getDailyContentMixLane(entry = {}) {
  if (isSpecificBeautyFashionExpression(entry)) return 'beauty_fashion_expression';
  if (isEstablishedDailyAbbreviation(entry)) return 'daily_abbreviation';
  if (isVerifiedTrendExpression(entry)) return 'verified_trend';
  const category = getDailyQualityCategory(entry);
  if (['emotion_state', 'social_nuance'].includes(category)) return 'core_emotion_social';
  return 'flexible';
}

export function getDailyExpressionForm(entry = {}) {
  const word = getWord(entry);
  if (!word) return 'short_expression';
  const text = `${word} ${getContextText(entry)}`;
  const characterCount = [...word.replace(/[\s、。！？!?]/g, '')].length;
  const particleCount = (word.match(/(?:が|を|に|へ|と|で|は|も|から|まで)/g) || []).length;
  const fullPhrase = BASIC_GREETING_WORDS.has(word)
    || TEXTBOOK_POLITE_WORDS.has(word)
    || /[\s、。！？!?]/.test(word)
    || FULL_PHRASE_RE.test(word)
    || FULL_PHRASE_CONTEXT_RE.test(text);
  if (LONG_IDIOM_CONTEXT_RE.test(text) || (fullPhrase && (characterCount >= 7 || particleCount >= 2))) return 'long_idiom';
  return fullPhrase ? 'full_phrase' : 'short_expression';
}

export function getDailySemanticCluster(entry = {}) {
  const word = getWord(entry);
  const text = `${word} ${getContextText(entry)}`;
  if (!word) return 'unknown';
  if (BASIC_GREETING_WORDS.has(word)) return 'basic_greeting_cluster';
  if (/^(モヤる|もやもや|モヤモヤ)$/.test(word)) return 'moya_cluster';
  if (/^(テンション|テンション上がる|テンション下がる)$/.test(word)) return 'tension_cluster';
  if (/^(空気読む|空気を読む|空気読める)$/.test(word)) return 'read_the_room_cluster';
  if (/^(気を遣う|気遣い)$/.test(word)) return 'consideration_cluster';
  if (/^(推し|自担|同担)$/.test(word)) return 'fandom_identity_cluster';
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
    moya_cluster: 1,
    tension_cluster: 1,
    read_the_room_cluster: 1,
    consideration_cluster: 1,
    fandom_identity_cluster: 2,
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
  const contentMixLane = getDailyContentMixLane(entry);
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
  const mixDelta = {
    daily_abbreviation: 8,
    verified_trend: 6,
    beauty_fashion_expression: 10,
    core_emotion_social: 4,
    flexible: 0
  }[contentMixLane] || 0;
  return clamp(categoryDelta + titleDelta + recentClusterDelta + mixDelta, -60, 42);
}

export function hasStrongXhsExpressionValue(entry = {}) {
  const category = getDailyQualityCategory(entry);
  const contentMixLane = getDailyContentMixLane(entry);
  const text = `${getWord(entry)} ${getContextText(entry)}`;
  if (['daily_abbreviation', 'verified_trend', 'beauty_fashion_expression'].includes(contentMixLane)) return true;
  if (['emotion_state', 'social_nuance', 'life_state', 'cute_slang', 'fandom_circle'].includes(category)) return true;
  return TITLE_VALUE_RE.test(text) && !LOW_TITLE_VALUE_RE.test(text);
}

export function buildDailyQualitySummary(entries = [], options = {}) {
  const categoryCounts = QUALITY_CATEGORIES.reduce((result, category) => ({ ...result, [category]: 0 }), {});
  const contentMixLaneCounts = DAILY_CONTENT_MIX_LANES.reduce((result, lane) => ({ ...result, [lane]: 0 }), {});
  const expressionFormCounts = { short_expression: 0, full_phrase: 0, long_idiom: 0 };
  const clusterCounts = {};
  entries.forEach(entry => {
    const category = getDailyQualityCategory(entry);
    const contentMixLane = getDailyContentMixLane(entry);
    const expressionForm = getDailyExpressionForm(entry);
    const cluster = getDailySemanticCluster(entry);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    contentMixLaneCounts[contentMixLane] = (contentMixLaneCounts[contentMixLane] || 0) + 1;
    expressionFormCounts[expressionForm] = (expressionFormCounts[expressionForm] || 0) + 1;
    clusterCounts[cluster] = (clusterCounts[cluster] || 0) + 1;
  });
  const warnings = [];
  const categoryConcentrationWarnings = [];
  const healthWarnings = [];
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
      const warning = `${name} quota exceeded: ${count}/${max}`;
      warnings.push(warning);
      categoryConcentrationWarnings.push(warning);
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
  const contentMixWarnings = [];
  Object.entries(DAILY_CONTENT_MIX_TARGETS).forEach(([lane, target]) => {
    const count = contentMixLaneCounts[lane] || 0;
    if (count !== target) {
      const warning = `${lane} mix target missed: ${count}/${target}`;
      warnings.push(warning);
      contentMixWarnings.push(warning);
      relaxedReasons.push(`${lane}_mix_target_missed`);
    }
  });
  const fullPhraseCount = (expressionFormCounts.full_phrase || 0) + (expressionFormCounts.long_idiom || 0);
  const longIdiomCount = expressionFormCounts.long_idiom || 0;
  if (fullPhraseCount > DAILY_EXPRESSION_FORM_MAXIMA.full_phrase) {
    const warning = `full_phrase quota exceeded: ${fullPhraseCount}/${DAILY_EXPRESSION_FORM_MAXIMA.full_phrase}`;
    warnings.push(warning);
    contentMixWarnings.push(warning);
    relaxedReasons.push('full_phrase_quota_exceeded');
  }
  if (longIdiomCount > DAILY_EXPRESSION_FORM_MAXIMA.long_idiom) {
    const warning = `long_idiom quota exceeded: ${longIdiomCount}/${DAILY_EXPRESSION_FORM_MAXIMA.long_idiom}`;
    warnings.push(warning);
    contentMixWarnings.push(warning);
    relaxedReasons.push('long_idiom_quota_exceeded');
  }
  Object.entries(clusterCounts).forEach(([cluster, count]) => {
    const limit = getDailyClusterLimit(cluster);
    if (count > limit) {
      warnings.push(`${cluster} cluster quota exceeded: ${count}/${limit}`);
      relaxedReasons.push(`${cluster}_cluster_exceeded`);
    }
  });
  const duplicateClusters = Object.entries(clusterCounts)
    .filter(([cluster, count]) => (
      count > getDailyClusterLimit(cluster)
      && !['basic_greeting_cluster', 'textbook_polite_cluster', 'otsukare_cluster', 'beauty_product_cluster'].includes(cluster)
    ))
    .map(([cluster, count]) => ({ cluster, count, limit: getDailyClusterLimit(cluster) }));
  const duplicateClusterCount = duplicateClusters.length;
  const beautyCategoryCount = categoryCounts.beauty_product || 0;
  const basicPoliteCount = basicTextbookCount;
  const genericBasicCount = categoryCounts.generic_basic || 0;
  const mixDeviation = Object.entries(DAILY_CONTENT_MIX_TARGETS)
    .reduce((sum, [lane, target]) => sum + Math.abs((contentMixLaneCounts[lane] || 0) - target), 0);
  const penalty = relaxedReasons.length * 4
    + mixDeviation * 3
    + Math.max(0, basicTextbookCount - DAILY_QUALITY_MAXIMA.basicTextbook) * 12
    + Math.max(0, (categoryCounts.beauty_product || 0) - DAILY_QUALITY_MAXIMA.beauty_product) * 8
    + Math.max(0, (categoryCounts.fandom_circle || 0) - DAILY_QUALITY_MAXIMA.fandom_circle) * 6;
  const positiveCoverage = Math.min(categoryCounts.emotion_state || 0, DAILY_QUALITY_MINIMA.emotion_state)
    + Math.min(categoryCounts.social_nuance || 0, DAILY_QUALITY_MINIMA.social_nuance);
  const score = clamp(62 + positiveCoverage * 3 - penalty, 0, 100);
  const estimatedPenalty = Math.min(18,
    duplicateClusterCount * 6
      + Math.max(0, beautyCategoryCount - 1) * 5
      + basicPoliteCount * 6
      + genericBasicCount * 3
      + Math.max(0, fullPhraseCount - DAILY_EXPRESSION_FORM_MAXIMA.full_phrase) * 4
      + Math.max(0, longIdiomCount - DAILY_EXPRESSION_FORM_MAXIMA.long_idiom) * 4
      + mixDeviation * 2
  );
  const estimatedHumanQualityScore = clamp(100 - estimatedPenalty, 0, 100);
  if (duplicateClusterCount > 0) healthWarnings.push(`存在 ${duplicateClusterCount} 组同日语义重复`);
  if (beautyCategoryCount > 1) healthWarnings.push(`美妆品类同日集中：${beautyCategoryCount}/1`);
  if (basicPoliteCount > 0) healthWarnings.push(`基础寒暄或教材礼貌词：${basicPoliteCount}`);
  if (genericBasicCount > 0) healthWarnings.push(`泛基础词：${genericBasicCount}`);
  healthWarnings.push(...contentMixWarnings);
  const relaxed = Boolean(options.relaxed || relaxedReasons.length);
  return {
    score,
    categoryCounts,
    contentMixLaneCounts,
    contentMixTargets: { ...DAILY_CONTENT_MIX_TARGETS },
    expressionFormCounts,
    fullPhraseCount,
    longIdiomCount,
    contentMixWarnings: contentMixWarnings.slice(0, 12),
    clusterCounts,
    duplicateClusterCount,
    duplicateClusters,
    beautyCategoryCount,
    basicPoliteCount,
    genericBasicCount,
    categoryConcentrationWarnings: categoryConcentrationWarnings.slice(0, 12),
    healthWarnings: healthWarnings.slice(0, 12),
    estimatedHumanQualityScore,
    warnings: warnings.slice(0, 12),
    relaxed,
    relaxedReasons: [...new Set([...(options.relaxedReasons || []), ...relaxedReasons])].slice(0, 12)
  };
}

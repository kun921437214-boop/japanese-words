import { ALL_WORDS } from './words-data.mjs';
import { LEGACY_DAILY_WORD_LIMIT, MAX_DAILY_S_LEVEL_COUNT } from './daily-config.mjs';
import { APP_TIME_ZONE, WORDS_PER_DAY, dateKey } from './rankings.mjs';
import {
  archiveTodaySnapshotIntoSnapshotHistory,
  cleanStoredWorkflow as cleanWorkflowSchema,
  isCompatibleTodaySnapshotGeneratorVersion,
  TODAY_SNAPSHOT_GENERATOR_VERSION
} from './workflow-schema.mjs';
import {
  DAILY_QUALITY_MAXIMA,
  DAILY_QUALITY_MINIMA,
  buildDailyQualityContext,
  buildDailyQualitySummary,
  getDailyClusterLimit,
  getDailyQualityCategory,
  getDailyQualityScoreDelta,
  getDailySemanticCluster,
  hasStrongXhsExpressionValue
} from './today-quality.mjs';

export { TODAY_SNAPSHOT_GENERATOR_VERSION };

const PURE_KANJI_RE = /^[\u3400-\u9fff々ヶ]+$/;
const RISK_LEVEL_OPTIONS = ['low', 'medium', 'high'];
const CONFIDENCE_LEVEL_OPTIONS = ['high', 'medium', 'low', 'review'];
const EVIDENCE_TYPE_OPTIONS = ['common_usage', 'ai_inferred', 'user_material', 'trend_claim', 'unknown'];
const DISPLAY_BUCKET_OPTIONS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked'];
const EMOTION_TONE_OPTIONS = ['positive', 'neutral', 'negative', 'aesthetic', 'lifestyle', 'fandom'];
const TODAY_SNAPSHOT_VERSION = 1;
export const TODAY_HISTORY_DEDUP_DAYS = 30;
const TODAY_HISTORY_DEDUP_RELAX_STEPS = [TODAY_HISTORY_DEDUP_DAYS];
const PROMPT_VERSION_BY_ACTION = {
  stable_today: 'candidate-v3',
  wild_ideas: 'candidate-v3',
  generate_candidates: 'candidate-v3',
  extract_from_materials: 'candidate-v3',
  enrich_words: 'card-v2',
  generate_word_card: 'card-v2',
  rerank_candidates: 'rerank-v1',
  audit_library_for_delete: 'library-audit-v2',
  audit_missing_library_words: 'library-audit-v2'
};
const LOW_VALUE_HOME_WORDS = new Set(['AI', 'ChatGPT', 'DM', 'DX', 'TikTok', 'TOEIC', 'Vtuber']);
const TODAY_HARD_EXCLUDED_WORDS = new Set([
  'ガチ恋',
  'キモい',
  'マジ卍',
  'コスミ',
  'バ美肉',
  '地雷系',
  'おじさん構文'
]);
const CHINESE_READABLE_LOW_VALUE_TODAY_WORDS = new Set([
  '副業',
  '資格',
  '資格勉強',
  '自己投資',
  '在宅勤務',
  '転職',
  '就職',
  '退職',
  '起業',
  '投資',
  '資産運用',
  '経済',
  '仕事術',
  '業務効率',
  '生産性',
  '消費',
  '洗濯',
  '語学',
  '管理',
  '最適化',
  '効率化',
  '寿司',
  '部屋',
  '書道'
]);
const CHINESE_READABLE_LOW_VALUE_CONTEXT_RE = /副业|副業|资格|資格|考证|考證|转职|轉職|転職|跳槽|就职|就職|退职|退職|自我投资|自己投資|投资|投資|资产|資産|经济|経済|职场|職場|职业|職業|事业|事業|商业|商業|业务|業務|办公|辦公|在家办公|在宅勤務|工作效率|業務効率|生产性|生産性|消费|消費|洗衣|洗濯|语学|語学|管理|优化|最適化|効率化|普通名词|普通名詞|泛用主题|泛用主題|抽象主题|抽象主題|教材|过于基础|過於基礎|太基础|太基礎/i;
const WORD_NORMALIZATION_MAP = {
  'オーバサイズ': 'オーバーサイズ'
};
const GENERIC_TOPIC_WORDS = new Set([
  'ネイル',
  'ベースメイク',
  'メンズメイク',
  '副業',
  '転職',
  '祭り',
  'お弁当',
  '資格勉強',
  '自己投資',
  'オーバーサイズ',
  '紅葉'
]);
const GENERIC_TOPIC_CONTEXT_RE = /泛话题|泛話題|话题分类|話題分類|搜索标签|搜尋標籤|纯分类|純分類|行业分类|行業分類|普通名词|普通名詞|只是名词|只是名詞|太基础|太基礎|过于基础|過於基礎|不好配图|不好配圖|不好做标题|不好做標題|标题价值低|標題價值低|单独做内容弱|單獨做內容弱/i;
const EXPRESSION_VALUE_STRONG_RE = /大正解|小確幸|自己肯定感|木漏れ日|清潔感|布教|推し変|気まずい|モヤる|距離感|気を遣う|空気読む|しんどい|刺さる|だるい|わかりみ|ガタが来る|メロい|ふて寝|しがみつく|エモ|匂わせ|ちょっかい|買い控え|ソロ活|スキマ時間|在宅ワーク|塩対応|沼|尊い|すれ違い/;
const EXPRESSION_VALUE_CONTEXT_RE = /共鸣|共鳴|情绪|情緒|人际|人際|社交|语感|語感|生活场景|生活場景|学习状态|學習狀態|工作状态|工作狀態|状态|狀態|中文不好直译|中文不好直譯|不好直译|不好直譯|不是.+而是|收藏|封面|标题|標題|标题封面|例句|自然例句|场景|場景|关系|關係|微妙|误解|誤解|表达|表達/;
const EXPRESSION_VALUE_LOW_RE = /泛话题|泛話題|话题分类|話題分類|纯分类|純分類|搜索标签|搜尋標籤|普通名词|普通名詞|教材|太基础|太基礎|不好解释|不好解釋|不好配图|不好配圖|不好做标题|不好做標題|内容价值低|內容價值低/;
const AESTHETIC_WORD_RE = /抜け感|透け感|こなれ|しっとり|ふんわり|レイヤード|ベージュ|マスタード|アシンメトリー|アシメトリー|木漏れ日|侘び寂び|清潔感|ツヤ感|マット|ヌーディ|アンニュイ/;
const LIFESTYLE_WORD_RE = /朝活|朝焼け|カフェ|弁当|おにぎり|パン|スイーツ|ソロ活|おひとりさま|グランピング|家計簿|断捨離|時短|勉強法|自炊|散歩|読書/;
const FANDOM_WORD_RE = /推し|オタ|痛バ|グッズ|聖地巡礼|自担|同担|箱推し|アニメ/;
const NEGATIVE_WORD_RE = /イライラ|うざい|キレる|グチる|めんどい|イチャモン|ムカつく|キモい|しんどい/;
const EMOTION_SOCIAL_RE = /大正解|小確幸|自己肯定感|気まずい|モヤる|距離感|気を遣う|空気読む|しんどい|刺さる|だるい|わかりみ|塩対応|すれ違い|共感|情绪|情緒|人际|人際|社交|语感|語感|関係|关系|關係|気持ち|心情/;
const SEASONAL_PATTERN = /バレンタイン|ホワイトデー|お盆|クリスマス|正月|花見|桜|ハロウィン|七夕|節分|祭り|紅葉|季節|节日|節日|季节|文化/;
const RECOMMENDATION_ORIGIN_LABELS = {
  codex_generated: 'Codex 次日草稿',
  deepseek_new: 'DeepSeek 新生成',
  candidate_pool: 'AI 候选池旧词',
  history_fallback: '历史热门回流',
  local_word_bank: '本地词库兜底',
  manual_added: '手动添加',
  today_backfill: '补位词',
  dedup_relaxed: '去重放宽回流',
  unknown: '来源未知'
};
const AUDIT_SPELLING_SUGGESTIONS = {
  '痛バック': '建议修正为「痛バッグ」',
  'オーバサイズ': '建议修正为「オーバーサイズ」'
};

const KNOWN_WORDS = new Map(
  ALL_WORDS
    .filter(word => word?.kanji && String(word.status || 'approved') === 'approved')
    .map(word => [String(word.kanji).trim(), word])
);

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeKanjiSpelling(value) {
  const cleanValue = cleanText(value, 80);
  return WORD_NORMALIZATION_MAP[cleanValue] || cleanValue;
}

function getEntryContextText(entry = {}) {
  return [
    entry.kanji,
    entry.meaning,
    entry.category,
    entry.candidateType,
    entry.reason,
    entry.suggestedAction,
    entry.reviewReason,
    entry.riskWarning
  ].map(value => cleanText(value, 1000)).join(' ');
}

export function isGenericTopicWord(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  if (!kanji) return false;
  if (GENERIC_TOPIC_WORDS.has(kanji)) return true;
  return GENERIC_TOPIC_CONTEXT_RE.test(`${kanji} ${getEntryContextText(entry)}`);
}

export function getExpressionValueScore(entry = {}) {
  const explicit = Number.parseInt(entry.expressionValueScore, 10);
  if (Number.isFinite(explicit) && explicit > 0) return clamp(explicit, 0, 100);
  const kanji = normalizeKanjiSpelling(entry.kanji);
  const text = `${kanji} ${getEntryContextText(entry)}`;
  let score = 62;
  if (EXPRESSION_VALUE_STRONG_RE.test(text)) score += 22;
  if (EXPRESSION_VALUE_CONTEXT_RE.test(text)) score += 16;
  if (['网络口语词', '新鲜梗词', '圈层词'].includes(entry.candidateType)) score += 4;
  if (['审美氛围词', '生活方式词', '追星兴趣词'].includes(entry.candidateType)) score += 6;
  if (isGenericTopicWord({ ...entry, kanji })) score -= 28;
  if (EXPRESSION_VALUE_LOW_RE.test(text)) score -= 18;
  if (PURE_KANJI_RE.test(kanji) && !EXPRESSION_VALUE_STRONG_RE.test(text)) score -= 8;
  return clamp(score, 0, 100);
}

function getAccountLearningTone(entry = {}) {
  const text = `${normalizeKanjiSpelling(entry.kanji)} ${getEntryContextText(entry)}`;
  if (EMOTION_SOCIAL_RE.test(text)) return 'emotion_social';
  if (LIFESTYLE_WORD_RE.test(text) || /生活|日常|学习|學習|工作|消费状态|消費狀態|状态场景|狀態場景|ソロ活|自炊|散歩|読書/.test(text)) return 'lifestyle';
  if (FANDOM_WORD_RE.test(text) || /追星|推し|圈层兴趣|圈層興趣|布教|二次元/.test(text)) return 'fandom';
  if (AESTHETIC_WORD_RE.test(text) || /审美|審美|美妆|美妝|穿搭|氛围|雰囲気/.test(text)) return 'aesthetic';
  if (SEASONAL_PATTERN.test(text) || /季节|季節|文化|旅行/.test(text)) return 'seasonal_culture';
  return 'other';
}

function getAccountLearningBonus(entry = {}) {
  const expressionValueScore = getExpressionValueScore(entry);
  const tone = getAccountLearningTone(entry);
  const toneBonus = {
    emotion_social: 18,
    lifestyle: 12,
    fandom: 8,
    aesthetic: 2,
    seasonal_culture: 0,
    other: 0
  }[tone] || 0;
  const expressionBonus = Math.round((expressionValueScore - 70) / 3);
  const genericPenalty = isGenericTopicWord(entry) ? 18 : 0;
  return clamp(toneBonus + expressionBonus - genericPenalty, -28, 24);
}

function isChineseReadableLowValueTodayWord(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  if (!kanji) return false;
  if (TODAY_HARD_EXCLUDED_WORDS.has(kanji)) return true;
  if (CHINESE_READABLE_LOW_VALUE_TODAY_WORDS.has(kanji)) return true;
  if (!PURE_KANJI_RE.test(kanji)) return false;
  const context = [
    entry.meaning,
    entry.category,
    entry.candidateType,
    entry.reason,
    entry.suggestedAction,
    entry.reviewReason
  ].map(value => cleanText(value, 240)).join(' ');
  return CHINESE_READABLE_LOW_VALUE_CONTEXT_RE.test(`${kanji} ${context}`);
}

export function getChineseTransparencyScore(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  if (!kanji) return 0;
  if (CHINESE_READABLE_LOW_VALUE_TODAY_WORDS.has(kanji) || CHINESE_READABLE_LOW_VALUE_CONTEXT_RE.test(getEntryContextText(entry))) return 92;
  if (PURE_KANJI_RE.test(kanji)) {
    const expressionValueScore = getExpressionValueScore(entry);
    return expressionValueScore >= 82 ? 58 : expressionValueScore >= 70 ? 70 : 84;
  }
  if (isGenericTopicWord(entry)) return 72;
  return 35;
}

function getRecommendationLevel(entry = {}) {
  const score = toInt(entry.finalScore || entry.lastScore || entry.xhsFitScore, 0);
  if (entry.riskLevel === 'high' || entry.lastReviewState === 'review' || entry.confidenceLevel === 'review') return 'B';
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  return 'C';
}

function getFreshBatchIds(workflow = {}, today = '') {
  return new Set(safeArray(workflow.aiBatches)
    .filter(batch => {
      if (!batch?.id || !batch.createdAt) return false;
      const created = new Date(batch.createdAt);
      if (Number.isNaN(created.getTime())) return false;
      return dateKey(created) === today && ['stable_today', 'generate_candidates', 'wild_ideas'].includes(batch.action);
    })
    .map(batch => cleanText(batch.id, 120))
    .filter(Boolean));
}

function getRecommendationAuditTrace(entry = {}, context = {}) {
  const freshBatchIds = context.freshBatchIds || new Set();
  const existingWords = context.existingWords || new Set();
  const sourceType = cleanText(entry.sourceType, 80);
  const fromCodex = sourceType === 'codex_generated';
  const fromDeepSeekNew = sourceType === 'deepseek_generated' && entry.aiBatchId && freshBatchIds.has(entry.aiBatchId);
  const fromManual = sourceType === 'manual_keep';
  const fromLocalFallback = Boolean(entry.fromLocalFallback || entry.lastOrigin === 'local' || sourceType === 'original' || sourceType === 'audit_missing');
  const fromHistoryFallback = Boolean(entry.historicalBackfill);
  const fromCandidatePool = !fromCodex && !fromDeepSeekNew && !fromManual && !fromLocalFallback && !fromHistoryFallback;
  const isBackfill = Boolean(entry.historicalBackfill)
    || (context.mode === 'fill' && !existingWords.has(entry.kanji))
    || (entry.displayBucket && entry.displayBucket !== 'today');
  const isDedupRelaxed = Boolean(entry.historicalBackfill || context.relaxedDedup || context.dedupDaysUsed < TODAY_HISTORY_DEDUP_DAYS);
  let originType = 'candidate_pool';
  if (fromCodex) originType = 'codex_generated';
  else if (fromDeepSeekNew) originType = 'deepseek_new';
  else if (fromHistoryFallback) originType = 'history_fallback';
  else if (fromLocalFallback) originType = 'local_word_bank';
  else if (fromManual) originType = 'manual_added';
  else if (!entry.kanji) originType = 'unknown';
  if (isBackfill) originType = 'today_backfill';
  if (isDedupRelaxed) originType = 'dedup_relaxed';
  return {
    originType,
    originLabel: RECOMMENDATION_ORIGIN_LABELS[originType] || RECOMMENDATION_ORIGIN_LABELS.unknown,
    sourceAction: entry.sourcePromptType || entry.sourceAction || '',
    sourceBatchId: entry.aiBatchId || '',
    fromDeepSeekNew,
    fromCandidatePool,
    fromHistoryFallback,
    fromLocalFallback,
    fromManual,
    fromCodex,
    isBackfill,
    isDedupRelaxed,
    dedupDaysUsed: context.dedupDaysUsed,
    selectedReason: [
      `分桶 ${entry.displayBucket || 'unknown'}`,
      `最终分 ${toInt(entry.finalScore || entry.lastScore || entry.xhsFitScore, 0)}`,
      `表达价值 ${getExpressionValueScore(entry)}`,
      isBackfill ? '用于补足今日推荐' : '',
      isDedupRelaxed ? `去重放宽到 ${context.dedupDaysUsed} 天` : ''
    ].filter(Boolean).join('；'),
    selectedAt: context.generatedAt || ''
  };
}

function buildAuditItem(entry = {}, context = {}) {
  const audit = getRecommendationAuditTrace(entry, context);
  const expressionValueScore = getExpressionValueScore(entry);
  const chineseTransparencyScore = getChineseTransparencyScore(entry);
  const genericTopic = isGenericTopicWord(entry);
  const diagnosis = [];
  if (genericTopic) diagnosis.push('泛话题词，适合候选池观察，不宜默认强推');
  if (chineseTransparencyScore >= 80) diagnosis.push('中文透明度高，可能缺少日语语感解释价值');
  if (expressionValueScore < 55) diagnosis.push('表达价值偏低');
  if (audit.isBackfill) diagnosis.push('补位入选，需要关注候选池是否不足');
  if (audit.isDedupRelaxed) diagnosis.push('去重放宽后入选');
  if (AUDIT_SPELLING_SUGGESTIONS[entry.kanji]) diagnosis.push(AUDIT_SPELLING_SUGGESTIONS[entry.kanji]);
  if (entry.kanji === 'レイヤー') diagnosis.push('需明确 cosplay / 创作者语境');
  if (entry.kanji === '乙') diagnosis.push('网络语语境依赖，需标注使用场景');
  return {
    kanji: entry.kanji,
    meaning: entry.meaning || '',
    recommendationLevel: getRecommendationLevel(entry),
    riskLevel: entry.riskLevel || '',
    ...audit,
    finalScore: clamp(toInt(entry.finalScore || entry.lastScore || entry.xhsFitScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(entry.accountLearningBonus || 0), -50, 50),
    accountLearningPenalty: Math.max(0, -clamp(toInt(entry.accountLearningBonus || 0), -50, 50)),
    expressionValueScore,
    chineseTransparencyScore,
    genericTopicPenalty: genericTopic ? 18 : 0,
    selectedReason: audit.selectedReason,
    diagnosis
  };
}

function average(items = []) {
  if (!items.length) return 0;
  return Math.round(items.reduce((sum, value) => sum + (Number(value) || 0), 0) / items.length);
}

function cleanNoveltySummary(summary = {}) {
  return {
    generatedUniqueCount: clamp(toInt(summary.generatedUniqueCount, 0), 0, 10000),
    importedUniqueCount: clamp(toInt(summary.importedUniqueCount, 0), 0, 10000),
    recentHistoryRejectedCount: clamp(toInt(summary.recentHistoryRejectedCount, 0), 0, 10000),
    favoriteProtectedRejectedCount: clamp(toInt(summary.favoriteProtectedRejectedCount, 0), 0, 10000),
    currentBatchDuplicateRejectedCount: clamp(toInt(summary.currentBatchDuplicateRejectedCount, 0), 0, 10000),
    reviewRejectedCount: clamp(toInt(summary.reviewRejectedCount, 0), 0, 10000),
    duplicateRate: clamp(toInt(summary.duplicateRate, 0), 0, 100),
    historyCollisionRate: clamp(toInt(summary.historyCollisionRate, 0), 0, 100)
  };
}

export function buildTodayRecommendationAudit(todayEntries = [], context = {}) {
  const clusterOccurrences = new Map();
  const items = safeArray(todayEntries).map(entry => {
    const candidate = entry.candidateMeta || entry;
    const item = buildAuditItem(candidate, context);
    const qualityCategory = getDailyQualityCategory(candidate);
    const semanticClusterKey = getDailySemanticCluster(candidate);
    const occurrence = (clusterOccurrences.get(semanticClusterKey) || 0) + 1;
    clusterOccurrences.set(semanticClusterKey, occurrence);
    const isDuplicateCluster = !semanticClusterKey.startsWith('word:') && occurrence > getDailyClusterLimit(semanticClusterKey);
    const pureCategoryWord = qualityCategory === 'beauty_product';
    const basicOrGeneric = ['basic_greeting', 'textbook_polite', 'generic_basic'].includes(qualityCategory);
    const sLevelEligible = !basicOrGeneric
      && !pureCategoryWord
      && !isDuplicateCluster
      && hasStrongXhsExpressionValue(candidate);
    return {
      ...item,
      recommendationLevel: item.recommendationLevel === 'S' && !sLevelEligible ? 'A' : item.recommendationLevel,
      semanticClusterKey,
      qualityCategory,
      isDuplicateCluster,
      sLevelEligible,
      diagnosis: [
        ...item.diagnosis,
        basicOrGeneric ? '基础或教材属性较强，默认不进入 S 级' : '',
        pureCategoryWord ? '单纯品类词默认不进入 S 级' : '',
        isDuplicateCluster ? '同日语义簇重复，作为次要词最多 A 级' : ''
      ].filter(Boolean)
    };
  });
  const sourceSummary = Object.keys(RECOMMENDATION_ORIGIN_LABELS).reduce((result, key) => ({ ...result, [key]: 0 }), {});
  items.forEach(item => {
    sourceSummary[item.originType] = (sourceSummary[item.originType] || 0) + 1;
    if (item.fromDeepSeekNew) sourceSummary.deepseek_new += item.originType === 'deepseek_new' ? 0 : 1;
    if (item.fromCodex) sourceSummary.codex_generated += item.originType === 'codex_generated' ? 0 : 1;
    if (item.fromCandidatePool) sourceSummary.candidate_pool += item.originType === 'candidate_pool' ? 0 : 1;
    if (item.fromLocalFallback) sourceSummary.local_word_bank += item.originType === 'local_word_bank' ? 0 : 1;
    if (item.isBackfill) sourceSummary.today_backfill += item.originType === 'today_backfill' ? 0 : 1;
    if (item.isDedupRelaxed) sourceSummary.dedup_relaxed += item.originType === 'dedup_relaxed' ? 0 : 1;
  });
  const qualitySummary = {
    averageFinalScore: average(items.map(item => item.finalScore)),
    averageExpressionValueScore: average(items.map(item => item.expressionValueScore)),
    averageChineseTransparencyScore: average(items.map(item => item.chineseTransparencyScore)),
    genericTopicCount: items.filter(item => item.genericTopicPenalty > 0).length,
    highTransparencyCount: items.filter(item => item.chineseTransparencyScore >= 80).length,
    sLevelCount: items.filter(item => item.recommendationLevel === 'S').length,
    aLevelCount: items.filter(item => item.recommendationLevel === 'A').length,
    bLevelCount: items.filter(item => item.recommendationLevel === 'B').length,
    cLevelCount: items.filter(item => item.recommendationLevel === 'C').length,
    ...buildDailyQualitySummary(todayEntries, {
      relaxed: Boolean(context.relaxedDedup),
      relaxedReasons: context.relaxedDedup ? ['dedup_relaxed'] : []
    })
  };
  qualitySummary.sLevelCount = items.filter(item => item.recommendationLevel === 'S').length;
  qualitySummary.aLevelCount = items.filter(item => item.recommendationLevel === 'A').length;
  qualitySummary.bLevelCount = items.filter(item => item.recommendationLevel === 'B').length;
  qualitySummary.cLevelCount = items.filter(item => item.recommendationLevel === 'C').length;
  if (qualitySummary.sLevelCount > MAX_DAILY_S_LEVEL_COUNT) {
    qualitySummary.estimatedHumanQualityScore = Math.min(qualitySummary.estimatedHumanQualityScore, 88);
    qualitySummary.healthWarnings = [...safeArray(qualitySummary.healthWarnings), '推荐等级过松，需要收紧 S/A 评分标准。'];
  }
  const total = items.length || 1;
  const diagnosis = [];
  const rawLatestBatchItems = safeArray(context.latestBatchItems);
  const rawGenericCount = rawLatestBatchItems.filter(item => isGenericTopicWord(item)).length;
  if ((sourceSummary.deepseek_new / total) >= 0.5 && qualitySummary.genericTopicCount >= 5) {
    diagnosis.push('问题主要来自 DeepSeek 找词方向，需要优化生成 prompt。');
  }
  if (rawLatestBatchItems.length && rawGenericCount <= 3 && qualitySummary.genericTopicCount >= 5) {
    diagnosis.push('问题主要来自筛选 / 排序 / 补位策略。');
  }
  if ((sourceSummary.today_backfill / total) > 0.3) {
    diagnosis.push(`今日推荐候选不足，补位比例过高，建议不要硬凑满 ${WORDS_PER_DAY} 个。`);
  }
  if ((sourceSummary.local_word_bank / total) > 0.2) {
    diagnosis.push('本地词库兜底过多，说明候选池有效词不足或去重规则过滤太多。');
  }
  if ((sourceSummary.dedup_relaxed / total) > 0.2) {
    diagnosis.push('30 天去重后候选不足，需要扩大候选池，而不是频繁放宽去重。');
  }
  if (qualitySummary.sLevelCount > MAX_DAILY_S_LEVEL_COUNT) {
    diagnosis.push('推荐等级过松，需要收紧 S/A 评分标准。');
  }
  if (qualitySummary.highTransparencyCount > 6) {
    diagnosis.push('首页中文一眼懂的词偏多，会影响点击率，需要提高表达价值筛选。');
  }
  if (!diagnosis.length) diagnosis.push('未发现单一明显来源，建议结合逐词审计继续观察。');
  return {
    date: context.date || '',
    total: items.length,
    sourceSummary,
    qualitySummary,
    noveltySummary: cleanNoveltySummary(context.noveltySummary || {}),
    diagnosis,
    items,
    createdAt: context.generatedAt || new Date().toISOString()
  };
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v3';
}

function cleanTraceText(value, maxLength = 8000) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value, maxLength);
  try {
    return cleanText(JSON.stringify(value), maxLength);
  } catch (error) {
    return '';
  }
}

function cleanEnum(value, options, fallback = '') {
  const cleanValue = cleanText(value, 80);
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueWords(words) {
  return [...new Set(safeArray(words).map(item => cleanText(item, 80)).filter(Boolean))];
}

function cleanWords(words) {
  return uniqueWords(words).slice(0, 500);
}

function dateDiffDays(dateKeyValue, todayDateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKeyValue || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayDateKey || ''))) return Infinity;
  const date = new Date(`${dateKeyValue}T00:00:00Z`).getTime();
  const today = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  return Math.round((today - date) / 86400000);
}

export function getRecentDailyHotBlockedWords(workflowInput = {}, days = TODAY_HISTORY_DEDUP_DAYS, options = {}) {
  const rawWorkflow = workflowInput || {};
  const workflow = cleanStoredWorkflow(workflowInput);
  const today = options.today || dateKey(options.now || new Date());
  const blocked = new Set();
  const addSnapshot = snapshot => {
    const cleanSnapshot = cleanHistorySnapshot(snapshot, snapshot?.dateKey);
    const diff = dateDiffDays(cleanSnapshot.dateKey, today);
    if (diff < 0) return;
    if (diff === 0 && !options.includeToday) return;
    if (days > 0 && diff > days) return;
    cleanSnapshot.words.forEach(word => blocked.add(word));
  };
  Object.values(cleanHistorySnapshots(workflow.historySnapshots)).forEach(addSnapshot);
  safeArray(workflow.todaySnapshotHistory).forEach(addSnapshot);
  Object.entries(rawWorkflow.rankingHistoryWords || {}).forEach(([dateKeyValue, words]) => {
    addSnapshot({ dateKey: dateKeyValue, words });
  });
  const currentSnapshot = cleanTodaySnapshot(workflow.todaySnapshot);
  if (currentSnapshot.dateKey === today && options.includeToday) currentSnapshot.words.forEach(word => blocked.add(word));
  return blocked;
}

function cleanStatuses(statuses, words) {
  const allowedWords = new Set(cleanWords(words));
  return Object.entries(statuses || {}).reduce((result, [word, status]) => {
    const cleanWord = cleanText(word, 80);
    if (allowedWords.has(cleanWord) && ['pending', 'published'].includes(status)) result[cleanWord] = status;
    return result;
  }, {});
}

function cleanFeedback(feedback) {
  return Object.entries(feedback || {}).reduce((result, [word, record]) => {
    const cleanWord = cleanText(word, 80);
    if (!cleanWord) return result;
    const reasons = Object.entries(record?.reasons || {}).reduce((nextReasons, [reason, count]) => {
      const cleanCount = clamp(toInt(count, 0), 0, 50);
      if (cleanCount > 0) nextReasons[reason] = cleanCount;
      return nextReasons;
    }, {});
    result[cleanWord] = {
      reasons,
      lastReason: cleanText(record?.lastReason, 80),
      updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
      needsReview: Boolean(record?.needsReview || reasons.inaccurate)
    };
    return result;
  }, {});
}

function cleanPublishedRecords(records) {
  return safeArray(records).slice(0, 1000).map((record, index) => ({
    ...record,
    id: cleanText(record?.id || `record_${index}`, 120),
    word: cleanText(record?.word, 80)
  })).filter(record => record.word || record.link || record.title);
}

function cleanCandidateEntry(kanji, entry = {}) {
  const rawKanji = cleanText(kanji || entry.kanji, 80);
  const cleanKanji = normalizeKanjiSpelling(rawKanji);
  const knownWord = KNOWN_WORDS.get(cleanKanji) || KNOWN_WORDS.get(rawKanji);
  let sourceType = String(entry.sourceType || '').trim();
  if (sourceType === 'deepseek_api') sourceType = 'deepseek_generated';
  else if (sourceType === 'manual') sourceType = 'manual_keep';
  else if (sourceType === 'original' || sourceType === 'audit_missing') sourceType = 'deepseek_reviewed';
  else if (!['codex_generated', 'deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(sourceType)) sourceType = knownWord ? 'deepseek_reviewed' : '';
  const hasAiLexicalFields = Boolean(entry.kana || entry.romaji || entry.meaning || ['codex_generated', 'deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(sourceType));
  if (!cleanKanji || (PURE_KANJI_RE.test(cleanKanji) && !knownWord && !hasAiLexicalFields)) return null;
  const riskLevel = cleanEnum(entry.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  let displayBucket = cleanEnum(entry.displayBucket, DISPLAY_BUCKET_OPTIONS, sourceType === 'deepseek_generated' ? 'long_term' : 'today');
  const expressionValueScore = getExpressionValueScore({ ...entry, kanji: cleanKanji, category: entry.category || knownWord?.category });
  if (isGenericTopicWord({ ...entry, kanji: cleanKanji }) && displayBucket === 'today') displayBucket = 'long_term';
  if (expressionValueScore < 55 && displayBucket === 'today') displayBucket = 'long_term';
  const emotionTone = cleanEnum(entry.emotionTone, EMOTION_TONE_OPTIONS, inferEmotionTone({
    ...entry,
    kanji: cleanKanji,
    category: entry.category || knownWord?.category
  }));
  return {
    ...entry,
    kanji: cleanKanji,
    romaji: cleanText(entry.romaji, 120),
    kana: cleanText(entry.kana || entry.reading || knownWord?.reading, 120),
    meaning: cleanText(entry.meaning || knownWord?.meaning, 240),
    category: cleanText(entry.category || knownWord?.category, 80),
    xhsFitScore: clamp(toInt(entry.xhsFitScore ?? entry.lastScore ?? knownWord?.popularity, 60), 0, 100),
    riskLevel,
    confidenceLevel: cleanEnum(entry.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, knownWord ? 'medium' : 'low'),
    evidenceType: cleanEnum(entry.evidenceType, EVIDENCE_TYPE_OPTIONS, sourceType === 'deepseek_generated' ? 'unknown' : 'common_usage'),
    sourceType,
    reviewSource: cleanText(entry.reviewSource, 120) || (sourceType === 'deepseek_reviewed' ? 'deepseek_library_audit' : ''),
    libraryReviewStatus: cleanEnum(entry.libraryReviewStatus || entry.libraryAuditAction, ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'], '') || (sourceType === 'deepseek_reviewed' ? 'approved' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditStatus: cleanEnum(entry.libraryAuditStatus, ['reviewed', 'missing', 'removed', 'protected', 'not_legacy'], '') || (sourceType === 'deepseek_reviewed' ? 'reviewed' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditAction: cleanEnum(entry.libraryAuditAction || entry.libraryReviewStatus, ['approve', 'keep', 'watch', 'review', 'delete', 'protect'], '') || (sourceType === 'deepseek_reviewed' ? 'approve' : sourceType === 'manual_keep' ? 'protect' : ''),
    libraryAuditReason: cleanText(entry.libraryAuditReason || entry.reviewReason, 800),
    libraryAuditReviewedAt: typeof entry.libraryAuditReviewedAt === 'string' ? entry.libraryAuditReviewedAt : '',
    protected: Boolean(entry.protected || sourceType === 'manual_keep'),
    displayBucket,
    emotionTone,
    lastReviewState: displayBucket === 'review' || displayBucket === 'blocked'
      ? 'review'
      : cleanEnum(entry.lastReviewState, ['ready', 'watch', 'review'], 'watch'),
    ignoredCount: clamp(toInt(entry.ignoredCount, 0), 0, 9999),
    recommendationCount: clamp(toInt(entry.recommendationCount, 0), 0, 9999),
    expressionValueScore,
    accountLearningTone: cleanText(entry.accountLearningTone || getAccountLearningTone({ ...entry, kanji: cleanKanji, category: entry.category || knownWord?.category }), 80),
    accountLearningBonus: clamp(toInt(entry.accountLearningBonus, getAccountLearningBonus({ ...entry, kanji: cleanKanji, category: entry.category || knownWord?.category })), -30, 30),
    aiBatchId: cleanText(entry.aiBatchId, 120),
    sourcePromptVersion: cleanText(entry.sourcePromptVersion || (entry.sourcePromptType ? getPromptVersion(entry.sourcePromptType) : ''), 80),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null
  };
}

function cleanCandidatePool(pool) {
  return Object.entries(pool || {}).reduce((result, [kanji, entry]) => {
    const cleanEntry = cleanCandidateEntry(kanji, entry);
    if (cleanEntry) result[cleanEntry.kanji] = cleanEntry;
    return result;
  }, {});
}

export function cleanTodaySnapshot(snapshot = {}) {
  const snapshotDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot?.dateKey || '')) ? String(snapshot.dateKey) : '';
  const words = cleanWords(snapshot?.words).slice(0, LEGACY_DAILY_WORD_LIMIT);
  return {
    dateKey: snapshotDateKey,
    words,
    generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : '',
    source: cleanText(snapshot?.source || 'candidatePool', 80) || 'candidatePool',
    batchIds: uniqueWords(snapshot?.batchIds).slice(0, 30),
    version: clamp(toInt(snapshot?.version, words.length ? TODAY_SNAPSHOT_VERSION : 0), 0, 999),
    generatorVersion: cleanText(snapshot?.generatorVersion, 80),
    createdBy: ['server', 'frontend', 'worker', 'manual', 'codex'].includes(snapshot?.createdBy) ? snapshot.createdBy : '',
    dedupDaysUsed: clamp(toInt(snapshot?.dedupDaysUsed, 0), 0, 365),
    relaxedDedup: Boolean(snapshot?.relaxedDedup),
    shortage: Boolean(snapshot?.shortage),
    repeated30Count: clamp(toInt(snapshot?.repeated30Count, 0), 0, LEGACY_DAILY_WORD_LIMIT),
    repeated30Words: uniqueWords(snapshot?.repeated30Words).slice(0, LEGACY_DAILY_WORD_LIMIT),
    recommendationAudit: snapshot?.recommendationAudit || {}
  };
}

export function isCurrentGeneratorSnapshot(snapshot = {}, now = new Date()) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  return cleanSnapshot.dateKey === dateKey(now)
    && cleanSnapshot.words.length > 0
    && isCompatibleTodaySnapshotGeneratorVersion(cleanSnapshot.generatorVersion);
}

export function cleanHistorySnapshot(snapshot = {}, fallbackDateKey = '') {
  const record = snapshot || {};
  const snapshotDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(record?.dateKey || '')) ? String(record.dateKey) : (/^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDateKey || '')) ? String(fallbackDateKey) : '');
  const words = cleanWords(record?.words).slice(0, LEGACY_DAILY_WORD_LIMIT);
  return {
    dateKey: snapshotDateKey,
    words,
    generatedAt: typeof record?.generatedAt === 'string' ? record.generatedAt : '',
    source: 'todaySnapshot',
    batchIds: uniqueWords(record?.batchIds).slice(0, 30),
    version: clamp(toInt(record?.version, words.length ? TODAY_SNAPSHOT_VERSION : 1), 1, 999),
    generatorVersion: cleanText(record?.generatorVersion, 80),
    createdBy: ['server', 'frontend', 'worker', 'manual', 'codex'].includes(record?.createdBy) ? record.createdBy : '',
    dedupDaysUsed: clamp(toInt(record?.dedupDaysUsed, 0), 0, 365),
    relaxedDedup: Boolean(record?.relaxedDedup),
    shortage: Boolean(record?.shortage),
    repeated30Count: clamp(toInt(record?.repeated30Count, 0), 0, LEGACY_DAILY_WORD_LIMIT),
    repeated30Words: uniqueWords(record?.repeated30Words).slice(0, LEGACY_DAILY_WORD_LIMIT),
    archivedAt: typeof record?.archivedAt === 'string' ? record.archivedAt : '',
    title: cleanText(record?.title || '今日 AI 候选归档', 120),
    recommendationAudit: record?.recommendationAudit || {}
  };
}

export function cleanHistorySnapshots(snapshots = {}) {
  return Object.entries(snapshots || {}).reduce((result, [dateKeyValue, snapshot]) => {
    const cleanSnapshot = cleanHistorySnapshot(snapshot, dateKeyValue);
    if (cleanSnapshot.dateKey && cleanSnapshot.words.length) result[cleanSnapshot.dateKey] = cleanSnapshot;
    return result;
  }, {});
}

export function archiveTodaySnapshotIntoHistory(historySnapshots = {}, snapshot = {}) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return cleanHistorySnapshots(historySnapshots);
  return cleanHistorySnapshots({
    ...historySnapshots,
    [cleanSnapshot.dateKey]: {
      dateKey: cleanSnapshot.dateKey,
      words: cleanSnapshot.words,
      generatedAt: cleanSnapshot.generatedAt,
      source: 'todaySnapshot',
      batchIds: cleanSnapshot.batchIds,
      version: cleanSnapshot.version || TODAY_SNAPSHOT_VERSION,
      generatorVersion: cleanSnapshot.generatorVersion,
      createdBy: cleanSnapshot.createdBy,
      dedupDaysUsed: cleanSnapshot.dedupDaysUsed,
      relaxedDedup: cleanSnapshot.relaxedDedup,
      shortage: cleanSnapshot.shortage,
      repeated30Count: cleanSnapshot.repeated30Count,
      repeated30Words: cleanSnapshot.repeated30Words,
      recommendationAudit: cleanSnapshot.recommendationAudit,
      archivedAt: new Date().toISOString(),
      title: '今日 AI 候选归档'
    }
  });
}

export function cleanStoredWorkflow(data = {}) {
  return cleanWorkflowSchema(data);
}

function getFavoriteBlockedWords(workflow) {
  const blocked = new Set(cleanWords(workflow.words));
  Object.entries(workflow.statuses || {}).forEach(([word, status]) => {
    if (['pending', 'published'].includes(status)) blocked.add(word);
  });
  cleanPublishedRecords(workflow.publishedRecords).forEach(record => {
    if (record.word) blocked.add(record.word);
  });
  return blocked;
}

function getFeedbackPenalty(kanji, feedback = {}) {
  const record = feedback[kanji];
  if (!record) return 0;
  return Object.entries(record.reasons || {}).reduce((sum, [reason, count]) => {
    const weight = {
      tooRisky: 16,
      inaccurate: 16,
      tooNiche: 10,
      notFresh: 8,
      tooMeme: 8,
      badVisual: 10,
      badTitle: 8,
      notMyTone: 12,
      uninterested: 7
    }[reason] || 6;
    return sum + weight * clamp(toInt(count, 0), 0, 10);
  }, record.needsReview ? 12 : 0);
}

function isSeasonalCandidateActive(entry = {}, date = new Date()) {
  const text = `${entry.kanji || ''} ${entry.freshness || ''} ${entry.category || ''} ${entry.reason || ''}`;
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: APP_TIME_ZONE, month: 'numeric' }).format(date));
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: APP_TIME_ZONE, day: 'numeric' }).format(date));
  const monthDay = month * 100 + day;
  if (/バレンタイン/.test(text)) return monthDay >= 120 && monthDay <= 214;
  if (/ホワイトデー/.test(text)) return monthDay >= 215 && monthDay <= 314;
  if (/クリスマス/.test(text)) return monthDay >= 1201 && monthDay <= 1225;
  if (/お盆/.test(text)) return monthDay >= 801 && monthDay <= 816;
  if (/桜|花見/.test(text)) return monthDay >= 301 && monthDay <= 430;
  if (/ハロウィン/.test(text)) return monthDay >= 1001 && monthDay <= 1031;
  return entry.displayBucket !== 'seasonal' || entry.freshness === '短期';
}

function hasDisplayWord(entry) {
  return Boolean(KNOWN_WORDS.has(entry.kanji) || entry.meaning || entry.kana || entry.romaji);
}

function isLegacyEntry(entry = {}) {
  return KNOWN_WORDS.has(entry.kanji) || ['audit_missing', 'deepseek_reviewed', 'manual_keep', 'original'].includes(entry.sourceType);
}

function isLibraryAuditRemoved(entry = {}) {
  return ['delete', 'deleted', 'archived'].includes(entry.libraryReviewStatus) || entry.libraryAuditStatus === 'removed' || entry.displayBucket === 'blocked' || Boolean(entry.removedAt);
}

function hasDeepSeekLibraryAudit(entry = {}) {
  return entry.sourceType === 'deepseek_generated'
    || entry.sourceType === 'deepseek_reviewed'
    || entry.sourceType === 'manual_keep'
    || entry.reviewSource === 'deepseek_library_audit'
    || Boolean(entry.libraryReviewStatus && entry.libraryReviewStatus !== 'missing');
}

function isMissingLibraryAudit(entry = {}) {
  return isLegacyEntry(entry) && !isLibraryAuditRemoved(entry) && !hasDeepSeekLibraryAudit(entry);
}

function isEligible(entry, workflow, excludedWords = new Set(), date = new Date(), recentBlockedWords = new Set()) {
  if (!entry || excludedWords.has(entry.kanji)) return false;
  if (recentBlockedWords.has(entry.kanji)) return false;
  if (getFavoriteBlockedWords(workflow).has(entry.kanji)) return false;
  if (isLibraryAuditRemoved(entry) || isMissingLibraryAudit(entry)) return false;
  if (!['deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(entry.sourceType)) return false;
  if (entry.sourceType === 'deepseek_reviewed' && ['delete', 'deleted', 'archived'].includes(entry.libraryReviewStatus)) return false;
  if (['review', 'blocked'].includes(entry.displayBucket)) return false;
  if (entry.riskLevel === 'high') return false;
  if (entry.confidenceLevel === 'review') return false;
  if (entry.evidenceType === 'unknown') return false;
  if (entry.lastReviewState === 'review') return false;
  if (isChineseReadableLowValueTodayWord(entry)) return false;
  if (isGenericTopicWord(entry)) return false;
  if (getExpressionValueScore(entry) < 55) return false;
  if (entry.displayBucket === 'seasonal' && !isSeasonalCandidateActive(entry, date)) return false;
  return hasDisplayWord(entry);
}

function getBucketWeight(bucket) {
  return {
    today: 16,
    meme_fast: 10,
    long_term: 4,
    seasonal: 2
  }[bucket] || 0;
}

function getTone(entry = {}) {
  return cleanEnum(entry.emotionTone, EMOTION_TONE_OPTIONS, inferEmotionTone(entry));
}

function inferEmotionTone(entry = {}) {
  const text = `${entry.kanji || ''} ${entry.meaning || ''} ${entry.category || ''} ${entry.candidateType || ''}`;
  if (AESTHETIC_WORD_RE.test(text) || /审美|美妆|穿搭|ファッション|自然|文化/.test(text)) return 'aesthetic';
  if (LIFESTYLE_WORD_RE.test(text) || /生活|旅行|食|日常|学習/.test(text)) return 'lifestyle';
  if (FANDOM_WORD_RE.test(text) || /追星|圈层|若者語/.test(text)) return 'fandom';
  if (NEGATIVE_WORD_RE.test(text)) return 'negative';
  return 'neutral';
}

function getSemanticGroup(entry = {}) {
  return [
    getAccountLearningTone(entry),
    entry.candidateType || entry.category || 'general',
    entry.category || ''
  ].filter(Boolean).join(':');
}

function isLaughWord(entry = {}) {
  const text = `${entry.kanji || ''} ${entry.meaning || ''}`;
  return /草|ワロタ|ウケる|笑|爆笑|笑える/.test(text);
}

function scoreCandidate(entry, workflow, qualityContext = {}) {
  const feedbackPenalty = Math.min(getFeedbackPenalty(entry.kanji, workflow.feedback), 28);
  const baseScore = toInt(entry.xhsFitScore || entry.lastScore, 60);
  const isAiCandidate = ['codex_generated', 'deepseek_generated'].includes(entry.sourceType);
  const sourceBonus = isAiCandidate ? 14 : -18;
  const lowValuePenalty = LOW_VALUE_HOME_WORDS.has(entry.kanji) ? 42 : 0;
  const genericTopicPenalty = isGenericTopicWord(entry) ? 18 : 0;
  const accountLearningBonus = getAccountLearningBonus(entry);
  const expressionValueScore = getExpressionValueScore(entry);
  const expressionBonus = Math.round((expressionValueScore - 70) / 3);
  const dailyQualityDelta = getDailyQualityScoreDelta(entry, qualityContext);
  const tone = getTone(entry);
  const toneBonus = {
    aesthetic: 2,
    lifestyle: 8,
    fandom: 6,
    positive: 5,
    neutral: 0,
    negative: -12
  }[tone] || 0;
  const rawScore = clamp(
    baseScore
      + getBucketWeight(entry.displayBucket)
      + sourceBonus
      + toneBonus
      + accountLearningBonus
      + expressionBonus
      + dailyQualityDelta
      - Math.min(entry.ignoredCount * 3, 18)
      - Math.min(entry.recommendationCount * 2, 10)
      - feedbackPenalty
      - lowValuePenalty
      - genericTopicPenalty,
    0,
    96
  );
  if (tone === 'negative') return Math.min(rawScore, 82);
  if (!isAiCandidate && LOW_VALUE_HOME_WORDS.has(entry.kanji)) return Math.min(rawScore, 70);
  return rawScore;
}

function selectBalancedCandidates(candidates) {
  const selected = [];
  const selectedWords = new Set();
  const toneCounts = {};
  const learningToneCounts = {};
  const groupCounts = {};
  const dailyCategoryCounts = {};
  const dailyClusterCounts = {};
  let laughCount = 0;
  const addWord = (entry, options = {}) => {
    if (!entry?.kanji || selectedWords.has(entry.kanji) || selected.length >= WORDS_PER_DAY) return false;
    const tone = getTone(entry);
    const learningTone = getAccountLearningTone(entry);
    const group = getSemanticGroup(entry);
    const dailyCategory = getDailyQualityCategory(entry);
    const dailyCluster = getDailySemanticCluster(entry);
    const basicTextbookCount = (dailyCategoryCounts.basic_greeting || 0) + (dailyCategoryCounts.textbook_polite || 0);
    if (tone === 'negative' && (toneCounts.negative || 0) >= 2) return false;
    if (isLaughWord(entry) && laughCount >= 2) return false;
    if (!options.relaxed) {
      if (['basic_greeting', 'textbook_polite'].includes(dailyCategory) && basicTextbookCount >= DAILY_QUALITY_MAXIMA.basicTextbook) return false;
      if (dailyCategory === 'beauty_product' && (dailyCategoryCounts.beauty_product || 0) >= DAILY_QUALITY_MAXIMA.beauty_product) return false;
      if (dailyCategory === 'cute_slang' && (dailyCategoryCounts.cute_slang || 0) >= DAILY_QUALITY_MAXIMA.cute_slang) return false;
      if (dailyCategory === 'fandom_circle' && (dailyCategoryCounts.fandom_circle || 0) >= DAILY_QUALITY_MAXIMA.fandom_circle) return false;
      if ((dailyClusterCounts[dailyCluster] || 0) >= getDailyClusterLimit(dailyCluster)) return false;
      if (learningTone === 'aesthetic' && (learningToneCounts.aesthetic || 0) >= 3) return false;
      if (learningTone === 'seasonal_culture' && (learningToneCounts.seasonal_culture || 0) >= 3) return false;
      if (learningTone === 'fandom' && dailyCategory === 'fandom_circle' && (learningToneCounts.fandom || 0) >= DAILY_QUALITY_MAXIMA.fandom_circle) return false;
      const groupLimit = learningTone === 'emotion_social' ? 5 : learningTone === 'lifestyle' ? 4 : 2;
      if ((groupCounts[group] || 0) >= groupLimit) return false;
    }
    selected.push(entry);
    selectedWords.add(entry.kanji);
    toneCounts[tone] = (toneCounts[tone] || 0) + 1;
    learningToneCounts[learningTone] = (learningToneCounts[learningTone] || 0) + 1;
    groupCounts[group] = (groupCounts[group] || 0) + 1;
    dailyCategoryCounts[dailyCategory] = (dailyCategoryCounts[dailyCategory] || 0) + 1;
    dailyClusterCounts[dailyCluster] = (dailyClusterCounts[dailyCluster] || 0) + 1;
    if (isLaughWord(entry)) laughCount += 1;
    return true;
  };
  const addMinimum = (predicate, minimum) => {
    candidates.filter(predicate).forEach(entry => {
      if (selected.length >= WORDS_PER_DAY) return;
      if (selected.filter(predicate).length < minimum) addWord(entry);
    });
  };
  addMinimum(entry => getDailyQualityCategory(entry) === 'emotion_state', DAILY_QUALITY_MINIMA.emotion_state);
  addMinimum(entry => getDailyQualityCategory(entry) === 'social_nuance', DAILY_QUALITY_MINIMA.social_nuance);
  addMinimum(entry => getDailyQualityCategory(entry) === 'life_state', DAILY_QUALITY_MINIMA.life_state);
  candidates.forEach(addWord);
  if (selected.length < WORDS_PER_DAY) candidates.forEach(entry => addWord(entry, { relaxed: true }));
  return selected.slice(0, WORDS_PER_DAY);
}

function buildCandidatesForDedupDays(poolEntries, workflow, excluded, now, dedupDays, workflowForHistory = workflow) {
  const recentBlockedWords = dedupDays > 0
    ? getRecentDailyHotBlockedWords(workflowForHistory, dedupDays, { now, today: dateKey(now), includeToday: false })
    : new Set();
  const historicalBackfillWords = dedupDays === 0
    ? getRecentDailyHotBlockedWords(workflowForHistory, TODAY_HISTORY_DEDUP_DAYS, { now, today: dateKey(now), includeToday: false })
    : new Set();
  const qualityContext = buildDailyQualityContext(workflowForHistory, { today: dateKey(now) });
  return poolEntries
    .filter(entry => isEligible(entry, workflow, excluded, now, recentBlockedWords))
    .map(entry => ({
      ...entry,
      historicalBackfill: dedupDays === 0 && historicalBackfillWords.has(entry.kanji),
      expressionValueScore: getExpressionValueScore(entry),
      accountLearningTone: getAccountLearningTone(entry),
      accountLearningBonus: getAccountLearningBonus(entry),
      dailyQualityCategory: getDailyQualityCategory(entry),
      dailySemanticCluster: getDailySemanticCluster(entry),
      dailyQualityScoreDelta: getDailyQualityScoreDelta(entry, qualityContext),
      finalScore: scoreCandidate(entry, workflow, qualityContext)
    }))
    .sort((left, right) => {
      const scoreDiff = right.finalScore - left.finalScore;
      if (scoreDiff) return scoreDiff;
      const expressionDiff = right.expressionValueScore - left.expressionValueScore;
      if (expressionDiff) return expressionDiff;
      const bucketDiff = getBucketWeight(right.displayBucket) - getBucketWeight(left.displayBucket);
      if (bucketDiff) return bucketDiff;
      return String(left.kanji).localeCompare(String(right.kanji), 'ja');
    });
}

function getRepeatedWords(words = [], workflowForHistory = {}, now = new Date()) {
  const blocked = getRecentDailyHotBlockedWords(workflowForHistory, TODAY_HISTORY_DEDUP_DAYS, { now, today: dateKey(now), includeToday: false });
  return uniqueWords(words).filter(word => blocked.has(word));
}

export function generateTodaySnapshot(workflowInput = {}, options = {}) {
  const workflow = cleanStoredWorkflow(workflowInput);
  const workflowForHistory = {
    ...workflow,
    rankingHistoryWords: workflowInput?.rankingHistoryWords || {}
  };
  const mode = ['create', 'fill', 'regenerate'].includes(options.mode) ? options.mode : 'create';
  const now = options.now || new Date();
  const today = dateKey(now);
  const currentSnapshot = cleanTodaySnapshot(workflow.todaySnapshot);
  const previousWords = currentSnapshot.dateKey === today ? currentSnapshot.words : [];
  const existingWords = mode === 'fill' ? previousWords : [];
  const excluded = new Set(mode === 'fill' ? existingWords : previousWords);
  const poolEntries = Object.values(cleanCandidatePool(workflow.candidatePool));
  const freshBatchIds = getFreshBatchIds(workflow, today);
  const qualityContext = buildDailyQualityContext(workflowForHistory, { today });
  const latestBatchItems = safeArray(workflow.aiBatches)
    .filter(batch => freshBatchIds.has(batch.id))
    .flatMap(batch => safeArray(batch.items));
  const existingEntries = existingWords
    .map(kanji => cleanCandidateEntry(kanji, workflow.candidatePool[kanji] || { kanji }))
    .filter(entry => isEligible(entry, workflow, new Set(), now, new Set()))
    .map(entry => ({
      ...entry,
      dailyQualityCategory: getDailyQualityCategory(entry),
      dailySemanticCluster: getDailySemanticCluster(entry),
      dailyQualityScoreDelta: getDailyQualityScoreDelta(entry, qualityContext),
      finalScore: scoreCandidate(entry, workflow, qualityContext)
    }));

  let candidates = [];
  let selected = [];
  let dedupDaysUsed = TODAY_HISTORY_DEDUP_DAYS;
  let relaxedDedup = false;
  for (const dedupDays of TODAY_HISTORY_DEDUP_RELAX_STEPS) {
    candidates = buildCandidatesForDedupDays(poolEntries, workflow, excluded, now, dedupDays, workflowForHistory);
    selected = selectBalancedCandidates([...existingEntries, ...candidates]);
    dedupDaysUsed = dedupDays;
    relaxedDedup = dedupDays !== TODAY_HISTORY_DEDUP_DAYS;
    if (selected.length >= WORDS_PER_DAY || dedupDays === 0) break;
  }
  const sameDay = currentSnapshot.dateKey === today;
  const generatedAt = new Date().toISOString();
  const auditContext = {
    date: today,
    mode,
    generatedAt,
    dedupDaysUsed,
    relaxedDedup,
    freshBatchIds,
    existingWords: new Set(existingWords),
    latestBatchItems,
    noveltySummary: options.noveltySummary || {}
  };
  const auditedSelected = selected.map(entry => ({
    ...entry,
    recommendationAudit: getRecommendationAuditTrace(entry, auditContext)
  }));
  const selectedWords = auditedSelected.map(entry => entry.kanji);
  const selectedWordSet = new Set(selectedWords);
  const batchIds = uniqueWords(auditedSelected.map(entry => entry.aiBatchId).filter(Boolean)).slice(0, 30);
  const recommendationAudit = buildTodayRecommendationAudit(auditedSelected, auditContext);
  const nextCandidatePool = { ...(workflowInput.candidatePool || {}) };
  auditedSelected.forEach(entry => {
    const original = nextCandidatePool[entry.kanji] || workflow.candidatePool[entry.kanji] || {};
    nextCandidatePool[entry.kanji] = {
      ...original,
      lastScore: entry.finalScore,
      lastScoredAt: generatedAt,
      lastRecommendedAt: generatedAt,
      wasRecommended: true,
      historicalBackfill: Boolean(entry.historicalBackfill),
      recommendationCount: clamp(toInt(original.recommendationCount, 0) + (previousWords.includes(entry.kanji) ? 0 : 1), 0, 9999),
      lastOrigin: entry.displayBucket === 'meme_fast' ? 'today' : entry.displayBucket === 'seasonal' ? 'history' : 'pool',
      lastConfidenceLevel: entry.confidenceLevel,
      lastReviewState: entry.lastReviewState,
      expressionValueScore: entry.expressionValueScore,
      accountLearningTone: entry.accountLearningTone,
      accountLearningBonus: entry.accountLearningBonus,
      dailyQualityCategory: entry.dailyQualityCategory,
      dailySemanticCluster: entry.dailySemanticCluster,
      dailyQualityScoreDelta: entry.dailyQualityScoreDelta,
      recommendationAudit: entry.recommendationAudit,
      updatedAt: generatedAt
    };
  });
  const nextAiBatches = safeArray(workflow.aiBatches).map(batch => ({
    ...batch,
    items: safeArray(batch.items).map(item => ({
      ...item,
      selectedForToday: Boolean(item.selectedForToday || selectedWordSet.has(item.kanji)),
      rejectedReason: selectedWordSet.has(item.kanji) ? '' : item.rejectedReason
    }))
  }));
  const todaySnapshot = cleanTodaySnapshot({
    dateKey: today,
    words: selectedWords,
    generatedAt,
    source: 'candidatePool',
    batchIds,
    version: sameDay ? toInt(currentSnapshot.version, 0) + 1 : 1,
    generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
    createdBy: options.createdBy || 'server',
    dedupDaysUsed,
    relaxedDedup,
    shortage: selectedWords.length < WORDS_PER_DAY,
    repeated30Count: getRepeatedWords(selectedWords, workflowForHistory, now).length,
    repeated30Words: getRepeatedWords(selectedWords, workflowForHistory, now),
    recommendationAudit
  });
  return {
    workflow: cleanWorkflowSchema({
      ...workflowInput,
      words: workflow.words,
      statuses: workflow.statuses,
      feedback: workflow.feedback,
      publishedRecords: workflow.publishedRecords,
      candidatePool: nextCandidatePool,
      aiBatches: nextAiBatches,
      todaySnapshot,
      todaySnapshotHistory: archiveTodaySnapshotIntoSnapshotHistory(workflow.todaySnapshotHistory, todaySnapshot),
      historySnapshots: archiveTodaySnapshotIntoHistory(workflow.historySnapshots, todaySnapshot),
      updated: generatedAt
    }),
    result: {
      mode,
      selectedCount: selectedWords.length,
      availableCount: candidates.length + existingEntries.length,
      dedupDaysUsed,
      relaxedDedup,
      shortage: selectedWords.length < WORDS_PER_DAY,
      todaySnapshot,
      recommendationAudit,
      words: auditedSelected.map(entry => ({
        kanji: entry.kanji,
        meaning: entry.meaning,
        displayBucket: entry.displayBucket,
        emotionTone: entry.emotionTone,
        expressionValueScore: entry.expressionValueScore,
        accountLearningTone: entry.accountLearningTone,
        accountLearningBonus: entry.accountLearningBonus,
        dailyQualityCategory: entry.dailyQualityCategory,
        dailySemanticCluster: entry.dailySemanticCluster,
        dailyQualityScoreDelta: entry.dailyQualityScoreDelta,
        finalScore: entry.finalScore,
        historicalBackfill: Boolean(entry.historicalBackfill),
        recommendationAudit: entry.recommendationAudit
      }))
    }
  };
}

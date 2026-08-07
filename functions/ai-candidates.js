import { getAccountLearningPromptContext } from '../shared/account-learning.mjs';
import {
  API_LIMITS,
  authorizeRequest,
  enforceRateLimit,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  readJsonBody,
  unauthorizedResponse
} from '../shared/api-security.mjs';

const ACTIONS = ['stable_today', 'wild_ideas', 'generate_candidates', 'extract_from_materials', 'enrich_words', 'generate_word_card', 'rerank_candidates', 'audit_library_for_delete', 'audit_missing_library_words'];
const CANDIDATE_TYPES = ['稳定候选', '新鲜梗词', '审美氛围词', '美妆穿搭词', '追星兴趣词', '生活方式词', '网络口语词', '圈层词', '高风险话题词'];
const FRESHNESS = ['长期', '中期', '短期', '需要尽快判断'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const SUGGESTED_ACTIONS = ['优先收藏观察', '可以收藏观察', '尽快判断', '暂缓', '不建议'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'review'];
const EVIDENCE_TYPES = ['common_usage', 'ai_inferred', 'user_material', 'trend_claim', 'unknown'];
const DISPLAY_BUCKETS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked'];
const EMOTION_TONES = ['positive', 'neutral', 'negative', 'aesthetic', 'lifestyle', 'fandom'];
const REVIEW_REASON_TYPES = ['uncertain_usage', 'too_niche', 'possible_wrong_meaning', 'ip_brand_role', 'privacy_sensitive', 'offensive', 'too_basic'];
const LIBRARY_AUDIT_ACTIONS = ['approve', 'keep', 'watch', 'review', 'delete', 'protect'];
const LIBRARY_AUDIT_BUCKETS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked', 'deleted'];
const MAX_SINGLE_DEEPSEEK_COUNT = 10;
const BATCH_DEEPSEEK_COUNT = 10;
const PROMPT_VERSION_BY_ACTION = {
  stable_today: 'candidate-v4-content-mix',
  wild_ideas: 'candidate-v4-content-mix',
  generate_candidates: 'candidate-v4-content-mix',
  extract_from_materials: 'candidate-v4-content-mix',
  enrich_words: 'card-v2',
  generate_word_card: 'card-v2',
  rerank_candidates: 'rerank-v1',
  audit_library_for_delete: 'library-audit-v2',
  audit_missing_library_words: 'library-audit-v2'
};
const BATCH_FOCUS_AREAS = [
  '情绪状态、人际关系、社交语感、中文不好直译的日语表达',
  '已证实常用的日常缩略语，说明完整形式；不确定缩写不要冒充常用语',
  '有时间证据的低风险流行表达；没有 trend_claim 证据就不要包装成流行词',
  '具体、可视化、能讲语感差异的美妆或穿搭表达；不要泛分类词',
  '生活状态或大众可理解圈层兴趣，作为结构补位但不要挤占账号主轴'
];
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
const ACCOUNT_LEARNING_EMOTION_SOCIAL_RE = /大正解|小確幸|自己肯定感|気まずい|モヤる|距離感|気を遣う|空気読む|しんどい|刺さる|だるい|わかりみ|塩対応|すれ違い|共感|情绪|情緒|人际|人際|社交|语感|語感|関係|关系|關係|気持ち|心情/;
const UNCERTAIN_PATTERN = /縮写|缩写|源于|新梗|自创|自創|合成词|合成詞|近期流行|网络传闻|網絡傳聞/i;
const ENTITY_REVIEW_PATTERN = /角色|IP|品牌|明星|隐私|隱私|窥私|窺私/i;
const PRIVACY_REVIEW_PATTERN = /偷拍|盗撮|隠し撮り|偶遇美女|偶遇|窥私|窺私|覗き|私生活|隐私|隱私/i;
const IP_BRAND_ROLE_PATTERN = /具体角色|特定角色|角色名|キャラ名|IP名|作品名|品牌名|ブランド名|商品名|明星名|芸能人名|明星|品牌|IP/i;
const TOO_NICHE_PATTERN = /二次元|虚拟形象|虛擬形象|VTuber|Vtuber|社群内部|社群內部|内轮|內輪|界隈|圈层|圈層|同人|オタサー|バ美|ぬるぬる|にわか/i;
const POSSIBLE_WRONG_MEANING_PATTERN = /解释可能不准|解释疑似错误|詞義可能|词义可能|意味違い|誤用|错误解释|錯誤解釋|疑似错误|疑似錯誤/i;
const TOO_BASIC_PATTERN = /太基础|太基礎|过于基础|過於基礎|单独成词|單獨成詞|内容价值低|內容價值低|普通词|普通詞/i;
const BLOCK_PATTERN = /しね|死ね|杀了|殺了|去死|死亡诅咒|死亡詛咒|辱骂|辱罵|歧视|歧視|攻击性|攻擊性/i;
const SEASONAL_PATTERN = /バレンタイン|ホワイトデー|お盆|クリスマス|正月|花見|桜|ハロウィン|七夕|節分|季節|节日|節日|季节/i;
const ORDINARY_CATEGORIES = ['日常', '生活方式词', '旅行', '食', '自然', '学習'];
const BLOCK_WORDS = {
  'デカ耳': '解释疑似错误，不应作为大耳狗词条导入',
  'しね': '攻击性/死亡诅咒表达，不建议导入'
};
const REVIEW_WORDS = {
  'バ美': '解释高度不确定，疑似错误缩写',
  '尊界': '疑似 AI 编词，需核验真实用法',
  'おふらんす': '用法小众，需核验',
  'バ美肉': '圈层较窄，需人工判断',
  'コスミ': '疑似自创/需核验',
  'ガチ恋': '追星边界风险',
  'キモい': '含义可能冒犯，不适合直接做首页候选',
  'マジ卍': '过气梗，不作为今日热门',
  '夢み': '单独用法不够稳定，需核验真实语境',
  'すき': '单独成词内容价值不稳定，需核验真实语境',
  'バ美声': '虚拟形象/社群内部用法，圈层较窄',
  'オタサー': '圈层较窄，需人工判断账号适配度',
  'ぬるぬる': '用法容易偏圈层或语境依赖，需人工判断',
  'にわか': '圈层评价色彩较强，需人工判断',
  '地雷系': '带有人群标签和刻板印象风险，需人工判断语境。',
  'おじさん構文': '带年龄刻板印象和冒犯风险，不建议默认进入首页。'
};
const REVIEW_REASON_OVERRIDES = {
  'バ美': 'uncertain_usage',
  '尊界': 'possible_wrong_meaning',
  'おふらんす': 'too_niche',
  'バ美肉': 'too_niche',
  'コスミ': 'uncertain_usage',
  'ガチ恋': 'privacy_sensitive',
  'キモい': 'offensive',
  'マジ卍': 'too_basic',
  'テン': 'uncertain_usage',
  '夢み': 'uncertain_usage',
  'すき': 'uncertain_usage',
  'バ美声': 'too_niche',
  'オタサー': 'too_niche',
  'ぬるぬる': 'too_niche',
  'にわか': 'too_niche',
  '地雷系': 'offensive',
  'おじさん構文': 'offensive'
};
const BUCKET_OVERRIDES = {
  '透け感': 'today',
  '抜け感': 'today',
  'こなれ': 'today',
  'ヌーディー': 'today',
  'ヌーディ': 'today',
  'モノトーン': 'today',
  'ベージュトーン': 'today',
  'しっとり': 'today',
  'ふんわり': 'today',
  'アンニュイ': 'today',
  'ツヤ感': 'today',
  'マット': 'today',
  '清潔感': 'today',
  'レイヤード': 'long_term',
  'グッズ': 'today',
  '聖地巡礼': 'today',
  '布教': 'today',
  '朝活': 'long_term',
  '朝焼け': 'today',
  '家計簿': 'today',
  '断捨離': 'today',
  '時短料理': 'today',
  '勉強法': 'today',
  'チルい': 'today',
  '沼': 'meme_fast',
  'おしゃれ': 'today',
  'パーソナルカラー': 'today',
  '草': 'meme_fast',
  'ウケる': 'meme_fast',
  '詰んだ': 'meme_fast',
  'ワロタ': 'meme_fast',
  'パない': 'meme_fast',
  '神': 'meme_fast',
  'ムカつく': 'meme_fast',
  'イライラ': 'meme_fast',
  'キレる': 'meme_fast',
  'グチる': 'meme_fast',
  'うざい': 'meme_fast',
  'めんどい': 'meme_fast',
  'イチャモン': 'meme_fast',
  'テンション': 'today',
  'モヤる': 'meme_fast',
  '即買い': 'meme_fast',
  'テン': 'review',
  '自担': 'meme_fast',
  '箱推し': 'meme_fast',
  '推し増し': 'meme_fast',
  '同担': 'meme_fast',
  '痛バ': 'meme_fast',
  'ビビる': 'long_term',
  'バレンタイン': 'seasonal',
  'ホワイトデー': 'seasonal',
  'クリスマス': 'seasonal',
  'お盆': 'seasonal',
  'マジ卍': 'review',
  '壁ドン': 'meme_fast',
  '陰キャ': 'meme_fast',
  '陽キャ': 'meme_fast',
  '爆イケ': 'meme_fast',
  'おつおつ': 'meme_fast',
  '推し変': 'meme_fast',
  'ドヤ顔': 'meme_fast',
  'カップル': 'long_term',
  'デート': 'long_term',
  'ペアリング': 'long_term',
  '読書感想文': 'long_term',
  'おうち時間': 'long_term',
  '円盤': 'long_term',
  'コスプレ': 'long_term',
  'ベージュ': 'long_term',
  'マスタード': 'long_term',
  'アシメトリー': 'long_term'
};
const BASIC_SCORE_CAPS = {
  '草': 82,
  'ワロタ': 82,
  'ウケる': 82,
  'カップル': 82,
  'デート': 82,
  'ビビる': 82,
  '神': 82
};
const OLD_MEME_SCORE_CAPS = { 'マジ卍': 65 };
const NICHE_SCORE_CAPS = {
  'オタサー': 78,
  'バ美声': 78,
  'ぬるぬる': 78,
  'にわか': 78
};
const UNCERTAIN_SCORE_CAPS = {
  '夢み': 70,
  'すき': 70
};
const NEGATIVE_SCORE_CAPS = {
  '詰んだ': 82,
  'ムカつく': 82,
  'イライラ': 82,
  'キレる': 82,
  'グチる': 82,
  'うざい': 78,
  'めんどい': 82,
  'イチャモン': 82,
  'テン': 70
};
const HIGH_RISK_SCORE_CAPS = { 'キモい': 60, 'ガチ恋': 60 };
const LONG_TERM_SCORE_CAPS = {
  'ペアリング': 82,
  '読書感想文': 82,
  'おうち時間': 82,
  '円盤': 82,
  'コスプレ': 82
};
const STRONG_AESTHETIC_WORDS = ['透け感', '抜け感', 'こなれ', 'ヌーディー', 'ヌーディ', 'ベージュトーン', 'しっとり', 'ふんわり', 'ツヤ感', '清潔感', 'アンニュイ', 'マット'];
const STRONG_FANDOM_WORDS = ['グッズ', '聖地巡礼', '痛バ', '箱推し', '自担', '同担', '推し増し', '布教'];
const STRONG_LIFESTYLE_WORDS = ['朝活', '朝焼け', '家計簿', '断捨離', '時短料理', '勉強法'];
const COSPLAY_REVIEW_PATTERN = /具体角色|特定角色|実在|IP|明星|擦边|擦邊|侵权|侵權|隐私|隱私|窥私|窺私/i;
const EMOTION_TONE_OVERRIDES = {
  'キレる': 'negative',
  'イライラ': 'negative',
  'グチる': 'negative',
  'うざい': 'negative',
  'めんどい': 'negative',
  'イチャモン': 'negative',
  '詰んだ': 'negative',
  'ムカつく': 'negative',
  'キモい': 'negative',
  '抜け感': 'aesthetic',
  '透け感': 'aesthetic',
  'こなれ': 'aesthetic',
  'しっとり': 'aesthetic',
  'ふんわり': 'aesthetic',
  'ツヤ感': 'aesthetic',
  '清潔感': 'aesthetic',
  'アンニュイ': 'aesthetic',
  'ヌーディ': 'aesthetic',
  'マット': 'aesthetic',
  'ベージュ': 'aesthetic',
  'ベージュトーン': 'aesthetic',
  'レイヤード': 'aesthetic',
  'ヌーディー': 'aesthetic',
  '朝活': 'lifestyle',
  '朝焼け': 'lifestyle',
  '家計簿': 'lifestyle',
  '断捨離': 'lifestyle',
  '時短料理': 'lifestyle',
  '勉強法': 'lifestyle',
  'グッズ': 'fandom',
  '聖地巡礼': 'fandom',
  '痛バ': 'fandom',
  '箱推し': 'fandom',
  '自担': 'fandom',
  '同担': 'fandom',
  '推し増し': 'fandom',
  '布教': 'fandom',
  'テンション': 'neutral',
  'モヤる': 'neutral',
  '即買い': 'positive',
  'テン': 'neutral'
};
const NEGATIVE_TONE_PATTERN = /キレる|イライラ|グチる|愚痴|うざい|ウザい|めんどい|面倒|イチャモン|詰んだ|ムカつく|キモい|吐槽|吐き出し|怒り|烦|煩|抱怨|挑刺|找茬|负面|負面/i;
const AESTHETIC_TONE_PATTERN = /抜け感|透け感|こなれ|しっとり|ふんわり|ツヤ感|清潔感|アンニュイ|ヌーディ|マット|ベージュ|レイヤード|モノトーン|パーソナルカラー|审美|審美|氛围|雰囲気|穿搭|美妆|写真|视觉|視覺/i;
const LIFESTYLE_TONE_PATTERN = /朝活|朝焼け|家計簿|断捨離|時短料理|勉強法|おうち時間|生活方式|学习|學習|料理|收纳|整理|日常管理/i;
const FANDOM_TONE_PATTERN = /推し|自担|同担|箱推し|痛バ|聖地巡礼|グッズ|追星|二次元|偶像|アイドル/i;

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
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

function isGenericTopicWord(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  if (!kanji) return false;
  if (GENERIC_TOPIC_WORDS.has(kanji)) return true;
  return GENERIC_TOPIC_CONTEXT_RE.test(`${kanji} ${getEntryContextText(entry)}`);
}

function getExpressionValueScore(entry = {}) {
  const explicit = Number.parseInt(entry.expressionValueScore, 10);
  if (Number.isFinite(explicit) && explicit > 0) return clampNumber(explicit, 0, 100);
  const kanji = normalizeKanjiSpelling(entry.kanji);
  const text = `${kanji} ${getEntryContextText(entry)}`;
  let score = 62;
  if (EXPRESSION_VALUE_STRONG_RE.test(text)) score += 22;
  if (EXPRESSION_VALUE_CONTEXT_RE.test(text)) score += 16;
  if (['网络口语词', '新鲜梗词', '圈层词'].includes(entry.candidateType)) score += 4;
  if (['审美氛围词', '生活方式词', '追星兴趣词'].includes(entry.candidateType)) score += 6;
  if (isGenericTopicWord({ ...entry, kanji })) score -= 28;
  if (EXPRESSION_VALUE_LOW_RE.test(text)) score -= 18;
  return clampNumber(score, 0, 100);
}

function getAccountLearningTone(entry = {}) {
  const text = `${normalizeKanjiSpelling(entry.kanji)} ${getEntryContextText(entry)}`;
  if (ACCOUNT_LEARNING_EMOTION_SOCIAL_RE.test(text)) return 'emotion_social';
  if (LIFESTYLE_TONE_PATTERN.test(text) || /生活|日常|学习|學習|工作|消费状态|消費狀態|状态场景|狀態場景|ソロ活|自炊|散歩|読書/.test(text)) return 'lifestyle';
  if (FANDOM_TONE_PATTERN.test(text) || /追星|推し|圈层兴趣|圈層興趣|布教|二次元/.test(text)) return 'fandom';
  if (AESTHETIC_TONE_PATTERN.test(text) || /审美|審美|美妆|美妝|穿搭|氛围|雰囲気/.test(text)) return 'aesthetic';
  if (SEASONAL_PATTERN.test(text) || /季节|季節|文化|旅行|紅葉|祭り/.test(text)) return 'seasonal_culture';
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
  return clampNumber(toneBonus + expressionBonus - genericPenalty, -28, 24);
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v4-content-mix';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function getInputHash(payload = {}) {
  return hashText(stableStringify({
    action: payload.action,
    input: payload.input,
    items: payload.items,
    rules: payload.rules,
    preferences: payload.preferences,
    context: payload.context,
    count: payload.count
  }));
}

function summarizeNormalizedOutput(data = {}) {
  const items = cleanArray(data.items, 80);
  return {
    itemCount: items.length,
    words: items.map(item => cleanText(item.kanji, 80)).filter(Boolean).slice(0, 80),
    summary: data.summary || {}
  };
}

function attachUsageTrace(data = {}, payload = {}, model = '', rawOutput = '', reviewResult = 'accepted') {
  return {
    ...data,
    usage: {
      ...(data.usage || {}),
      model,
      createdAt: data.usage?.createdAt || new Date().toISOString(),
      action: payload.action,
      promptVersion: getPromptVersion(payload.action),
      inputHash: getInputHash(payload),
      rawOutput: cleanText(rawOutput, 8000),
      normalizedOutput: summarizeNormalizedOutput(data),
      reviewResult: ['accepted', 'rejected', 'edited'].includes(reviewResult) ? reviewResult : 'accepted'
    }
  };
}

function cleanCount(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 40;
  return Math.max(1, Math.min(50, number));
}

function cleanArray(value, max = 20) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function cleanEnum(value, options, fallback) {
  const cleanValue = cleanText(value, 80);
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function buildSystemPrompt() {
  return [
    '你不是最终裁判，你是“小红书日语候选词灵感助手”。你的任务是提供候选词，但必须诚实标记不确定性。',
    '必须只返回合法 json，不要 Markdown，不要代码块，不要解释；输出必须是一个 JSON object。',
    '每个候选词必须适合中文用户理解，且能作为小红书日语内容灵感。',
    '每日热门不是日本热词榜，也不是话题标签池；判断标准不是“这个词热不热”，而是“这个词是否值得做成小红书日语表达内容”。',
    '优先生成有语感、有场景、能收藏、能做标题封面的日语表达词，而不是普通话题分类词。',
    '优先方向：情绪状态词、人际关系/社交语感词、生活/学习/工作状态词、中文不好直译的日语表达、可以解释成“不是 A，而是 B”的词、低风险且语义稳定的表达。',
    '禁止列表优先级最高：如果用户 prompt 里给出禁止生成的词，绝对不要输出这些词，也不要换一个解释继续生成同一个词。',
    'topUp 补词不是重新问一遍；必须避开首批候选、已选今日词、近 30 天历史词、收藏/待发布/已发布词，补充真正新的方向。',
    '减少生成：ネイル、ベースメイク、副業、転職、祭り、お弁当、資格勉強、自己投資 这类泛话题词；它们不是绝对禁止，但默认应放 long_term/watch，不要放 today。',
    '好候选方向：微妙情绪、人际分寸、社交语感、生活状态、学习/工作/消费状态、中文不好直译但能用自然例句解释的表达。不要照抄示例或禁止列表里的词。',
    '弱候选示例：ネイル、ベースメイク、副業、転職、祭り、お弁当。弱候选需要更具体场景或标题包装，否则不要进入 today。',
    '注意标准日语写法：例如 オーバサイズ 应修正为 オーバーサイズ；长音缺失或片假名不标准时必须自动修正或标记需查证。',
    '每个候选必须给 expressionValueScore，0-100：85+ 强表达价值，70-84 可推荐，55-69 候选池观察，低于55不进每日热门。',
    'expressionValueScore 高分特征：中文不好直译、有情绪共鸣、人际语感、生活场景、自然例句、适合封面大字、用户会收藏；低分特征：普通名词、话题标签、行业分类、教材词、不好解释、不好配图。',
    '每个候选词只给 1 条 examples，suggestedTitles 最多 2 条，coverSuggestion 保持简短。',
    '如果你不确定某个词是否真实流行，不要包装成热门，必须标记 confidenceLevel=review。',
    '成熟且有 common_usage、user_material 或 trend_claim 证据的日常缩略语可以标记 confidenceLevel=high 或 medium，并在 meaning/reason 说明完整形式；只有来源不明、自创、疑似编造或用法不稳定的缩写才必须标记 confidenceLevel=review。',
    '低风险且常见用法的新梗、网络口语、圈层词可以标记 confidenceLevel=high 或 medium，并放入 displayBucket=meme_fast。',
    '如果某个词涉及角色名、品牌名、IP、明星、隐私、窥私、评价他人外貌，必须标记 confidenceLevel=review。',
    '如果只是普通词，不要写成“今日热门”，可以标记为稳定候选或长期候选。',
    '高风险词不得包装成今日热门，只能标记 riskLevel=high、suggestedAction=暂缓 或 不建议。',
    '梗化词可以保留，但 freshness 必须标注短期或需要尽快判断。',
    '低风险、常见用法的新鲜梗词不要默认放复核池，应进入 displayBucket=meme_fast。',
    '只有不确定、疑似错误、高风险或需人工核验的词进入 displayBucket=review。',
    '梗化词必须在 reviewReason 或 riskWarning 里说明过期风险。',
    '不允许编造来源，不允许写“近期流行”但 evidenceType 却是 unknown。',
    '流行表达要进入 displayBucket=meme_fast，必须 evidenceType=trend_claim 且 confidenceLevel=high 或 medium；没有时间证据时改为稳定候选或放 review。',
    '当任务要求 10 个候选时，内容结构按 4 个情绪/人际核心表达、2 个成熟日常缩略语、1 个有时间证据的流行表达、2 个具体美妆/穿搭表达、1 个灵活补位生成。',
    '每 10 个候选最多 2 个完整词组，其中长句式或惯用语最多 1 个；其余使用单词、缩略语或短复合词。',
    '适配分不能普遍偏高，只有真正适合小红书且解释可靠的词才可以超过85分。',
    'displayBucket=today 只给表达价值高、场景清楚、风险低、适合标题封面且不是最近重复的词；泛话题词、纯分类词、需要包装的词放 long_term。',
    '基础网络词、吐槽词、追星圈层词优先放 displayBucket=meme_fast；普通长期可做词和泛话题观察词放 long_term；节日季节词放 seasonal。',
    '每个词必须给 emotionTone：positive、neutral、negative、aesthetic、lifestyle、fandom 之一。',
    '进入复核或屏蔽的词必须给 reviewReasonType：uncertain_usage、too_niche、possible_wrong_meaning、ip_brand_role、privacy_sensitive、offensive、too_basic 之一；非复核词也可以给空字符串。',
    '复核原因不要模板化：疑似自创、缩写、用法不常见是 uncertain_usage；二次元、虚拟形象、社群内部词是 too_niche；解释可能不准是 possible_wrong_meaning；具体角色名、品牌名、明星名、IP 名是 ip_brand_role；偷拍、偶遇美女、窥私表达是 privacy_sensitive；侮辱攻击歧视骂人是 offensive；过于基础、单独成词内容价值低是 too_basic。',
    '负面情绪/吐槽词如キレる、イライラ、グチる、うざい、めんどい、イチャモン必须标记 emotionTone=negative，优先放 meme_fast，不要进入首页 today。',
    '审美氛围词如抜け感、透け感、こなれ、しっとり、ふんわり、レイヤード标记 emotionTone=aesthetic；生活方式词如朝活、朝焼け标记 emotionTone=lifestyle。',
    '审美氛围词如透け感、抜け感、こなれ、しっとり、ふんわり、ツヤ感、清潔感、アンニュイ、ヌーディ、マット可以 85-92；草、ワロタ、ウケる最高 82；オタサー、バ美声、ぬるぬる、にわか最高 78；夢み、すき最高 70。',
    'テン作为テンション缩略语默认不确定，放 review 或 long_term，分数不超过70。',
    '草、ウケる、カップル、デート、ビビる、神最高 82；マジ卍最高 65 且进 review；キモい、ガチ恋最高 60 且进 review。',
    'コスプレ本身不要默认复核，只有出现具体角色、IP、明星、擦边、侵权、隐私风险时才进入 review，否则放 long_term。',
    '不确定但有灵感价值的词，不要删除，放入复核池：confidenceLevel=review，suggestedAction=暂缓。',
    'romaji 和 kana 都要给出。不要编造明显不自然的日语。'
  ].join('\n');
}

function buildUserPrompt(payload) {
  const context = payload.context || {};
  const exclusionContext = context.deepSeekExclusion || {};
  const excludedWords = cleanArray(exclusionContext.excludedWords || payload.avoidWords, 200);
  const excludedReasons = exclusionContext.excludedReasons || {};
  return JSON.stringify({
    task: payload.action,
    generationMode: payload.action === 'generate_candidates' ? 'wild_ideas' : payload.action,
    count: payload.count,
    batchHint: payload.batchHint || '',
    avoidWords: excludedWords,
    input: payload.input,
    preferences: payload.preferences,
    highRiskRule: payload.preferences.includeHighRisk === 'exclude'
      ? '不要生成 high 风险词。'
      : '可以给出 high 风险词，但必须标记 riskLevel=high，只能作为复核候选。',
    context: {
      favorites: cleanArray(context.favorites, 120),
      negativeFeedback: context.negativeFeedback || {},
      publishedWords: cleanArray(context.publishedWords, 120),
      existingCandidates: cleanArray(context.existingCandidates, 160)
    },
    jsonRequirement: '必须返回合法 json object，顶层字段必须包含 items、summary；不要输出 json 之外的任何文字。',
    duplicationRule: 'avoidWords、禁止生成的词、favorites、publishedWords、existingCandidates 中出现过的词不要再生成；同一批 items 内也不要重复。',
    noveltyRule: {
      title: '【禁止生成的词】',
      forbiddenWords: excludedWords,
      forbiddenReasons: {
        recent_history_30d: cleanArray(excludedReasons.recent_history_30d, 80),
        favorite_or_pending: cleanArray(excludedReasons.favorite_or_pending, 80),
        published: cleanArray(excludedReasons.published, 80),
        selected_today: cleanArray(excludedReasons.selected_today, 80),
        current_batch_duplicate: cleanArray(excludedReasons.current_batch_duplicate, 80),
        protected: cleanArray(excludedReasons.protected, 80),
        existing_recent_candidate: cleanArray(excludedReasons.existing_recent_candidate, 80)
      },
      instructions: [
        '上面的 forbiddenWords 已经推荐过、收藏过、发布过、今天选过或本轮出现过，禁止再次生成。',
        '如果你想生成的词在禁止列表里，请换成新的表达。',
        '不要生成同义重复词，不要只换解释继续生成同一个词。',
        '优先找更细分、更有语感、更有生活场景的新词。',
        '不要生成中文用户一眼能懂的泛话题词、普通话题名词、泛美妆标签、泛职业标签、太基础教材词、过度圈层黑话、词义不稳定的新造词、高风险或易冒犯词。'
      ]
    },
    accountLearningRule: {
      coreQuestion: '这个词是否值得做成小红书日语内容，而不只是热门话题？',
      priorityMix: '每 10 个候选固定为：情绪状态/人际语感 4，成熟日常缩略语 2，有时间证据的流行表达 1，具体美妆/穿搭表达 2，灵活补位 1。',
      expressionFormRule: '每 10 个候选至少 8 个单词、成熟缩略语或短复合词；完整词组最多 2 个，长句式或惯用语最多 1 个。',
      trendRule: '流行词配额必须 evidenceType=trend_claim、displayBucket=meme_fast 且 confidenceLevel=high/medium；不能只凭“近期流行”描述。',
      abbreviationRule: '成熟日常缩略语要写出完整形式并提供 common_usage、user_material 或 trend_claim 证据；来源不明、自造或用法不稳的缩写进入 review。',
      genericTopicRule: 'ネイル、ベースメイク、副業、転職、祭り、お弁当、資格勉強、自己投資 这类泛话题词默认不要放 today；美妆/穿搭名额只给具体、可视化、能讲清语感差异的表达。',
      publishedReviewRule: '已发布复盘中，泛“流行词”标题没有稳定显示更高收藏价值，因此不做自动加权；继续以收藏率、分享、关注和评论判断选题，只把成熟 topic 信号用于选词。'
    },
    completeJsonExample: {
      items: [
        {
          kanji: 'めろい',
          romaji: 'meroi',
          kana: 'めろい',
          meaning: '太心动了、被可爱到融化',
          category: '网络口语',
          candidateType: '新鲜梗词',
          freshness: '需要尽快判断',
          expressionValueScore: 86,
          xhsFitScore: 88,
          riskLevel: 'low',
          riskWarning: '',
          confidenceLevel: 'medium',
          evidenceType: 'common_usage',
          reviewReason: '',
          reviewReasonType: '',
          displayBucket: 'meme_fast',
          emotionTone: 'positive',
          reason: '适合追星、恋爱、二次元、可爱瞬间类小红书内容。',
          suggestedAction: '尽快判断',
          examples: [
            {
              jp: 'このビジュ、めろすぎる。',
              romaji: 'kono biju, mero sugiru.',
              cn: '这个颜值太让人心动了。',
              note: '适合追星、看图、表达被可爱到。'
            }
          ],
          suggestedTitles: ['日本年轻人说「めろい」，不是旋律，是被可爱到晕'],
          coverSuggestion: {
            coverText: '被可爱到晕：めろい',
            mainVisual: '偶像神图、猫猫撒娇、心动表情',
            style: '粉色、可爱、追星感',
            avoid: '不要用于正式场合'
          }
        }
      ],
      summary: {
        batchTitle: 'AI灵感扩词',
        trendNotes: '本批以追星、审美氛围、网络口语为主。',
        needsReviewCount: 0
      }
    },
    enumRules: {
      candidateType: CANDIDATE_TYPES,
      freshness: FRESHNESS,
      riskLevel: RISK_LEVELS,
      suggestedAction: SUGGESTED_ACTIONS,
      confidenceLevel: CONFIDENCE_LEVELS,
      evidenceType: EVIDENCE_TYPES,
      displayBucket: DISPLAY_BUCKETS,
      emotionTone: EMOTION_TONES,
      reviewReasonType: REVIEW_REASON_TYPES
    }
  });
}

function buildWordCardSystemPrompt() {
  const accountLearning = getAccountLearningPromptContext();
  return [
    '你是“小红书日语词卡编辑”。你的任务不是筛选候选词，而是为已入候选池的日语词生成完整、可直接进入详情页的词卡内容。',
    '必须只返回合法 json object，不要 Markdown，不要代码块，不要解释；顶层必须包含 items、summary。',
    '每个 items 元素必须包含 kanji 和 aiCard。',
    'aiCard 必须完整覆盖：summary、explanation、usageScenes、examples、suggestedTitles、coverSuggestion、contentAngles、targetAudience、referenceDirection、riskWarning、wrongUsage、similarWords、interactionPrompts。',
    '内容要面向中文用户和小红书内容创作者：解释清楚、标题可用、例句自然、风险诚实。',
    `账号定位：${accountLearning.accountPositioning}`,
    `优先方向：${accountLearning.preferredDirections.join('、')}。`,
    `谨慎方向：${accountLearning.avoidDirections.join('、')}。`,
    `词卡规则：${accountLearning.wordCardRules.join('；')}。`,
    '不要编造“近期流行”来源；不确定时在 riskWarning 或 wrongUsage 里说明。',
    'examples 给 2-4 条，必须有 jp、kana、romaji、cn、note。',
    'suggestedTitles 给 3-6 条；contentAngles 给 3-6 条；interactionPrompts 给 2-4 条。',
    'coverSuggestion 要具体到封面字、主视觉、风格、避免事项。',
    '输出必须是 json。'
  ].join('\n');
}

function buildWordCardUserPrompt(payload) {
  const accountLearningSummary = {
    ...getAccountLearningPromptContext(),
    ...(payload.context?.accountLearningSummary || {})
  };
  const words = cleanArray(payload.context?.words, 20).map(item => ({
    kanji: cleanText(item.kanji, 80),
    kana: cleanText(item.kana || item.reading, 120),
    romaji: cleanText(item.romaji, 120),
    meaning: cleanText(item.meaning, 240),
    category: cleanText(item.category, 80),
    candidateType: cleanText(item.candidateType, 80),
    freshness: cleanText(item.freshness, 80),
    riskLevel: cleanText(item.riskLevel, 40),
    confidenceLevel: cleanText(item.confidenceLevel, 40),
    evidenceType: cleanText(item.evidenceType, 40),
    reviewReason: cleanText(item.reviewReason, 240),
    reason: cleanText(item.reason, 500),
    sourceType: cleanText(item.sourceType, 80),
    sourceTags: cleanArray(item.sourceTags, 12).map(tag => cleanText(tag, 80)).filter(Boolean),
    discoverySource: cleanText(item.discoverySource, 120),
    discoveryContext: cleanText(item.discoveryContext, 800),
    isManualAdded: Boolean(item.isManualAdded || item.sourceType === 'manual' || cleanArray(item.sourceTags, 12).includes('手动添加'))
  })).filter(item => item.kanji);
  const regenerationScope = ['card', 'cover'].includes(payload.context?.regeneration?.scope)
    ? payload.context.regeneration.scope
    : '';
  const regenerationReason = cleanText(payload.context?.regeneration?.reason, 80);
  const regenerationReasonLabel = {
    meaningInaccurate: '释义不准确',
    tooTextbookTone: '解释太教材',
    unnaturalExamples: '例句不自然',
    weakXhsTone: '小红书感不够',
    weakTitles: '标题不吸引人',
    repetitiveAngles: '内容角度重复',
    wrongRiskAssessment: '风险判断不准确',
    weakVisual: '画面不够吸引',
    weakCoverText: '封面文字不够醒目',
    visualMismatch: '图片和词义不匹配',
    offBrand: '风格不符合账号',
    tooCluttered: '信息太多',
    mobileUnreadable: '手机端看不清',
    unnaturalVisual: '人物或场景不自然',
    tooSimilar: '与近期封面太相似'
  }[regenerationReason] || regenerationReason;
  const currentCard = payload.context?.regeneration?.currentCard
    ? normalizeAiCard(payload.context.regeneration.currentCard)
    : null;
  return JSON.stringify({
    task: 'generate_word_card',
    jsonRequirement: '必须返回合法 json object。顶层 items 是数组，每个元素包含 kanji 和 aiCard。',
    accountLearningSummary,
    accountLearningInstruction: '生成 aiCard 时必须参考 accountLearningSummary：不要像词典或教材，优先给中文用户有共鸣、有场景、愿意收藏、能做标题封面的内容；但不要改变 aiCard 字段结构。',
    regeneration: regenerationScope ? {
      scope: regenerationScope,
      reason: regenerationReasonLabel,
      instruction: regenerationScope === 'card'
        ? '这是单词卡内容负反馈。重点修正释义、场景、例句、标题、内容角度和风险判断；封面方案将由系统保留，不要用封面变化掩盖内容问题。'
        : '这是封面包装负反馈。保持单词卡释义、例句和内容方向不变，只重新设计 coverSuggestion，尤其修正给出的封面原因。',
      currentCard
    } : null,
    words,
    completeJsonExample: {
      items: [
        {
          kanji: '抜け感',
          aiCard: {
            cardStatus: 'ready',
            cardSource: 'deepseek_api',
            cardModel: '',
            cardVersion: 1,
            generatedAt: '',
            summary: '适合讲日系穿搭、妆容和照片氛围的审美词。',
            explanation: '「抜け感」指刻意保留一点松弛和不满格的感觉，让整体更自然。',
            usageScenes: ['穿搭标题', '妆容解析', '照片氛围点评'],
            examples: [
              {
                jp: 'このコーデ、抜け感があって好き。',
                kana: 'この こーで、ぬけかんが あって すき。',
                romaji: 'kono kode, nukekan ga atte suki.',
                cn: '这套穿搭有种松弛感，我很喜欢。',
                note: '适合评价穿搭不过度用力。'
              }
            ],
            suggestedTitles: ['日本女生常说的「抜け感」，到底是哪种松弛美？'],
            coverSuggestion: {
              coverText: '日系松弛感：抜け感',
              mainVisual: '干净穿搭、低饱和妆容、自然光自拍',
              style: '留白、浅色、轻杂志感',
              avoid: '不要解释成偷懒或不修边幅'
            },
            contentAngles: ['用 3 张图解释什么是抜け感', '和こなれ感的区别', '适合放进穿搭标题的句式'],
            targetAudience: '喜欢日系穿搭、妆容和氛围照片的中文用户。',
            referenceDirection: '做成收藏型图文：词义、场景、例句、避坑。',
            riskWarning: '',
            wrongUsage: '不要用于正式商务评价，也不要理解成邋遢。',
            similarWords: [
              {
                word: 'こなれ',
                romaji: 'konare',
                meaning: '熟练自然、不费力的时髦感',
                difference: 'こなれ更偏熟练，抜け感更偏留白和松弛。'
              }
            ],
            interactionPrompts: ['你觉得“松弛感”和“精致感”哪个更难？']
          }
        }
      ],
      summary: {
        batchTitle: 'DeepSeek词卡生成',
        trendNotes: '已生成完整词卡。',
        needsReviewCount: 0
      }
    }
  });
}

function buildLibraryAuditSystemPrompt() {
  return [
    '你是“小红书日语历史种子数据清洗审核助手”。你只给删除审核建议，不直接删除数据。',
    '必须只返回合法 json object，不要 Markdown，不要代码块，不要解释；顶层必须包含 items 和 summary。',
    '输入是一批历史种子数据词条，每批最多 50 个。你必须逐个返回 kanji、action、xhsFitScore、reason、riskLevel、confidenceLevel、suggestedBucket、replacementSuggestion。',
    'action 只能是 keep、watch、review、delete、protect。',
    'delete 标准：太普通、太教材、不适合小红书日语选题、不好配图、不好做标题、解释质量差、过时且无怀旧价值、与日语选题关系弱、和高质量词重复且价值更低、高风险且不适合账号方向。',
    'keep 标准：适合小红书、低风险、好配图、好做标题、能延展成系列、可作为 DeepSeek 审核词补位。',
    'watch 标准：不算差但暂不优先，内容价值中等，以后可以人工再看。',
    'review 标准：用法不确定、可能有争议、圈层较窄但可能有价值。',
    'protect 标准：如果上下文 protectedWords 命中，必须 action=protect，reason=用户已进入工作流，禁止自动删除。',
    'AI、アニメ、ChatGPT、生成AI 这类词如果只是普通名词或不符合账号方向，可以建议 delete。',
    '不要为了凑数量删除；不确定时用 watch 或 review，不要强行 delete。',
    '输出必须是 json。'
  ].join('\n');
}

function buildLibraryAuditUserPrompt(payload) {
  const context = payload.context || {};
  return JSON.stringify({
    task: 'audit_library_for_delete',
    count: payload.count,
    input: payload.input,
    protectedRule: 'protectedWords 里的词禁止删除；即使你认为不适合，也必须 action=protect，reason=用户已进入工作流，禁止自动删除。',
    context: {
      protectedWords: cleanArray(context.protectedWords, 300),
      favorites: cleanArray(context.favorites, 200),
      publishedWords: cleanArray(context.publishedWords, 200),
      todayWords: cleanArray(context.todayWords, 40),
      existingCandidates: cleanArray(context.existingCandidates, 300)
    },
    jsonRequirement: '必须返回合法 json object；items 数量应覆盖 input 中每一个 kanji；不要输出 json 之外的任何文字。',
    completeJsonExample: {
      items: [
        {
          kanji: '選択肢',
          action: 'delete',
          xhsFitScore: 42,
          reason: '表达过于教材和抽象，单独做小红书日语选题画面感弱，标题价值低。',
          riskLevel: 'low',
          confidenceLevel: 'high',
          suggestedBucket: 'deleted',
          replacementSuggestion: '可用「迷う」「二択」等更有场景感的表达替代。'
        },
        {
          kanji: '抜け感',
          action: 'keep',
          xhsFitScore: 90,
          reason: '适合日系穿搭、美妆和照片氛围内容，好配图且标题价值高。',
          riskLevel: 'low',
          confidenceLevel: 'high',
          suggestedBucket: 'today',
          replacementSuggestion: ''
        },
        {
          kanji: 'やばい',
          action: 'protect',
          xhsFitScore: 0,
          reason: '用户已进入工作流，禁止自动删除',
          riskLevel: 'low',
          confidenceLevel: 'high',
          suggestedBucket: 'long_term',
          replacementSuggestion: ''
        }
      ],
      summary: {
        keepCount: 1,
        watchCount: 0,
        reviewCount: 0,
        deleteCount: 1,
        protectCount: 1
      }
    },
    enumRules: {
      action: LIBRARY_AUDIT_ACTIONS,
      riskLevel: RISK_LEVELS,
      confidenceLevel: CONFIDENCE_LEVELS,
      suggestedBucket: LIBRARY_AUDIT_BUCKETS
    }
  });
}

function buildMissingLibraryAuditSystemPrompt() {
  return [
    '你是“小红书日语历史种子数据 DeepSeek 补审助手”。你不是最终裁判，但必须给出可执行审核结论。',
    '必须只返回合法 json object，不要 Markdown，不要代码块，不要解释；顶层必须包含 items 和 summary。',
    '输入是一批历史种子词条，每批最多 50 个。你必须逐个返回 kanji、auditAction、libraryReviewStatus、xhsFitScore、reason、candidateType、displayBucket、riskLevel、confidenceLevel、evidenceType、suggestedAction、romaji、kana、meaning、category、reviewReasonType、reviewReason。',
    'auditAction 只能是 approve、delete、review、protect。',
    'approve：适合小红书日语选题、好做标题、好配图、风险可控、能做成 DeepSeek 词卡、有内容延展价值。',
    'approve 不能只因为词语常见；必须能独立做成账号需要的日语词卡，有明确标题、封面画面和内容角度。',
    'delete：太普通、太教材、不好配图、不好做标题、与账号方向弱、解释质量差、明显过时且无怀旧价值、高风险不适合、疑似错误词/伪词/自造词、与高质量词重复且价值更低。',
    '如果是基础教材词、普通名词、泛泛抽象词、英文外来普通词、商业/工具名词、单独做选题价值低，即使词本身正确也应 delete。',
    'review：有价值但用法不确定、圈层太窄、可能有争议、需要人工判断。',
    'protect：已收藏、待发布、已发布、今日正在展示、手动保留；上下文 protectedWords 命中时必须 protect。',
    '当 rules.strictSecondPass=true 时执行严格二审：宁可少留，不要宽泛通过；只有强小红书日语内容价值的词 approve，其余 delete 或 review。',
    'libraryReviewStatus 必须对应：approve->approved，delete->deleted，review->review，protect->protected。',
    '不允许编造流行来源；不确定时 review，不要包装成热门。',
    '输出必须是 json。'
  ].join('\n');
}

function buildMissingLibraryAuditUserPrompt(payload) {
  const context = payload.context || {};
  let items = payload.items;
  if (!Array.isArray(items)) {
    try {
      const parsed = JSON.parse(payload.input || '[]');
      items = Array.isArray(parsed) ? parsed : parsed.items;
    } catch (error) {
      items = [];
    }
  }
  return JSON.stringify({
    task: 'audit_missing_library_words',
    count: payload.count,
    items: cleanArray(items, 50),
    rules: {
      deleteIfNotFit: payload.rules?.deleteIfNotFit !== false,
      protectFavorites: payload.rules?.protectFavorites !== false,
      strictSecondPass: Boolean(payload.rules?.strictSecondPass),
      approvalThreshold: cleanText(payload.rules?.approvalThreshold, 400)
    },
    protectedRule: 'protectedWords 里的词禁止删除；即使你认为不适合，也必须 auditAction=protect，libraryReviewStatus=protected，reason=用户已进入工作流，禁止自动删除。',
    context: {
      protectedWords: cleanArray(context.protectedWords, 300),
      favorites: cleanArray(context.favorites, 200),
      publishedWords: cleanArray(context.publishedWords, 200),
      todayWords: cleanArray(context.todayWords, 40)
    },
    jsonRequirement: '必须返回合法 json object；items 数量应覆盖输入中每一个 kanji；不要输出 json 之外的任何文字。',
    completeJsonExample: {
      items: [
        {
          kanji: '抜け感',
          auditAction: 'approve',
          libraryReviewStatus: 'approved',
          xhsFitScore: 90,
          reason: '适合日系穿搭、美妆和照片氛围内容，好配图且标题价值高。',
          candidateType: '审美氛围词',
          displayBucket: 'today',
          riskLevel: 'low',
          confidenceLevel: 'high',
          evidenceType: 'common_usage',
          suggestedAction: '优先收藏观察',
          romaji: 'nukekan',
          kana: 'ぬけかん',
          meaning: '松弛感、留白感、不用力的时髦',
          category: '审美氛围',
          reviewReasonType: '',
          reviewReason: ''
        },
        {
          kanji: '選択肢',
          auditAction: 'delete',
          libraryReviewStatus: 'deleted',
          xhsFitScore: 35,
          reason: '表达过于教材和抽象，单独做小红书日语选题画面感弱。',
          candidateType: '稳定候选',
          displayBucket: 'blocked',
          riskLevel: 'low',
          confidenceLevel: 'high',
          evidenceType: 'common_usage',
          suggestedAction: '不建议',
          romaji: 'sentakushi',
          kana: 'せんたくし',
          meaning: '选项',
          category: '基础词',
          reviewReasonType: 'too_basic',
          reviewReason: '太基础，单独成词内容价值低。'
        }
      ],
      summary: {
        approvedCount: 1,
        deleteCount: 1,
        reviewCount: 0,
        protectCount: 0
      }
    }
  });
}

function extractJsonObject(text) {
  const raw = cleanText(text, 200000);
  if (!raw) return null;
  const normalized = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  try {
    return JSON.parse(normalized);
  } catch (error) {
    const match = normalized.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const candidate = match[0];
    try {
      return JSON.parse(candidate);
    } catch (innerError) {
      let depth = 0;
      let start = -1;
      let inString = false;
      let escaped = false;
      for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === '{') {
          if (depth === 0) start = index;
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            try {
              return JSON.parse(normalized.slice(start, index + 1));
            } catch (scanError) {
              start = -1;
            }
          }
        }
      }
      return null;
    }
  }
}

function extractMessageContent(messageContent) {
  if (typeof messageContent === 'string') return messageContent;
  if (!Array.isArray(messageContent)) return '';
  return messageContent
    .map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    })
    .join('\n');
}

async function repairJsonContent(env, payload, rawContent) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const model = cleanText(env.DEEPSEEK_MODEL || 'deepseek-v4-flash', 120);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You repair malformed JSON. Return only one valid json object. Do not explain.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              instruction: 'Convert the following model output into one valid json object that matches the existing items/summary schema. Keep only recoverable content. Output json only.',
              count: payload.count,
              malformedContent: cleanText(rawContent, 120000)
            })
          }
        ],
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return null;
    const responseBody = await response.text();
    const apiData = extractJsonObject(responseBody);
    const content = extractMessageContent(apiData?.choices?.[0]?.message?.content || '');
    return extractJsonObject(content);
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeExample(example = {}) {
  return {
    jp: cleanText(example.jp, 220),
    kana: cleanText(example.kana, 220),
    romaji: cleanText(example.romaji, 220),
    cn: cleanText(example.cn, 220),
    note: cleanText(example.note, 220)
  };
}

function normalizeAiCard(card = {}, model = '') {
  const coverSuggestion = card.coverSuggestion || {};
  return {
    cardStatus: cleanEnum(card.cardStatus, ['none', 'pending', 'ready', 'failed', 'stale'], 'ready'),
    cardSource: 'deepseek_api',
    cardModel: cleanText(card.cardModel || model, 120),
    cardVersion: Math.max(1, Math.min(99, Number.parseInt(card.cardVersion, 10) || 1)),
    coverVersion: Math.max(1, Math.min(99, Number.parseInt(card.coverVersion, 10) || 1)),
    generatedAt: cleanText(card.generatedAt, 80) || new Date().toISOString(),
    coverGeneratedAt: cleanText(card.coverGeneratedAt, 80) || cleanText(card.generatedAt, 80) || new Date().toISOString(),
    summary: cleanText(card.summary, 500),
    explanation: cleanText(card.explanation, 1600),
    usageScenes: cleanArray(card.usageScenes, 8).map(item => cleanText(item, 120)).filter(Boolean),
    examples: cleanArray(card.examples, 5).map(normalizeExample).filter(example => example.jp || example.cn),
    suggestedTitles: cleanArray(card.suggestedTitles, 8).map(item => cleanText(item, 140)).filter(Boolean),
    coverSuggestion: {
      coverText: cleanText(coverSuggestion.coverText, 120),
      mainVisual: cleanText(coverSuggestion.mainVisual, 240),
      style: cleanText(coverSuggestion.style, 160),
      avoid: cleanText(coverSuggestion.avoid, 240)
    },
    contentAngles: cleanArray(card.contentAngles, 8).map(item => cleanText(item, 180)).filter(Boolean),
    targetAudience: cleanText(card.targetAudience, 400),
    referenceDirection: cleanText(card.referenceDirection, 600),
    riskWarning: cleanText(card.riskWarning, 500),
    wrongUsage: cleanText(card.wrongUsage, 600),
    similarWords: cleanArray(card.similarWords, 8).map(item => ({
      word: cleanText(item.word || item.kanji, 80),
      romaji: cleanText(item.romaji, 120),
      meaning: cleanText(item.meaning, 240),
      difference: cleanText(item.difference || item.note, 500)
    })).filter(item => item.word || item.meaning),
    interactionPrompts: cleanArray(card.interactionPrompts, 8).map(item => cleanText(item, 220)).filter(Boolean)
  };
}

function normalizeWordCardData(data, payload, model) {
  const items = cleanArray(data?.items, 40)
    .map(item => {
      const kanji = cleanText(item.kanji, 80);
      if (!kanji) return null;
      return {
        kanji,
        aiCard: normalizeAiCard(item.aiCard || item.card || item, model)
      };
    })
    .filter(Boolean)
    .slice(0, payload.count);
  return {
    items,
    summary: {
      batchTitle: cleanText(data?.summary?.batchTitle || 'DeepSeek词卡生成', 120),
      trendNotes: cleanText(data?.summary?.trendNotes || '', 1000),
      needsReviewCount: 0
    },
    usage: {
      model,
      createdAt: new Date().toISOString(),
      action: payload.action
    }
  };
}

function normalizeLibraryAuditItem(item = {}) {
  const kanji = cleanText(item.kanji, 80);
  if (!kanji) return null;
  const rawAction = item.auditAction || item.action || item.libraryReviewStatus;
  let action = cleanText(rawAction, 80);
  if (action === 'approved') action = 'approve';
  action = cleanEnum(action, LIBRARY_AUDIT_ACTIONS, 'review');
  if (action === 'keep' || action === 'watch') action = 'approve';
  const riskLevel = cleanEnum(item.riskLevel, RISK_LEVELS, action === 'delete' ? 'medium' : 'low');
  const confidenceLevel = cleanEnum(item.confidenceLevel, CONFIDENCE_LEVELS, action === 'review' ? 'review' : 'medium');
  const suggestedBucket = cleanEnum(
    item.suggestedBucket,
    LIBRARY_AUDIT_BUCKETS,
    action === 'delete' ? 'deleted' : action === 'review' ? 'review' : 'long_term'
  );
  return {
    kanji,
    action,
    auditAction: action,
    libraryReviewStatus: action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : action === 'protect' ? 'protected' : 'review',
    xhsFitScore: Math.max(0, Math.min(100, Number.parseInt(item.xhsFitScore, 10) || 0)),
    reason: action === 'protect'
      ? '用户已进入工作流，禁止自动删除'
      : cleanText(item.reason, 800),
    riskLevel,
    confidenceLevel,
    candidateType: cleanEnum(item.candidateType, CANDIDATE_TYPES, '稳定候选'),
    displayBucket: action === 'delete' ? 'blocked' : cleanEnum(item.displayBucket || item.suggestedBucket, DISPLAY_BUCKETS, action === 'review' ? 'review' : 'long_term'),
    evidenceType: cleanEnum(item.evidenceType, EVIDENCE_TYPES, 'common_usage'),
    suggestedAction: cleanEnum(item.suggestedAction, SUGGESTED_ACTIONS, action === 'delete' ? '不建议' : action === 'review' ? '暂缓' : '可以收藏观察'),
    romaji: cleanText(item.romaji, 120),
    kana: cleanText(item.kana, 120),
    meaning: cleanText(item.meaning, 240),
    category: cleanText(item.category, 80),
    reviewReasonType: cleanEnum(item.reviewReasonType, REVIEW_REASON_TYPES, ''),
    reviewReason: cleanText(item.reviewReason, 500),
    suggestedBucket: action === 'delete' ? 'deleted' : suggestedBucket,
    replacementSuggestion: cleanText(item.replacementSuggestion, 500)
  };
}

function normalizeLibraryAuditData(data, payload, model) {
  const items = cleanArray(data?.items, 80)
    .map(normalizeLibraryAuditItem)
    .filter(Boolean)
    .slice(0, payload.count);
  const counts = items.reduce((result, item) => {
    result[`${item.action}Count`] = (result[`${item.action}Count`] || 0) + 1;
    return result;
  }, {});
  return {
    items,
    summary: {
      approvedCount: (counts.approveCount || 0) + (counts.keepCount || 0) + (counts.watchCount || 0),
      keepCount: (counts.approveCount || 0) + (counts.keepCount || 0),
      watchCount: counts.watchCount || 0,
      reviewCount: counts.reviewCount || 0,
      deleteCount: counts.deleteCount || 0,
      protectCount: counts.protectCount || 0
    },
    usage: {
      model,
      createdAt: new Date().toISOString(),
      action: payload.action
    }
  };
}

function appendReason(base, note) {
  const cleanBase = cleanText(base, 500);
  const cleanNote = cleanText(note, 240);
  if (!cleanNote || cleanBase.includes(cleanNote)) return cleanBase;
  return cleanBase ? `${cleanBase}；${cleanNote}`.slice(0, 500) : cleanNote;
}

function hasEntityReviewRisk(kanji, text) {
  if (kanji === 'コスプレ') return COSPLAY_REVIEW_PATTERN.test(text);
  return ENTITY_REVIEW_PATTERN.test(text);
}

function inferReviewReasonType(kanji, text, fallback = '') {
  if (REVIEW_REASON_OVERRIDES[kanji]) return REVIEW_REASON_OVERRIDES[kanji];
  if (BLOCK_WORDS[kanji] || BLOCK_PATTERN.test(text)) return 'offensive';
  if (PRIVACY_REVIEW_PATTERN.test(text)) return 'privacy_sensitive';
  if (IP_BRAND_ROLE_PATTERN.test(text)) return 'ip_brand_role';
  if (POSSIBLE_WRONG_MEANING_PATTERN.test(text)) return 'possible_wrong_meaning';
  if (TOO_NICHE_PATTERN.test(text)) return 'too_niche';
  if (TOO_BASIC_PATTERN.test(text)) return 'too_basic';
  if (UNCERTAIN_PATTERN.test(text)) return 'uncertain_usage';
  return fallback;
}

function reviewReasonForType(type) {
  return {
    uncertain_usage: '用法或来源不够稳定，需要核验真实语境。',
    too_niche: '圈层较窄或偏社群内部用法，需要人工判断账号适配度。',
    possible_wrong_meaning: '词义解释可能不准，需要人工核对。',
    ip_brand_role: '涉及具体 IP、品牌、角色或明星，需要确认边界。',
    privacy_sensitive: '涉及隐私、窥私或偶遇表达，需要人工复核边界。',
    offensive: '含冒犯、攻击、歧视或骂人风险，不适合直接推荐。',
    too_basic: '表达过于基础或单独成词内容价值低，不适合直接上首页。'
  }[type] || '';
}

function inferEmotionTone(kanji, item = {}, fallback = 'neutral') {
  const explicitTone = cleanEnum(item.emotionTone, EMOTION_TONES, '');
  if (EMOTION_TONE_OVERRIDES[kanji]) return EMOTION_TONE_OVERRIDES[kanji];
  const text = [
    kanji,
    item.meaning,
    item.reason,
    item.reviewReason,
    item.riskWarning,
    item.category,
    item.candidateType
  ].map(value => cleanText(value, 1000)).join(' ');
  if (NEGATIVE_TONE_PATTERN.test(text)) return 'negative';
  if (AESTHETIC_TONE_PATTERN.test(text)) return 'aesthetic';
  if (LIFESTYLE_TONE_PATTERN.test(text)) return 'lifestyle';
  if (FANDOM_TONE_PATTERN.test(text)) return 'fandom';
  if (['审美氛围词', '美妆穿搭词'].includes(item.candidateType)) return 'aesthetic';
  if (item.candidateType === '生活方式词') return 'lifestyle';
  if (item.candidateType === '追星兴趣词') return 'fandom';
  return explicitTone || fallback;
}

function calibrateScore(kanji, score, { riskLevel = 'low', confidenceLevel = 'medium', emotionTone = 'neutral', reviewReasonType = '' } = {}) {
  let nextScore = Math.max(0, Math.min(100, Number.parseInt(score, 10) || 0));
  if (HIGH_RISK_SCORE_CAPS[kanji] || riskLevel === 'high') nextScore = Math.min(nextScore, HIGH_RISK_SCORE_CAPS[kanji] || 60);
  if (OLD_MEME_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, OLD_MEME_SCORE_CAPS[kanji]);
  if (NICHE_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, NICHE_SCORE_CAPS[kanji]);
  if (UNCERTAIN_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, UNCERTAIN_SCORE_CAPS[kanji]);
  if (NEGATIVE_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, NEGATIVE_SCORE_CAPS[kanji]);
  if (emotionTone === 'negative') nextScore = Math.min(nextScore, 82);
  if (reviewReasonType === 'too_niche' && !STRONG_FANDOM_WORDS.includes(kanji)) nextScore = Math.min(nextScore, 78);
  if (reviewReasonType === 'uncertain_usage' && confidenceLevel === 'review') nextScore = Math.min(nextScore, 70);
  if (BASIC_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, BASIC_SCORE_CAPS[kanji]);
  if (LONG_TERM_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, LONG_TERM_SCORE_CAPS[kanji]);
  if (['high', 'medium'].includes(confidenceLevel) && riskLevel !== 'high') {
    if (STRONG_AESTHETIC_WORDS.includes(kanji)) nextScore = Math.max(85, Math.min(92, nextScore < 85 ? 88 : nextScore));
    if (STRONG_FANDOM_WORDS.includes(kanji)) nextScore = Math.max(82, Math.min(90, nextScore < 82 ? 86 : nextScore));
    if (STRONG_LIFESTYLE_WORDS.includes(kanji)) nextScore = Math.max(82, Math.min(88, nextScore < 82 ? 86 : nextScore));
  }
  return nextScore;
}

function inferDisplayBucket({
  kanji,
  candidateType,
  confidenceLevel,
  evidenceType,
  freshness,
  riskLevel,
  suggestedAction,
  xhsFitScore,
  emotionTone,
  expressionValueScore,
  text
}) {
  const memeFastEligible = ['新鲜梗词', '网络口语词', '圈层词'].includes(candidateType)
    && ['low', 'medium'].includes(riskLevel)
    && ['high', 'medium'].includes(confidenceLevel)
    && ['common_usage', 'trend_claim', 'ai_inferred'].includes(evidenceType)
    && ['尽快判断', '可以收藏观察'].includes(suggestedAction);
  if (BLOCK_WORDS[kanji] || BLOCK_PATTERN.test(text) || (riskLevel === 'high' && suggestedAction === '不建议')) return 'blocked';
  if (REVIEW_WORDS[kanji]) return 'review';
  if (BUCKET_OVERRIDES[kanji]) return BUCKET_OVERRIDES[kanji];
  if (riskLevel === 'high' || candidateType === '高风险话题词') return 'review';
  if (hasEntityReviewRisk(kanji, text)) return 'review';
  if (UNCERTAIN_PATTERN.test(text) && !['common_usage', 'user_material'].includes(evidenceType) && !memeFastEligible) return 'review';
  if (confidenceLevel === 'review') return 'review';
  if (evidenceType === 'unknown' && candidateType !== '稳定候选') return 'review';
  if (SEASONAL_PATTERN.test(text) || freshness === '短期') return 'seasonal';
  if (isGenericTopicWord({ kanji, candidateType, reason: text }) || clampNumber(expressionValueScore, 0, 100) < 55) return 'long_term';
  if (emotionTone === 'negative') return 'meme_fast';
  if (memeFastEligible) return 'meme_fast';
  if (riskLevel === 'low'
    && ['high', 'medium'].includes(confidenceLevel)
    && ['稳定候选', '审美氛围词', '美妆穿搭词', '生活方式词', '追星兴趣词'].includes(candidateType)
    && xhsFitScore >= 78
    && clampNumber(expressionValueScore, 0, 100) >= 70
    && !SEASONAL_PATTERN.test(text)) {
    return 'today';
  }
  return 'long_term';
}

function normalizeItem(item = {}) {
  const rawKanji = cleanText(item.kanji, 80);
  const kanji = normalizeKanjiSpelling(rawKanji);
  if (!kanji) return null;
  let riskLevel = cleanEnum(item.riskLevel, RISK_LEVELS, 'low');
  let confidenceLevel = cleanEnum(item.confidenceLevel, CONFIDENCE_LEVELS, 'low');
  let evidenceType = cleanEnum(item.evidenceType, EVIDENCE_TYPES, 'unknown');
  let reviewReason = cleanText(item.reviewReason, 500);
  let reviewReasonType = cleanEnum(item.reviewReasonType, REVIEW_REASON_TYPES, '');
  let candidateType = cleanEnum(item.candidateType, CANDIDATE_TYPES, riskLevel === 'high' ? '高风险话题词' : '网络口语词');
  let freshness = cleanEnum(item.freshness, FRESHNESS, '中期');
  let suggestedAction = cleanEnum(item.suggestedAction, SUGGESTED_ACTIONS, confidenceLevel === 'review' ? '暂缓' : '可以收藏观察');
  const category = cleanText(item.category, 80);
  const meaning = cleanText(item.meaning, 240);
  const reason = cleanText(item.reason, 1000);
  let emotionTone = inferEmotionTone(kanji, { ...item, candidateType }, 'neutral');
  let riskWarning = cleanText(item.riskWarning, 500);
  const uncertaintyText = [kanji, meaning, reason, reviewReason, riskWarning, category].join(' ');
  reviewReasonType = reviewReasonType || inferReviewReasonType(kanji, uncertaintyText, '');
  const blockReason = BLOCK_WORDS[kanji] || (BLOCK_PATTERN.test(uncertaintyText) ? '含攻击性、辱骂、死亡诅咒或歧视类表达。' : '');
  const reviewWordReason = REVIEW_WORDS[kanji] || '';
  const overrideBucket = BUCKET_OVERRIDES[kanji] || '';
  const lowRiskMemeEvidence = ['新鲜梗词', '网络口语词', '圈层词'].includes(candidateType)
    && ['low', 'medium'].includes(riskLevel)
    && ['common_usage', 'trend_claim', 'ai_inferred'].includes(evidenceType);
  if (blockReason) {
    riskLevel = 'high';
    confidenceLevel = 'review';
    emotionTone = 'negative';
    suggestedAction = '不建议';
    reviewReasonType = 'offensive';
    reviewReason = appendReason(reviewReason, blockReason);
    riskWarning = appendReason(riskWarning, blockReason);
  } else if (reviewWordReason) {
    confidenceLevel = 'review';
    suggestedAction = '暂缓';
    reviewReasonType = reviewReasonType || inferReviewReasonType(kanji, `${uncertaintyText} ${reviewWordReason}`, 'uncertain_usage');
    reviewReason = appendReason(reviewReason, reviewWordReason);
  } else if (overrideBucket && ['today', 'meme_fast', 'seasonal', 'long_term'].includes(overrideBucket) && riskLevel !== 'high') {
    if (['today', 'meme_fast'].includes(overrideBucket) && evidenceType === 'unknown') evidenceType = 'common_usage';
    if (confidenceLevel === 'low' || confidenceLevel === 'review') confidenceLevel = 'medium';
  } else if (lowRiskMemeEvidence && confidenceLevel === 'review' && !/(疑似|错误|錯誤|不确定|不確定|需核验|需核驗|缩写|縮写|源于|自创|自創|合成词|合成詞)/i.test(reviewReason)) {
    confidenceLevel = 'medium';
  }
  if (kanji === 'テン') {
    confidenceLevel = 'review';
    suggestedAction = '暂缓';
    reviewReasonType = 'uncertain_usage';
    reviewReason = appendReason(reviewReason, '作为テンション缩略语不确定，需核验真实语境。');
  }
  if (!blockReason && !reviewWordReason && UNCERTAIN_PATTERN.test(uncertaintyText) && !['common_usage', 'user_material'].includes(evidenceType) && !lowRiskMemeEvidence && !overrideBucket) {
    confidenceLevel = 'review';
    suggestedAction = '暂缓';
    reviewReasonType = reviewReasonType || 'uncertain_usage';
    reviewReason = appendReason(reviewReason, reviewReasonForType(reviewReasonType));
  }
  if (!blockReason && !reviewWordReason && hasEntityReviewRisk(kanji, uncertaintyText)) {
    confidenceLevel = 'review';
    suggestedAction = '暂缓';
    reviewReasonType = inferReviewReasonType(kanji, uncertaintyText, reviewReasonType || 'ip_brand_role');
    reviewReason = appendReason(reviewReason, reviewReasonForType(reviewReasonType));
  }
  if (riskLevel === 'high' || candidateType === '高风险话题词' || ((evidenceType === 'unknown' && candidateType !== '稳定候选') && !overrideBucket)) {
    confidenceLevel = 'review';
    suggestedAction = riskLevel === 'high' ? '暂缓' : suggestedAction;
    reviewReasonType = reviewReasonType || (riskLevel === 'high' ? 'offensive' : 'uncertain_usage');
    reviewReason = appendReason(reviewReason, riskLevel === 'high' ? reviewReasonForType(reviewReasonType) : '证据来源未知，需要核验真实用法。');
  }
  let xhsFitScore = Math.max(0, Math.min(100, Number.parseInt(item.xhsFitScore, 10) || 0));
  const genericTopicWord = isGenericTopicWord({ ...item, kanji, candidateType, reason, reviewReason, riskWarning });
  let expressionValueScore = getExpressionValueScore({ ...item, kanji, candidateType, reason, reviewReason, riskWarning });
  if (genericTopicWord) {
    expressionValueScore = Math.min(expressionValueScore, 68);
    xhsFitScore = Math.min(xhsFitScore || 60, 74);
    suggestedAction = suggestedAction === '不建议' ? '不建议' : '可以收藏观察';
    reviewReason = appendReason(reviewReason, '偏泛话题词，需要更具体场景或标题包装后再进入每日热门。');
  }
  if (xhsFitScore >= 85 && !['high', 'medium'].includes(confidenceLevel)) xhsFitScore = 70;
  const ordinaryWithoutStrongReason = ORDINARY_CATEGORIES.includes(category)
    && !/(小红书|标题|封面|收藏|评论|口播|场景|误解|共鸣|视觉)/.test(reason);
  if (ordinaryWithoutStrongReason) xhsFitScore = Math.min(xhsFitScore || 60, 78);
  if (candidateType === '新鲜梗词') {
    freshness = freshness === '长期' ? '需要尽快判断' : freshness;
    if (!['high', 'medium'].includes(confidenceLevel)) {
      reviewReasonType = reviewReasonType || 'uncertain_usage';
      reviewReason = appendReason(reviewReason, '新鲜梗词有过期风险，建议尽快人工判断。');
    }
  }
  if (kanji === 'マジ卍') {
    reviewReasonType = 'too_basic';
    reviewReason = appendReason(reviewReason, '过气梗，不作为今日热门');
  }
  if (confidenceLevel === 'review' && !reviewReasonType) reviewReasonType = inferReviewReasonType(kanji, uncertaintyText, 'uncertain_usage');
  if (confidenceLevel === 'review' && !reviewReason) reviewReason = reviewReasonForType(reviewReasonType);
  xhsFitScore = calibrateScore(kanji, xhsFitScore, { riskLevel, confidenceLevel, emotionTone, reviewReasonType });
  if (lowRiskMemeEvidence && confidenceLevel !== 'review' && suggestedAction === '暂缓') suggestedAction = '可以收藏观察';
  const inferredBucket = inferDisplayBucket({
      kanji,
      candidateType,
      confidenceLevel,
      evidenceType,
      freshness,
      riskLevel,
      suggestedAction,
      xhsFitScore,
      emotionTone,
      expressionValueScore,
      text: uncertaintyText
    });
  const displayBucket = inferredBucket;
  if (displayBucket === 'blocked') suggestedAction = '不建议';
  if (displayBucket === 'review') suggestedAction = suggestedAction === '不建议' ? '不建议' : '暂缓';
  if (displayBucket === 'meme_fast') {
    freshness = freshness === '长期' ? '需要尽快判断' : freshness;
    if (!['尽快判断', '可以收藏观察'].includes(suggestedAction)) suggestedAction = '可以收藏观察';
  }
  return {
    kanji,
    romaji: cleanText(item.romaji, 120),
    kana: cleanText(item.kana, 120),
    meaning,
    category,
    candidateType,
    freshness,
    expressionValueScore,
    accountLearningTone: getAccountLearningTone({ ...item, kanji, candidateType, emotionTone }),
    accountLearningBonus: getAccountLearningBonus({ ...item, kanji, candidateType, emotionTone, expressionValueScore }),
    xhsFitScore,
    riskLevel,
    riskWarning,
    confidenceLevel,
    evidenceType,
    reviewReason,
    reviewReasonType,
    displayBucket,
    emotionTone,
    reason,
    suggestedAction,
    examples: cleanArray(item.examples, 5).map(normalizeExample).filter(example => example.jp || example.cn),
    suggestedTitles: cleanArray(item.suggestedTitles, 8).map(title => cleanText(title, 140)).filter(Boolean),
    coverSuggestion: {
      coverText: cleanText(item.coverSuggestion?.coverText, 120),
      mainVisual: cleanText(item.coverSuggestion?.mainVisual, 240),
      style: cleanText(item.coverSuggestion?.style, 160),
      avoid: cleanText(item.coverSuggestion?.avoid, 240)
    }
  };
}

function normalizeDeepSeekData(data, payload, model) {
  const items = cleanArray(data?.items, 80)
    .map(normalizeItem)
    .filter(Boolean)
    .filter(item => payload.preferences.includeHighRisk !== 'exclude' || item.riskLevel !== 'high')
    .slice(0, payload.count);
  const needsReviewCount = items.filter(item => ['review', 'blocked'].includes(item.displayBucket)).length;
  return {
    items,
    summary: {
      batchTitle: cleanText(data?.summary?.batchTitle || 'AI灵感扩词', 120),
      trendNotes: cleanText(data?.summary?.trendNotes || '', 1000),
      needsReviewCount
    },
    usage: {
      model,
      createdAt: new Date().toISOString(),
      action: payload.action
    }
  };
}

function splitPayload(payload) {
  if (['audit_library_for_delete', 'audit_missing_library_words'].includes(payload.action) && payload.count > MAX_SINGLE_DEEPSEEK_COUNT) {
    let items = cleanArray(payload.items, 80);
    if (!items.length) {
      try {
        const parsed = JSON.parse(payload.input || '[]');
        items = cleanArray(Array.isArray(parsed) ? parsed : parsed.items, 80);
      } catch (error) {
        items = [];
      }
    }
    if (items.length <= MAX_SINGLE_DEEPSEEK_COUNT) return [payload];
    const parts = [];
    for (let index = 0; index < items.length; index += BATCH_DEEPSEEK_COUNT) {
      const partItems = items.slice(index, index + BATCH_DEEPSEEK_COUNT);
      parts.push({
        ...payload,
        count: partItems.length,
        items: partItems,
        input: JSON.stringify(partItems),
        batchHint: `历史种子审核拆分批次 ${Math.floor(index / BATCH_DEEPSEEK_COUNT) + 1}/${Math.ceil(items.length / BATCH_DEEPSEEK_COUNT)}`
      });
    }
    return parts;
  }
  if (payload.count <= MAX_SINGLE_DEEPSEEK_COUNT || ['rerank_candidates', 'generate_word_card'].includes(payload.action)) return [payload];
  const parts = [];
  let remaining = payload.count;
  let batchIndex = 1;
  const totalBatches = Math.ceil(payload.count / BATCH_DEEPSEEK_COUNT);
  while (remaining > 0) {
    const count = Math.min(BATCH_DEEPSEEK_COUNT, remaining);
    const focus = BATCH_FOCUS_AREAS[(batchIndex - 1) % BATCH_FOCUS_AREAS.length];
    parts.push({
      ...payload,
      count,
      batchHint: `这是第 ${batchIndex}/${totalBatches} 批，本批只聚焦：${focus}。请生成与其他批次尽量不重复的候选词。`
    });
    remaining -= count;
    batchIndex += 1;
  }
  return parts;
}

function mergeDeepSeekResults(results, payload, model) {
  const successful = results.filter(result => result.ok && result.data);
  if (!successful.length) {
    return results[0] || { ok: false, status: 502, error: 'DeepSeek request failed' };
  }
  const seen = new Set();
  const items = [];
  for (const result of successful) {
    for (const item of cleanArray(result.data.items, 80)) {
      if (!item.kanji || seen.has(item.kanji)) continue;
      seen.add(item.kanji);
      items.push(item);
      if (items.length >= payload.count) break;
    }
    if (items.length >= payload.count) break;
  }
  const failedCount = results.length - successful.length;
  const trendNotes = successful
    .map(result => cleanText(result.data.summary?.trendNotes, 300))
    .filter(Boolean)
    .join('；');
  const mergedData = {
    ok: true,
    data: {
      items,
      summary: {
        batchTitle: successful[0].data.summary?.batchTitle || 'AI灵感扩词',
        trendNotes: failedCount ? `${trendNotes}；部分批次生成失败，已返回成功批次结果。` : trendNotes,
        needsReviewCount: items.filter(item => ['review', 'blocked'].includes(item.displayBucket)).length
      },
      usage: {
        model,
        createdAt: new Date().toISOString(),
        action: payload.action,
        promptVersion: getPromptVersion(payload.action),
        inputHash: getInputHash(payload),
        rawOutput: cleanText(JSON.stringify(successful.map((result, index) => ({
          batch: index + 1,
          rawOutput: result.data.usage?.rawOutput || '',
          reviewResult: result.data.usage?.reviewResult || 'accepted'
        }))), 8000),
        normalizedOutput: summarizeNormalizedOutput({ items, summary: successful[0].data.summary || {} }),
        reviewResult: successful.some(result => result.data.usage?.reviewResult === 'edited') ? 'edited' : 'accepted',
        requestedCount: payload.count,
        returnedCount: items.length,
        batchCount: results.length,
        failedBatchCount: failedCount
      }
    }
  };
  return mergedData;
}

function getTemperature(action) {
  if (action === 'stable_today') return 0.4;
  if (action === 'wild_ideas' || action === 'generate_candidates') return 0.85;
  if (action === 'extract_from_materials') return 0.3;
  if (action === 'enrich_words' || action === 'generate_word_card') return 0.5;
  if (action === 'audit_library_for_delete' || action === 'audit_missing_library_words') return 0.25;
  if (action === 'rerank_candidates') return 0.25;
  return 0.5;
}

function getSystemPromptForAction(payload) {
  if (payload.action === 'generate_word_card') return buildWordCardSystemPrompt();
  if (payload.action === 'audit_library_for_delete') return buildLibraryAuditSystemPrompt();
  if (payload.action === 'audit_missing_library_words') return buildMissingLibraryAuditSystemPrompt();
  return buildSystemPrompt();
}

function getUserPromptForAction(payload) {
  if (payload.action === 'generate_word_card') return buildWordCardUserPrompt(payload);
  if (payload.action === 'audit_library_for_delete') return buildLibraryAuditUserPrompt(payload);
  if (payload.action === 'audit_missing_library_words') return buildMissingLibraryAuditUserPrompt(payload);
  return buildUserPrompt(payload);
}

function getMaxTokensForAction(payload) {
  if (payload.action === 'generate_word_card') return Math.min(12000, Math.max(4200, payload.count * 1600));
  if (payload.action === 'audit_library_for_delete') return Math.min(12000, Math.max(3600, payload.count * 230));
  if (payload.action === 'audit_missing_library_words') return Math.min(12000, Math.max(4200, payload.count * 320));
  return payload.count >= 20 ? 5600 : payload.count >= 10 ? 4200 : 3200;
}

function normalizeDataForAction(parsedContent, payload, model) {
  if (payload.action === 'generate_word_card') return normalizeWordCardData(parsedContent, payload, model);
  if (payload.action === 'audit_library_for_delete') return normalizeLibraryAuditData(parsedContent, payload, model);
  if (payload.action === 'audit_missing_library_words') return normalizeLibraryAuditData(parsedContent, payload, model);
  return normalizeDeepSeekData(parsedContent, payload, model);
}

async function callSingleDeepSeek(env, payload, retryIndex = 0) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const model = cleanText(env.DEEPSEEK_MODEL || 'deepseek-v4-flash', 120);
  const controller = new AbortController();
  const timeoutMs = ['audit_library_for_delete', 'audit_missing_library_words'].includes(payload.action) ? 95000 : 75000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: getSystemPromptForAction(payload) },
          { role: 'user', content: getUserPromptForAction(payload) }
        ],
        temperature: getTemperature(payload.action),
        max_tokens: getMaxTokensForAction(payload),
        response_format: { type: 'json_object' }
      })
    });
    const responseBody = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `DeepSeek API error ${response.status}`,
        details: cleanText(responseBody, 500)
      };
    }
    const apiData = extractJsonObject(responseBody);
    const content = extractMessageContent(apiData?.choices?.[0]?.message?.content || '');
    let parsedContent = extractJsonObject(content);
    let reviewResult = 'accepted';
    if (!parsedContent && content) {
      parsedContent = await repairJsonContent(env, payload, content);
      if (parsedContent) reviewResult = 'edited';
    }
    if (!parsedContent && retryIndex < 1) return callSingleDeepSeek(env, payload, retryIndex + 1);
    if (!parsedContent) {
      return { ok: false, status: 502, error: 'DeepSeek returned non-JSON content' };
    }
    const normalizedData = attachUsageTrace(normalizeDataForAction(parsedContent, payload, model), payload, model, content, reviewResult);
    return {
      ok: true,
      data: normalizedData
    };
  } catch (error) {
    if (retryIndex < 1 && error?.name !== 'AbortError') return callSingleDeepSeek(env, payload, retryIndex + 1);
    return {
      ok: false,
      status: error?.name === 'AbortError' ? 504 : 502,
      error: error?.name === 'AbortError' ? 'DeepSeek request timed out' : 'DeepSeek request failed'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callDeepSeek(env, payload) {
  const model = cleanText(env.DEEPSEEK_MODEL || 'deepseek-v4-flash', 120);
  const payloads = splitPayload(payload);
  if (payloads.length === 1) return callSingleDeepSeek(env, payload);
  const results = await Promise.all(payloads.map(batchPayload => callSingleDeepSeek(env, batchPayload)));
  let merged = mergeDeepSeekResults(results, payload, model);
  let fillAttempts = 0;
  while (merged.ok && merged.data.items.length < payload.count && fillAttempts < 3) {
    const existingWords = [
      ...cleanArray(payload.context?.existingCandidates, 160).map(item => typeof item === 'string' ? item : item?.kanji).filter(Boolean),
      ...merged.data.items.map(item => item.kanji)
    ];
    const missingCount = Math.min(BATCH_DEEPSEEK_COUNT, payload.count - merged.data.items.length);
    const focus = BATCH_FOCUS_AREAS[(payloads.length + fillAttempts) % BATCH_FOCUS_AREAS.length];
    const fillPayload = {
      ...payload,
      count: missingCount,
      avoidWords: existingWords,
      context: {
        ...payload.context,
        existingCandidates: existingWords
      },
      batchHint: `补齐批次：当前只拿到 ${merged.data.items.length}/${payload.count} 个唯一词。本批只聚焦：${focus}。必须避开 avoidWords，补充全新的候选词。`
    };
    results.push(await callSingleDeepSeek(env, fillPayload));
    merged = mergeDeepSeekResults(results, payload, model);
    fillAttempts += 1;
  }
  if (merged.ok && fillAttempts) {
    merged.data.usage.fillAttempts = fillAttempts;
  }
  return merged;
}

export async function onRequest({ request, env }) {
  const methods = ['POST', 'OPTIONS'];
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods, requestId });
  const fail = (status, code, message, options = {}) => errorResponse(request, env, status, code, message, { methods, requestId, ...options });

  if (request.method === 'OPTIONS') {
    return optionsResponse(request, env, methods);
  }
  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  const authorization = await authorizeRequest(request, env, { allowAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods, requestId });
  if (!env.DEEPSEEK_API_KEY) {
    return fail(503, 'AI_NOT_CONFIGURED', 'DEEPSEEK_API_KEY is not configured');
  }

  const rateLimit = await enforceRateLimit(env.FAVORITES, `ai:${authorization.actor}`, { limit: 12, windowSeconds: 60 });
  if (!rateLimit.ok) {
    return fail(429, 'RATE_LIMITED', 'AI 请求过于频繁，请稍后重试', { retryable: true });
  }

  const parsed = await readJsonBody(request, { maxBytes: API_LIMITS.ai });
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
  const body = parsed.value;

  const action = ACTIONS.includes(body.action) ? body.action : '';
  if (!action) return fail(400, 'INVALID_ACTION', 'Invalid action');

  const payload = {
    action,
    input: cleanText(body.input, 12000),
    items: cleanArray(body.items, 50),
    rules: body.rules || {},
    count: cleanCount(body.count),
    preferences: {
      includeMemes: Boolean(body.preferences?.includeMemes),
      includeHighRisk: ['exclude', 'review_only'].includes(body.preferences?.includeHighRisk) ? body.preferences.includeHighRisk : 'review_only',
      readingFormat: body.preferences?.readingFormat === 'romaji_kana' ? 'romaji_kana' : 'romaji_kana'
    },
    context: body.context || {}
  };

  const result = await callDeepSeek(env, payload);
  if (!result.ok) {
    const status = result.status || 502;
    return respond({
      ok: false,
      error: {
        code: status === 429 ? 'AI_RATE_LIMITED' : 'AI_REQUEST_FAILED',
        message: result.error,
        details: result.details || '',
        retryable: status === 429 || status >= 500
      },
      items: [],
      summary: {
        batchTitle: 'AI生成失败',
        trendNotes: '',
        needsReviewCount: 0
      },
      usage: {
        model: cleanText(env.DEEPSEEK_MODEL || 'deepseek-v4-flash', 120),
        createdAt: new Date().toISOString(),
        action,
        promptVersion: getPromptVersion(action),
        inputHash: getInputHash(payload),
        rawOutput: '',
        normalizedOutput: '',
        reviewResult: 'rejected'
      }
    }, status);
  }

  return respond({ ok: true, ...result.data });
}

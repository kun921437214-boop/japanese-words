import { createApiClient } from './frontend/api-client.mjs';
import {
  AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY,
  buildTodayAiCardsRequest,
  buildWordCardRequestPayload as buildAiCardRequestPayload,
  canAutoGenerateAiCard,
  getSingleTodayAiCardGenerationOptions,
  getTodayAiCardActionState,
  isAiCardStalePending,
  selectMissingTodayAiCardKanjis
} from './frontend/ai-card-generation.mjs';
import {
  buildAutoAiCandidatePayload,
  requestAutoAiCandidateBatch
} from './frontend/ai-candidate-service.mjs';
import { createAppShellController } from './frontend/app-shell.mjs';
import {
  buildFavoriteSelectionExportText,
  buildRecommendationAuditCsv,
  getRecommendationAuditFilename
} from './frontend/content-export.mjs';
import {
  buildDailyHotDateOptions,
  buildDailyHotSourceFilterModel,
  buildHistoryNavigationModel,
  createDailyHotPageController,
  normalizeDailyHotDateSelection
} from './frontend/daily-hot-page.mjs';
import {
  buildFavoritesPageModel,
  createFavoritesPageController,
  normalizeFavoriteStatus,
  normalizeFavoriteStatusFilter,
  transitionFavoriteStatus,
  transitionFavoriteToggle
} from './frontend/favorites-page.mjs';
import { createImageFallbackController } from './frontend/image-fallback.mjs';
import { createManualWordModalController } from './frontend/manual-word-modal.mjs';
import { createModalActionsController } from './frontend/modal-actions.mjs';
import { parseXiaohongshuSharePayload } from './frontend/published-record-parser.mjs';
import {
  buildPublishedPageModel,
  createPublishedPageController,
  getPublishedAutoRefreshSummary,
  ratePublishedRecord
} from './frontend/published-page.mjs';
import { buildWordCardViewModel } from './frontend/word-card-view.mjs';
import { createWorkflowActionsController } from './frontend/workflow-actions.mjs';
import {
  MAX_WORKFLOW_BACKUP_BYTES,
  buildWorkflowBackup,
  formatWorkflowBackupSummary,
  getWorkflowBackupFilename,
  parseWorkflowBackupText,
  serializeWorkflowBackup
} from './frontend/workflow-backup.mjs';
import { createWorkflowCache, DEFAULT_CANDIDATE_LIMIT } from './frontend/workflow-cache.mjs';
import { createWorkflowStore } from './frontend/workflow-store.mjs';
import { createWorkflowSync } from './frontend/workflow-sync.mjs';
import {
  cleanHistorySnapshot as cleanSharedHistorySnapshot,
  cleanHistorySnapshots as cleanSharedHistorySnapshots,
  cleanTodaySnapshot as cleanSharedTodaySnapshot,
  cleanTodaySnapshotHistory as cleanSharedTodaySnapshotHistory,
  mergeHistorySnapshots as mergeSharedHistorySnapshots,
  mergeTodaySnapshot as mergeSharedTodaySnapshot,
  mergeTodaySnapshotHistory as mergeSharedTodaySnapshotHistory
} from './shared/workflow-schema.mjs';

/* ═══════════════════════════════════════════
   记忆面包 — 小红书日语选题推荐系统（Phase 1）
   保持旧收藏 / 状态 / Cloudflare KV 兼容
   ═══════════════════════════════════════════ */

let rankingTodayWords = [];
let rankingHistoryWords = {};
let rankingHistoryDates = [];
let todayWords = [];
let favorites = [];
let favoriteStatuses = {};
let wordFeedback = {};
let publishedRecords = [];
let candidatePool = {};
let aiBatches = [];
let todaySnapshot = {};
let historySnapshots = {};
let todaySnapshotHistory = [];
let libraryReviewRecords = {};
let libraryAuditCoverage = {
  total: 0,
  reviewed: 0,
  missing: 0,
  protected: 0,
  removed: 0,
  approved: 0,
  review: 0,
  missingWords: []
};
let aiPreview = {};
let todayDismissed = { dateKey: '', words: [], updatedAt: '' };
let todayRecoveryPromise = null;
let autoDailyRefreshPromise = null;
let isAutoDailyRefreshRunning = false;
let aiCardAutoQueuePromise = null;
let aiCardAutoInFlight = new Set();
let currentWordForModal = null;
let currentPublishedRecordId = null;
let activeStatusMenuKanji = null;
let activeFeedbackMenuKanji = null;
let lastCloudSyncAt = '';
let lastLocalCacheAt = '';
let cloudWorkflowFailed = false;
let codexTomorrowDraftStatus = null;
let codexTomorrowDraft = null;
let codexTomorrowDraftPromise = null;
let codexTomorrowDraftError = '';

const FAVORITES_STORAGE_KEY = 'kotoba_favorites';
const FAVORITE_STATUSES_STORAGE_KEY = 'kotoba_favorite_statuses';
const WORKFLOW_STORAGE_KEY = 'kotoba_workflow_state_v2';
const AI_PREVIEW_STORAGE_KEY = 'kotoba_ai_preview_state';
const AUTO_DAILY_REFRESH_KEY = 'kotoba_auto_daily_refresh_state';
const AI_CARD_AUTO_ATTEMPTS_KEY = 'kotoba_ai_card_auto_attempts';
const CANDIDATE_POOL_RETENTION_DAYS = 30;
const CANDIDATE_POOL_BOOTSTRAP_SIZE = 300;
const CANDIDATE_POOL_DAILY_INTAKE = 50;
const CANDIDATE_POOL_MIN_SCORE = 60;
const TODAY_HISTORY_DEDUP_DAYS = 30;
const TODAY_HISTORY_DEDUP_RELAX_STEPS = [TODAY_HISTORY_DEDUP_DAYS];
const ACTIVE_TAB_STORAGE_KEY = 'kotoba_active_tab';
const SOURCE_FILTER_STORAGE_PREFIX = 'kotoba_source_filter_';
const STATUS_FILTER_STORAGE_KEY = 'kotoba_status_filter';
const HISTORY_DATE_STORAGE_KEY = 'kotoba_history_date';
const DAILY_HOT_DATE_STORAGE_KEY = 'kotoba_daily_hot_date';
const TODAY_DISMISSED_STORAGE_KEY = 'kotoba_today_dismissed';
const TODAY_SNAPSHOT_VERSION = 1;
const TODAY_SNAPSHOT_GENERATOR_VERSION = 'daily-v4-dedup30-server';
const AUTO_DAILY_REFRESH_RUNNING_TTL_MS = 3 * 60 * 1000;
const LEGACY_SYNC_CODE_STORAGE_KEY = 'kotoba_sync_code';
const SYNC_API_URL = normalizeSyncApiUrl(window.KOTOBA_SYNC_API_URL);
const APP_TIME_ZONE = 'Asia/Shanghai';
const RANKINGS_DAYS = 30;
const WORDS_PER_DAY = 20;
const FAVORITE_STATUS_ORDER = ['none', 'pending', 'published'];
const FAVORITE_STATUS_LABELS = {
  none: '已收藏',
  pending: '待发布',
  published: '已发布'
};
const CONFIDENCE_LABELS = {
  high: '高',
  medium: '中',
  low: '低',
  review: '需复核'
};
const NEGATIVE_FEEDBACK_TYPES = {
  uninterested: '不感兴趣',
  tooBasic: '太普通',
  tooTextbook: '太教材',
  notForXhs: '不适合小红书',
  inaccurate: '解释不准',
  tooRisky: '风险太高',
  tooNiche: '太小众',
  notFresh: '不够新鲜',
  tooMeme: '太梗/容易过期',
  badVisual: '不好配图',
  badTitle: '不好做标题',
  notMyTone: '不符合账号调性'
};
const AI_ACTION_LABELS = {
  stable_today: '稳定今日候选',
  wild_ideas: '野生灵感扩词',
  generate_candidates: 'AI 自己找词',
  extract_from_materials: '从素材提词',
  enrich_words: '给定词生成词卡',
  generate_word_card: '生成 DeepSeek 词卡',
  rerank_candidates: '根据反馈重新推荐',
  audit_library_for_delete: 'AI 清洗历史种子数据',
  audit_missing_library_words: '历史种子复核'
};
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
const RECOMMENDATION_ORIGIN_TYPES = Object.keys(RECOMMENDATION_ORIGIN_LABELS);
const AUDIT_SPELLING_SUGGESTIONS = {
  '痛バック': '建议修正为「痛バッグ」',
  'オーバサイズ': '建议修正为「オーバーサイズ」'
};
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
const CANDIDATE_TYPE_OPTIONS = ['稳定候选', '新鲜梗词', '审美氛围词', '美妆穿搭词', '追星兴趣词', '生活方式词', '网络口语词', '圈层词', '高风险话题词'];
const FRESHNESS_OPTIONS = ['长期', '中期', '短期', '需要尽快判断'];
const SUGGESTED_ACTION_OPTIONS = ['优先收藏观察', '可以收藏观察', '尽快判断', '暂缓', '不建议'];
const RISK_LEVEL_OPTIONS = ['low', 'medium', 'high'];
const CONFIDENCE_LEVEL_OPTIONS = ['high', 'medium', 'low', 'review'];
const EVIDENCE_TYPE_OPTIONS = ['common_usage', 'ai_inferred', 'user_material', 'trend_claim', 'unknown'];
const EMOTION_TONE_OPTIONS = ['positive', 'neutral', 'negative', 'aesthetic', 'lifestyle', 'fandom'];
const REVIEW_REASON_TYPE_OPTIONS = ['uncertain_usage', 'too_niche', 'possible_wrong_meaning', 'ip_brand_role', 'privacy_sensitive', 'offensive', 'too_basic'];
const AI_REVIEW_WORDS = {
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
const AI_REVIEW_REASON_OVERRIDES = {
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
const AI_BLOCK_WORDS = {
  'デカ耳': '解释疑似错误，不应作为大耳狗词条导入',
  'しね': '攻击性/死亡诅咒表达，不建议导入'
};
const AI_BUCKET_OVERRIDES = {
  '透け感': { bucket: 'today' },
  '抜け感': { bucket: 'today' },
  'こなれ': { bucket: 'today' },
  'ヌーディー': { bucket: 'today' },
  'ヌーディ': { bucket: 'today' },
  'モノトーン': { bucket: 'today' },
  'ベージュトーン': { bucket: 'today' },
  'しっとり': { bucket: 'today' },
  'ふんわり': { bucket: 'today' },
  'アンニュイ': { bucket: 'today' },
  'ツヤ感': { bucket: 'today' },
  'マット': { bucket: 'today' },
  '清潔感': { bucket: 'today' },
  'レイヤード': { bucket: 'long_term' },
  'グッズ': { bucket: 'today' },
  '聖地巡礼': { bucket: 'today' },
  '布教': { bucket: 'today' },
  '朝活': { bucket: 'long_term' },
  '朝焼け': { bucket: 'today' },
  '家計簿': { bucket: 'today' },
  '断捨離': { bucket: 'today' },
  '時短料理': { bucket: 'today' },
  '勉強法': { bucket: 'today' },
  'チルい': { bucket: 'today' },
  '沼': { bucket: 'meme_fast' },
  'おしゃれ': { bucket: 'today' },
  'パーソナルカラー': { bucket: 'today' },
  '草': { bucket: 'meme_fast' },
  'ウケる': { bucket: 'meme_fast' },
  '詰んだ': { bucket: 'meme_fast' },
  'ワロタ': { bucket: 'meme_fast' },
  'パない': { bucket: 'meme_fast' },
  '神': { bucket: 'meme_fast' },
  'ムカつく': { bucket: 'meme_fast' },
  'イライラ': { bucket: 'meme_fast' },
  'キレる': { bucket: 'meme_fast' },
  'グチる': { bucket: 'meme_fast' },
  'うざい': { bucket: 'meme_fast' },
  'めんどい': { bucket: 'meme_fast' },
  'イチャモン': { bucket: 'meme_fast' },
  'テンション': { bucket: 'today' },
  'モヤる': { bucket: 'meme_fast' },
  '即買い': { bucket: 'meme_fast' },
  'テン': { bucket: 'review', reviewReason: '作为テンション缩略语不确定，需核验真实语境' },
  '自担': { bucket: 'meme_fast' },
  '箱推し': { bucket: 'meme_fast' },
  '推し増し': { bucket: 'meme_fast' },
  '同担': { bucket: 'meme_fast' },
  '痛バ': { bucket: 'meme_fast' },
  'ビビる': { bucket: 'long_term' },
  'バレンタイン': { bucket: 'seasonal' },
  'ホワイトデー': { bucket: 'seasonal' },
  'クリスマス': { bucket: 'seasonal' },
  'お盆': { bucket: 'seasonal' },
  'マジ卍': { bucket: 'review', reviewReason: '过气梗，不作为今日热门' },
  '壁ドン': { bucket: 'meme_fast' },
  '陰キャ': { bucket: 'meme_fast' },
  '陽キャ': { bucket: 'meme_fast' },
  '爆イケ': { bucket: 'meme_fast' },
  'おつおつ': { bucket: 'meme_fast' },
  '推し変': { bucket: 'meme_fast' },
  'ドヤ顔': { bucket: 'meme_fast' },
  'カップル': { bucket: 'long_term' },
  'デート': { bucket: 'long_term' },
  'ペアリング': { bucket: 'long_term' },
  '読書感想文': { bucket: 'long_term' },
  'おうち時間': { bucket: 'long_term' },
  '円盤': { bucket: 'long_term' },
  'コスプレ': { bucket: 'long_term' },
  'ベージュ': { bucket: 'long_term' },
  'マスタード': { bucket: 'long_term' },
  'アシメトリー': { bucket: 'long_term' }
};
const AI_BASIC_SCORE_CAPS = {
  '草': 82,
  'ワロタ': 82,
  'ウケる': 82,
  'カップル': 82,
  'デート': 82,
  'ビビる': 82,
  '神': 82
};
const AI_OLD_MEME_SCORE_CAPS = { 'マジ卍': 65 };
const AI_NICHE_SCORE_CAPS = {
  'オタサー': 78,
  'バ美声': 78,
  'ぬるぬる': 78,
  'にわか': 78
};
const AI_UNCERTAIN_SCORE_CAPS = {
  '夢み': 70,
  'すき': 70
};
const AI_NEGATIVE_SCORE_CAPS = {
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
const AI_HIGH_RISK_SCORE_CAPS = { 'キモい': 60, 'ガチ恋': 60 };
const AI_LONG_TERM_SCORE_CAPS = {
  'ペアリング': 82,
  '読書感想文': 82,
  'おうち時間': 82,
  '円盤': 82,
  'コスプレ': 82
};
const AI_STRONG_AESTHETIC_WORDS = ['透け感', '抜け感', 'こなれ', 'ヌーディー', 'ヌーディ', 'ベージュトーン', 'しっとり', 'ふんわり', 'ツヤ感', '清潔感', 'アンニュイ', 'マット'];
const AI_STRONG_FANDOM_WORDS = ['グッズ', '聖地巡礼', '痛バ', '箱推し', '自担', '同担', '推し増し', '布教'];
const AI_STRONG_LIFESTYLE_WORDS = ['朝活', '朝焼け', '家計簿', '断捨離', '時短料理', '勉強法'];
const DISPLAY_BUCKET_OPTIONS = ['today', 'meme_fast', 'long_term', 'seasonal', 'review', 'blocked'];
const AI_EMOTION_TONE_OVERRIDES = {
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
const AI_UNCERTAIN_PATTERN = /縮写|缩写|源于|新梗|自创|自創|合成词|合成詞|近期流行|网络传闻|網絡傳聞/i;
const AI_REVIEW_ENTITY_PATTERN = /角色|IP|品牌|明星|隐私|隱私|窥私|窺私/i;
const AI_PRIVACY_REVIEW_PATTERN = /偷拍|盗撮|隠し撮り|偶遇美女|偶遇|窥私|窺私|覗き|私生活|隐私|隱私/i;
const AI_IP_BRAND_ROLE_PATTERN = /具体角色|特定角色|角色名|キャラ名|IP名|作品名|品牌名|ブランド名|商品名|明星名|芸能人名|明星|品牌|IP/i;
const AI_TOO_NICHE_PATTERN = /二次元|虚拟形象|虛擬形象|VTuber|Vtuber|社群内部|社群內部|内轮|內輪|界隈|圈层|圈層|同人|オタサー|バ美|ぬるぬる|にわか/i;
const AI_POSSIBLE_WRONG_MEANING_PATTERN = /解释可能不准|解释疑似错误|詞義可能|词义可能|意味違い|誤用|错误解释|錯誤解釋|疑似错误|疑似錯誤/i;
const AI_TOO_BASIC_PATTERN = /太基础|太基礎|过于基础|過於基礎|单独成词|單獨成詞|内容价值低|內容價值低|普通词|普通詞/i;
const AI_BLOCK_PATTERN = /しね|死ね|杀了|殺了|去死|死亡诅咒|死亡詛咒|辱骂|辱罵|歧视|歧視|攻击性|攻擊性/i;
const AI_SEASONAL_PATTERN = /バレンタイン|ホワイトデー|お盆|クリスマス|正月|花見|桜|ハロウィン|七夕|節分|季節|节日|節日|季节/i;
const AI_STRONG_XHS_REASON_PATTERN = /小红书|标题|封面|收藏|评论|口播|场景|误解|共鸣|视觉|穿搭|美妆|追星|二次元/;
const AI_ORDINARY_CATEGORY_PATTERN = /日常|生活|旅行|食|自然|学習|普通|基础/;
const AI_COSPLAY_REVIEW_PATTERN = /具体角色|特定角色|実在|IP|明星|擦边|擦邊|侵权|侵權|隐私|隱私|窥私|窺私/i;
const AI_NEGATIVE_TONE_PATTERN = /キレる|イライラ|グチる|愚痴|うざい|ウザい|めんどい|面倒|イチャモン|詰んだ|ムカつく|キモい|吐槽|吐き出し|怒り|烦|煩|抱怨|挑刺|找茬|负面|負面/i;
const AI_AESTHETIC_TONE_PATTERN = /抜け感|透け感|こなれ|しっとり|ふんわり|ツヤ感|清潔感|アンニュイ|ヌーディ|マット|ベージュ|レイヤード|モノトーン|パーソナルカラー|审美|審美|氛围|雰囲気|穿搭|美妆|写真|视觉|視覺/i;
const AI_LIFESTYLE_TONE_PATTERN = /朝活|朝焼け|家計簿|断捨離|時短料理|勉強法|おうち時間|生活方式|学习|學習|料理|收纳|整理|日常管理/i;
const AI_FANDOM_TONE_PATTERN = /推し|自担|同担|箱推し|痛バ|聖地巡礼|グッズ|追星|二次元|偶像|アイドル/i;
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
const ACCOUNT_LEARNING_EMOTION_SOCIAL_RE = /大正解|小確幸|自己肯定感|気まずい|モヤる|距離感|気を遣う|空気読む|しんどい|刺さる|だるい|わかりみ|塩対応|すれ違い|共感|情绪|情緒|人际|人際|社交|语感|語感|関係|关系|關係|気持ち|心情/;
const TODAY_NEGATIVE_TONE_LIMIT = 2;
const TODAY_AESTHETIC_TONE_MIN = 2;
const TODAY_LIFESTYLE_TONE_MIN = 5;
const TODAY_FANDOM_TONE_MIN = 3;
const TODAY_EMOTION_SOCIAL_TONE_MIN = 8;
const TODAY_SEASONAL_CULTURE_TONE_MIN = 2;
const CANDIDATE_SOURCE_FILTER_LABELS = {
  all: '全部来源',
  codex_generated: 'Codex 生成词',
  deepseek_generated: 'DeepSeek 生成词',
  deepseek_reviewed: 'DeepSeek 审核词',
  manual_keep: '手动保留词'
};
const MANUAL_DISCOVERY_SOURCE_OPTIONS = ['小红书', '日剧 / 动漫', 'YouTube', 'Instagram', 'X / Twitter', '朋友聊天', '日语资料', '其他'];
const PERFORMANCE_REASON_LABELS = {
  wordMismatch: '词不适合',
  titleProblem: '标题问题',
  coverProblem: '封面问题',
  contentProblem: '内容表达问题',
  timingProblem: '发布时间问题',
  lowExposure: '曝光不足',
  dataAbnormal: '数据异常',
  observing: '待观察'
};

function getAccountLearningSummary() {
  return {
    version: 'xhs-account-learning-v1',
    sourceReport: 'account-intelligence/xhs-account-learning-report.md',
    accountPositioning: '小红书日语选题后台，优先服务中文用户共鸣、收藏、标题封面和图文内容制作，不是普通日语词典。',
    preferredDirections: ['情绪状态', '人际关系', '社交语感', '生活场景', '学习状态', '大众可理解的圈层兴趣'],
    avoidDirections: ['过度谐音梗', '过度圈层', '太基础', '太教材', '不好配图', '浏览高但收藏弱', '词义不稳定', '高风险或需复核'],
    scoringRules: {
      highSaveRateBonus: true,
      highEngagementBonus: true,
      highViewLowSavePenalty: true,
      basicWordPenalty: true,
      textbookPenalty: true,
      riskPenalty: true,
      titleCoverFitBonus: true,
      naturalExampleBonus: true
    },
    titlePatterns: [
      '日本人说「XXX」，其实是在表达这种感觉',
      '「XXX」不是 A，而是 B',
      '这个日语词，太适合形容我的状态了',
      '日语里这种说不上来的感觉，原来可以这样说',
      '日本人聊天里常说的「XXX」，到底什么意思？'
    ],
    coverPatterns: ['中文大字 + 日语小字', '情绪 / 场景优先', '短句优先', '不要全日语封面', '不要像教材课件'],
    selectionRules: [
      '收藏率比浏览量更重要',
      '互动率比单纯点赞更重要',
      '浏览高但收藏低不要强加权',
      '圈层词必须能翻译成大众可理解的情绪或生活场景'
    ],
    wordCardRules: ['不要像词典', '不要像教材', '先给场景，再解释词', '标题要有小红书感', '封面文案要短', '例句要自然', '风险要诚实']
  };
}

const SNAPSHOT_NODE_ORDER = ['1h', '2h', '4h', '24h', '72h'];
const CONTENT_TYPE_OPTIONS = ['图文', '视频', '其他'];
const AUTO_REFRESH_STATUS_LABELS = {
  idle: '待自动更新',
  success: '自动更新成功',
  partial: '部分更新',
  failed: '自动更新失败'
};
const AUTO_REFRESH_SOURCE_LABELS = {
  remote: '页面识别',
  text: '分享文案'
};
const CANDIDATE_REVIEW_STATE_LABELS = {
  ready: '可直接上首页',
  watch: '值得继续观察',
  review: '需复核'
};
const sourceFilters = {
  today: localStorage.getItem(`${SOURCE_FILTER_STORAGE_PREFIX}today`) || 'all',
  history: localStorage.getItem(`${SOURCE_FILTER_STORAGE_PREFIX}history`) || 'all',
  favorites: localStorage.getItem(`${SOURCE_FILTER_STORAGE_PREFIX}favorites`) || 'all'
};
let statusFilter = cleanStatusFilter(localStorage.getItem(STATUS_FILTER_STORAGE_KEY));
let currentDailyHotDateKey = localStorage.getItem(DAILY_HOT_DATE_STORAGE_KEY) || 'today';
let currentHistoryDateKey = localStorage.getItem(HISTORY_DATE_STORAGE_KEY) || '';
const PURE_KANJI_RE = /^[\u3400-\u9fff々ヶ]+$/;

const sourceIcons = {
  'Twitter/X': '𝕏',
  Twitter: '𝕏',
  'Google Trends': 'G',
  'Yahoo知恵袋': 'Y',
  ニコニコ: 'N',
  '2ch/5ch': '2',
  Reddit: 'R',
  Wikipedia: 'W',
  Instagram: 'IG',
  YouTube: 'YT',
  '每日热门': '🍞',
  '手动添加': '＋',
  LINE: 'LN',
  小红书: '📕',
  抖音: '🎵',
  NHK: 'NHK',
  ビジネス: 'B',
  SNS総合: 'SNS'
};

function getAllWords() {
  const words = window.ALL_WORDS || (typeof ALL_WORDS !== 'undefined' ? ALL_WORDS : []);
  if (!window.ALL_WORDS && Array.isArray(words)) window.ALL_WORDS = words;
  return Array.isArray(words) ? words : [];
}

function normalizeSyncApiUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function cleanSyncCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeJSString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function renderMultiline(value) {
  return escapeHTML(value).replace(/\n/g, '<br>');
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'candidate-v3';
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

function getAiInputHash(payload = {}) {
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

function cleanTraceText(value, maxLength = 8000) {
  if (!value) return '';
  if (typeof value === 'string') return cleanShortText(value, maxLength);
  try {
    return cleanShortText(JSON.stringify(value), maxLength);
  } catch (error) {
    return '';
  }
}

function getAiTraceFromUsage(usage = {}, payload = {}) {
  return {
    promptVersion: cleanShortText(usage.promptVersion || getPromptVersion(payload.action), 80),
    inputHash: cleanShortText(usage.inputHash || getAiInputHash(payload), 120),
    rawOutput: cleanTraceText(usage.rawOutput, 8000),
    normalizedOutput: cleanTraceText(usage.normalizedOutput, 8000),
    reviewResult: ['accepted', 'rejected', 'edited'].includes(usage.reviewResult) ? usage.reviewResult : 'accepted'
  };
}

function getTodayDismissedState() {
  if (todayDismissed?.dateKey === todayKey()) {
    return {
      dateKey: todayDismissed.dateKey,
      words: getUniqueWords(todayDismissed.words || []),
      updatedAt: typeof todayDismissed.updatedAt === 'string' ? todayDismissed.updatedAt : ''
    };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(TODAY_DISMISSED_STORAGE_KEY) || '{}');
    if (stored?.dateKey === todayKey() && Array.isArray(stored.words)) {
      return {
        dateKey: stored.dateKey,
        words: getUniqueWords(stored.words)
      };
    }
  } catch (error) {
    console.warn('忽略已损坏的今日移除记录', error);
  }
  return { dateKey: todayKey(), words: [] };
}

function getTodayDismissedWords() {
  return getTodayDismissedState().words;
}

function setTodayDismissedWords(words) {
  todayDismissed = cleanTeamDismissedState({
    dateKey: todayKey(),
    words: getUniqueWords(words),
    updatedAt: nowIso()
  });
  localStorage.setItem(TODAY_DISMISSED_STORAGE_KEY, JSON.stringify(todayDismissed));
}

function cleanTeamDismissedState(state = {}) {
  const dateKeyValue = /^\d{4}-\d{2}-\d{2}$/.test(String(state.dateKey || '')) ? String(state.dateKey) : '';
  return {
    dateKey: dateKeyValue,
    words: getUniqueWords(state.words || []).slice(0, 100),
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : ''
  };
}

function cleanAiPreviewState(preview = {}) {
  const items = safeArray(preview.items)
    .map((item, index) => normalizeAiPreviewItem({ ...item, previewIndex: item.previewIndex ?? index }, item.aiBatchId || preview.batchId || '', item.sourceText || '', item.sourcePromptType || 'generate_candidates'))
    .filter(Boolean)
    .slice(0, 100);
  const itemSet = new Set(items.map(item => item.kanji));
  return {
    items,
    selected: getUniqueWords(preview.selected || []).filter(kanji => itemSet.has(kanji)),
    savedAt: typeof preview.savedAt === 'string' ? preview.savedAt : '',
    batchId: cleanShortText(preview.batchId || items[0]?.aiBatchId || '', 120),
    createdBy: cleanShortText(preview.createdBy || 'team', 120)
  };
}

function getUniqueWords(words) {
  return [...new Set(safeArray(words)
    .filter(word => typeof word === 'string' && word.trim())
    .map(word => word.trim()))];
}

function getKnownKanjiSet() {
  return new Set([
    ...getAllWords().map(word => word.kanji).filter(Boolean),
    ...Object.keys(candidatePool || {}).filter(Boolean)
  ]);
}

function getWordByKanji(kanji) {
  return getAllWords().find(word => word.kanji === kanji) || null;
}

function cleanLibraryReviewRecord(record = {}, kanji = '') {
  const cleanKanji = cleanShortText(record.kanji || kanji, 80);
  if (!cleanKanji) return null;
  return {
    kanji: cleanKanji,
    reviewSource: cleanShortText(record.reviewSource || 'deepseek_library_audit', 120),
    libraryReviewStatus: normalizeEnumValue(record.libraryReviewStatus || record.auditAction || record.action, ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'], 'review'),
    action: normalizeEnumValue(record.auditAction || record.action || record.libraryReviewStatus, ['approve', 'keep', 'watch', 'review', 'delete', 'protect'], 'review'),
    xhsFitScore: clamp(toInt(record.xhsFitScore, 0), 0, 100),
    reason: cleanShortText(record.reason || record.libraryAuditReason, 800),
    riskLevel: normalizeEnumValue(record.riskLevel, RISK_LEVEL_OPTIONS, 'low'),
    confidenceLevel: normalizeEnumValue(record.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    suggestedBucket: normalizeEnumValue(record.suggestedBucket || record.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term'),
    reviewedAt: typeof record.reviewedAt === 'string' ? record.reviewedAt : (typeof record.libraryAuditReviewedAt === 'string' ? record.libraryAuditReviewedAt : '')
  };
}

function cleanLibraryReviewRecords(records = {}) {
  if (Array.isArray(records)) {
    return records.reduce((result, record) => {
      const cleanRecord = cleanLibraryReviewRecord(record, record?.kanji);
      if (cleanRecord) result[cleanRecord.kanji] = cleanRecord;
      return result;
    }, {});
  }
  const source = records?.items || records;
  return Object.entries(source || {}).reduce((result, [kanji, record]) => {
    const cleanRecord = cleanLibraryReviewRecord(record, kanji);
    if (cleanRecord) result[cleanRecord.kanji] = cleanRecord;
    return result;
  }, {});
}

async function loadLibraryReviewRecords() {
  try {
    const response = await apiFetch('data/library-review.json', { cache: 'no-store' }, { cancelKey: 'library-review' });
    if (!response.ok) {
      libraryReviewRecords = {};
      return false;
    }
    libraryReviewRecords = cleanLibraryReviewRecords(await response.json());
    return true;
  } catch (error) {
    libraryReviewRecords = {};
    return false;
  }
}

function isLegacyLibraryWord(kanji, entry = null) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return false;
  if (getWordByKanji(cleanKanji)) return true;
  return ['original', 'audit_missing', 'deepseek_reviewed', 'manual_keep'].includes(entry?.sourceType);
}

function getLibraryAuditRecord(kanji, entry = candidatePool[kanji] || {}) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return null;
  if (['codex_generated', 'deepseek_generated', 'deepseek_api'].includes(entry?.sourceType)) return { kanji: cleanKanji, source: 'candidatePool.generated' };
  if (entry?.sourceType === 'manual_keep' || entry?.protected) return { kanji: cleanKanji, source: 'candidatePool.protected', libraryReviewStatus: 'protected', action: 'protect' };
  if (entry?.sourceType === 'deepseek_reviewed') return { kanji: cleanKanji, source: 'candidatePool.sourceType' };
  if (entry?.reviewSource === 'deepseek_library_audit') return { kanji: cleanKanji, source: 'candidatePool.reviewSource' };
  if (entry?.libraryReviewStatus && entry.libraryReviewStatus !== 'missing') return { kanji: cleanKanji, source: 'candidatePool.libraryReviewStatus' };
  if (libraryReviewRecords[cleanKanji]) return libraryReviewRecords[cleanKanji];
  if (getWordByKanji(cleanKanji)) return { kanji: cleanKanji, source: 'historical_seed.kept', libraryReviewStatus: 'approved', action: 'approve' };
  return null;
}

function isLibraryAuditRemoved(entry = {}) {
  return ['delete', 'deleted', 'archived'].includes(entry.libraryReviewStatus) || entry.displayBucket === 'blocked' || Boolean(entry.removedAt);
}

function isLibraryAuditRecordRemoved(record = {}) {
  return ['delete', 'deleted', 'archived'].includes(record.libraryReviewStatus) || record.action === 'delete' || record.suggestedBucket === 'deleted';
}

function hasDeepSeekLibraryAudit(kanji, entry = candidatePool[kanji] || {}) {
  return Boolean(getLibraryAuditRecord(kanji, entry));
}

function getLibraryAuditStatus(kanji, entry = candidatePool[kanji] || {}) {
  if (!isLegacyLibraryWord(kanji, entry)) return 'not_legacy';
  if (isLibraryAuditRemoved(entry)) return 'removed';
  const record = getLibraryAuditRecord(kanji, entry);
  if (isLibraryAuditRecordRemoved(record)) return 'removed';
  return record || getWordByKanji(kanji) ? 'reviewed' : 'missing';
}

function isLibraryAuditMissing(kanji, entry = candidatePool[kanji] || {}) {
  return getLibraryAuditStatus(kanji, entry) === 'missing';
}

function getLegacyLibraryAuditTargets() {
  const words = new Map();
  getAllWords().forEach(word => {
    if (word?.kanji) words.set(word.kanji, { kanji: word.kanji, word, entry: candidatePool[word.kanji] || {} });
  });
  Object.entries(candidatePool || {}).forEach(([kanji, entry]) => {
    if (['original', 'audit_missing'].includes(entry?.sourceType) || (getWordByKanji(kanji) && !hasDeepSeekLibraryAudit(kanji, entry))) words.set(kanji, { kanji, word: getWordByKanji(kanji), entry });
  });
  Object.values(historySnapshots || {}).forEach(snapshot => {
    safeArray(snapshot.words).forEach(kanji => {
      if (getWordByKanji(kanji) || ['original', 'audit_missing'].includes(candidatePool[kanji]?.sourceType)) words.set(kanji, { kanji, word: getWordByKanji(kanji), entry: candidatePool[kanji] || {} });
    });
  });
  safeArray(rankingTodayWords).forEach(word => {
    if (word?.kanji && getWordByKanji(word.kanji)) words.set(word.kanji, { kanji: word.kanji, word, entry: candidatePool[word.kanji] || {} });
  });
  Object.values(rankingHistoryWords || {}).flat().forEach(word => {
    if (word?.kanji && getWordByKanji(word.kanji)) words.set(word.kanji, { kanji: word.kanji, word, entry: candidatePool[word.kanji] || {} });
  });
  return [...words.values()];
}

function findUnauditedLibraryWords() {
  return getLegacyLibraryAuditTargets()
    .filter(target => getLibraryAuditStatus(target.kanji, candidatePool[target.kanji] || target.entry || {}) === 'missing')
    .map(target => target.kanji);
}

function verifyDeepSeekLibraryAuditCoverage() {
  const protectedWords = getProtectedLibraryWords();
  const targets = getLegacyLibraryAuditTargets();
  const missingWords = [];
  let reviewed = 0;
  let protectedCount = 0;
  let removed = 0;
  let approved = 0;
  let review = 0;
  targets.forEach(target => {
    const entry = candidatePool[target.kanji] || {};
    if (protectedWords.has(target.kanji)) protectedCount += 1;
    const status = getLibraryAuditStatus(target.kanji, entry);
    const reviewStatus = entry.libraryReviewStatus || libraryReviewRecords[target.kanji]?.libraryReviewStatus || libraryReviewRecords[target.kanji]?.action || '';
    if (status === 'removed') removed += 1;
    else if (status === 'reviewed') {
      reviewed += 1;
      if (['review'].includes(reviewStatus)) review += 1;
      else if (['protected', 'protect'].includes(reviewStatus) || protectedWords.has(target.kanji)) protectedCount += protectedWords.has(target.kanji) ? 0 : 1;
      else approved += 1;
    }
    else if (status === 'missing') missingWords.push(target.kanji);
  });
  libraryAuditCoverage = {
    total: targets.length,
    reviewed,
    missing: missingWords.length,
    protected: protectedCount,
    removed,
    approved,
    review,
    missingWords
  };
  return libraryAuditCoverage;
}

function canExportFormalWordCard(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return false;
  const entry = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {});
  if (!entry) return false;
  if (isLibraryAuditRemoved(entry)) return false;
  return buildWordCardViewModel({ entry, aiCard: entry.aiCard || {} }).hasFormalCard;
}

function getFormalWordCardBlockReason(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  const entry = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {});
  if (!entry) return '缺少候选池记录';
  if (isLibraryAuditRemoved(entry)) return '该词已被历史种子审核标记为删除或归档';
  const wordCardView = buildWordCardViewModel({ entry, aiCard: entry.aiCard || {} });
  if (!wordCardView.hasFormalCard) return wordCardView.statusLabel;
  return '';
}

function normalizeEnumValue(value, options, fallback = '') {
  const cleanValue = String(value || '').trim();
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function cleanShortText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function isChineseReadableLowValueTodayWord(entry = {}) {
  const kanji = cleanShortText(entry.kanji, 80);
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
  ].map(value => cleanShortText(value, 240)).join(' ');
  return CHINESE_READABLE_LOW_VALUE_CONTEXT_RE.test(`${kanji} ${context}`);
}

function cleanAiExample(example = {}) {
  const jp = cleanShortText(example.jp, 220);
  const cn = cleanShortText(example.cn, 220);
  if (!jp && !cn) return null;
  return {
    jp,
    kana: cleanShortText(example.kana, 220),
    romaji: cleanShortText(example.romaji, 220),
    cn,
    note: cleanShortText(example.note || example.source, 220),
    source: cleanShortText(example.source || example.note || 'AI 候选例句', 120)
  };
}

function cleanCoverSuggestion(coverSuggestion = {}) {
  return {
    coverText: cleanShortText(coverSuggestion.coverText, 120),
    mainVisual: cleanShortText(coverSuggestion.mainVisual, 240),
    style: cleanShortText(coverSuggestion.style, 160),
    avoid: cleanShortText(coverSuggestion.avoid, 240)
  };
}

function cleanAiCard(card = {}) {
  card = card || {};
  const status = normalizeEnumValue(card.cardStatus, ['none', 'pending', 'ready', 'failed', 'stale'], '');
  if (!status && !card.summary && !card.explanation) return null;
  return {
    cardStatus: status || 'ready',
    cardSource: ['codex', 'deepseek_api'].includes(card.cardSource) ? card.cardSource : '',
    cardModel: cleanShortText(card.cardModel, 120),
    cardVersion: clamp(toInt(card.cardVersion, 1), 1, 99),
    generatedAt: typeof card.generatedAt === 'string' ? card.generatedAt : '',
    referenceImage: {
      status: normalizeEnumValue(card.referenceImage?.status, ['missing', 'ready', 'failed'], 'missing'),
      url: cleanShortText(card.referenceImage?.url, 1000),
      key: cleanShortText(card.referenceImage?.key, 500),
      visualBrief: cleanShortText(card.referenceImage?.visualBrief, 1000),
      prompt: cleanShortText(card.referenceImage?.prompt, 4000),
      provider: cleanShortText(card.referenceImage?.provider, 80),
      generatedAt: typeof card.referenceImage?.generatedAt === 'string' ? card.referenceImage.generatedAt : ''
    },
    summary: cleanShortText(card.summary, 500),
    explanation: cleanShortText(card.explanation, 1600),
    usageScenes: getUniqueWords(card.usageScenes || []).map(item => cleanShortText(item, 120)).slice(0, 8),
    examples: safeArray(card.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: getUniqueWords(card.suggestedTitles || []).map(item => cleanShortText(item, 140)).slice(0, 8),
    coverSuggestion: cleanCoverSuggestion(card.coverSuggestion || {}),
    contentAngles: getUniqueWords(card.contentAngles || []).map(item => cleanShortText(item, 180)).slice(0, 8),
    targetAudience: cleanShortText(card.targetAudience, 400),
    referenceDirection: cleanShortText(card.referenceDirection, 600),
    riskWarning: cleanShortText(card.riskWarning, 500),
    wrongUsage: cleanShortText(card.wrongUsage, 600),
    similarWords: safeArray(card.similarWords).map(item => ({
      word: cleanShortText(item.word || item.kanji, 80),
      romaji: cleanShortText(item.romaji, 120),
      meaning: cleanShortText(item.meaning, 240),
      difference: cleanShortText(item.difference || item.note, 500)
    })).filter(item => item.word || item.meaning).slice(0, 8),
    interactionPrompts: getUniqueWords(card.interactionPrompts || []).map(item => cleanShortText(item, 220)).slice(0, 8)
  };
}

function getAiReviewWordReason(kanji) {
  return AI_REVIEW_WORDS[String(kanji || '').trim()] || '';
}

function getAiBlockWordReason(kanji) {
  return AI_BLOCK_WORDS[String(kanji || '').trim()] || '';
}

function hasAiEntityReviewRisk(kanji, text) {
  if (kanji === 'コスプレ') return AI_COSPLAY_REVIEW_PATTERN.test(text);
  return AI_REVIEW_ENTITY_PATTERN.test(text);
}

function inferAiReviewReasonType(kanji, text, fallback = '') {
  if (AI_REVIEW_REASON_OVERRIDES[kanji]) return AI_REVIEW_REASON_OVERRIDES[kanji];
  if (getAiBlockWordReason(kanji) || AI_BLOCK_PATTERN.test(text)) return 'offensive';
  if (AI_PRIVACY_REVIEW_PATTERN.test(text)) return 'privacy_sensitive';
  if (AI_IP_BRAND_ROLE_PATTERN.test(text)) return 'ip_brand_role';
  if (AI_POSSIBLE_WRONG_MEANING_PATTERN.test(text)) return 'possible_wrong_meaning';
  if (AI_TOO_NICHE_PATTERN.test(text)) return 'too_niche';
  if (AI_TOO_BASIC_PATTERN.test(text)) return 'too_basic';
  if (AI_UNCERTAIN_PATTERN.test(text)) return 'uncertain_usage';
  return fallback;
}

function getAiReviewReasonByType(type) {
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

function inferAiEmotionTone(kanji, item = {}, fallback = 'neutral') {
  const explicitTone = normalizeEnumValue(item.emotionTone, EMOTION_TONE_OPTIONS, '');
  if (AI_EMOTION_TONE_OVERRIDES[kanji]) return AI_EMOTION_TONE_OVERRIDES[kanji];
  const text = [
    kanji,
    item.meaning,
    item.reason,
    item.reviewReason,
    item.riskWarning,
    item.category,
    item.candidateType
  ].map(value => cleanShortText(value, 1000)).join(' ');
  if (AI_NEGATIVE_TONE_PATTERN.test(text)) return 'negative';
  if (AI_AESTHETIC_TONE_PATTERN.test(text)) return 'aesthetic';
  if (AI_LIFESTYLE_TONE_PATTERN.test(text)) return 'lifestyle';
  if (AI_FANDOM_TONE_PATTERN.test(text)) return 'fandom';
  if (['审美氛围词', '美妆穿搭词'].includes(item.candidateType)) return 'aesthetic';
  if (item.candidateType === '生活方式词') return 'lifestyle';
  if (item.candidateType === '追星兴趣词') return 'fandom';
  return explicitTone || fallback;
}

function getTodayEmotionTone(wordOrEntry = {}) {
  const entry = wordOrEntry.candidateMeta || wordOrEntry;
  return normalizeEnumValue(entry.emotionTone, EMOTION_TONE_OPTIONS, inferAiEmotionTone(entry.kanji || wordOrEntry.kanji, entry, 'neutral'));
}

function normalizeKanjiSpelling(value) {
  const cleanValue = cleanShortText(value, 80);
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
  ].map(value => cleanShortText(value, 1000)).join(' ');
}

function isGenericTopicWord(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  if (!kanji) return false;
  if (GENERIC_TOPIC_WORDS.has(kanji)) return true;
  return GENERIC_TOPIC_CONTEXT_RE.test(`${kanji} ${getEntryContextText(entry)}`);
}

function getExpressionValueScore(entry = {}) {
  const explicit = toInt(entry.expressionValueScore, 0);
  if (explicit > 0) return clamp(explicit, 0, 100);
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

function getChineseTransparencyScore(entry = {}) {
  const kanji = normalizeKanjiSpelling(entry.kanji);
  const text = `${kanji} ${cleanShortText(entry.meaning, 160)} ${cleanShortText(entry.category, 80)}`;
  if (!kanji) return 0;
  let score = 20;
  if (/^[\u4e00-\u9fff]{2,}$/.test(kanji)) score += 52;
  if (/^[\u4e00-\u9fffぁ-んァ-ンー]+$/.test(kanji) && /副業|通勤|睡眠|免疫|入浴|絶景|資格|自己|承認|欲求|習慣|化|高揚|感|清潔|感/.test(kanji)) score += 26;
  if (/中文|一眼懂|普通名词|普通名詞|话题|話題|分类|分類|标签|標籤/.test(text)) score += 16;
  if (EXPRESSION_VALUE_STRONG_RE.test(text)) score -= 16;
  if (AI_FANDOM_TONE_PATTERN.test(text) || AI_NEGATIVE_TONE_PATTERN.test(text)) score -= 8;
  return clamp(score, 0, 100);
}

function getFreshAiBatchIdsForDate(dateKeyValue = todayKey()) {
  return new Set(cleanAiBatches(aiBatches)
    .filter(batch => {
      if (!batch.id || !batch.createdAt) return false;
      const created = new Date(batch.createdAt);
      if (Number.isNaN(created.getTime())) return false;
      return dateKey(created) === dateKeyValue && ['stable_today', 'generate_candidates', 'wild_ideas'].includes(batch.action);
    })
    .map(batch => batch.id));
}

function getLatestBatchItemsForIds(batchIds = []) {
  const batchIdSet = new Set(safeArray(batchIds).filter(Boolean));
  return cleanAiBatches(aiBatches)
    .filter(batch => !batchIdSet.size || batchIdSet.has(batch.id))
    .flatMap(batch => safeArray(batch.items));
}

function getRecommendationAuditTrace(entry = {}, context = {}) {
  const cleanEntry = entry.candidateMeta || entry || {};
  const freshBatchIds = context.freshBatchIds || new Set();
  const existingWords = context.existingWords || new Set();
  const sourceType = cleanShortText(cleanEntry.sourceType, 80);
  const sourceBatchId = cleanEntry.aiBatchId || cleanEntry.sourceBatchId || '';
  const fromCodex = sourceType === 'codex_generated';
  const fromDeepSeekNew = sourceType === 'deepseek_generated' && sourceBatchId && freshBatchIds.has(sourceBatchId);
  const fromManual = sourceType === 'manual_keep' || sourceType === 'manual';
  const fromHistoryFallback = Boolean(cleanEntry.historicalBackfill);
  const fromLocalFallback = Boolean(cleanEntry.fromLocalFallback || cleanEntry.lastOrigin === 'local' || sourceType === 'original' || sourceType === 'audit_missing');
  const fromCandidatePool = !fromCodex && !fromDeepSeekNew && !fromManual && !fromHistoryFallback && !fromLocalFallback;
  const isBackfill = Boolean(cleanEntry.historicalBackfill)
    || (context.mode === 'fill' && cleanEntry.kanji && !existingWords.has(cleanEntry.kanji))
    || (cleanEntry.displayBucket && cleanEntry.displayBucket !== 'today');
  const isDedupRelaxed = Boolean(cleanEntry.historicalBackfill || context.relaxedDedup || (context.dedupDaysUsed && context.dedupDaysUsed < TODAY_HISTORY_DEDUP_DAYS));
  let originType = 'candidate_pool';
  if (fromCodex) originType = 'codex_generated';
  else if (fromDeepSeekNew) originType = 'deepseek_new';
  else if (fromHistoryFallback) originType = 'history_fallback';
  else if (fromLocalFallback) originType = 'local_word_bank';
  else if (fromManual) originType = 'manual_added';
  else if (!cleanEntry.kanji) originType = 'unknown';
  if (isBackfill) originType = 'today_backfill';
  if (isDedupRelaxed) originType = 'dedup_relaxed';
  const finalScore = clamp(toInt(cleanEntry.finalScore || cleanEntry.lastScore || cleanEntry.xhsFitScore, 0), 0, 100);
  return cleanRecommendationAuditTrace({
    originType,
    originLabel: RECOMMENDATION_ORIGIN_LABELS[originType] || RECOMMENDATION_ORIGIN_LABELS.unknown,
    sourceAction: cleanEntry.sourcePromptType || cleanEntry.sourceAction || context.sourceAction || '',
    sourceBatchId,
    fromDeepSeekNew,
    fromCandidatePool,
    fromHistoryFallback,
    fromLocalFallback,
    fromManual,
    fromCodex,
    isBackfill,
    isDedupRelaxed,
    dedupDaysUsed: context.dedupDaysUsed || cleanEntry.dedupDaysUsed || TODAY_HISTORY_DEDUP_DAYS,
    selectedReason: [
      `分桶 ${cleanEntry.displayBucket || 'unknown'}`,
      `最终分 ${finalScore}`,
      `表达价值 ${getExpressionValueScore(cleanEntry)}`,
      isBackfill ? '用于补足今日推荐' : '',
      isDedupRelaxed ? `去重放宽到 ${context.dedupDaysUsed || cleanEntry.dedupDaysUsed || 0} 天` : ''
    ].filter(Boolean).join('；'),
    selectedAt: context.generatedAt || nowIso()
  });
}

function buildRecommendationAuditItem(wordOrEntry = {}, context = {}) {
  const entry = wordOrEntry.candidateMeta || wordOrEntry || {};
  const audit = cleanRecommendationAuditTrace(entry.recommendationAudit || getRecommendationAuditTrace(entry, context));
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
  return cleanRecommendationAuditItem({
    kanji: entry.kanji || wordOrEntry.kanji || '',
    meaning: entry.meaning || wordOrEntry.meaning || '',
    recommendationLevel: getRecommendationGrade(wordOrEntry),
    riskLevel: entry.riskLevel || wordOrEntry.riskLevel || '',
    ...audit,
    finalScore: clamp(toInt(wordOrEntry.finalScore || entry.lastScore || entry.xhsFitScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(entry.accountLearningBonus || wordOrEntry.accountLearningBonus || 0), -50, 50),
    accountLearningPenalty: Math.max(0, -clamp(toInt(entry.accountLearningBonus || wordOrEntry.accountLearningBonus || 0), -50, 50)),
    expressionValueScore,
    chineseTransparencyScore,
    genericTopicPenalty: genericTopic ? 18 : 0,
    selectedReason: audit.selectedReason,
    diagnosis
  });
}

function averageNumber(values = []) {
  const numbers = safeArray(values).map(value => Number(value) || 0);
  if (!numbers.length) return 0;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function buildTodayRecommendationAudit(words = [], context = {}) {
  const items = safeArray(words).map(word => buildRecommendationAuditItem(word, context));
  const sourceSummary = RECOMMENDATION_ORIGIN_TYPES.reduce((result, key) => ({ ...result, [key]: 0 }), {});
  items.forEach(item => {
    sourceSummary[item.originType] = (sourceSummary[item.originType] || 0) + 1;
    if (item.fromDeepSeekNew && item.originType !== 'deepseek_new') sourceSummary.deepseek_new += 1;
    if (item.fromCandidatePool && item.originType !== 'candidate_pool') sourceSummary.candidate_pool += 1;
    if (item.fromLocalFallback && item.originType !== 'local_word_bank') sourceSummary.local_word_bank += 1;
    if (item.isBackfill && item.originType !== 'today_backfill') sourceSummary.today_backfill += 1;
    if (item.isDedupRelaxed && item.originType !== 'dedup_relaxed') sourceSummary.dedup_relaxed += 1;
  });
  const qualitySummary = {
    averageFinalScore: averageNumber(items.map(item => item.finalScore)),
    averageExpressionValueScore: averageNumber(items.map(item => item.expressionValueScore)),
    averageChineseTransparencyScore: averageNumber(items.map(item => item.chineseTransparencyScore)),
    genericTopicCount: items.filter(item => item.genericTopicPenalty > 0).length,
    highTransparencyCount: items.filter(item => item.chineseTransparencyScore >= 80).length,
    sLevelCount: items.filter(item => item.recommendationLevel === 'S').length,
    aLevelCount: items.filter(item => item.recommendationLevel === 'A').length,
    bLevelCount: items.filter(item => item.recommendationLevel === 'B').length,
    cLevelCount: items.filter(item => item.recommendationLevel === 'C').length
  };
  const total = items.length || 1;
  const latestBatchItems = safeArray(context.latestBatchItems);
  const rawGenericCount = latestBatchItems.filter(item => isGenericTopicWord(item)).length;
  const diagnosis = [];
  if ((sourceSummary.deepseek_new / total) >= 0.5 && qualitySummary.genericTopicCount >= 5) diagnosis.push('问题主要来自 DeepSeek 找词方向，需要优化生成 prompt。');
  if (latestBatchItems.length && rawGenericCount <= 3 && qualitySummary.genericTopicCount >= 5) diagnosis.push('问题主要来自筛选 / 排序 / 补位策略。');
  if ((sourceSummary.today_backfill / total) > 0.3) diagnosis.push('今日推荐候选不足，补位比例过高，建议不要硬凑满 20 个。');
  if ((sourceSummary.local_word_bank / total) > 0.2) diagnosis.push('本地词库兜底过多，说明候选池有效词不足或去重规则过滤太多。');
  if ((sourceSummary.dedup_relaxed / total) > 0.2) diagnosis.push('30 天去重后候选不足，需要扩大候选池，而不是频繁放宽去重。');
  if (qualitySummary.sLevelCount > 10) diagnosis.push('推荐等级过松，需要收紧 S/A 评分标准。');
  if (qualitySummary.highTransparencyCount > 6) diagnosis.push('首页中文一眼懂的词偏多，会影响点击率，需要提高表达价值筛选。');
  if (!diagnosis.length) diagnosis.push('未发现单一明显来源，建议结合逐词审计继续观察。');
  return cleanRecommendationAuditSummary({
    date: context.date || todayKey(),
    total: items.length,
    sourceSummary,
    qualitySummary,
    diagnosis,
    items,
    createdAt: context.generatedAt || nowIso()
  });
}

function getAccountLearningTone(entry = {}) {
  const text = `${normalizeKanjiSpelling(entry.kanji)} ${getEntryContextText(entry)}`;
  if (ACCOUNT_LEARNING_EMOTION_SOCIAL_RE.test(text)) return 'emotion_social';
  if (AI_LIFESTYLE_TONE_PATTERN.test(text) || /生活|日常|学习|學習|工作|消费状态|消費狀態|状态场景|狀態場景|ソロ活|自炊|散歩|読書/.test(text)) return 'lifestyle';
  if (AI_FANDOM_TONE_PATTERN.test(text) || /追星|推し|圈层兴趣|圈層興趣|布教|二次元/.test(text)) return 'fandom';
  if (AI_AESTHETIC_TONE_PATTERN.test(text) || /审美|審美|美妆|美妝|穿搭|氛围|雰囲気/.test(text)) return 'aesthetic';
  if (AI_SEASONAL_PATTERN.test(text) || /季节|季節|文化|旅行|紅葉|祭り/.test(text)) return 'seasonal_culture';
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

function calibrateAiScore(kanji, score, { riskLevel = 'low', confidenceLevel = 'medium', emotionTone = 'neutral', reviewReasonType = '' } = {}) {
  let nextScore = clamp(toInt(score, 60), 0, 100);
  if (AI_HIGH_RISK_SCORE_CAPS[kanji] || riskLevel === 'high') nextScore = Math.min(nextScore, AI_HIGH_RISK_SCORE_CAPS[kanji] || 60);
  if (AI_OLD_MEME_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_OLD_MEME_SCORE_CAPS[kanji]);
  if (AI_NICHE_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_NICHE_SCORE_CAPS[kanji]);
  if (AI_UNCERTAIN_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_UNCERTAIN_SCORE_CAPS[kanji]);
  if (AI_NEGATIVE_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_NEGATIVE_SCORE_CAPS[kanji]);
  if (emotionTone === 'negative') nextScore = Math.min(nextScore, 82);
  if (reviewReasonType === 'too_niche' && !AI_STRONG_FANDOM_WORDS.includes(kanji)) nextScore = Math.min(nextScore, 78);
  if (reviewReasonType === 'uncertain_usage' && confidenceLevel === 'review') nextScore = Math.min(nextScore, 70);
  if (AI_BASIC_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_BASIC_SCORE_CAPS[kanji]);
  if (AI_LONG_TERM_SCORE_CAPS[kanji]) nextScore = Math.min(nextScore, AI_LONG_TERM_SCORE_CAPS[kanji]);
  if (['high', 'medium'].includes(confidenceLevel) && riskLevel !== 'high') {
    if (AI_STRONG_AESTHETIC_WORDS.includes(kanji)) nextScore = clamp(nextScore < 85 ? 88 : nextScore, 85, 92);
    if (AI_STRONG_FANDOM_WORDS.includes(kanji)) nextScore = clamp(nextScore < 82 ? 86 : nextScore, 82, 90);
    if (AI_STRONG_LIFESTYLE_WORDS.includes(kanji)) nextScore = clamp(nextScore < 82 ? 86 : nextScore, 82, 88);
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
  if (getAiBlockWordReason(kanji) || AI_BLOCK_PATTERN.test(text) || (riskLevel === 'high' && suggestedAction === '不建议')) return 'blocked';
  if (getAiReviewWordReason(kanji)) return 'review';
  const override = AI_BUCKET_OVERRIDES[kanji];
  if (override?.bucket) return override.bucket;
  if (riskLevel === 'high') return 'review';
  if (hasAiEntityReviewRisk(kanji, text)) return 'review';
  if (AI_UNCERTAIN_PATTERN.test(text) && !['common_usage', 'user_material'].includes(evidenceType) && !memeFastEligible) return 'review';
  if (confidenceLevel === 'review') return 'review';
  if (evidenceType === 'unknown' && candidateType !== '稳定候选') return 'review';
  if (AI_SEASONAL_PATTERN.test(text)) return 'seasonal';
  if (isGenericTopicWord({ kanji, candidateType, reason: text }) || clamp(toInt(expressionValueScore, 0), 0, 100) < 55) return 'long_term';
  if (emotionTone === 'negative') return 'meme_fast';
  if (memeFastEligible) return 'meme_fast';
  if (riskLevel === 'low'
    && ['high', 'medium'].includes(confidenceLevel)
    && ['稳定候选', '审美氛围词', '美妆穿搭词', '生活方式词', '追星兴趣词'].includes(candidateType)
    && xhsFitScore >= 78
    && clamp(toInt(expressionValueScore, 0), 0, 100) >= 70
    && candidateType !== '高风险话题词') {
    return 'today';
  }
  return 'long_term';
}

function normalizeAiCandidate(item = {}, options = {}) {
  const rawKanji = cleanShortText(item.kanji, 80);
  const kanji = normalizeKanjiSpelling(rawKanji);
  if (!kanji) return null;
  const blockReason = getAiBlockWordReason(kanji);
  if (blockReason && !options.forceImport) {
    return {
      kanji,
      blocked: true,
      blockReason
    };
  }
  let riskLevel = normalizeEnumValue(item.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  let confidenceLevel = normalizeEnumValue(item.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'low');
  let evidenceType = normalizeEnumValue(item.evidenceType, EVIDENCE_TYPE_OPTIONS, 'unknown');
  let candidateType = normalizeEnumValue(item.candidateType, CANDIDATE_TYPE_OPTIONS, riskLevel === 'high' ? '高风险话题词' : '网络口语词');
  let freshness = normalizeEnumValue(item.freshness, FRESHNESS_OPTIONS, '中期');
  let reviewReason = cleanShortText(item.reviewReason, 500);
  let reviewReasonType = normalizeEnumValue(item.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, '');
  let riskWarning = cleanShortText(item.riskWarning, 500);
  let emotionTone = inferAiEmotionTone(kanji, { ...item, candidateType }, 'neutral');
  const reviewWordReason = getAiReviewWordReason(kanji);
  const override = AI_BUCKET_OVERRIDES[kanji] || {};
  const uncertaintyText = [kanji, item.meaning, item.reason, item.reviewReason, item.riskWarning, item.category].map(value => cleanShortText(value, 1000)).join(' ');
  reviewReasonType = reviewReasonType || inferAiReviewReasonType(kanji, uncertaintyText, '');
  const lowRiskMemeEvidence = ['新鲜梗词', '网络口语词', '圈层词'].includes(candidateType)
    && ['low', 'medium'].includes(riskLevel)
    && ['common_usage', 'trend_claim', 'ai_inferred'].includes(evidenceType);
  const overrideCanRoute = ['today', 'meme_fast', 'seasonal', 'long_term'].includes(override.bucket) && !reviewWordReason && riskLevel !== 'high';
  if (blockReason) {
    riskLevel = 'high';
    confidenceLevel = 'review';
    emotionTone = 'negative';
    reviewReasonType = 'offensive';
    reviewReason = blockReason;
    riskWarning = riskWarning || blockReason;
  } else if (reviewWordReason) {
    confidenceLevel = 'review';
    reviewReasonType = reviewReasonType || inferAiReviewReasonType(kanji, `${uncertaintyText} ${reviewWordReason}`, 'uncertain_usage');
    reviewReason = reviewWordReason;
  } else if (overrideCanRoute) {
    if (['today', 'meme_fast'].includes(override.bucket) && evidenceType === 'unknown') evidenceType = 'common_usage';
    if (confidenceLevel === 'low' || confidenceLevel === 'review') confidenceLevel = 'medium';
  } else if (lowRiskMemeEvidence && confidenceLevel === 'review' && !/(疑似|错误|錯誤|不确定|不確定|需核验|需核驗|缩写|縮写|源于|自创|自創|合成词|合成詞)/i.test(reviewReason)) {
    confidenceLevel = 'medium';
  }
  if (AI_UNCERTAIN_PATTERN.test(uncertaintyText) && !['common_usage', 'user_material'].includes(evidenceType) && !lowRiskMemeEvidence && !overrideCanRoute) {
    confidenceLevel = 'review';
    reviewReasonType = reviewReasonType || 'uncertain_usage';
    reviewReason = reviewReason || getAiReviewReasonByType(reviewReasonType);
  }
  if (kanji === 'テン') {
    confidenceLevel = 'review';
    reviewReasonType = 'uncertain_usage';
    reviewReason = reviewReason || '作为テンション缩略语不确定，需核验真实语境。';
  }
  if (hasAiEntityReviewRisk(kanji, uncertaintyText)) {
    confidenceLevel = 'review';
    reviewReasonType = inferAiReviewReasonType(kanji, uncertaintyText, reviewReasonType || 'ip_brand_role');
    reviewReason = reviewReason || getAiReviewReasonByType(reviewReasonType);
  }
  if (riskLevel === 'high' || ((evidenceType === 'unknown' && candidateType !== '稳定候选') && !overrideCanRoute) || candidateType === '高风险话题词') {
    confidenceLevel = 'review';
    reviewReasonType = reviewReasonType || (riskLevel === 'high' ? 'offensive' : 'uncertain_usage');
    reviewReason = reviewReason || (riskLevel === 'high' ? getAiReviewReasonByType(reviewReasonType) : '证据来源未知，需要核验真实用法。');
  }
  if (candidateType === '新鲜梗词') {
    freshness = freshness === '长期' ? '需要尽快判断' : freshness;
    if (!['high', 'medium'].includes(confidenceLevel)) {
      reviewReasonType = reviewReasonType || 'uncertain_usage';
      reviewReason = reviewReason || '新鲜梗词有过期风险，建议尽快人工判断。';
    }
  }
  let xhsFitScore = clamp(toInt(item.xhsFitScore, 60), 0, 100);
  let suggestedAction = normalizeEnumValue(item.suggestedAction, SUGGESTED_ACTION_OPTIONS, confidenceLevel === 'review' ? '暂缓' : '可以收藏观察');
  const genericTopicWord = isGenericTopicWord({ ...item, kanji, candidateType, reason: item.reason, reviewReason, riskWarning });
  let expressionValueScore = getExpressionValueScore({ ...item, kanji, candidateType, reason: item.reason, reviewReason, riskWarning });
  if (genericTopicWord) {
    expressionValueScore = Math.min(expressionValueScore, 68);
    suggestedAction = '可以收藏观察';
    reviewReason = reviewReason || '偏泛话题词，需要更具体场景或标题包装后再进入每日热门。';
  }
  if (xhsFitScore >= 85 && !['high', 'medium'].includes(confidenceLevel)) xhsFitScore = 70;
  const ordinaryWithoutStrongReason = AI_ORDINARY_CATEGORY_PATTERN.test(`${item.category || ''} ${candidateType}`)
    && !AI_STRONG_XHS_REASON_PATTERN.test(cleanShortText(item.reason, 1000));
  if (ordinaryWithoutStrongReason) xhsFitScore = Math.min(xhsFitScore, 78);
  if (genericTopicWord) xhsFitScore = Math.min(xhsFitScore, 74);
  if (kanji === 'マジ卍') reviewReasonType = 'too_basic';
  if (override.reviewReason) reviewReason = reviewReason || override.reviewReason;
  if (confidenceLevel === 'review' && !reviewReasonType) reviewReasonType = inferAiReviewReasonType(kanji, uncertaintyText, 'uncertain_usage');
  if (confidenceLevel === 'review' && !reviewReason) reviewReason = getAiReviewReasonByType(reviewReasonType);
  xhsFitScore = calibrateAiScore(kanji, xhsFitScore, { riskLevel, confidenceLevel, emotionTone, reviewReasonType });
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
  if (displayBucket === 'meme_fast') {
    freshness = freshness === '长期' ? '需要尽快判断' : freshness;
    if (!['尽快判断', '可以收藏观察'].includes(suggestedAction)) suggestedAction = '可以收藏观察';
  }
  const lastReviewState = displayBucket === 'review' || displayBucket === 'blocked'
    ? 'review'
    : (item.lastReviewState || (confidenceLevel === 'high' && xhsFitScore >= 78 ? 'ready' : 'watch'));
  let sourceTags = getUniqueWords(['AI候选', 'DeepSeek', ...safeArray(item.sourceTags)]);
  if (displayBucket === 'meme_fast') sourceTags = getUniqueWords([...sourceTags, '梗词快看']);
  if (displayBucket === 'review') sourceTags = getUniqueWords([...sourceTags, '人工复核']);
  if (displayBucket === 'blocked') sourceTags = getUniqueWords([...sourceTags, '不建议']);
  return {
    ...item,
    kanji,
    candidateType,
    freshness,
    xhsFitScore,
    riskLevel,
    riskWarning,
    emotionTone,
    confidenceLevel,
    evidenceType,
    reviewReason,
    reviewReasonType,
    displayBucket,
    expressionValueScore,
    accountLearningTone: getAccountLearningTone({ ...item, kanji, candidateType, emotionTone }),
    accountLearningBonus: getAccountLearningBonus({ ...item, kanji, candidateType, emotionTone, expressionValueScore }),
    suggestedAction,
    sourceTags: sourceTags.slice(0, 12),
    lastScore: xhsFitScore,
    lastReviewState,
    lastReviewNote: reviewReason || cleanShortText(item.lastReviewNote, 240)
  };
}

function canAutoEnterToday(entry = {}) {
  return entry.displayBucket === 'today'
    && entry.riskLevel !== 'high'
    && entry.confidenceLevel !== 'review'
    && !isGenericTopicWord(entry)
    && getExpressionValueScore(entry) >= 70
    && !(getTodayEmotionTone(entry) === 'negative' && ['うざい', 'キモい', 'しね', 'イチャモン'].includes(entry.kanji))
    && clamp(toInt(entry.xhsFitScore, entry.lastScore || 0), 0, 100) >= 78
    && entry.lastReviewState !== 'review';
}

function normalizeCandidateSourceType(entry = {}, knownWord = null, kanji = '') {
  const raw = String(entry.sourceType || '').trim();
  if (raw === 'deepseek_api') return 'deepseek_generated';
  if (raw === 'manual') return 'manual_keep';
  if (['codex_generated', 'deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(raw)) return raw;
  if (raw === 'original' || raw === 'audit_missing') {
    if (entry.reviewSource === 'deepseek_library_audit' || entry.libraryReviewStatus) return 'deepseek_reviewed';
    const record = libraryReviewRecords[kanji || entry.kanji || knownWord?.kanji];
    if (record && !isLibraryAuditRecordRemoved(record)) return 'deepseek_reviewed';
    return knownWord ? 'deepseek_reviewed' : 'deepseek_reviewed';
  }
  if (entry.reviewSource === 'deepseek_library_audit' || entry.libraryReviewStatus) return 'deepseek_reviewed';
  if (knownWord) {
    const record = libraryReviewRecords[kanji || knownWord.kanji];
    return record && isLibraryAuditRecordRemoved(record) ? '' : 'deepseek_reviewed';
  }
  return '';
}

function getCandidateSourceType(entry = {}) {
  const knownWord = getWordByKanji(entry.kanji);
  return normalizeCandidateSourceType(entry, knownWord, entry.kanji) || 'manual_keep';
}

function getDisplayWordByKanji(kanji) {
  const cleanKanji = String(kanji || '').trim();
  const dbWord = getWordByKanji(cleanKanji);
  const entry = cleanCandidatePoolEntry(cleanKanji, candidatePool?.[cleanKanji] || {}) || (dbWord ? ensureReviewedSeedWordInCandidatePool(cleanKanji) : null);
  if (!entry && dbWord) return dbWord;
  if (!entry) return null;
  const kana = cleanShortText(entry.kana || dbWord?.kana || dbWord?.reading || cleanKanji, 120);
  const romaji = cleanShortText(entry.romaji || dbWord?.romaji || (kana ? kanaToRomaji(kana) : ''), 120);
  const meaning = cleanShortText(entry.meaning || dbWord?.meaning || entry.reason || 'AI 候选词，等待人工确认', 240);
  const examples = safeArray(entry.examples).map(cleanAiExample).filter(Boolean);
  return {
    kanji: cleanKanji,
    reading: kana || romaji || cleanKanji,
    kana,
    romaji,
    meaning,
    category: cleanShortText(entry.category || dbWord?.category || 'AI候选', 80),
    source: CANDIDATE_SOURCE_FILTER_LABELS[getCandidateSourceType(entry)] || '候选池',
    popularity: clamp(toInt(entry.xhsFitScore || entry.lastScore, dbWord?.popularity || 60), 0, 100),
    heat: clamp(toInt(entry.xhsFitScore || entry.lastScore, dbWord?.popularity || 60), 0, 100),
    explanation: cleanShortText(entry.reason || dbWord?.explanation || meaning, 1000),
    detail: '',
    examples,
    exampleSet: examples,
    candidateType: entry.candidateType,
    freshness: entry.freshness,
    displayBucket: entry.displayBucket,
    xhsFitScore: entry.xhsFitScore,
    riskLevel: entry.riskLevel,
    riskWarning: entry.riskWarning,
    aiCard: entry.aiCard,
    emotionTone: entry.emotionTone,
    confidenceLevel: entry.confidenceLevel,
    evidenceType: entry.evidenceType,
    reviewReason: entry.reviewReason,
    reviewReasonType: entry.reviewReasonType,
    suggestedAction: entry.suggestedAction,
    suggestedTitles: safeArray(entry.suggestedTitles),
    coverSuggestion: entry.coverSuggestion,
    sourceType: entry.sourceType,
    sourceTags: safeArray(entry.sourceTags),
    discoverySource: entry.discoverySource,
    discoveryContext: entry.discoveryContext
  };
}

function isWordApproved(word) {
  const status = String(word?.status || 'approved').trim();
  return !status || status === 'approved';
}

function isLikelyPureKanjiNoun(word) {
  const kanji = String(word?.kanji || '').trim();
  return PURE_KANJI_RE.test(kanji);
}

function shouldFilterPureChineseCandidate(wordOrKanji) {
  const word = typeof wordOrKanji === 'string' ? getDisplayWordByKanji(String(wordOrKanji || '').trim()) : wordOrKanji;
  return Boolean(word && isLikelyPureKanjiNoun(word));
}

function canUseHistoricalSeedWord(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return false;
  if (getProtectedLibraryWords().has(cleanKanji)) return true;
  const entry = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {});
  if (!entry) return Boolean(getWordByKanji(cleanKanji) || (libraryReviewRecords[cleanKanji] && !isLibraryAuditRecordRemoved(libraryReviewRecords[cleanKanji])));
  if (entry.sourceType === 'manual_keep') return true;
  if (entry.sourceType === 'deepseek_reviewed') return !['delete', 'deleted', 'archived'].includes(entry.libraryReviewStatus);
  return Boolean(libraryReviewRecords[cleanKanji] && !isLibraryAuditRecordRemoved(libraryReviewRecords[cleanKanji]));
}

function getRankingCandidates(words = getAllWords()) {
  return safeArray(words).filter(word => isWordApproved(word) && !shouldFilterPureChineseCandidate(word) && canUseHistoricalSeedWord(word.kanji));
}

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function addDaysToDateKey(dateKeyValue, offset) {
  const [year, month, day] = String(dateKeyValue || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function diffDateKeysInDays(dateKeyValue, todayDateKey = todayKey()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKeyValue || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayDateKey || ''))) return Infinity;
  const date = new Date(`${dateKeyValue}T00:00:00Z`).getTime();
  const today = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  return Math.round((today - date) / 86400000);
}

function formatDisplayDate(dateKeyValue) {
  const [year, month, day] = String(dateKeyValue || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12));
  return date.toLocaleDateString('zh-CN', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
}

function formatWeekdayShort(dateKeyValue) {
  const [year, month, day] = String(dateKeyValue || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12));
  return date.toLocaleDateString('zh-CN', {
    timeZone: APP_TIME_ZONE,
    weekday: 'short'
  });
}

function seededRNG(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) state = ((state << 5) - state) + seed.charCodeAt(index) | 0;
  return function random() {
    state = (state * 16807 + 12345) % 2147483647;
    return (state & 0x7fffffff) / 2147483647;
  };
}

function seededShuffle(list, rng) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getImageUrl(word, index) {
  const seeds = ['sakura','cherry','japan','zen','matcha','blossom','temple','kyoto','fuji','bamboo','lotus','wave','crane','moon','garden','petal','ribbon','cloud','dusk','dawn'];
  const seed = seeds[index % seeds.length] + word;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/520/390`;
}

function getHeroImageUrl(word) {
  return `https://picsum.photos/seed/${encodeURIComponent(`hero${word}`)}/900/400`;
}

function kanaToRomaji(value) {
  const kana = String(value || '').replace(/[\u30a1-\u30f6]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
  const pairs = {
    きゃ:'kya',きゅ:'kyu',きょ:'kyo',ぎゃ:'gya',ぎゅ:'gyu',ぎょ:'gyo',
    しゃ:'sha',しゅ:'shu',しょ:'sho',じゃ:'ja',じゅ:'ju',じょ:'jo',
    ちゃ:'cha',ちゅ:'chu',ちょ:'cho',にゃ:'nya',にゅ:'nyu',にょ:'nyo',
    ひゃ:'hya',ひゅ:'hyu',ひょ:'hyo',びゃ:'bya',びゅ:'byu',びょ:'byo',
    ぴゃ:'pya',ぴゅ:'pyu',ぴょ:'pyo',みゃ:'mya',みゅ:'myu',みょ:'myo',
    りゃ:'rya',りゅ:'ryu',りょ:'ryo',ふぁ:'fa',ふぃ:'fi',ふぇ:'fe',ふぉ:'fo',
    てぃ:'ti',でぃ:'di',うぃ:'wi',うぇ:'we',うぉ:'wo'
  };
  const singles = {
    あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',
    さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',
    な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',
    ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',
    ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',を:'o',ん:'n',
    が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',
    だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',
    ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o'
  };
  const lastVowel = text => (text.match(/[aiueo](?!.*[aiueo])/) || [''])[0];
  const firstConsonant = text => (text.match(/^[bcdfghjklmnpqrstvwxyz]+/) || [''])[0][0] || '';
  let result = '';
  let doubleNext = false;
  for (let index = 0; index < kana.length; index += 1) {
    const char = kana[index];
    if (char === 'っ') {
      doubleNext = true;
      continue;
    }
    if (char === 'ー') {
      result += lastVowel(result);
      continue;
    }
    const pair = kana.slice(index, index + 2);
    let romaji = pairs[pair];
    if (romaji) index += 1;
    else romaji = singles[char] || char;
    if (doubleNext) {
      result += firstConsonant(romaji);
      doubleNext = false;
    }
    result += romaji;
  }
  return result.replace(/\s+/g, ' ').trim();
}

function tokenizeMeaning(value) {
  return String(value || '')
    .split(/[、，,／/・\s（）()]+/)
    .map(token => token.trim())
    .filter(token => token && token.length >= 2);
}

function filterKnownFavorites(words, pool = candidatePool) {
  const uniqueWords = getUniqueWords(words).map(normalizeKanjiSpelling);
  const knownKanji = new Set([
    ...getAllWords().map(word => word.kanji).filter(Boolean),
    ...Object.keys(pool || {}).filter(Boolean)
  ]);
  if (knownKanji.size === 0) return uniqueWords;
  return uniqueWords.filter(word => knownKanji.has(word));
}

function cleanFavoriteStatus(status) {
  return normalizeFavoriteStatus(status);
}

function cleanStatusFilter(status) {
  return normalizeFavoriteStatusFilter(status);
}

function cleanConfidenceLevel(level) {
  return ['high', 'medium', 'low', 'review'].includes(level) ? level : 'medium';
}

function cleanCandidateReviewState(state) {
  return ['ready', 'watch', 'review'].includes(state) ? state : 'watch';
}

function cleanFeedbackRecord(record) {
  const reasons = Object.entries(record?.reasons || {}).reduce((result, [key, value]) => {
    if (NEGATIVE_FEEDBACK_TYPES[key]) result[key] = clamp(toInt(value, 0), 0, 50);
    return result;
  }, {});
  return {
    reasons,
    lastReason: NEGATIVE_FEEDBACK_TYPES[record?.lastReason] ? record.lastReason : '',
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
    needsReview: Boolean(record?.needsReview || reasons.inaccurate)
  };
}

function cleanWordFeedback(feedback, pool = candidatePool, options = {}) {
  return Object.entries(feedback || {}).reduce((result, [kanji, record]) => {
    const cleanKanji = String(kanji || '').trim();
    if (!cleanKanji || (!options.preserveUnknown && !getWordByKanji(cleanKanji) && !pool?.[cleanKanji])) return result;
    result[cleanKanji] = cleanFeedbackRecord(record);
    return result;
  }, {});
}

function cleanCandidateScoreBreakdown(breakdown = {}) {
  return {
    platformHeatScore: clamp(toInt(breakdown.platformHeatScore, 0), 0, 100),
    accountFitScore: clamp(toInt(breakdown.accountFitScore, 0), 0, 100),
    contentValueScore: clamp(toInt(breakdown.contentValueScore, 0), 0, 100),
    dataFeedbackScore: clamp(toInt(breakdown.dataFeedbackScore, 0), 0, 100),
    referenceQualityScore: clamp(toInt(breakdown.referenceQualityScore, 0), 0, 100),
    confidenceWeightScore: clamp(toInt(breakdown.confidenceWeightScore, 0), 0, 100),
    extensionBoost: clamp(toInt(breakdown.extensionBoost, 0), -30, 30),
    freshnessBonus: clamp(toInt(breakdown.freshnessBonus, 0), -30, 30),
    candidateTypeBonus: clamp(toInt(breakdown.candidateTypeBonus, 0), -30, 30),
    expressionValueScore: clamp(toInt(breakdown.expressionValueScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(breakdown.accountLearningBonus, 0), -30, 30),
    riskPenalty: clamp(toInt(breakdown.riskPenalty, 0), 0, 100),
    feedbackPenalty: clamp(toInt(breakdown.feedbackPenalty, 0), 0, 100),
    duplicatePenalty: clamp(toInt(breakdown.duplicatePenalty, 0), 0, 100),
    finalScore: clamp(toInt(breakdown.finalScore, 0), 0, 100)
  };
}

function cleanRecommendationAuditTrace(trace = {}) {
  const originType = RECOMMENDATION_ORIGIN_TYPES.includes(trace.originType) ? trace.originType : 'unknown';
  return {
    originType,
    originLabel: cleanShortText(trace.originLabel || RECOMMENDATION_ORIGIN_LABELS[originType] || RECOMMENDATION_ORIGIN_LABELS.unknown, 80),
    sourceAction: cleanShortText(trace.sourceAction, 120),
    sourceBatchId: cleanShortText(trace.sourceBatchId, 120),
    fromDeepSeekNew: Boolean(trace.fromDeepSeekNew),
    fromCandidatePool: Boolean(trace.fromCandidatePool),
    fromHistoryFallback: Boolean(trace.fromHistoryFallback),
    fromLocalFallback: Boolean(trace.fromLocalFallback),
    fromManual: Boolean(trace.fromManual),
    fromCodex: Boolean(trace.fromCodex),
    isBackfill: Boolean(trace.isBackfill),
    isDedupRelaxed: Boolean(trace.isDedupRelaxed),
    dedupDaysUsed: clamp(toInt(trace.dedupDaysUsed, TODAY_HISTORY_DEDUP_DAYS), 0, 365),
    selectedReason: cleanShortText(trace.selectedReason, 1000),
    selectedAt: typeof trace.selectedAt === 'string' ? trace.selectedAt : ''
  };
}

function cleanRecommendationAuditItem(item = {}) {
  const trace = cleanRecommendationAuditTrace(item);
  return {
    kanji: cleanShortText(item.kanji, 80),
    meaning: cleanShortText(item.meaning, 240),
    recommendationLevel: ['S', 'A', 'B', 'C'].includes(item.recommendationLevel) ? item.recommendationLevel : 'C',
    riskLevel: normalizeEnumValue(item.riskLevel, RISK_LEVEL_OPTIONS, 'low'),
    ...trace,
    finalScore: clamp(toInt(item.finalScore, 0), 0, 100),
    accountLearningBonus: clamp(toInt(item.accountLearningBonus, 0), -50, 50),
    accountLearningPenalty: clamp(toInt(item.accountLearningPenalty, 0), 0, 50),
    expressionValueScore: clamp(toInt(item.expressionValueScore, 0), 0, 100),
    chineseTransparencyScore: clamp(toInt(item.chineseTransparencyScore, 0), 0, 100),
    genericTopicPenalty: clamp(toInt(item.genericTopicPenalty, 0), 0, 100),
    semanticClusterKey: cleanShortText(item.semanticClusterKey, 120),
    qualityCategory: cleanShortText(item.qualityCategory, 80),
    isDuplicateCluster: Boolean(item.isDuplicateCluster),
    sLevelEligible: Boolean(item.sLevelEligible),
    selectedReason: cleanShortText(item.selectedReason || trace.selectedReason, 1000),
    diagnosis: safeArray(item.diagnosis).map(text => cleanShortText(text, 300)).filter(Boolean).slice(0, 8)
  };
}

function cleanRecommendationAuditSummary(audit = {}) {
  const emptySourceSummary = RECOMMENDATION_ORIGIN_TYPES.reduce((result, key) => ({ ...result, [key]: 0 }), {});
  const sourceSummary = Object.entries(audit.sourceSummary || {}).reduce((result, [key, value]) => {
    if (RECOMMENDATION_ORIGIN_TYPES.includes(key)) result[key] = clamp(toInt(value, 0), 0, 1000);
    return result;
  }, { ...emptySourceSummary });
  const qualityKeys = [
    'averageFinalScore',
    'averageExpressionValueScore',
    'averageChineseTransparencyScore',
    'genericTopicCount',
    'highTransparencyCount',
    'sLevelCount',
    'aLevelCount',
    'bLevelCount',
    'cLevelCount',
    'score',
    'duplicateClusterCount',
    'beautyCategoryCount',
    'basicPoliteCount',
    'genericBasicCount',
    'estimatedHumanQualityScore'
  ];
  const qualitySummary = qualityKeys.reduce((result, key) => ({
    ...result,
    [key]: clamp(toInt(audit.qualitySummary?.[key], 0), 0, 1000)
  }), {});
  qualitySummary.healthWarnings = safeArray(audit.qualitySummary?.healthWarnings).map(text => cleanShortText(text, 240)).filter(Boolean).slice(0, 12);
  qualitySummary.categoryConcentrationWarnings = safeArray(audit.qualitySummary?.categoryConcentrationWarnings).map(text => cleanShortText(text, 240)).filter(Boolean).slice(0, 12);
  qualitySummary.duplicateClusters = safeArray(audit.qualitySummary?.duplicateClusters).slice(0, 12);
  return {
    date: cleanShortText(audit.date, 20),
    total: clamp(toInt(audit.total, 0), 0, 1000),
    sourceSummary,
    qualitySummary,
    diagnosis: safeArray(audit.diagnosis).map(text => cleanShortText(text, 500)).filter(Boolean).slice(0, 12),
    items: safeArray(audit.items).map(cleanRecommendationAuditItem).filter(item => item.kanji).slice(0, 100),
    createdAt: typeof audit.createdAt === 'string' ? audit.createdAt : ''
  };
}

function cleanCandidatePoolEntry(kanji, entry = {}) {
  const rawKanji = String(kanji || entry.kanji || '').trim();
  const cleanKanji = normalizeKanjiSpelling(rawKanji);
  const knownWord = getWordByKanji(cleanKanji) || getWordByKanji(rawKanji);
  const sourceType = normalizeCandidateSourceType(entry, knownWord, cleanKanji);
  const hasAiLexicalFields = Boolean(entry.kana || entry.romaji || entry.meaning || ['codex_generated', 'deepseek_generated', 'deepseek_api', 'deepseek_reviewed', 'manual_keep'].includes(sourceType || entry.sourceType));
  if (!cleanKanji || (knownWord && !isWordApproved(knownWord)) || (PURE_KANJI_RE.test(cleanKanji) && !knownWord && !hasAiLexicalFields)) return null;
  const riskLevel = normalizeEnumValue(entry.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  const freshness = normalizeEnumValue(entry.freshness, FRESHNESS_OPTIONS, '');
  const candidateType = normalizeEnumValue(entry.candidateType, CANDIDATE_TYPE_OPTIONS, knownWord ? '稳定候选' : '网络口语词');
  const suggestedAction = normalizeEnumValue(entry.suggestedAction, SUGGESTED_ACTION_OPTIONS, riskLevel === 'high' ? '暂缓' : '可以收藏观察');
  const normalizedAi = sourceType === 'deepseek_generated'
    ? normalizeAiCandidate({ ...entry, kanji: cleanKanji, riskLevel, freshness, candidateType, suggestedAction }, { forceImport: true })
    : null;
  const confidenceLevel = normalizeEnumValue(normalizedAi?.confidenceLevel || entry.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, knownWord ? 'medium' : 'low');
  const evidenceType = normalizeEnumValue(normalizedAi?.evidenceType || entry.evidenceType, EVIDENCE_TYPE_OPTIONS, knownWord ? 'common_usage' : 'unknown');
  const reviewReason = cleanShortText(normalizedAi?.reviewReason || entry.reviewReason, 500);
  const reviewReasonType = normalizeEnumValue(normalizedAi?.reviewReasonType || entry.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, '');
  let displayBucket = normalizeEnumValue(normalizedAi?.displayBucket || entry.displayBucket, DISPLAY_BUCKET_OPTIONS, knownWord ? 'today' : 'long_term');
  const expressionValueScore = getExpressionValueScore({ ...entry, ...normalizedAi, kanji: cleanKanji, candidateType });
  if (isGenericTopicWord({ ...entry, ...normalizedAi, kanji: cleanKanji, candidateType }) && displayBucket === 'today') displayBucket = 'long_term';
  if (expressionValueScore < 55 && displayBucket === 'today') displayBucket = 'long_term';
  const emotionTone = normalizeEnumValue(normalizedAi?.emotionTone || entry.emotionTone, EMOTION_TONE_OPTIONS, inferAiEmotionTone(cleanKanji, { ...entry, candidateType }, knownWord ? 'neutral' : 'neutral'));
  const xhsFitScore = clamp(toInt(normalizedAi?.xhsFitScore ?? entry.xhsFitScore, entry.lastScore || knownWord?.popularity || 60), 0, 100);
  let sourceTags = getUniqueWords(entry.sourceTags || []).slice(0, 12);
  if (sourceType === 'deepseek_generated' && !sourceTags.includes('DeepSeek生成')) sourceTags.unshift('DeepSeek生成');
  if (sourceType === 'codex_generated' && !sourceTags.includes('Codex生成')) sourceTags.unshift('Codex生成');
  if (sourceType === 'deepseek_reviewed' && !sourceTags.includes('DeepSeek审核')) sourceTags.unshift('DeepSeek审核');
  if (sourceType === 'deepseek_reviewed' && !sourceTags.includes('已审核词库')) sourceTags.unshift('已审核词库');
  if (sourceType === 'manual_keep' && !sourceTags.includes('受保护')) sourceTags.unshift('受保护');
  if (freshness === '需要尽快判断' && !sourceTags.includes('梗词快看')) sourceTags.push('梗词快看');
  if (displayBucket === 'meme_fast' && !sourceTags.includes('梗词快看')) sourceTags.push('梗词快看');
  if (displayBucket === 'review' && !sourceTags.includes('人工复核')) sourceTags.push('人工复核');
  if (displayBucket === 'blocked' && !sourceTags.includes('不建议')) sourceTags.push('不建议');
  sourceTags = getUniqueWords(sourceTags).slice(0, 12);
  const lastReviewState = displayBucket === 'review' || displayBucket === 'blocked'
    ? 'review'
    : cleanCandidateReviewState(entry.lastReviewState);
  return {
    kanji: cleanKanji,
    romaji: cleanShortText(entry.romaji, 120),
    kana: cleanShortText(entry.kana || entry.reading, 120),
    meaning: cleanShortText(entry.meaning, 240),
    category: cleanShortText(entry.category, 80),
    candidateType,
    freshness,
    xhsFitScore,
    riskLevel,
    riskWarning: cleanShortText(entry.riskWarning, 500),
    emotionTone,
    confidenceLevel,
    evidenceType,
    reviewReason,
    reviewReasonType,
    displayBucket,
    expressionValueScore,
    accountLearningTone: cleanShortText(entry.accountLearningTone || normalizedAi?.accountLearningTone || getAccountLearningTone({ ...entry, ...normalizedAi, kanji: cleanKanji, candidateType, emotionTone }), 80),
    accountLearningBonus: clamp(toInt(entry.accountLearningBonus ?? normalizedAi?.accountLearningBonus, getAccountLearningBonus({ ...entry, ...normalizedAi, kanji: cleanKanji, candidateType, emotionTone, expressionValueScore })), -30, 30),
    reason: cleanShortText(entry.reason, 1000),
    suggestedAction,
    aiCard: cleanAiCard(entry.aiCard || {}),
    aiCardHistory: safeArray(entry.aiCardHistory).map(cleanAiCard).filter(Boolean).slice(0, 3),
    examples: safeArray(entry.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: getUniqueWords(entry.suggestedTitles || []).map(item => cleanShortText(item, 140)).slice(0, 8),
    coverSuggestion: cleanCoverSuggestion(entry.coverSuggestion || {}),
    sourceType,
    reviewSource: cleanShortText(entry.reviewSource, 120) || (sourceType === 'deepseek_reviewed' ? 'deepseek_library_audit' : ''),
    libraryReviewStatus: normalizeEnumValue(entry.libraryReviewStatus || entry.libraryAuditAction, ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'], '') || (sourceType === 'deepseek_reviewed' ? 'approved' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditStatus: normalizeEnumValue(entry.libraryAuditStatus, ['reviewed', 'missing', 'removed', 'protected', 'not_legacy'], '') || (sourceType === 'deepseek_reviewed' ? 'reviewed' : sourceType === 'manual_keep' ? 'protected' : ''),
    libraryAuditAction: normalizeEnumValue(entry.libraryAuditAction || entry.libraryReviewStatus, ['approve', 'keep', 'watch', 'review', 'delete', 'protect'], '') || (sourceType === 'deepseek_reviewed' ? 'approve' : sourceType === 'manual_keep' ? 'protect' : ''),
    libraryAuditReason: cleanShortText(entry.libraryAuditReason || entry.reviewReason, 800),
    libraryAuditReviewedAt: typeof entry.libraryAuditReviewedAt === 'string' ? entry.libraryAuditReviewedAt : '',
    libraryAuditScore: clamp(toInt(entry.libraryAuditScore ?? entry.xhsFitScore, 0), 0, 100),
    libraryAuditBucket: normalizeEnumValue(entry.libraryAuditBucket || entry.suggestedBucket || entry.displayBucket, [...DISPLAY_BUCKET_OPTIONS, 'deleted'], ''),
    libraryAuditConfidenceLevel: normalizeEnumValue(entry.libraryAuditConfidenceLevel || entry.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, ''),
    libraryAuditRiskLevel: normalizeEnumValue(entry.libraryAuditRiskLevel || entry.riskLevel, RISK_LEVEL_OPTIONS, ''),
    protected: Boolean(entry.protected || sourceType === 'manual_keep'),
    sourcePromptType: Object.keys(AI_ACTION_LABELS).includes(entry.sourcePromptType) ? entry.sourcePromptType : '',
    sourcePromptVersion: cleanShortText(entry.sourcePromptVersion || (entry.sourcePromptType ? getPromptVersion(entry.sourcePromptType) : ''), 80),
    sourceText: cleanShortText(entry.sourceText, 12000),
    sourceTags,
    discoverySource: cleanShortText(entry.discoverySource, 80),
    discoveryContext: cleanShortText(entry.discoveryContext, 1200),
    aiBatchId: cleanShortText(entry.aiBatchId, 120),
    importedAt: typeof entry.importedAt === 'string' ? entry.importedAt : null,
    extensionFrom: getUniqueWords(entry.extensionFrom || []).slice(0, 12),
    firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : nowIso(),
    lastScoredAt: typeof entry.lastScoredAt === 'string' ? entry.lastScoredAt : null,
    lastRecommendedAt: typeof entry.lastRecommendedAt === 'string' ? entry.lastRecommendedAt : null,
    lastScore: clamp(toInt(entry.lastScore, 0), 0, 100),
    recommendationCount: clamp(toInt(entry.recommendationCount, 0), 0, 9999),
    ignoredCount: clamp(toInt(entry.ignoredCount, 0), 0, 9999),
    recommendationAudit: cleanRecommendationAuditTrace(entry.recommendationAudit || {}),
    wasRecommended: Boolean(entry.wasRecommended),
    historicalBackfill: Boolean(entry.historicalBackfill),
    lastDecayAt: typeof entry.lastDecayAt === 'string' ? entry.lastDecayAt : '',
    removedAt: typeof entry.removedAt === 'string' ? entry.removedAt : '',
    lastOrigin: ['today', 'history', 'pool', 'favorite', 'lookup'].includes(entry.lastOrigin) ? entry.lastOrigin : 'pool',
    lastConfidenceLevel: cleanConfidenceLevel(entry.lastConfidenceLevel),
    lastReviewState,
    lastReviewNote: String(entry.lastReviewNote || '').trim().slice(0, 240),
    manualReviewState: ['ready', 'watch', 'review', ''].includes(String(entry.manualReviewState || '')) ? String(entry.manualReviewState || '') : '',
    manualReviewNote: String(entry.manualReviewNote || '').trim().slice(0, 240),
    lastBreakdown: cleanCandidateScoreBreakdown(entry.lastBreakdown || {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : nowIso()
  };
}

function cleanCandidatePool(pool) {
  return Object.entries(pool || {}).reduce((result, [kanji, entry]) => {
    const cleanEntry = cleanCandidatePoolEntry(kanji, entry);
    if (cleanEntry) result[cleanEntry.kanji] = cleanEntry;
    return result;
  }, {});
}

function buildReviewedSeedCandidateEntry(word = {}, existing = {}) {
  const cleanKanji = cleanShortText(word.kanji || existing.kanji, 80);
  if (!cleanKanji) return null;
  const record = libraryReviewRecords[cleanKanji] || {};
  const recordStatus = normalizeEnumValue(
    record.libraryReviewStatus || record.action || existing.libraryReviewStatus,
    ['approved', 'keep', 'watch', 'review', 'delete', 'deleted', 'archived', 'protect', 'protected', 'missing'],
    'approved'
  );
  if (['delete', 'deleted', 'archived'].includes(recordStatus) || isLibraryAuditRecordRemoved(record)) return null;
  const protectedWords = getProtectedLibraryWords();
  const isProtected = protectedWords.has(cleanKanji) || existing.protected || existing.sourceType === 'manual_keep' || ['protect', 'protected'].includes(recordStatus);
  const reviewStatus = isProtected ? 'protected' : (recordStatus === 'missing' ? 'approved' : recordStatus);
  const isReview = reviewStatus === 'review';
  const kana = cleanShortText(existing.kana || existing.reading || word.kana || word.reading || cleanKanji, 120);
  const romaji = cleanShortText(existing.romaji || word.romaji || (kana ? kanaToRomaji(kana) : ''), 120);
  const displayBucket = isReview
    ? 'review'
    : normalizeEnumValue(existing.displayBucket || record.suggestedBucket || record.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term');
  const now = nowIso();
  return cleanCandidatePoolEntry(cleanKanji, {
    ...existing,
    kanji: cleanKanji,
    romaji,
    kana,
    meaning: existing.meaning || word.meaning || '',
    category: existing.category || word.category || '',
    candidateType: existing.candidateType || '稳定候选',
    freshness: existing.freshness || '长期',
    xhsFitScore: existing.xhsFitScore || record.xhsFitScore || word.popularity || 60,
    riskLevel: existing.riskLevel || record.riskLevel || 'low',
    riskWarning: existing.riskWarning || '',
    confidenceLevel: existing.confidenceLevel || record.confidenceLevel || (isReview ? 'review' : 'medium'),
    evidenceType: existing.evidenceType || 'common_usage',
    displayBucket,
    reason: existing.reason || record.reason || word.explanation || word.meaning || '',
    suggestedAction: existing.suggestedAction || (isReview ? '暂缓' : '可以收藏观察'),
    sourceType: isProtected ? 'manual_keep' : 'deepseek_reviewed',
    reviewSource: existing.reviewSource || 'deepseek_library_audit',
    libraryReviewStatus: reviewStatus,
    libraryAuditStatus: isProtected ? 'protected' : 'reviewed',
    libraryAuditAction: isProtected ? 'protect' : (isReview ? 'review' : 'approve'),
    libraryAuditReason: existing.libraryAuditReason || record.reason || '',
    libraryAuditReviewedAt: existing.libraryAuditReviewedAt || record.reviewedAt || '',
    libraryAuditScore: existing.libraryAuditScore || record.xhsFitScore || word.popularity || 60,
    libraryAuditBucket: existing.libraryAuditBucket || record.suggestedBucket || displayBucket,
    libraryAuditConfidenceLevel: existing.libraryAuditConfidenceLevel || record.confidenceLevel || '',
    libraryAuditRiskLevel: existing.libraryAuditRiskLevel || record.riskLevel || '',
    protected: isProtected,
    aiCard: existing.aiCard || { cardStatus: 'none' },
    aiCardHistory: existing.aiCardHistory || [],
    sourceTags: getUniqueWords([
      ...(existing.sourceTags || []),
      isProtected ? '受保护' : 'DeepSeek审核',
      isProtected ? '' : '已审核词库',
      isReview ? '人工复核' : ''
    ]),
    importedAt: existing.importedAt || now,
    updatedAt: now
  });
}

function ensureReviewedSeedWordInCandidatePool(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  const word = getWordByKanji(cleanKanji);
  if (!word) return cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {});
  const existing = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {}) || {};
  const entry = buildReviewedSeedCandidateEntry(word, existing);
  if (!entry) return null;
  candidatePool[cleanKanji] = entry;
  return entry;
}

function ensureReviewedSeedWordsInCandidatePool() {
  let changed = false;
  getAllWords().forEach(word => {
    if (!word?.kanji) return;
    const before = candidatePool[word.kanji];
    const entry = buildReviewedSeedCandidateEntry(word, before || {});
    if (!entry) return;
    if (!before || before.sourceType === 'original' || before.sourceType === 'audit_missing' || before.sourceType === 'deepseek_api') changed = true;
    candidatePool[word.kanji] = entry;
  });
  candidatePool = cleanCandidatePool(candidatePool);
  return changed;
}

function mergeCandidatePool(localPool, remotePool) {
  const nonEmpty = (preferred, fallback, maxLength = 1000) => cleanShortText(preferred, maxLength) || cleanShortText(fallback, maxLength);
  const isMeaningfulCard = card => Boolean(card && (
    card.cardStatus !== 'none'
    || card.summary
    || card.explanation
    || safeArray(card.examples).length
    || safeArray(card.suggestedTitles).length
  ));
  const chooseAiCard = (left, right) => {
    const localCard = cleanAiCard(left || {});
    const remoteCard = cleanAiCard(right || {});
    if (localCard?.cardStatus === 'ready' && remoteCard?.cardStatus !== 'ready') return localCard;
    if (remoteCard?.cardStatus === 'ready' && localCard?.cardStatus !== 'ready') return remoteCard;
    if (!isMeaningfulCard(remoteCard)) return localCard;
    if (!isMeaningfulCard(localCard)) return remoteCard;
    return String(remoteCard.generatedAt || '') >= String(localCard.generatedAt || '') ? remoteCard : localCard;
  };
  const mergeEntry = (current, incoming) => {
    const currentUpdated = current.updatedAt || '';
    const incomingUpdated = incoming.updatedAt || '';
    const newer = incomingUpdated >= currentUpdated ? incoming : current;
    const older = newer === incoming ? current : incoming;
    const manualSource = current.manualReviewState || current.manualReviewNote ? current : incoming;
    const scoreSource = String(incoming.lastScoredAt || '') >= String(current.lastScoredAt || '') ? incoming : current;
    const recommendedSource = String(incoming.lastRecommendedAt || '') >= String(current.lastRecommendedAt || '') ? incoming : current;
    return cleanCandidatePoolEntry(newer.kanji || older.kanji, {
      ...older,
      ...newer,
      kanji: newer.kanji || older.kanji,
      romaji: nonEmpty(newer.romaji, older.romaji, 120),
      kana: nonEmpty(newer.kana, older.kana, 120),
      meaning: nonEmpty(newer.meaning, older.meaning, 240),
      category: nonEmpty(newer.category, older.category, 80),
      riskWarning: nonEmpty(newer.riskWarning, older.riskWarning, 500),
      reviewReason: nonEmpty(newer.reviewReason, older.reviewReason, 500),
      reason: nonEmpty(newer.reason, older.reason, 1000),
      aiCard: chooseAiCard(current.aiCard, incoming.aiCard),
      aiCardHistory: [...safeArray(current.aiCardHistory), ...safeArray(incoming.aiCardHistory)].map(cleanAiCard).filter(Boolean).slice(0, 10),
      sourceTags: getUniqueWords([...(current.sourceTags || []), ...(incoming.sourceTags || [])]).slice(0, 12),
      discoverySource: nonEmpty(newer.discoverySource, older.discoverySource, 80),
      discoveryContext: nonEmpty(newer.discoveryContext, older.discoveryContext, 1200),
      extensionFrom: getUniqueWords([...(current.extensionFrom || []), ...(incoming.extensionFrom || [])]).slice(0, 12),
      importedAt: [current.importedAt, incoming.importedAt].filter(Boolean).sort()[0] || null,
      firstSeenAt: [current.firstSeenAt, incoming.firstSeenAt].filter(Boolean).sort()[0] || null,
      lastScore: scoreSource.lastScore,
      lastScoredAt: [current.lastScoredAt, incoming.lastScoredAt].filter(Boolean).sort().pop() || null,
      lastRecommendedAt: [current.lastRecommendedAt, incoming.lastRecommendedAt].filter(Boolean).sort().pop() || null,
      recommendationCount: Math.max(toInt(current.recommendationCount, 0), toInt(incoming.recommendationCount, 0)),
      ignoredCount: Math.max(toInt(current.ignoredCount, 0), toInt(incoming.ignoredCount, 0)),
      wasRecommended: Boolean(current.wasRecommended || incoming.wasRecommended),
      lastOrigin: recommendedSource.lastOrigin || newer.lastOrigin,
      lastConfidenceLevel: recommendedSource.lastConfidenceLevel || newer.lastConfidenceLevel,
      manualReviewState: manualSource.manualReviewState || '',
      manualReviewNote: manualSource.manualReviewNote || '',
      updatedAt: [current.updatedAt, incoming.updatedAt].filter(Boolean).sort().pop() || null
    });
  };
  const merged = new Map();
  [...Object.values(cleanCandidatePool(localPool)), ...Object.values(cleanCandidatePool(remotePool))].forEach(entry => {
    const current = merged.get(entry.kanji);
    if (!current) {
      merged.set(entry.kanji, entry);
      return;
    }
    merged.set(entry.kanji, mergeEntry(current, entry));
  });
  return [...merged.values()].reduce((result, entry) => {
    result[entry.kanji] = entry;
    return result;
  }, {});
}

function migrateOriginalWordsAfterAudit() {
  const protectedWords = getProtectedLibraryWords();
  const nextPool = {};
  Object.entries(candidatePool || {}).forEach(([kanji, rawEntry]) => {
    const entry = cleanCandidatePoolEntry(kanji, rawEntry || {});
    if (!entry) return;
    const isProtected = protectedWords.has(entry.kanji) || entry.protected || entry.sourceType === 'manual_keep';
    const record = getLibraryAuditRecord(entry.kanji, entry);
    const recordStatus = record?.libraryReviewStatus || record?.action || entry.libraryReviewStatus || '';
    if (isProtected) {
      nextPool[entry.kanji] = cleanCandidatePoolEntry(entry.kanji, {
        ...entry,
        sourceType: 'manual_keep',
        libraryReviewStatus: 'protected',
        libraryAuditStatus: 'protected',
        libraryAuditAction: 'protect',
        protected: isProtected,
        reason: entry.reason || '用户已进入工作流，禁止自动删除',
        sourceTags: getUniqueWords([...(entry.sourceTags || []), '受保护']),
        updatedAt: nowIso()
      });
      return;
    }
    if (['delete', 'deleted', 'archived'].includes(recordStatus) || isLibraryAuditRemoved(entry)) {
      nextPool[entry.kanji] = cleanCandidatePoolEntry(entry.kanji, {
        ...entry,
        sourceType: 'deepseek_reviewed',
        libraryReviewStatus: 'deleted',
        libraryAuditStatus: 'removed',
        libraryAuditAction: 'delete',
        displayBucket: 'blocked',
        removedAt: entry.removedAt || nowIso(),
        updatedAt: nowIso()
      });
      return;
    }
    if (record || entry.sourceType === 'deepseek_reviewed') {
      const approvedStatus = ['keep', 'watch'].includes(recordStatus) ? 'approved' : (recordStatus || 'approved');
      nextPool[entry.kanji] = cleanCandidatePoolEntry(entry.kanji, {
        ...entry,
        sourceType: 'deepseek_reviewed',
        reviewSource: entry.reviewSource || 'deepseek_library_audit',
        libraryReviewStatus: approvedStatus,
        libraryAuditStatus: 'reviewed',
        libraryAuditAction: approvedStatus === 'review' ? 'review' : 'approve',
        sourceTags: getUniqueWords([...(entry.sourceTags || []), 'DeepSeek审核', '已审核词库']),
        updatedAt: nowIso()
      });
      return;
    }
    nextPool[entry.kanji] = cleanCandidatePoolEntry(entry.kanji, {
      ...entry,
      sourceType: 'deepseek_reviewed',
      reviewSource: entry.reviewSource || 'deepseek_library_audit',
      libraryReviewStatus: entry.libraryReviewStatus && entry.libraryReviewStatus !== 'missing' ? entry.libraryReviewStatus : 'approved',
      libraryAuditStatus: 'reviewed',
      libraryAuditAction: entry.libraryAuditAction || 'approve',
      sourceTags: getUniqueWords([...(entry.sourceTags || []), 'DeepSeek审核', '已审核词库']),
      updatedAt: nowIso()
    });
  });
  candidatePool = cleanCandidatePool(nextPool);
  return candidatePool;
}

function cleanPublishedStats(stats) {
  return {
    likes: clamp(toInt(stats?.likes, 0), 0, 99999999),
    favorites: clamp(toInt(stats?.favorites, 0), 0, 99999999),
    comments: clamp(toInt(stats?.comments, 0), 0, 99999999),
    shares: clamp(toInt(stats?.shares, 0), 0, 99999999),
    views: clamp(toInt(stats?.views, 0), 0, 999999999)
  };
}

function cleanAutoRefreshState(state) {
  return {
    status: ['idle', 'success', 'failed', 'partial'].includes(state?.status) ? state.status : 'idle',
    lastAttemptAt: typeof state?.lastAttemptAt === 'string' ? state.lastAttemptAt : '',
    lastSuccessAt: typeof state?.lastSuccessAt === 'string' ? state.lastSuccessAt : '',
    lastMessage: String(state?.lastMessage || '').trim().slice(0, 1000),
    source: ['remote', 'text'].includes(state?.source) ? state.source : '',
    updatedFields: Array.isArray(state?.updatedFields)
      ? [...new Set(state.updatedFields.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20)
      : []
  };
}

function cleanSnapshot(snapshot, fallbackNodeType = '1h') {
  const nodeType = SNAPSHOT_NODE_ORDER.includes(snapshot?.nodeType) ? snapshot.nodeType : fallbackNodeType;
  return {
    nodeType,
    ...cleanPublishedStats(snapshot),
    capturedAt: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt : '',
    source: snapshot?.source === 'auto' ? 'auto' : 'manual'
  };
}

function cleanPublishedRecord(record, index = 0) {
  const word = String(record?.word || '').trim();
  const recordId = String(record?.id || `record_${word || 'unknown'}_${index}`).trim();
  const latestStats = cleanPublishedStats(record?.latestStats || record?.metrics || record);
  const snapshots = SNAPSHOT_NODE_ORDER.map(nodeType => {
    const matched = safeArray(record?.snapshots).find(item => item?.nodeType === nodeType);
    return cleanSnapshot(matched || { nodeType }, nodeType);
  });
  return {
    id: recordId,
    word,
    link: String(record?.link || '').trim(),
    title: String(record?.title || '').trim(),
    description: String(record?.description || '').trim(),
    contentType: CONTENT_TYPE_OPTIONS.includes(record?.contentType) ? record.contentType : '图文',
    authorName: String(record?.authorName || '').trim(),
    publishedAt: String(record?.publishedAt || '').trim(),
    latestStats,
    snapshots,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : nowIso(),
    rating: String(record?.rating || '').trim(),
    performanceReason: safeArray(record?.performanceReason).filter(item => PERFORMANCE_REASON_LABELS[item]),
    performanceNote: String(record?.performanceNote || '').trim(),
    remarks: String(record?.remarks || '').trim(),
    sourceStatus: record?.sourceStatus === 'placeholder' ? 'placeholder' : 'record',
    autoRefresh: cleanAutoRefreshState(record?.autoRefresh)
  };
}

function cleanPublishedRecords(records) {
  return safeArray(records)
    .map((record, index) => cleanPublishedRecord(record, index))
    .filter(record => record.word || record.link || record.title);
}

function cleanStoredWorkflow(data = {}) {
  const cleanedCandidatePool = cleanCandidatePool(data.candidatePool);
  const words = getUniqueWords(data.words).map(normalizeKanjiSpelling).filter(Boolean).slice(0, 500);
  const rawScope = cleanShortText(data.appView?.scope, 40);
  const appViewScope = ['all', 'today', 'favorites', 'published'].includes(rawScope) ? rawScope : 'all';
  const appViewHistoryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.appView?.historyDate || ''))
    ? String(data.appView.historyDate)
    : '';
  const statuses = Object.entries(data.statuses || {}).reduce((result, [word, status]) => {
    const cleanWord = String(word || '').trim();
    const cleanStatus = cleanFavoriteStatus(status);
    if (words.includes(cleanWord) && cleanStatus !== 'none') result[cleanWord] = cleanStatus;
    return result;
  }, {});
  return {
    words,
    statuses,
    feedback: cleanWordFeedback(data.feedback, cleanedCandidatePool, { preserveUnknown: true }),
    publishedRecords: cleanPublishedRecords(data.publishedRecords),
    candidatePool: cleanedCandidatePool,
    aiBatches: cleanAiBatches(data.aiBatches),
    aiPreview: cleanAiPreviewState(data.aiPreview || {}),
    todaySnapshot: cleanTodaySnapshot(data.todaySnapshot),
    todayDismissed: cleanTeamDismissedState(data.todayDismissed || data.teamDismissed || {}),
    historySnapshots: cleanHistorySnapshots(data.historySnapshots),
    todaySnapshotHistory: cleanTodaySnapshotHistory(data.todaySnapshotHistory),
    revision: clamp(toInt(data.revision, 0), 0, Number.MAX_SAFE_INTEGER),
    auditLog: safeArray(data.auditLog).map((event, index) => ({
      id: cleanShortText(event?.id || `legacy-event-${index}`, 120),
      action: cleanShortText(event?.action || 'workflow.update', 120),
      actor: cleanShortText(event?.actor || 'unknown', 320),
      at: typeof event?.at === 'string' ? event.at : '',
      target: cleanShortText(event?.target, 240),
      summary: cleanShortText(event?.summary, 500),
      revision: clamp(toInt(event?.revision, 0), 0, Number.MAX_SAFE_INTEGER)
    })).filter(event => event.id).slice(0, 100),
    appView: {
      scope: appViewScope,
      historyDate: appViewHistoryDate,
      partialCandidatePool: Boolean(data.appView?.partialCandidatePool),
      candidateCount: clamp(toInt(data.appView?.candidateCount, Object.keys(cleanedCandidatePool).length), 0, 500)
    },
    updated: typeof data.updated === 'string' ? data.updated : null,
    schemaVersion: clamp(toInt(data.schemaVersion, 2), 1, 999)
  };
}

function cleanAiBatchItem(item = {}, index = 0, fallbackAction = '', fallbackBatchId = '') {
  const kanji = cleanShortText(item.kanji, 80);
  if (!kanji) return null;
  return {
    kanji,
    kana: cleanShortText(item.kana || item.reading, 120),
    romaji: cleanShortText(item.romaji, 120),
    meaning: cleanShortText(item.meaning, 240),
    candidateType: normalizeEnumValue(item.candidateType, CANDIDATE_TYPE_OPTIONS, '稳定候选'),
    displayBucket: normalizeEnumValue(item.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term'),
    riskLevel: normalizeEnumValue(item.riskLevel, RISK_LEVEL_OPTIONS, 'low'),
    confidenceLevel: normalizeEnumValue(item.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'medium'),
    sourceAction: cleanShortText(item.sourceAction || fallbackAction, 120),
    sourceBatchId: cleanShortText(item.sourceBatchId || fallbackBatchId, 120),
    rawRank: clamp(toInt(item.rawRank, index + 1), 0, 9999),
    rejectedReason: cleanShortText(item.rejectedReason, 500),
    selectedForToday: Boolean(item.selectedForToday)
  };
}

function cleanAiBatch(batch = {}, index = 0) {
  const action = Object.keys(AI_ACTION_LABELS).includes(batch.action) ? batch.action : 'generate_candidates';
  const id = cleanShortText(batch.id || `batch_${index}`, 120);
  if (!id) return null;
  return {
    id,
    action,
    promptType: cleanShortText(batch.promptType || action, 120),
    model: cleanShortText(batch.model, 120),
    createdAt: typeof batch.createdAt === 'string' ? batch.createdAt : nowIso(),
    promptVersion: cleanShortText(batch.promptVersion || getPromptVersion(action), 80),
    inputHash: cleanShortText(batch.inputHash, 120),
    rawOutput: cleanTraceText(batch.rawOutput, 8000),
    normalizedOutput: cleanTraceText(batch.normalizedOutput, 8000),
    reviewResult: ['accepted', 'rejected', 'edited'].includes(batch.reviewResult) ? batch.reviewResult : '',
    rawCount: clamp(toInt(batch.rawCount ?? batch.itemCount, 0), 0, 1000),
    normalizedCount: clamp(toInt(batch.normalizedCount ?? batch.itemCount, 0), 0, 1000),
    acceptedCount: clamp(toInt(batch.acceptedCount ?? batch.importedCount, 0), 0, 1000),
    rejectedCount: clamp(toInt(batch.rejectedCount ?? batch.skippedCount, 0), 0, 1000),
    itemCount: clamp(toInt(batch.itemCount, 0), 0, 1000),
    importedCount: clamp(toInt(batch.importedCount, 0), 0, 1000),
    skippedCount: clamp(toInt(batch.skippedCount, 0), 0, 1000),
    promptSummary: cleanShortText(batch.promptSummary, 500),
    trendNotes: cleanShortText(batch.trendNotes, 1000),
    items: safeArray(batch.items).map((item, itemIndex) => cleanAiBatchItem(item, itemIndex, action, id)).filter(Boolean).slice(0, 200)
  };
}

function cleanAiBatches(batches) {
  return safeArray(batches)
    .map((batch, index) => cleanAiBatch(batch, index))
    .filter(Boolean)
    .slice(0, 100);
}

function buildAiBatchItems(rawItems = [], normalizedItems = [], batchId = '', action = '') {
  const normalizedByKanji = new Map(safeArray(normalizedItems).map(item => [item.kanji, item]));
  return safeArray(rawItems).map((rawItem, index) => {
    const kanji = normalizeKanjiSpelling(rawItem?.kanji || rawItem?.word || '');
    const normalized = normalizedByKanji.get(kanji) || {};
    return cleanAiBatchItem({
      ...rawItem,
      ...normalized,
      kanji,
      sourceAction: normalized.sourcePromptType || rawItem?.sourceAction || action,
      sourceBatchId: batchId,
      rawRank: index + 1,
      rejectedReason: normalized.blocked ? 'blocked' : (!normalized.kanji ? 'missing_kanji' : ''),
      selectedForToday: Boolean(normalized.selectedForToday)
    }, index, action, batchId);
  }).filter(Boolean).slice(0, 200);
}

function mergeFeedback(localFeedback, remoteFeedback) {
  const next = { ...cleanWordFeedback(localFeedback) };
  Object.entries(cleanWordFeedback(remoteFeedback)).forEach(([kanji, remoteRecord]) => {
    const localRecord = next[kanji];
    if (!localRecord) {
      next[kanji] = remoteRecord;
      return;
    }
    const reasons = { ...localRecord.reasons };
    Object.entries(remoteRecord.reasons || {}).forEach(([reason, count]) => {
      reasons[reason] = Math.max(toInt(reasons[reason], 0), toInt(count, 0));
    });
    next[kanji] = {
      reasons,
      lastReason: remoteRecord.updatedAt && (!localRecord.updatedAt || remoteRecord.updatedAt >= localRecord.updatedAt)
        ? remoteRecord.lastReason
        : localRecord.lastReason,
      updatedAt: [localRecord.updatedAt, remoteRecord.updatedAt].filter(Boolean).sort().pop() || null,
      needsReview: Boolean(localRecord.needsReview || remoteRecord.needsReview || reasons.inaccurate)
    };
  });
  return next;
}

function mergePublishedRecords(localRecords, remoteRecords) {
  const nonEmpty = (preferred, fallback) => String(preferred || '').trim() || String(fallback || '').trim();
  const mergeStats = (older = {}, newer = {}) => {
    const cleanOlder = cleanPublishedStats(older);
    const cleanNewer = cleanPublishedStats(newer);
    return Object.keys(cleanOlder).reduce((result, key) => {
      result[key] = cleanNewer[key] > 0 || cleanOlder[key] === 0 ? cleanNewer[key] : cleanOlder[key];
      return result;
    }, {});
  };
  const mergeSnapshots = (olderSnapshots = [], newerSnapshots = []) => {
    const mergedSnapshots = new Map();
    [...safeArray(olderSnapshots), ...safeArray(newerSnapshots)].forEach(snapshot => {
      const cleaned = cleanSnapshot(snapshot, snapshot?.nodeType || '');
      if (!cleaned.nodeType) return;
      const current = mergedSnapshots.get(cleaned.nodeType);
      if (!current || String(cleaned.capturedAt || '') >= String(current.capturedAt || '')) {
        mergedSnapshots.set(cleaned.nodeType, {
          ...current,
          ...cleaned,
          ...mergeStats(current || {}, cleaned),
          capturedAt: [current?.capturedAt, cleaned.capturedAt].filter(Boolean).sort().pop() || ''
        });
      }
    });
    return SNAPSHOT_NODE_ORDER.map(nodeType => cleanSnapshot(mergedSnapshots.get(nodeType) || { nodeType }, nodeType));
  };
  const mergeRecord = (current, incoming) => {
    const incomingIsNewer = String(incoming.updatedAt || '') >= String(current.updatedAt || '');
    const newer = incomingIsNewer ? incoming : current;
    const older = incomingIsNewer ? current : incoming;
    return cleanPublishedRecord({
      ...older,
      ...newer,
      id: newer.id || older.id,
      word: nonEmpty(newer.word, older.word),
      link: nonEmpty(newer.link, older.link),
      title: nonEmpty(newer.title, older.title),
      description: nonEmpty(newer.description, older.description),
      authorName: nonEmpty(newer.authorName, older.authorName),
      publishedAt: newer.publishedAt || older.publishedAt,
      latestStats: mergeStats(older.latestStats, newer.latestStats),
      snapshots: mergeSnapshots(older.snapshots, newer.snapshots),
      rating: nonEmpty(newer.rating, older.rating),
      performanceReason: getUniqueWords([...(older.performanceReason || []), ...(newer.performanceReason || [])]).filter(item => PERFORMANCE_REASON_LABELS[item]).slice(0, 8),
      performanceNote: nonEmpty(newer.performanceNote, older.performanceNote),
      remarks: nonEmpty(newer.remarks, older.remarks),
      autoRefresh: {
        ...(older.autoRefresh || {}),
        ...(newer.autoRefresh || {}),
        lastAttemptAt: [older.autoRefresh?.lastAttemptAt, newer.autoRefresh?.lastAttemptAt].filter(Boolean).sort().pop() || '',
        lastSuccessAt: [older.autoRefresh?.lastSuccessAt, newer.autoRefresh?.lastSuccessAt].filter(Boolean).sort().pop() || ''
      },
      updatedAt: [current.updatedAt, incoming.updatedAt].filter(Boolean).sort().pop() || null
    });
  };
  const merged = new Map();
  [...cleanPublishedRecords(localRecords), ...cleanPublishedRecords(remoteRecords)].forEach(record => {
    const key = record.id;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, record);
      return;
    }
    merged.set(key, mergeRecord(current, record));
  });
  return [...merged.values()].sort((left, right) => String(right.publishedAt || right.updatedAt).localeCompare(String(left.publishedAt || left.updatedAt)));
}

function mergeAiBatches(localBatches, remoteBatches) {
  const merged = new Map();
  [...cleanAiBatches(remoteBatches), ...cleanAiBatches(localBatches)].forEach(batch => {
    const current = merged.get(batch.id);
    if (!current) {
      merged.set(batch.id, batch);
      return;
    }
    const winner = String(batch.createdAt || '') >= String(current.createdAt || '') ? batch : current;
    const fallback = winner === batch ? current : batch;
    merged.set(batch.id, cleanAiBatch({
      ...fallback,
      ...winner,
      rawCount: Math.max(toInt(fallback.rawCount, 0), toInt(winner.rawCount, 0)),
      normalizedCount: Math.max(toInt(fallback.normalizedCount, 0), toInt(winner.normalizedCount, 0)),
      acceptedCount: Math.max(toInt(fallback.acceptedCount, 0), toInt(winner.acceptedCount, 0)),
      rejectedCount: Math.max(toInt(fallback.rejectedCount, 0), toInt(winner.rejectedCount, 0)),
      importedCount: Math.max(toInt(fallback.importedCount, 0), toInt(winner.importedCount, 0)),
      skippedCount: Math.max(toInt(fallback.skippedCount, 0), toInt(winner.skippedCount, 0)),
      items: safeArray(winner.items).length >= safeArray(fallback.items).length ? winner.items : fallback.items
    }));
  });
  return [...merged.values()]
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, 100);
}

function isCompatibleTodaySnapshotGeneratorVersion(value = '') {
  const generatorVersion = cleanShortText(value, 80);
  return generatorVersion === TODAY_SNAPSHOT_GENERATOR_VERSION
    || generatorVersion.startsWith(`${TODAY_SNAPSHOT_GENERATOR_VERSION}+`);
}

function cleanTodaySnapshot(snapshot = {}) {
  return cleanSharedTodaySnapshot(snapshot);
}

function cleanHistorySnapshot(snapshot = {}, fallbackDateKey = '') {
  return cleanSharedHistorySnapshot(snapshot, fallbackDateKey);
}

function cleanHistorySnapshots(snapshots = {}) {
  return cleanSharedHistorySnapshots(snapshots);
}

function cleanTodaySnapshotHistory(history = []) {
  return cleanSharedTodaySnapshotHistory(history);
}

function mergeHistorySnapshots(localSnapshots, remoteSnapshots) {
  return mergeSharedHistorySnapshots(localSnapshots, remoteSnapshots);
}

function mergeTodaySnapshotHistory(localHistory, remoteHistory) {
  return mergeSharedTodaySnapshotHistory(localHistory, remoteHistory);
}

function archiveTodaySnapshotHistory(snapshot = todaySnapshot) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return false;
  todaySnapshotHistory = cleanTodaySnapshotHistory([
    {
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
      archivedAt: nowIso(),
      title: '每日热门归档'
    },
    ...safeArray(todaySnapshotHistory)
  ]);
  return true;
}

function archiveTodaySnapshot(snapshot = todaySnapshot) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  if (!cleanSnapshot.dateKey || !cleanSnapshot.words.length) return false;
  archiveTodaySnapshotHistory(cleanSnapshot);
  const existing = cleanHistorySnapshot(historySnapshots[cleanSnapshot.dateKey] || {}, cleanSnapshot.dateKey);
  historySnapshots = cleanHistorySnapshots({
    ...historySnapshots,
    [cleanSnapshot.dateKey]: {
      dateKey: cleanSnapshot.dateKey,
      words: cleanSnapshot.words,
      generatedAt: cleanSnapshot.generatedAt,
      source: 'todaySnapshot',
      batchIds: cleanSnapshot.batchIds,
      version: Math.max(toInt(cleanSnapshot.version, 1), toInt(existing.version, 0)),
      generatorVersion: cleanSnapshot.generatorVersion,
      createdBy: cleanSnapshot.createdBy,
      dedupDaysUsed: cleanSnapshot.dedupDaysUsed,
      relaxedDedup: cleanSnapshot.relaxedDedup,
      shortage: cleanSnapshot.shortage,
      repeated30Count: cleanSnapshot.repeated30Count,
      repeated30Words: cleanSnapshot.repeated30Words,
      recommendationAudit: cleanSnapshot.recommendationAudit,
      archivedAt: nowIso(),
      title: '每日热门归档'
    }
  });
  refreshHistoryDates();
  return true;
}

function archiveStaleTodaySnapshot() {
  const snapshot = cleanTodaySnapshot(todaySnapshot);
  if (!snapshot.dateKey || !snapshot.words.length || snapshot.dateKey === todayKey()) return false;
  archiveTodaySnapshot(snapshot);
  todaySnapshot = cleanTodaySnapshot({});
  todayWords = [];
  return true;
}

function mergeTodaySnapshot(localSnapshot, remoteSnapshot) {
  return mergeSharedTodaySnapshot(localSnapshot, remoteSnapshot);
}

function hasTodaySnapshotForToday(snapshot = todaySnapshot) {
  const cleanSnapshot = cleanTodaySnapshot(snapshot);
  return cleanSnapshot.dateKey === todayKey()
    && cleanSnapshot.words.length > 0
    && isCompatibleTodaySnapshotGeneratorVersion(cleanSnapshot.generatorVersion);
}

function cleanAutoDailyRefreshState(state = {}) {
  const dateKeyValue = /^\d{4}-\d{2}-\d{2}$/.test(String(state.dateKey || '')) ? String(state.dateKey) : '';
  return {
    dateKey: dateKeyValue,
    status: ['idle', 'running', 'success', 'failed'].includes(state.status) ? state.status : 'idle',
    startedAt: typeof state.startedAt === 'string' ? state.startedAt : '',
    finishedAt: typeof state.finishedAt === 'string' ? state.finishedAt : '',
    error: cleanShortText(state.error, 500),
    attempts: clamp(toInt(state.attempts, 0), 0, 10)
  };
}

function getAutoDailyRefreshState() {
  try {
    return cleanAutoDailyRefreshState(JSON.parse(localStorage.getItem(AUTO_DAILY_REFRESH_KEY) || '{}'));
  } catch (error) {
    return cleanAutoDailyRefreshState();
  }
}

function setAutoDailyRefreshState(nextState = {}) {
  const state = cleanAutoDailyRefreshState(nextState);
  localStorage.setItem(AUTO_DAILY_REFRESH_KEY, JSON.stringify(state));
  return state;
}

function isAutoDailyRunningFresh(state = getAutoDailyRefreshState()) {
  if (state.status !== 'running' || !state.startedAt) return false;
  const startedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt < AUTO_DAILY_REFRESH_RUNNING_TTL_MS;
}

function getRenderableAutoDailyRefreshState() {
  const state = getAutoDailyRefreshState();
  if (state.dateKey === todayKey() && state.status === 'running' && !isAutoDailyRunningFresh(state)) {
    return setAutoDailyRefreshState({
      ...state,
      status: 'failed',
      finishedAt: nowIso(),
      error: '上次自动生成超时，已停止等待，可以手动生成。'
    });
  }
  return state;
}

function setTodayActionButtonsDisabled(disabled) {
  document.querySelectorAll('[data-today-action]').forEach(button => {
    button.disabled = Boolean(disabled);
  });
}

function markAutoDailySuccess() {
  return setAutoDailyRefreshState({
    dateKey: todayKey(),
    status: 'success',
    startedAt: getAutoDailyRefreshState().startedAt || nowIso(),
    finishedAt: nowIso(),
    error: '',
    attempts: getAutoDailyRefreshState().dateKey === todayKey() ? getAutoDailyRefreshState().attempts : 1
  });
}

function shouldRunDailyAutoRefresh(options = {}) {
  if (!options.force) return false;
  if (hasTodaySnapshotForToday(todaySnapshot)) return false;
  const state = getRenderableAutoDailyRefreshState();
  if (state.dateKey === todayKey() && state.status === 'success' && hasTodaySnapshotForToday(todaySnapshot)) return false;
  if (state.dateKey === todayKey() && state.status === 'failed' && state.attempts >= 3) return false;
  if (state.dateKey === todayKey() && isAutoDailyRunningFresh(state)) return false;
  return true;
}

function queueDailyAutoRefreshIfNeeded(options = {}) {
  if (!shouldRunDailyAutoRefresh(options)) return Promise.resolve(false);
  if (autoDailyRefreshPromise && !options.force) return autoDailyRefreshPromise;
  autoDailyRefreshPromise = runDailyAutoRefreshIfNeeded(options);
  return autoDailyRefreshPromise;
}

function updateAiBatchImportStats(batchId, importedDelta = 0, skippedDelta = 0) {
  if (!batchId) return;
  const current = cleanAiBatches(aiBatches);
  const index = current.findIndex(batch => batch.id === batchId);
  if (index < 0) return;
  current[index] = cleanAiBatch({
    ...current[index],
    importedCount: toInt(current[index].importedCount, 0) + importedDelta,
    skippedCount: toInt(current[index].skippedCount, 0) + skippedDelta
  }, index);
  aiBatches = current;
}

const workflowStore = createWorkflowStore({
  cleanWorkflow: cleanStoredWorkflow,
  mergeCandidatePool: (localPool, remotePool) => cleanCandidatePool({
    ...(localPool || {}),
    ...(remotePool || {})
  }),
  mergeHistorySnapshots,
  mergeTodaySnapshotHistory
});

function getCurrentWorkflowState() {
  return {
    words: favorites,
    statuses: favoriteStatuses,
    feedback: wordFeedback,
    publishedRecords,
    candidatePool,
    aiBatches,
    aiPreview,
    todaySnapshot,
    todayDismissed,
    historySnapshots,
    todaySnapshotHistory
  };
}

function applyWorkflowData(workflow = {}) {
  favorites = workflow.words;
  favoriteStatuses = workflow.statuses;
  wordFeedback = workflow.feedback;
  publishedRecords = workflow.publishedRecords;
  candidatePool = workflow.candidatePool;
  aiBatches = workflow.aiBatches;
  aiPreview = cleanAiPreviewState(workflow.aiPreview);
  todaySnapshot = workflow.todaySnapshot;
  todayDismissed = workflow.todayDismissed;
  historySnapshots = workflow.historySnapshots;
  todaySnapshotHistory = workflow.todaySnapshotHistory;
}

function loadLocalWorkflow(options = {}) {
  const includeLegacyLocal = Boolean(options.includeLegacyLocal);
  let workflow = { words: [], statuses: {}, feedback: {}, publishedRecords: [], candidatePool: {}, aiBatches: [], aiPreview: {}, todaySnapshot: {}, todayDismissed: {}, historySnapshots: {}, todaySnapshotHistory: [], revision: 0, auditLog: [], schemaVersion: 2 };
  try {
    const storedWorkflow = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (storedWorkflow) {
      workflow = cleanStoredWorkflow(JSON.parse(storedWorkflow));
      lastLocalCacheAt = workflow.updated || '';
    }
  } catch (error) {
    console.warn('本地工作流数据损坏，已忽略', error);
  }

  if (includeLegacyLocal) {
    try {
      const storedFavorites = localStorage.getItem(FAVORITES_STORAGE_KEY);
      const storedStatuses = localStorage.getItem(FAVORITE_STATUSES_STORAGE_KEY);
      const legacyFavorites = storedFavorites ? JSON.parse(storedFavorites) : [];
      const legacyStatuses = storedStatuses ? JSON.parse(storedStatuses) : {};
      const mergedWords = filterKnownFavorites([...workflow.words, ...safeArray(legacyFavorites)], workflow.candidatePool);
      const mergedStatuses = { ...legacyStatuses, ...workflow.statuses };
      workflow.words = mergedWords;
      workflow.statuses = Object.entries(mergedStatuses).reduce((result, [word, status]) => {
        const cleanWord = String(word || '').trim();
        const cleanStatus = cleanFavoriteStatus(status);
        if (mergedWords.includes(cleanWord) && cleanStatus !== 'none') result[cleanWord] = cleanStatus;
        return result;
      }, {});
    } catch (error) {
      console.warn('旧收藏数据读取失败，已忽略', error);
    }
  }

  applyWorkflowData(workflow);
  workflowStore.replaceMetadata(workflow);
  migrateOriginalWordsAfterAudit();
  ensureReviewedSeedWordsInCandidatePool();
  archiveStaleTodaySnapshot();
  hydrateTodayWordsFromSnapshot();
  refreshHistoryDates();
}

function saveLocalWorkflow() {
  ensureFavoriteWordsHaveCandidateEntries();
  favorites = filterKnownFavorites(favorites);
  favoriteStatuses = Object.entries(favoriteStatuses || {}).reduce((result, [word, status]) => {
    const cleanWord = String(word || '').trim();
    const cleanStatus = cleanFavoriteStatus(status);
    if (favorites.includes(cleanWord) && cleanStatus !== 'none') result[cleanWord] = cleanStatus;
    return result;
  }, {});
  wordFeedback = cleanWordFeedback(wordFeedback);
  publishedRecords = cleanPublishedRecords(publishedRecords);
  getProtectedLibraryWords().forEach(kanji => ensureManualKeepEntry(kanji));
  candidatePool = cleanCandidatePool(candidatePool);
  migrateOriginalWordsAfterAudit();
  ensureReviewedSeedWordsInCandidatePool();
  aiBatches = cleanAiBatches(aiBatches);
  aiPreview = cleanAiPreviewState(aiPreview);
  todaySnapshot = cleanTodaySnapshot(todaySnapshot);
  todayDismissed = cleanTeamDismissedState(todayDismissed);
  if (todaySnapshot.words.length) archiveTodaySnapshot(todaySnapshot);
  historySnapshots = cleanHistorySnapshots(historySnapshots);
  todaySnapshotHistory = cleanTodaySnapshotHistory(todaySnapshotHistory);

  const payload = workflowStore.buildPayload(getCurrentWorkflowState(), nowIso());
  if (writeLocalWorkflowCache(payload)) lastLocalCacheAt = payload.updated;
}

const LOCAL_WORKFLOW_CACHE_CANDIDATE_LIMIT = DEFAULT_CANDIDATE_LIMIT;
const workflowCache = createWorkflowCache({
  storage: localStorage,
  cleanWorkflow: cleanStoredWorkflow,
  candidateLimit: LOCAL_WORKFLOW_CACHE_CANDIDATE_LIMIT,
  keys: {
    workflow: WORKFLOW_STORAGE_KEY,
    favorites: FAVORITES_STORAGE_KEY,
    statuses: FAVORITE_STATUSES_STORAGE_KEY,
    aiPreview: AI_PREVIEW_STORAGE_KEY,
    todayDismissed: TODAY_DISMISSED_STORAGE_KEY
  }
});

function writeLocalWorkflowCache(payload = {}) {
  return workflowCache.write(payload);
}

function cacheCurrentWorkflow(updatedAt = nowIso()) {
  ensureFavoriteWordsHaveCandidateEntries();
  aiPreview = cleanAiPreviewState(aiPreview);
  todayDismissed = cleanTeamDismissedState(todayDismissed);
  const payload = workflowStore.buildPayload(getCurrentWorkflowState(), updatedAt);
  const workflowCached = writeLocalWorkflowCache(payload);
  workflowStore.replaceMetadata(payload);
  if (workflowCached) lastLocalCacheAt = payload.updated || updatedAt;
  return payload;
}

let hasUnsavedFormChanges = false;
let cloudSaveEpoch = 0;
let cloudSaveQueue = Promise.resolve(false);
let pendingCloudSaveCount = 0;
let cloudWorkflowLoadEpoch = 0;
let backgroundSyncPromise = null;
const apiClient = createApiClient({ getWorkflowRevision: () => workflowStore.getRevision() });
const uiOperationsInFlight = apiClient.operationsInFlight;
const createOperationId = apiClient.createOperationId;
const getApiErrorMessage = apiClient.getApiErrorMessage;
const createApiError = apiClient.createApiError;
const apiFetch = apiClient.request;
const workflowSync = createWorkflowSync({
  request: apiFetch,
  createError: createApiError,
  loadRemote: () => loadCloudWorkflow({ mode: 'remote-first', showMessages: false })
});

async function runUiOperation(key, operation) {
  return apiClient.runExclusive(key, operation, () => showToast('操作正在处理中，请稍候'));
}

function normalizeWorkflowScope(scope = '') {
  return workflowStore.normalizeScope(scope);
}

function getPreferredWorkflowScope() {
  const activeTab = document.body.dataset.activeTab || localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) || 'today';
  return normalizeWorkflowScope(activeTab === 'history' ? 'today' : activeTab);
}

function getWorkflowScopeHistoryDate(scope = getPreferredWorkflowScope()) {
  if (scope !== 'today') return '';
  const tomorrow = addDaysToDateKey(todayKey(), 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(currentDailyHotDateKey) && currentDailyHotDateKey !== tomorrow
    ? currentDailyHotDateKey
    : '';
}

function getWorkflowScopeKey(scope = getPreferredWorkflowScope(), historyDate = getWorkflowScopeHistoryDate(scope)) {
  return workflowStore.getScopeKey(scope, historyDate);
}

function isWorkflowScopeLoaded(scope = getPreferredWorkflowScope(), historyDate = getWorkflowScopeHistoryDate(scope)) {
  return workflowStore.isScopeLoaded(scope, historyDate);
}

function markWorkflowScopeLoaded(scope = 'today', historyDate = '') {
  workflowStore.markScopeLoaded(scope, historyDate);
}

function getSyncEndpoint(options = {}) {
  if (!SYNC_API_URL) return '';
  const url = new URL(`${SYNC_API_URL}/favorites`, window.location.origin);
  url.searchParams.set('view', 'app');
  const scope = normalizeWorkflowScope(options.scope || getPreferredWorkflowScope());
  const historyDate = cleanShortText(options.historyDate || getWorkflowScopeHistoryDate(scope), 20);
  url.searchParams.set('scope', scope);
  if (historyDate) url.searchParams.set('historyDate', historyDate);
  return url.toString();
}

function getFavoriteCommandEndpoint(kanji) {
  if (!SYNC_API_URL) return '';
  const url = new URL(`${SYNC_API_URL}/favorites`, window.location.origin);
  url.searchParams.set('view', 'command');
  url.searchParams.set('word', cleanShortText(kanji, 80));
  return url.toString();
}

function getRankingsEndpoint(days = RANKINGS_DAYS) {
  if (!SYNC_API_URL) return '';
  return `${SYNC_API_URL}/rankings?days=${encodeURIComponent(days)}`;
}

function getPublishedRefreshEndpoint() {
  if (!SYNC_API_URL) return '';
  return `${SYNC_API_URL}/published-refresh`;
}

function getAiCandidatesEndpoint() {
  return SYNC_API_URL ? `${SYNC_API_URL}/ai-candidates` : '/ai-candidates';
}

function getAiCardsEndpoint() {
  return SYNC_API_URL ? `${SYNC_API_URL}/ai-cards` : '/ai-cards';
}

function getTodaySnapshotEndpoint() {
  return SYNC_API_URL ? `${SYNC_API_URL}/today-snapshot` : '/today-snapshot';
}

function getCodexDailyEndpoint(targetDateKey = addDaysToDateKey(todayKey(), 1), view = 'status') {
  const base = SYNC_API_URL ? `${SYNC_API_URL}/codex-daily` : '/codex-daily';
  const url = new URL(base, window.location.origin);
  url.searchParams.set('date', targetDateKey);
  const allowedViews = new Set(['status', 'draft', 'preview-status', 'preview']);
  url.searchParams.set('view', allowedViews.has(view) ? view : 'status');
  return url.toString();
}

async function loadCodexTomorrowDraftStatus() {
  const targetDateKey = addDaysToDateKey(todayKey(), 1);
  try {
    const response = await apiFetch(getCodexDailyEndpoint(targetDateKey, 'preview-status'), { headers: { Accept: 'application/json' } }, { cancelKey: 'codex-draft-status' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    codexTomorrowDraftStatus = data.draft || null;
    codexTomorrowDraftError = '';
    if (codexTomorrowDraft?.targetDateKey !== targetDateKey
      || (codexTomorrowDraftStatus?.updatedAt && codexTomorrowDraft?.updatedAt !== codexTomorrowDraftStatus.updatedAt)) {
      codexTomorrowDraft = null;
    }
  } catch (error) {
    codexTomorrowDraftStatus = null;
    if (!codexTomorrowDraft) codexTomorrowDraftError = error.message || '明日草稿状态读取失败';
  }
  if (isViewingTomorrowDailyHot()) return loadCodexTomorrowDraft();
  if (document.body.dataset.activeTab === 'today') renderDailyHot();
  return codexTomorrowDraftStatus;
}

async function loadCodexTomorrowDraft(options = {}) {
  const targetDateKey = addDaysToDateKey(todayKey(), 1);
  if (!options.force && codexTomorrowDraft?.targetDateKey === targetDateKey) return codexTomorrowDraft;
  if (codexTomorrowDraftPromise) return codexTomorrowDraftPromise;
  codexTomorrowDraftError = '';
  codexTomorrowDraftPromise = (async () => {
    try {
      const response = await apiFetch(
        getCodexDailyEndpoint(targetDateKey, 'preview'),
        { headers: { Accept: 'application/json' } },
        { cancelKey: 'codex-draft-preview' }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.draft) throw new Error('接口未返回明日草稿');
      codexTomorrowDraft = data.draft;
      return codexTomorrowDraft;
    } catch (error) {
      codexTomorrowDraft = null;
      codexTomorrowDraftError = error.message || '明日草稿读取失败';
      if (options.notifyOnError) showToast(`明日草稿读取失败：${error.message || '请稍后重试'}`);
      return null;
    } finally {
      codexTomorrowDraftPromise = null;
      if (document.body.dataset.activeTab === 'today' && isViewingTomorrowDailyHot()) renderDailyHot();
    }
  })();
  return codexTomorrowDraftPromise;
}

function getLegacySyncEndpoint() {
  if (!SYNC_API_URL) return '';
  const legacySyncCode = cleanSyncCode(localStorage.getItem(LEGACY_SYNC_CODE_STORAGE_KEY));
  if (legacySyncCode.length < 8) return '';
  return `${SYNC_API_URL}/favorites?code=${encodeURIComponent(legacySyncCode)}`;
}

async function loadLegacyCloudFavorites() {
  const endpoint = getLegacySyncEndpoint();
  if (!endpoint) return [];
  try {
    const response = await apiFetch(endpoint, { headers: { Accept: 'application/json' } }, { cancelKey: 'legacy-workflow' });
    if (!response.ok) return [];
    const data = await response.json();
    return filterKnownFavorites(data.words);
  } catch (error) {
    console.warn('旧同步码收藏迁移失败', error);
    return [];
  }
}

function updateSyncStatus(message, color = 'var(--text-secondary)') {
  const status = document.getElementById('tokenStatus');
  if (!status) return;
  status.textContent = message;
  status.style.color = color;
}

function applyRemoteWorkflowState(remoteData, options = {}) {
  const prepared = workflowStore.prepareRemoteState(remoteData, getCurrentWorkflowState(), options);
  if (!prepared.applied) {
    console.info('已忽略旧版云端工作流响应', {
      remoteRevision: prepared.data.revision,
      currentRevision: workflowStore.getRevision()
    });
    return prepared;
  }

  applyWorkflowData(prepared.state);
  cloudWorkflowFailed = false;
  lastCloudSyncAt = nowIso();
  hydrateTodayWordsFromSnapshot();
  cacheCurrentWorkflow(prepared.data.updated || lastCloudSyncAt);
  return prepared;
}

function applyFavoriteCommandResponse(responseData, kanji) {
  const candidate = cleanCandidatePoolEntry(kanji, responseData?.candidate || {});
  if (candidate) candidatePool[kanji] = candidate;
  favorites = filterKnownFavorites(responseData?.words, candidatePool);
  favoriteStatuses = cleanStoredWorkflow({
    words: favorites,
    statuses: responseData?.statuses
  }).statuses;
  workflowStore.applyCommandMetadata(responseData);
  cloudWorkflowFailed = false;
  lastCloudSyncAt = nowIso();
  cacheCurrentWorkflow(responseData?.updated || lastCloudSyncAt);
}

function buildFavoriteCommandPayload(kanji, action, status = '') {
  const payload = { action, word: kanji };
  if (action === 'status') payload.status = status;
  const candidate = cleanCandidatePoolEntry(kanji, candidatePool[kanji] || {});
  if (candidate && ['add', 'status'].includes(action)) {
    payload.candidatePool = { [kanji]: candidate };
  }
  return payload;
}

function isFavoriteCommandSatisfied(kanji, action, status = '') {
  const isFavorite = favorites.includes(kanji);
  if (action === 'add') return isFavorite;
  if (action === 'remove') return !isFavorite;
  if (action === 'status') return isFavorite && getFavoriteStatus(kanji) === cleanFavoriteStatus(status);
  return false;
}

function buildReconciledFavoriteCommandResponse(kanji) {
  return {
    ok: true,
    words: favorites,
    statuses: favoriteStatuses,
    candidate: candidatePool[kanji] || null,
    revision: workflowStore.getRevision(),
    auditEvent: null,
    updated: lastCloudSyncAt,
    schemaVersion: 2
  };
}

async function requestFavoriteCommand(kanji, action, status = '') {
  const endpoint = getFavoriteCommandEndpoint(kanji);
  if (!endpoint) throw new Error('收藏同步接口还没有配置');
  ensureFavoriteWordsHaveCandidateEntries();
  const payload = buildFavoriteCommandPayload(kanji, action, status);
  const operationId = createOperationId(`favorite-${action}`);
  return workflowSync.mutate({
    endpoint,
    payload,
    operationId,
    operationPrefix: `favorite-${action}`,
    isSatisfied: () => isFavoriteCommandSatisfied(kanji, action, status),
    buildReconciledResponse: () => buildReconciledFavoriteCommandResponse(kanji)
  });
}

async function fetchWorkflowView(endpoint, loadEpoch) {
  return workflowSync.read({
    endpoint,
    isCurrent: () => loadEpoch === cloudWorkflowLoadEpoch
  });
}

async function loadCloudWorkflow(options = false) {
  const config = typeof options === 'boolean' ? { showMessages: options } : (options || {});
  const showMessages = Boolean(config.showMessages);
  const scope = normalizeWorkflowScope(config.scope || getPreferredWorkflowScope());
  const historyDate = cleanShortText(config.historyDate || getWorkflowScopeHistoryDate(scope), 20);
  const endpoint = getSyncEndpoint({ scope, historyDate });
  const loadEpoch = ++cloudWorkflowLoadEpoch;
  if (!endpoint) {
    if (showMessages) showToast('云端后端还没有配置');
    cloudWorkflowFailed = true;
    return false;
  }

  try {
    if (showMessages) updateSyncStatus('正在同步工作流数据...');
    const responseData = await fetchWorkflowView(endpoint, loadEpoch);
    if (loadEpoch !== cloudWorkflowLoadEpoch) return false;
    const applied = applyRemoteWorkflowState(responseData, {
      mergeCandidatePool: Boolean(config.mergeCandidatePool || workflowStore.hasLoadedScopes())
    });
    if (!applied.applied) {
      cloudWorkflowFailed = false;
      if (showMessages) showToast('已保留页面中的较新数据');
      return true;
    }
    const responseScope = applied.data.appView?.scope || scope;
    const responseHistoryDate = applied.data.appView?.historyDate || historyDate;
    markWorkflowScopeLoaded(responseScope, responseHistoryDate);
    archiveStaleTodaySnapshot();
    verifyDeepSeekLibraryAuditCoverage();
    try {
      updateAllBadges();
      refreshCurrentGrid();
    } catch (renderError) {
      console.error('工作流已同步，但页面渲染失败', renderError);
      if (showMessages) showToast('数据已同步，但页面显示失败，请刷新后重试');
    }

    if (showMessages) {
      updateSyncStatus(`团队工作流已同步：选题池 ${getFavoriteWords().length} 个词，已发布 ${getPublishedDisplayItems().length} 条`, '#4caf50');
      showToast('工作流已同步');
    }
    return true;
  } catch (error) {
    if (loadEpoch !== cloudWorkflowLoadEpoch || error?.code === 'REQUEST_ABORTED') {
      console.info('旧的工作流同步已取消');
      return false;
    }
    console.warn('工作流同步失败', error);
    cloudWorkflowFailed = true;
    if (showMessages) {
      updateSyncStatus('云端同步失败，正在使用本地缓存', '#c0392b');
      showToast('云端同步失败，正在使用本地缓存');
    }
    return false;
  }
}

function buildCloudWorkflowPayload() {
  ensureReviewedSeedWordsInCandidatePool();
  ensureFavoriteWordsHaveCandidateEntries();
  if (cleanTodaySnapshot(todaySnapshot).words.length) archiveTodaySnapshot(todaySnapshot);
  aiPreview = cleanAiPreviewState(aiPreview);
  todayDismissed = cleanTeamDismissedState(todayDismissed);
  return workflowStore.buildPayload({
    ...getCurrentWorkflowState(),
    words: filterKnownFavorites(favorites, candidatePool),
    feedback: cleanWordFeedback(wordFeedback),
    publishedRecords: cleanPublishedRecords(publishedRecords),
    candidatePool: cleanCandidatePool(candidatePool),
    aiBatches: cleanAiBatches(aiBatches),
    todaySnapshot: cleanTodaySnapshot(todaySnapshot),
    historySnapshots: cleanHistorySnapshots(historySnapshots),
    todaySnapshotHistory: cleanTodaySnapshotHistory(todaySnapshotHistory)
  }, nowIso());
}

async function performCloudWorkflowSave(showMessages, payload, queuedEpoch) {
  const endpoint = getSyncEndpoint();
  if (!endpoint) {
    cloudWorkflowFailed = true;
    if (showMessages) showToast('云端后端还没有配置，团队同步失败');
    return false;
  }
  try {
    const response = await apiFetch(endpoint, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, { workflowMutation: true, operationPrefix: 'workflow-save', timeoutMs: 30000 });
    const responseData = await response.json().catch(() => payload);
    if (!response.ok) throw createApiError(responseData, response.status);
    applyRemoteWorkflowState(responseData, { mergeCandidatePool: true });
    if (showMessages) {
      updateSyncStatus('已保存到云端', '#4caf50');
      showToast('已保存到云端');
    }
    return true;
  } catch (error) {
    console.warn('保存工作流失败', error);
    if (error.status === 409) {
      cloudSaveEpoch = Math.max(cloudSaveEpoch, queuedEpoch + 1);
      await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    }
    cloudWorkflowFailed = true;
    updateSyncStatus('团队同步失败，本次修改未保存到团队后台', '#c0392b');
    showToast('团队同步失败，本次修改未保存到团队后台');
    return false;
  }
}

function saveCloudWorkflow(showMessages = false) {
  if (!getSyncEndpoint()) {
    cloudWorkflowFailed = true;
    if (showMessages) showToast('云端后端还没有配置，团队同步失败');
    return Promise.resolve(false);
  }
  const payload = buildCloudWorkflowPayload();
  const queuedEpoch = cloudSaveEpoch;
  const queuedSave = cloudSaveQueue.then(() => {
    if (queuedEpoch !== cloudSaveEpoch) return false;
    return performCloudWorkflowSave(showMessages, payload, queuedEpoch);
  });
  pendingCloudSaveCount += 1;
  const trackedSave = queuedSave.finally(() => {
    pendingCloudSaveCount = Math.max(0, pendingCloudSaveCount - 1);
  });
  cloudSaveQueue = trackedSave.catch(() => false);
  return trackedSave;
}

async function refreshPublishedMetrics(recordId = '') {
  const endpoint = getPublishedRefreshEndpoint();
  if (!endpoint) {
    showToast('自动更新接口还没有配置');
    return false;
  }

  try {
    updateSyncStatus(recordId ? '正在尝试更新这条已发布记录...' : '正在尝试更新已发布数据...');
    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        recordId,
        publishedRecords: cleanPublishedRecords(publishedRecords)
      })
    }, { workflowMutation: true, operationPrefix: 'published-refresh', timeoutMs: 30000 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw createApiError(data, response.status);
    publishedRecords = mergePublishedRecords(publishedRecords, data.publishedRecords);
    workflowStore.acceptRevision(data.revision);
    saveLocalWorkflow();
    updateAllBadges();
    renderPublished();
    refreshCurrentGrid();
    if (recordId && currentPublishedRecordId === recordId) openPublishedDetail(recordId);
    const message = data.summary?.message || '已完成自动更新尝试';
    updateSyncStatus(message, data.summary?.successCount ? '#4caf50' : '#c0392b');
    showToast(message);
    return true;
  } catch (error) {
    console.warn('自动更新已发布数据失败', error);
    updateSyncStatus('自动更新失败，已保留本地数据', '#c0392b');
    showToast('自动更新失败，已保留上一次数据');
    return false;
  }
}

async function syncFavoriteChange(kanji, action) {
  try {
    const responseData = await requestFavoriteCommand(kanji, action);
    applyFavoriteCommandResponse(responseData, kanji);
    updateAllBadges();
    refreshCurrentGrid();
    return true;
  } catch (error) {
    console.warn('收藏同步失败', error);
    const reconciled = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    cloudWorkflowFailed = !reconciled;
    showToast('团队同步失败，本次修改未保存到团队后台');
    return false;
  }
}

async function syncFavoriteStatus(kanji, status) {
  try {
    const responseData = await requestFavoriteCommand(kanji, 'status', status);
    applyFavoriteCommandResponse(responseData, kanji);
    updateAllBadges();
    refreshCurrentGrid();
    return true;
  } catch (error) {
    console.warn('状态同步失败', error);
    const reconciled = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    cloudWorkflowFailed = !reconciled;
    showToast('团队同步失败，本次修改未保存到团队后台');
    return false;
  }
}

function getUsageScene(word) {
  const category = String(word?.category || '');
  const source = String(word?.source || '');
  if (category === '若者語') return '年轻人口语和评论区';
  if (category === 'SNS') return '社交平台标题、评论和互动文案';
  if (category === 'ビジネス') return '职场、报告或工作沟通';
  if (category === '感情') return '表达情绪和共鸣型内容';
  if (category === '食') return '美食、探店和生活分享';
  if (category === '旅行') return '旅行笔记和城市体验';
  if (category === '文化') return '文化差异和知识型内容';
  if (category === '学習') return '学习经验和方法内容';
  if (source.includes('Twitter') || source.includes('Instagram') || source.includes('YouTube') || source.includes('SNS')) return '社交媒体的轻松语境';
  if (source.includes('NHK') || source.includes('書籍') || source.includes('伝統')) return '偏正式或解释型语境';
  return '日常会话和普通分享';
}

function getUsageRegister(word) {
  const source = String(word?.source || '');
  const kanji = String(word?.kanji || '');
  if (/[ァ-ヶ]/.test(kanji)) return '外来语或网络感更强';
  if (source.includes('NHK') || source.includes('書籍') || source.includes('ビジネス') || source.includes('伝統')) return '书面感和正式度更高';
  if (source.includes('LINE') || source.includes('Twitter') || source.includes('Instagram') || source.includes('2ch') || source.includes('SNS')) return '口语感更强';
  return '使用场景比较中性';
}

function getExampleSourcePresets(word) {
  const category = String(word?.category || '');
  const source = String(word?.source || '');
  if (category === '若者語' || source.includes('Twitter') || source.includes('SNS')) {
    return ['弹幕常见句式', '评论区常见说法', '综艺接话风'];
  }
  if (category === '感情') {
    return ['热门歌词风', '日剧台词风', '网络共鸣句'];
  }
  if (category === '文化' || category === '学習') {
    return ['知识讲解风', '采访表达风', '网络科普句'];
  }
  if (category === '食' || category === '旅行' || category === '日常') {
    return ['探店文案风', 'Vlog 口播风', '朋友圈配文风'];
  }
  if (category === 'ビジネス') {
    return ['职场表达风', '采访表达风', '复盘句式'];
  }
  return ['网络句子', '口播常用句', '评论区常见说法'];
}

function fillExampleTemplate(template, kanji, reading, meaningCore) {
  return String(template || '')
    .replaceAll('{K}', kanji)
    .replaceAll('{R}', reading)
    .replaceAll('{M}', meaningCore);
}

function getExampleTierPriority(tier) {
  return ({ B: 0, A: 1, C: 2 })[String(tier || '').toUpperCase()] ?? 9;
}

function inferExampleTierFromSource(word) {
  const source = String(word?.source || '');
  if (source.includes('歌詞') || source.includes('書籍') || source.includes('伝統') || source.includes('名言')) {
    return 'B';
  }
  return 'A';
}

function inferExampleSourceLabel(word, tier) {
  const source = String(word?.source || '');
  if (tier === 'B') {
    if (source.includes('歌詞')) return '歌词常见表达';
    if (source.includes('書籍')) return '书籍常见表达';
    if (source.includes('伝統')) return '传统表达';
    if (source.includes('名言')) return '名言常见表达';
    return '经典表达';
  }
  if (source.includes('Twitter') || source.includes('Instagram') || source.includes('YouTube') || source.includes('LINE') || source.includes('SNS')) {
    return '网络常见句子';
  }
  if (source.includes('NHK') || source.includes('ビジネス') || source.includes('学習')) {
    return '常见用法例句';
  }
  return '常见句子';
}

function buildKanaFromLegacyExample(exampleText, kanji, reading) {
  const text = String(exampleText || '').trim();
  if (!text || !kanji || !reading) return '';
  const replaced = text.replaceAll(kanji, reading);
  return /[一-龯々]/.test(replaced) ? '' : replaced;
}

function buildLegacyExampleTranslation(exampleText, kanji, meaningCore) {
  const text = String(exampleText || '').trim();
  const meaning = String(meaningCore || '这个词').trim();
  if (!text) return '';
  if (/に行こう[！!。]?$/.test(text)) return `去${meaning}相关的地方吧。`;
  if (/したい[！!。]?$/.test(text)) return `想试试看和“${meaning}”有关的这件事。`;
  if (/してみる[！!。]?$/.test(text)) return `试着做一次和“${meaning}”有关的事。`;
  if (/中です[。!！]?$/.test(text)) return `现在正在做和“${meaning}”相关的事。`;
  if (/好き[。!！]?$/.test(text)) return `我很喜欢这种“${meaning}”的感觉。`;
  if (/わかる[〜~！!。]?$/.test(text)) return `这种“${meaning}”的感觉我太懂了。`;
  if (/深刻[。!！]?$/.test(text)) return `和“${meaning}”相关的话题已经变得很明显了。`;
  if (/感謝[。!！]?$/.test(text)) return `对这种“${meaning}”的相遇和体验心怀感谢。`;
  return `这句话里用“${kanji || meaning}”来表达“${meaning}”这种感觉。`;
}

function buildLegacyExampleRecord(word, kanji, reading, meaningCore) {
  const jp = String(word?.example || '').trim();
  if (!jp) return null;
  const tier = inferExampleTierFromSource(word);
  const kana = buildKanaFromLegacyExample(jp, kanji, reading);
  return {
    tier,
    jp,
    kana,
    romaji: kana ? kanaToRomaji(kana) : '',
    cn: buildLegacyExampleTranslation(jp, kanji, meaningCore),
    source: inferExampleSourceLabel(word, tier)
  };
}

function normalizeExampleRecord(example, kanji, reading, meaningCore, fallbackTier = 'C') {
  if (!example) return null;
  const jp = fillExampleTemplate(example.jp || '', kanji, reading, meaningCore).trim();
  const kana = fillExampleTemplate(example.kana || '', kanji, reading, meaningCore).trim();
  const romaji = fillExampleTemplate(example.romaji || '', kanji, reading, meaningCore).trim();
  const cn = fillExampleTemplate(example.cn || '', kanji, reading, meaningCore).trim();
  if (!jp || !cn) return null;
  return {
    tier: String(example.tier || fallbackTier).toUpperCase(),
    jp,
    kana,
    romaji: romaji || (kana ? kanaToRomaji(kana) : ''),
    cn,
    source: String(example.source || '语境仿写').trim() || '语境仿写'
  };
}

function getStructuredExampleTemplates(baseWord, meaningCore) {
  const category = String(baseWord?.category || '');
  const scene = getUsageScene(baseWord);
  const categoryTemplates = {
    若者語: [
      {
        source: '评论区仿写',
        jp: 'そのひとこと、まじで「{K}」って感じ。',
        kana: 'そのひとこと、まじで「{R}」って かんじ。',
        cn: `这句话一出来，真的就是“{M}”那种感觉。`
      },
      {
        source: '弹幕句式仿写',
        jp: 'コメント欄で「{K}」って見ると、空気がすぐわかる。',
        kana: 'こめんとらんで「{R}」って みると、くうきが すぐ わかる。',
        cn: '在评论区里看到“{K}”，一下就能懂当下的气氛。'
      },
      {
        source: '综艺接话风仿写',
        jp: 'この返しで「{K}」使うの、いまっぽくて好き。',
        kana: 'この かえしで「{R}」つかうの、いまっぽくて すき。',
        cn: '这种接话里用“{K}”，会特别有现在流行的语感。'
      }
    ],
    SNS: [
      {
        source: '标题文案仿写',
        jp: 'タイトルに「{K}」を入れると、空気感が一気に伝わる。',
        kana: 'たいとるに「{R}」を いれると、くうきかんが いっきに つたわる。',
        cn: '标题里放进“{K}”，氛围感一下就出来了。'
      },
      {
        source: '平台短句仿写',
        jp: 'SNSでは「{K}」のひとことで、温度感まで出せる。',
        kana: 'えすえぬえすでは「{R}」の ひとことで、おんどかんまで だせる。',
        cn: '在社交平台上，“{K}”一句话就能把语气温度带出来。'
      },
      {
        source: '评论区仿写',
        jp: '短く言いたいときは、「{K}」がちょうどいい。',
        kana: 'みじかく いいたいときは、「{R}」が ちょうどいい。',
        cn: '想短一点表达时，用“{K}”会刚刚好。'
      }
    ],
    感情: [
      {
        source: '日剧台词风仿写',
        jp: 'あのときの気持ち、ひとことで言うなら「{K}」だった。',
        kana: 'あのときの きもち、ひとことで いうなら「{R}」だった。',
        cn: '那一刻的心情，如果只用一个词来说，就是“{K}”。'
      },
      {
        source: '歌词风仿写',
        jp: 'ちゃんと説明できないけど、「{K}」がいちばん近い。',
        kana: 'ちゃんと せつめい できないけど、「{R}」が いちばん ちかい。',
        cn: '虽然很难解释清楚，但“{K}”已经是最接近的说法了。'
      },
      {
        source: '共鸣文案仿写',
        jp: 'この場面は「{K}」って言うと、気持ちがすっと伝わる。',
        kana: 'この ばめんは「{R}」って いうと、きもちが すっと つたわる。',
        cn: '这个场景里说“{K}”，情绪会一下子顺进去。'
      }
    ],
    文化: [
      {
        source: '知识口播仿写',
        jp: 'こういう場面で「{K}」って言うと、日本語らしい空気が出る。',
        kana: 'こういう ばめんで「{R}」って いうと、にほんごらしい くうきが でる。',
        cn: '这种场合里说“{K}”，会很有日语本身的语感。'
      },
      {
        source: '讲解文案仿写',
        jp: '直訳より「{K}」のまま覚えたほうが、使いどころが見えやすい。',
        kana: 'ちょくやくより「{R}」のまま おぼえたほうが、つかいどころが みえやすい。',
        cn: '比起硬翻译，直接把“{K}”当成一个整体记住会更好用。'
      },
      {
        source: '采访表达风仿写',
        jp: '日本では、この感覚を「{K}」でまとめることが多い。',
        kana: 'にほんでは、この かんかくを「{R}」で まとめることが おおい。',
        cn: '在日本，这种感觉经常会直接用“{K}”来概括。'
      }
    ],
    学習: [
      {
        source: '知识讲解仿写',
        jp: 'こういう場面で「{K}」って言うと、日本語らしい空気が出る。',
        kana: 'こういう ばめんで「{R}」って いうと、にほんごらしい くうきが でる。',
        cn: '这种场景里说“{K}”，会更接近日语原本的表达方式。'
      },
      {
        source: '课堂笔记风仿写',
        jp: '直訳だけで覚えるより、「{K}」の使いどころごと覚えたい。',
        kana: 'ちょくやくだけで おぼえるより、「{R}」の つかいどころごと おぼえたい。',
        cn: '比起只背直译，更重要的是一起记住“{K}”会在什么场景出现。'
      },
      {
        source: '口播讲解仿写',
        jp: '「{K}」は意味だけじゃなく、場面ごと覚えると使いやすい。',
        kana: '「{R}」は いみだけじゃなく、ばめんごと おぼえると つかいやすい。',
        cn: '“{K}”不只是记意思，连同场景一起记会更容易真正用出来。'
      }
    ],
    食: [
      {
        source: '探店文案仿写',
        jp: 'ひとくち目で「おいしい」より先に「{K}」って言いたくなる。',
        kana: 'ひとくちめで「おいしい」より さきに「{R}」って いいたくなる。',
        cn: '第一口时，比起只说“好吃”，会更想说一句“{K}”。'
      },
      {
        source: 'Vlog 口播风仿写',
        jp: 'この一皿、味だけじゃなくて「{K}」って余韻まで残る。',
        kana: 'この ひとさら、あじだけじゃなくて「{R}」って よいんまで のこる。',
        cn: '这道菜留下来的不只是味道，还有“{K}”那种余韵。'
      },
      {
        source: '生活分享仿写',
        jp: '食レポで「{K}」を使うと、感想に温度感が出る。',
        kana: 'しょくれぽで「{R}」を つかうと、かんそうに おんどかんが でる。',
        cn: '做美食分享时，用“{K}”会让感受显得更有温度。'
      }
    ],
    旅行: [
      {
        source: '旅行文案仿写',
        jp: 'この景色は、「{K}」って言葉がいちばんしっくりくる。',
        kana: 'この けしきは、「{R}」って ことばが いちばん しっくりくる。',
        cn: '这片风景如果只用一个词来概括，“{K}”最贴切。'
      },
      {
        source: 'Vlog 口播风仿写',
        jp: '旅先の空気をひとことで言うなら、「{K}」かもしれない。',
        kana: 'たびさきの くうきを ひとことで いうなら、「{R}」かもしれない。',
        cn: '如果要用一句话总结旅途里的气氛，也许就是“{K}”。'
      },
      {
        source: '配文仿写',
        jp: 'Vlogのひとことで「{K}」を入れると、ムードまで伝わる。',
        kana: 'ぶいろぐの ひとことで「{R}」を いれると、むーどまで つたわる。',
        cn: 'Vlog 里加一句“{K}”，连整体氛围都会一起传出来。'
      }
    ],
    ビジネス: [
      {
        source: '职场表达仿写',
        jp: 'この場面で「{K}」と言えると、意図が短く伝わる。',
        kana: 'この ばめんで「{R}」と いえると、いとが みじかく つたわる。',
        cn: '这个场景里如果能用“{K}”来说，意思会更简洁地传达出去。'
      },
      {
        source: '会议口播仿写',
        jp: '会話で「{K}」を使うときは、言い方の温度感が大事。',
        kana: 'かいわで「{R}」を つかうときは、いいかたの おんどかんが だいじ。',
        cn: '在对话里用“{K}”时，重点不只是词本身，还有说出来的语气。'
      },
      {
        source: '复盘句式仿写',
        jp: '仕事の文脈では、「{K}」の使い方で印象が変わる。',
        kana: 'しごとの ぶんみゃくでは、「{R}」の つかいかたで いんしょうが かわる。',
        cn: '放在工作语境里，“{K}”怎么用，会直接影响别人接收到的感觉。'
      }
    ]
  };

  return categoryTemplates[category] || [
    {
      source: '语境仿写',
      jp: 'この場面、「{K}」って言うと空気が自然にまとまる。',
      kana: 'この ばめん、「{R}」って いうと くうきが しぜんに まとまる。',
      cn: '这个场景里说“{K}”，整体氛围会显得更自然。'
    },
    {
      source: '口播常用句仿写',
      jp: '最近は{scene}で「{K}」って見ることが増えた。',
      kana: 'さいきんは {scene}で「{R}」って みることが ふえた。',
      cn: '最近在{scene}里，看到“{K}”这种说法的次数真的变多了。'
    },
    {
      source: '评论区仿写',
      jp: 'ひとことで雰囲気を出したいとき、「{K}」はかなり強い。',
      kana: 'ひとことで ふんいきを だしたいとき、「{R}」は かなり つよい。',
      cn: '想一句话把气氛立起来时，“{K}”会很有力量。'
    }
  ].map(item => ({
    ...item,
    jp: item.jp.replace('{scene}', scene),
    kana: item.kana.replace('{scene}', 'そのばめん')
  }));
}

function buildWordExamples(word, dbWord = {}) {
  const baseWord = { ...dbWord, ...word };
  const kanji = baseWord.kanji || '';
  const reading = baseWord.reading || kanji;
  const meaningCore = String(baseWord.meaning || '').split(/[、，,]/)[0] || '这种感觉';
  const preferredExamples = safeArray(baseWord.exampleSet)
    .map(item => normalizeExampleRecord(item, kanji, reading, meaningCore, item?.tier || 'A'))
    .filter(Boolean);
  const legacyExample = buildLegacyExampleRecord(baseWord, kanji, reading, meaningCore);
  const fallbackExamples = getStructuredExampleTemplates(baseWord, meaningCore)
    .map(item => normalizeExampleRecord({ ...item, tier: 'C' }, kanji, reading, meaningCore, 'C'))
    .filter(Boolean);

  const mergedExamples = [...preferredExamples, legacyExample, ...fallbackExamples]
    .filter(Boolean)
    .sort((left, right) => getExampleTierPriority(left.tier) - getExampleTierPriority(right.tier));

  const seenSentences = new Set();
  return mergedExamples.filter(example => {
    if (seenSentences.has(example.jp)) return false;
    seenSentences.add(example.jp);
    return true;
  }).slice(0, 3);
}

function scoreAlternativeWord(baseWord, candidateWord) {
  if (!candidateWord || candidateWord.kanji === baseWord.kanji) return -Infinity;
  const baseTokens = tokenizeMeaning(baseWord.meaning);
  const candidateTokens = tokenizeMeaning(candidateWord.meaning);
  const baseSynonyms = new Set([...(baseWord.synonyms || []), ...baseTokens]);
  const candidateSynonyms = new Set([...(candidateWord.synonyms || []), ...candidateTokens, candidateWord.kanji]);
  let score = 0;
  baseSynonyms.forEach(token => {
    if (candidateSynonyms.has(token)) score += 6;
    else if (String(candidateWord.meaning || '').includes(token)) score += 3;
  });
  if (candidateWord.category === baseWord.category) score += 4;
  if (candidateWord.source === baseWord.source) score += 1;
  if (String(candidateWord.meaning || '').slice(0, 4) === String(baseWord.meaning || '').slice(0, 4)) score += 2;
  return score;
}

function buildUsageAlternatives(word, dbWord = {}) {
  const baseWord = { ...dbWord, ...word };
  const relatedWords = getAllWords()
    .map(candidate => ({ candidate, score: scoreAlternativeWord(baseWord, candidate) }))
    .filter(item => Number.isFinite(item.score) && item.score > 3)
    .sort((left, right) => right.score - left.score || (right.candidate.popularity || 0) - (left.candidate.popularity || 0))
    .slice(0, 2)
    .map(item => item.candidate);

  return relatedWords.map(candidate => {
    const sharedMeaning = tokenizeMeaning(candidate.meaning).find(token => String(baseWord.meaning || '').includes(token))
      || tokenizeMeaning(baseWord.meaning)[0]
      || String(baseWord.meaning || '').split(/[、，,]/)[0]
      || '相近意思';
    return {
      kanji: candidate.kanji,
      reading: candidate.reading,
      meaning: candidate.meaning,
      note: `两者都能表达“${sharedMeaning}”。但「${baseWord.kanji}」更偏${getUsageScene(baseWord)}；「${candidate.kanji}」更偏${getUsageScene(candidate)}，放在句子里时通常是「${baseWord.kanji}」${getUsageRegister(baseWord)}，「${candidate.kanji}」${getUsageRegister(candidate)}。`
    };
  });
}

function editDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const matrix = Array.from({ length: a.length + 1 }, (_, row) => Array.from({ length: b.length + 1 }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)));
  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(matrix[row - 1][col] + 1, matrix[row][col - 1] + 1, matrix[row - 1][col - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

function visualSimilarityScore(baseWord, candidateWord) {
  if (!candidateWord || candidateWord.kanji === baseWord.kanji) return -Infinity;
  const left = String(baseWord.kanji || '');
  const right = String(candidateWord.kanji || '');
  let score = 0;
  const sharedChars = new Set([...left].filter(char => right.includes(char)));
  const bigrams = new Set(Array.from({ length: Math.max(0, left.length - 1) }, (_, index) => left.slice(index, index + 2)));
  const sharedBigrams = [...bigrams].filter(chunk => right.includes(chunk)).length;
  const distance = editDistance(left, right);
  score += sharedChars.size * 4;
  score += sharedBigrams * 5;
  if (left[0] && left[0] === right[0]) score += 3;
  if (left[left.length - 1] && left[left.length - 1] === right[right.length - 1]) score += 2;
  score -= Math.abs(left.length - right.length);
  score -= distance * 1.5;
  const readingLeft = String(baseWord.reading || '');
  const readingRight = String(candidateWord.reading || '');
  if (readingLeft[0] && readingLeft[0] === readingRight[0]) score += 1;
  if (left.includes(right) || right.includes(left)) score += 3;
  if (sharedChars.size === 0 && sharedBigrams === 0 && distance > 2) return -Infinity;
  return score;
}

function buildLookalikeWord(word, dbWord = {}) {
  const baseWord = { ...dbWord, ...word };
  const candidate = getAllWords()
    .map(item => ({ item, score: visualSimilarityScore(baseWord, item) }))
    .filter(entry => Number.isFinite(entry.score) && entry.score > 3)
    .sort((left, right) => right.score - left.score || (right.item.popularity || 0) - (left.item.popularity || 0))[0]?.item;

  if (!candidate) return null;
  return {
    kanji: candidate.kanji,
    reading: candidate.reading,
    meaning: candidate.meaning
  };
}

function buildInteractionPrompts(word, dbWord = {}) {
  const baseWord = { ...dbWord, ...word };
  return [
    `${baseWord.cover || '💬'} 这个词如果放进小红书标题里，你会优先从什么角度讲？`,
    `如果要用「${baseWord.kanji}」做成收藏型内容，你会先解释意思、场景，还是文化差异？`,
    `把「${baseWord.kanji}」放进你的账号内容里，它更适合讲${getUsageScene(baseWord)}还是做例句拆解？`
  ];
}

function buildExtensionWords(word, dbWord = {}) {
  const baseWord = { ...dbWord, ...word };
  const synonymCandidates = getUniqueWords(baseWord.synonyms || [])
    .map(token => getWordByKanji(token))
    .filter(Boolean)
    .map(item => item.kanji);
  const categoryCandidates = getAllWords()
    .filter(item => item.kanji !== baseWord.kanji && item.category === baseWord.category)
    .sort((left, right) => (right.popularity || 0) - (left.popularity || 0))
    .slice(0, 4)
    .map(item => item.kanji);
  return [...new Set([...synonymCandidates, ...categoryCandidates])].slice(0, 6);
}

function enrichWords(words, dateKeyValue = todayKey()) {
  return safeArray(words).map((word, index) => {
    const dbWord = getDisplayWordByKanji(word.kanji) || {};
    const extensionWords = buildExtensionWords(word, dbWord);
    return {
      ...dbWord,
      ...word,
      id: word.id || `${dateKeyValue}_${index}`,
      heat: word.heat || word.popularity || dbWord.popularity || 0,
      imageUrl: word.imageUrl || getImageUrl(word.kanji, index),
      detail: word.detail || dbWord.explanation || `${word.kanji}（${word.reading}）的意思是「${word.meaning}」。`,
      synonyms: buildUsageAlternatives(word, dbWord),
      lookalike: buildLookalikeWord(word, dbWord),
      wrongUsage: word.wrongUsage || `「${word.kanji}」是${word.category || dbWord.category || '日语'}类词汇，注意使用场合和语体。`,
      examples: buildWordExamples(word, dbWord),
      interactions: buildInteractionPrompts(word, dbWord),
      extensionWords,
      relatedWords: extensionWords
    };
  });
}

function hydrateRankingWords(dateKeyValue, rankingWords) {
  return safeArray(rankingWords)
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

function refreshHistoryDates() {
  rankingHistoryDates = getUniqueWords([
    ...Object.keys(cleanHistorySnapshots(historySnapshots)),
    ...rankingHistoryDates
  ]).sort((left, right) => String(right).localeCompare(String(left)));
  if (!rankingHistoryDates.includes(currentHistoryDateKey)) currentHistoryDateKey = rankingHistoryDates[0] || '';
  if (currentDailyHotDateKey !== 'today'
    && currentDailyHotDateKey !== addDaysToDateKey(todayKey(), 1)
    && !rankingHistoryDates.includes(currentDailyHotDateKey)) currentDailyHotDateKey = 'today';
}

function getDailyHotDateOptions() {
  refreshHistoryDates();
  const today = todayKey();
  const tomorrow = addDaysToDateKey(today, 1);
  return buildDailyHotDateOptions({
    todayDateKey: today,
    tomorrowDateKey: tomorrow,
    historyDates: rankingHistoryDates,
    formatWeekday: formatWeekdayShort
  });
}

function populateDailyHotDateSelect() {
  const select = document.getElementById('dailyHotDateSelect');
  if (!select) return;
  const options = getDailyHotDateOptions();
  const current = normalizeDailyHotDateSelection(currentDailyHotDateKey, options);
  currentDailyHotDateKey = current;
  localStorage.setItem(DAILY_HOT_DATE_STORAGE_KEY, currentDailyHotDateKey);
  select.innerHTML = options.map(option => `<option value="${escapeHTML(option.value)}">${escapeHTML(option.label)}</option>`).join('');
  select.value = current;
}

function setDailyHotDate(dateKeyValue) {
  currentDailyHotDateKey = dateKeyValue === 'today' ? 'today' : cleanShortText(dateKeyValue, 20);
  if (currentDailyHotDateKey !== 'today' && !isViewingTomorrowDailyHot()) {
    currentHistoryDateKey = currentDailyHotDateKey;
    localStorage.setItem(HISTORY_DATE_STORAGE_KEY, currentHistoryDateKey);
  }
  localStorage.setItem(DAILY_HOT_DATE_STORAGE_KEY, currentDailyHotDateKey);
  closeDailyManageMenu();
  if (isViewingTomorrowDailyHot()) void loadCodexTomorrowDraft({ notifyOnError: true });
  const selectedHistoryDate = currentDailyHotDateKey;
  if (!isViewingTomorrowDailyHot()) {
    const historyDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedHistoryDate) ? selectedHistoryDate : '';
    if (isWorkflowScopeLoaded('today', historyDate)) {
      renderDailyHot();
      return;
    }
    const grid = document.getElementById('todayGrid');
    if (grid) grid.innerHTML = `<div class="empty-state inline-empty"><div class="empty-title">${historyDate ? '正在读取历史推荐' : '正在读取今日推荐'}</div><div class="empty-desc">正在加载这一天的词卡内容…</div></div>`;
    void ensureWorkflowScopeLoaded('today', { historyDate }).then(loaded => {
      if (currentDailyHotDateKey !== selectedHistoryDate) return;
      if (loaded) renderDailyHot();
      else renderWorkflowScopeState('today', 'error');
    });
    return;
  }
  renderDailyHot();
}

function getCurrentDailyHotWords() {
  if (currentDailyHotDateKey === 'today') {
    hydrateTodayWordsFromSnapshot();
    return todayWords;
  }
  currentHistoryDateKey = currentDailyHotDateKey;
  return getCurrentHistoryWords();
}

function isViewingTodayDailyHot() {
  return currentDailyHotDateKey === 'today';
}

function isViewingTomorrowDailyHot() {
  return currentDailyHotDateKey === addDaysToDateKey(todayKey(), 1);
}

function applyCloudRankings(days) {
  const normalizedDays = safeArray(days).filter(day => day && typeof day.dateKey === 'string' && Array.isArray(day.words));
  if (normalizedDays.length === 0) return false;
  const [todayDay, ...historyDays] = normalizedDays;
  const todayDateKeyValue = todayDay.dateKey || todayKey();
  rankingTodayWords = enrichWords(hydrateRankingWords(todayDateKeyValue, todayDay.words), todayDateKeyValue);
  rankingHistoryDates = [];
  rankingHistoryWords = {};
  historyDays.forEach(day => {
    rankingHistoryDates.push(day.dateKey);
    rankingHistoryWords[day.dateKey] = enrichWords(hydrateRankingWords(day.dateKey, day.words), day.dateKey);
  });
  refreshHistoryDates();
  return true;
}

function generateWordsForDate(dateKeyValue) {
  const rankingCandidates = getRankingCandidates();
  const shuffled = seededShuffle(rankingCandidates, seededRNG(dateKeyValue));
  return shuffled.slice(0, WORDS_PER_DAY).map((word, index) => ({
    ...word,
    id: `${dateKeyValue}_${index}`,
    imageUrl: getImageUrl(word.kanji, index)
  }));
}

function generateFallbackRankings() {
  const todayDateKeyValue = todayKey();
  rankingTodayWords = enrichWords(generateWordsForDate(todayDateKeyValue), todayDateKeyValue);
  rankingHistoryWords = {};
  rankingHistoryDates = [];
  for (let offset = 1; offset < RANKINGS_DAYS; offset += 1) {
    const historyDateKey = addDaysToDateKey(todayDateKeyValue, -offset);
    rankingHistoryDates.push(historyDateKey);
    rankingHistoryWords[historyDateKey] = enrichWords(generateWordsForDate(historyDateKey), historyDateKey);
  }
  refreshHistoryDates();
}

async function loadCloudRankings(showMessages = false) {
  const endpoint = getRankingsEndpoint();
  if (!endpoint) return false;
  try {
    const response = await apiFetch(endpoint, { headers: { Accept: 'application/json' } }, { cancelKey: 'rankings-load' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const applied = applyCloudRankings(data.days);
    if (!applied) throw new Error('Invalid rankings payload');
    if (showMessages) showToast('✅ 已同步固定榜单');
    return true;
  } catch (error) {
    console.warn('固定榜单加载失败', error);
    if (showMessages) showToast('⚠️ 榜单同步失败，已使用本地候补词');
    return false;
  }
}

function getFavoriteStatus(kanji) {
  return cleanFavoriteStatus(favoriteStatuses[kanji]);
}

function getFeedbackRecord(kanji) {
  return cleanFeedbackRecord(wordFeedback[kanji]);
}

function getPublishedRecordsForWord(kanji) {
  return cleanPublishedRecords(publishedRecords).filter(record => record.word === kanji && record.sourceStatus !== 'placeholder');
}

function getPlaceholderPublishedWords() {
  const statusPublishedWords = favorites.filter(kanji => getFavoriteStatus(kanji) === 'published');
  const recordWords = new Set(cleanPublishedRecords(publishedRecords).map(record => record.word));
  return statusPublishedWords.filter(kanji => !recordWords.has(kanji));
}

function getPublishedDisplayItems() {
  const items = cleanPublishedRecords(publishedRecords).map(record => ({
    type: 'record',
    record,
    word: getDisplayWordByKanji(record.word) || findWord(record.word)
  }));
  const placeholders = getPlaceholderPublishedWords().map(kanji => ({
    type: 'placeholder',
    record: cleanPublishedRecord({
      id: `placeholder_${kanji}`,
      word: kanji,
      title: '',
      description: '',
      link: '',
      contentType: '图文',
      sourceStatus: 'placeholder',
      performanceReason: ['observing'],
      performanceNote: '这个词已经被标记为已发布，但还没有补充小红书链接和数据。'
    }),
    word: getDisplayWordByKanji(kanji) || findWord(kanji)
  }));
  return [...items, ...placeholders].sort((left, right) => String(right.record.publishedAt || right.record.updatedAt || '').localeCompare(String(left.record.publishedAt || left.record.updatedAt || '')));
}

function daysBetweenIso(isoLeft, isoRight = nowIso()) {
  if (!isoLeft) return 9999;
  const left = new Date(isoLeft).getTime();
  const right = new Date(isoRight).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 9999;
  return Math.max(0, Math.floor((right - left) / 86400000));
}

function upsertCandidatePoolEntry(kanji, patch = {}) {
  if (shouldFilterPureChineseCandidate(kanji)) return null;
  const current = cleanCandidatePoolEntry(kanji, candidatePool[kanji] || {}) || cleanCandidatePoolEntry(kanji, { firstSeenAt: nowIso() });
  if (!current) return null;
  const next = cleanCandidatePoolEntry(kanji, {
    ...current,
    ...patch,
    sourceTags: getUniqueWords([...(current.sourceTags || []), ...(patch.sourceTags || [])]),
    extensionFrom: getUniqueWords([...(current.extensionFrom || []), ...(patch.extensionFrom || [])]),
    updatedAt: nowIso()
  });
  candidatePool[kanji] = next;
  return next;
}

function seedCandidatePool() {
  const todaySeed = rankingTodayWords.slice(0, CANDIDATE_POOL_DAILY_INTAKE);
  const historySeed = rankingHistoryDates.flatMap(dateKeyValue => safeArray(rankingHistoryWords[dateKeyValue]).slice(0, 10));
  const extensionSeed = favorites.flatMap(kanji => {
    const word = getDisplayWordByKanji(kanji);
    return safeArray(buildExtensionWords(word || { kanji }, word || {})).map(extensionKanji => getWordByKanji(extensionKanji)).filter(Boolean);
  });
  const allSeedWords = [
    ...todaySeed,
    ...historySeed,
    ...extensionSeed,
    ...getRankingCandidates().slice(0, CANDIDATE_POOL_BOOTSTRAP_SIZE)
  ];

  allSeedWords.forEach(word => {
    if (!word?.kanji) return;
    if (!canUseHistoricalSeedWord(word.kanji)) return;
    const sourceTags = [];
    if (todaySeed.some(item => item.kanji === word.kanji)) sourceTags.push('daily_new');
    if (historySeed.some(item => item.kanji === word.kanji)) sourceTags.push('history_ranked');
    if (extensionSeed.some(item => item.kanji === word.kanji)) sourceTags.push('extension_seed');
    upsertCandidatePoolEntry(word.kanji, {
      sourceTags,
      extensionFrom: favorites.filter(favoriteKanji => safeArray(buildExtensionWords(getDisplayWordByKanji(favoriteKanji) || { kanji: favoriteKanji }, getDisplayWordByKanji(favoriteKanji) || {})).includes(word.kanji))
    });
  });
}

function refreshCandidatePool() {
  const blocked = getBlockedTodayWords();
  const now = nowIso();
  seedCandidatePool();

  rankingTodayWords.slice(0, CANDIDATE_POOL_DAILY_INTAKE).forEach(word => {
    if (!canUseHistoricalSeedWord(word.kanji)) return;
    upsertCandidatePoolEntry(word.kanji, {
      sourceTags: ['daily_new'],
      removedAt: ''
    });
  });

  rankingHistoryDates.forEach(dateKeyValue => {
    safeArray(rankingHistoryWords[dateKeyValue]).slice(0, 12).forEach(word => {
      if (!canUseHistoricalSeedWord(word.kanji)) return;
      upsertCandidatePoolEntry(word.kanji, {
        sourceTags: ['history_ranked'],
        removedAt: ''
      });
    });
  });

  favorites.forEach(kanji => {
    const baseWord = getDisplayWordByKanji(kanji);
    safeArray(buildExtensionWords(baseWord || { kanji }, baseWord || {})).forEach(extensionKanji => {
      if (!canUseHistoricalSeedWord(extensionKanji)) return;
      upsertCandidatePoolEntry(extensionKanji, {
        sourceTags: [getFavoriteStatus(kanji) === 'pending' ? 'pending_extension' : getFavoriteStatus(kanji) === 'published' ? 'published_extension' : 'favorite_extension'],
        extensionFrom: [kanji],
        removedAt: ''
      });
    });
  });

  cleanPublishedRecords(publishedRecords).forEach(record => {
    const baseWord = getDisplayWordByKanji(record.word);
    safeArray(buildExtensionWords(baseWord || { kanji: record.word }, baseWord || {})).forEach(extensionKanji => {
      if (!canUseHistoricalSeedWord(extensionKanji)) return;
      upsertCandidatePoolEntry(extensionKanji, {
        sourceTags: ['published_extension'],
        extensionFrom: [record.word],
        removedAt: ''
      });
    });
  });

  Object.entries(cleanCandidatePool(candidatePool)).forEach(([kanji, entry]) => {
    if (blocked.has(kanji)) {
      delete candidatePool[kanji];
      return;
    }
    const ageDays = daysBetweenIso(entry.firstSeenAt, now);
    const staleDays = daysBetweenIso(entry.lastScoredAt || entry.firstSeenAt, now);
    const hasExtensionValue = (entry.extensionFrom || []).length > 0;
    const hasUserSignal = favorites.includes(kanji) || Boolean(wordFeedback[kanji]) || hasExtensionValue;
    if (ageDays > CANDIDATE_POOL_RETENTION_DAYS && !hasUserSignal && entry.lastScore < CANDIDATE_POOL_MIN_SCORE && staleDays > 7) {
      delete candidatePool[kanji];
    }
  });
}

function getBlockedTodayWords() {
  const blocked = new Set(filterKnownFavorites(favorites));
  cleanPublishedRecords(publishedRecords).forEach(record => {
    if (record.word) blocked.add(record.word);
  });
  return blocked;
}

function getRecentHistoryBlockedWords(days = TODAY_HISTORY_DEDUP_DAYS) {
  const blocked = new Set();
  safeArray(rankingHistoryDates).slice(0, Math.max(0, days)).forEach(dateKeyValue => {
    safeArray(rankingHistoryWords[dateKeyValue]).forEach(word => {
      if (word?.kanji) blocked.add(word.kanji);
    });
  });
  return blocked;
}

function getCategoryPreferenceMap() {
  const categoryScore = {};
  const addCategoryScore = (kanji, amount) => {
    const word = getDisplayWordByKanji(kanji);
    if (!word?.category) return;
    categoryScore[word.category] = (categoryScore[word.category] || 0) + amount;
  };
  favorites.forEach(kanji => {
    const status = getFavoriteStatus(kanji);
    addCategoryScore(kanji, status === 'pending' ? 6 : status === 'published' ? 4 : 3);
  });
  cleanPublishedRecords(publishedRecords).forEach(record => {
    const rating = getRecordRating(record).level;
    if (rating === '优秀') addCategoryScore(record.word, 8);
    else if (rating === '正常') addCategoryScore(record.word, 4);
    else if (rating === '偏弱') addCategoryScore(record.word, -3);
    else if (rating === '异常差') addCategoryScore(record.word, -6);
  });
  return categoryScore;
}

function getSourcePreferenceMap() {
  const sourceScore = {};
  const addSourceScore = (source, amount) => {
    const cleanSource = String(source || '').trim();
    if (!cleanSource) return;
    sourceScore[cleanSource] = (sourceScore[cleanSource] || 0) + amount;
  };
  favorites.forEach(kanji => {
    const word = getDisplayWordByKanji(kanji);
    if (!word?.source) return;
    const status = getFavoriteStatus(kanji);
    addSourceScore(word.source, status === 'pending' ? 5 : status === 'published' ? 3 : 2);
  });
  cleanPublishedRecords(publishedRecords).forEach(record => {
    const word = getDisplayWordByKanji(record.word);
    const rating = getRecordRating(record).level;
    if (!word?.source) return;
    if (rating === '优秀') addSourceScore(word.source, 6);
    else if (rating === '正常') addSourceScore(word.source, 3);
    else if (rating === '偏弱') addSourceScore(word.source, -2);
    else if (rating === '异常差') addSourceScore(word.source, -5);
  });
  return sourceScore;
}

function getPublishedDirectionProfile() {
  const profile = {
    category: {},
    source: {},
    scene: {},
    contentType: {}
  };
  const addScore = (bucket, key, amount) => {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return;
    bucket[cleanKey] = (bucket[cleanKey] || 0) + amount;
  };
  cleanPublishedRecords(publishedRecords).forEach(record => {
    const word = getDisplayWordByKanji(record.word);
    if (!word) return;
    const rating = getRecordRating(record).level;
    const reasons = safeArray(record.performanceReason);
    let baseDelta = rating === '优秀' ? 10 : rating === '正常' ? 4 : rating === '偏弱' ? -4 : rating === '异常差' ? -8 : 0;
    if (!baseDelta) return;
    let multiplier = 1;
    if (reasons.includes('lowExposure') || reasons.includes('timingProblem')) multiplier = 0.35;
    else if (reasons.includes('coverProblem')) multiplier = 0.45;
    else if (reasons.includes('titleProblem')) multiplier = 0.72;
    else if (reasons.includes('contentProblem')) multiplier = 0.82;
    else if (reasons.includes('dataAbnormal')) multiplier = 0.2;
    else if (reasons.includes('wordMismatch')) multiplier = 1.2;
    const delta = Math.round(baseDelta * multiplier);
    addScore(profile.category, word.category, delta);
    addScore(profile.source, word.source, delta);
    addScore(profile.scene, getUsageScene(word), delta);
    addScore(profile.contentType, record.contentType || '图文', delta);
  });
  return profile;
}

function getWordStyleModes(word, contentType = '图文') {
  const category = String(word?.category || '');
  const source = String(word?.source || '');
  let titleMode = 'explain';
  let hookMode = 'practical';
  let referenceMode = 'translate';

  if (category === '若者語' || category === 'SNS') {
    titleMode = 'question';
    hookMode = 'trend';
    referenceMode = 'platform';
  } else if (category === '感情') {
    titleMode = 'emotion';
    hookMode = 'emotion';
    referenceMode = 'commentary';
  } else if (category === '食' || category === '旅行' || category === '日常') {
    titleMode = 'scene';
    hookMode = 'scenario';
    referenceMode = 'lifestyle';
  } else if (category === '文化' || category === '学習' || category === 'ビジネス') {
    titleMode = 'explain';
    hookMode = 'mistake';
    referenceMode = 'knowledge';
  }

  if (source.includes('Instagram')) {
    titleMode = titleMode === 'explain' ? 'scene' : titleMode;
    referenceMode = 'visual';
  }
  if (source.includes('YouTube')) {
    hookMode = 'spoken';
    referenceMode = 'spoken';
  }
  if (contentType === '视频') {
    hookMode = 'spoken';
    referenceMode = referenceMode === 'knowledge' ? 'spoken' : referenceMode;
  }

  return { titleMode, hookMode, referenceMode };
}

function getPublishedStyleProfile() {
  const profile = {
    titleMode: {},
    hookMode: {},
    referenceMode: {}
  };
  const addScore = (bucket, key, amount) => {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return;
    bucket[cleanKey] = (bucket[cleanKey] || 0) + amount;
  };
  cleanPublishedRecords(publishedRecords).forEach(record => {
    const word = getDisplayWordByKanji(record.word);
    if (!word) return;
    const rating = getRecordRating(record).level;
    const reasons = safeArray(record.performanceReason);
    let baseDelta = rating === '优秀' ? 10 : rating === '正常' ? 4 : rating === '偏弱' ? -4 : rating === '异常差' ? -8 : 0;
    if (!baseDelta) return;
    let multiplier = 1;
    if (reasons.includes('titleProblem')) multiplier = 0.4;
    else if (reasons.includes('contentProblem')) multiplier = 0.6;
    else if (reasons.includes('lowExposure') || reasons.includes('timingProblem') || reasons.includes('coverProblem')) multiplier = 0.8;
    else if (reasons.includes('dataAbnormal')) multiplier = 0.2;
    const delta = Math.round(baseDelta * multiplier);
    const modes = getWordStyleModes(word, record.contentType || '图文');
    addScore(profile.titleMode, modes.titleMode, delta);
    addScore(profile.hookMode, modes.hookMode, delta);
    addScore(profile.referenceMode, modes.referenceMode, delta);
  });
  return profile;
}

function getStyleBiasForWord(word, styleProfile, contentType = '图文') {
  const modes = getWordStyleModes(word, contentType);
  return {
    titleMode: modes.titleMode,
    hookMode: modes.hookMode,
    referenceMode: modes.referenceMode,
    titleScore: clamp(styleProfile.titleMode[modes.titleMode] || 0, -12, 12),
    hookScore: clamp(styleProfile.hookMode[modes.hookMode] || 0, -12, 12),
    referenceScore: clamp(styleProfile.referenceMode[modes.referenceMode] || 0, -12, 12)
  };
}

function getPublishedPerformanceWordMap() {
  const wordScores = {};
  cleanPublishedRecords(publishedRecords).forEach(record => {
    if (!record.word) return;
    const result = getRecordRating(record);
    const baseDelta = result.level === '优秀' ? 10 : result.level === '正常' ? 4 : result.level === '偏弱' ? -4 : result.level === '异常差' ? -8 : 0;
    const reasons = safeArray(record.performanceReason);
    let multiplier = 1;
    if (reasons.includes('lowExposure') || reasons.includes('timingProblem') || reasons.includes('coverProblem')) multiplier = 0.45;
    else if (reasons.includes('titleProblem') || reasons.includes('contentProblem')) multiplier = 0.72;
    else if (reasons.includes('dataAbnormal')) multiplier = 0.25;
    else if (reasons.includes('wordMismatch')) multiplier = 1.15;
    const delta = Math.round(baseDelta * multiplier);
    wordScores[record.word] = (wordScores[record.word] || 0) + delta;
  });
  return wordScores;
}

function getDirectionSignal(word, directionProfile, contentType = '图文') {
  const categorySignal = directionProfile.category[word.category] || 0;
  const sourceSignal = directionProfile.source[word.source] || 0;
  const sceneSignal = directionProfile.scene[getUsageScene(word)] || 0;
  const contentTypeSignal = directionProfile.contentType[contentType] || 0;
  return {
    categorySignal: clamp(categorySignal, -14, 14),
    sourceSignal: clamp(sourceSignal, -12, 12),
    sceneSignal: clamp(sceneSignal, -14, 14),
    contentTypeSignal: clamp(contentTypeSignal, -10, 10)
  };
}

function getCategoryFeedbackSignal(word) {
  if (!word?.category) return 0;
  let signal = 0;
  Object.entries(wordFeedback || {}).forEach(([kanji, record]) => {
    const feedbackWord = getDisplayWordByKanji(kanji);
    if (!feedbackWord || feedbackWord.category !== word.category) return;
    const reasons = record?.reasons || {};
    signal -= Math.min(toInt(reasons.uninterested, 0), 2) * 2;
    signal -= Math.min(toInt(reasons.tooBasic, 0), 2) * 2;
    signal -= Math.min(toInt(reasons.tooTextbook, 0), 2) * 3;
    signal -= Math.min(toInt(reasons.notForXhs, 0), 2) * 3;
    signal -= Math.min(toInt(reasons.inaccurate, 0), 2) * 2;
    signal -= Math.min(toInt(reasons.tooRisky, 0), 2) * 4;
    signal -= Math.min(toInt(reasons.tooNiche, 0), 2) * 3;
    signal -= Math.min(toInt(reasons.notFresh, 0), 2) * 3;
    signal -= Math.min(toInt(reasons.tooMeme, 0), 2) * 3;
    signal -= Math.min(toInt(reasons.badVisual, 0), 2) * 2;
    signal -= Math.min(toInt(reasons.badTitle, 0), 2) * 2;
    signal -= Math.min(toInt(reasons.notMyTone, 0), 2) * 3;
  });
  return clamp(signal, -14, 6);
}

function getWorkflowSignalForKanji(kanji, publishedWordMap) {
  if (!kanji) return 0;
  const status = getFavoriteStatus(kanji);
  let score = 0;
  if (status === 'pending') score += 12;
  else if (status === 'published') score += 6;
  else if (favorites.includes(kanji)) score += 7;
  score += publishedWordMap[kanji] || 0;
  const feedback = getFeedbackRecord(kanji);
  if (feedback.reasons.uninterested) score -= 6;
  if (feedback.reasons.notForXhs) score -= 8;
  if (feedback.reasons.tooBasic) score -= 5;
  if (feedback.reasons.tooTextbook) score -= 5;
  if (feedback.reasons.inaccurate || feedback.needsReview) score -= 10;
  if (feedback.reasons.tooRisky) score -= 12;
  if (feedback.reasons.tooNiche) score -= 8;
  if (feedback.reasons.notFresh) score -= 7;
  if (feedback.reasons.tooMeme) score -= 7;
  if (feedback.reasons.badVisual) score -= 6;
  if (feedback.reasons.badTitle) score -= 6;
  if (feedback.reasons.notMyTone) score -= 8;
  return score;
}

function getFeedbackPenalty(kanji) {
  const feedback = getFeedbackRecord(kanji);
  return Object.entries(feedback.reasons || {}).reduce((penalty, [reason, count]) => {
    const unit = {
      uninterested: 8,
      tooBasic: 6,
      tooTextbook: 6,
      notForXhs: 9,
      inaccurate: 12,
      tooRisky: 14,
      tooNiche: 8,
      notFresh: 7,
      tooMeme: 7,
      badVisual: 7,
      badTitle: 7,
      notMyTone: 9
    }[reason] || 0;
    return penalty + unit * Math.min(count, 3);
  }, 0);
}

function getReferenceQualityScore(word) {
  const source = String(word.source || '');
  let score = 72;
  if (source.includes('DeepSeek')) score = 78;
  else if (source.includes('小红书')) score = 88;
  else if (source.includes('Instagram') || source.includes('Twitter') || source.includes('YouTube') || source.includes('SNS')) score = 84;
  else if (source.includes('LINE')) score = 70;
  else if (source.includes('NHK') || source.includes('書籍') || source.includes('伝統')) score = 60;
  if (String(word.detail || word.explanation || '').length >= 26) score += 4;
  if (String(word.example || '').length >= 8) score += 3;
  if ((word.synonyms || []).length >= 2) score += 2;
  if ((word.interactions || []).length >= 3) score += 2;
  return clamp(score, 45, 96);
}

function getPlatformHeatScore(word, origin = 'pool') {
  let score = clamp(word.heat || word.popularity || 0, 0, 100);
  const source = String(word.source || '');
  if (source.includes('小红书')) score += 6;
  if (source.includes('Instagram') || source.includes('Twitter') || source.includes('YouTube') || source.includes('SNS')) score += 4;
  if (origin === 'today') score += 4;
  if (origin === 'history') score += 2;
  if ((word.extensionWords || []).length >= 3) score += 2;
  return clamp(score, 8, 99);
}

function getContentValueScore(word, directionSignal = null) {
  const categoryBase = {
    若者語: 90,
    SNS: 92,
    感情: 86,
    文化: 84,
    日常: 78,
    食: 80,
    ファッション: 82,
    旅行: 81,
    学習: 68,
    ビジネス: 62,
    自然: 60
  };
  let score = categoryBase[word.category] || 72;
  if (String(word.meaning || '').length <= 10) score += 4;
  if ((word.extensionWords || []).length >= 3) score += 3;
  if (/[ァ-ヶ]/.test(String(word.kanji || ''))) score += 2;
  if (String(word.detail || word.explanation || '').length >= 28) score += 3;
  if (String(word.example || '').length >= 8) score += 2;
  if ((word.interactions || []).length >= 3) score += 2;
  if ((word.synonyms || []).length >= 2) score += 2;
  score += getCategoryFeedbackSignal(word);
  if (directionSignal) score += clamp(directionSignal.sceneSignal * 0.35, -4, 5);
  return clamp(score, 40, 98);
}

function getAccountFitScore(word, categoryPreferenceMap, sourcePreferenceMap, directionSignal = null) {
  const categoryBonus = categoryPreferenceMap[word.category] || 0;
  const sourceBonus = sourcePreferenceMap[word.source] || 0;
  let score = 60 + categoryBonus + sourceBonus;
  if (favorites.includes(word.kanji)) score += 6;
  if (getFavoriteStatus(word.kanji) === 'pending') score += 10;
  if (getFavoriteStatus(word.kanji) === 'published') score += 4;
  score += getCategoryFeedbackSignal(word) * 0.4;
  if (directionSignal) {
    score += directionSignal.categorySignal * 0.7;
    score += directionSignal.sourceSignal * 0.55;
    score += directionSignal.contentTypeSignal * 0.35;
  }
  return clamp(score, 30, 98);
}

function getConfidenceLevel(word) {
  const feedback = getFeedbackRecord(word.kanji);
  if (feedback.needsReview || feedback.reasons.inaccurate) return 'review';
  const source = String(word.source || '');
  const meaningLength = String(word.meaning || '').length;
  if (source.includes('SNS') || source.includes('Twitter') || source.includes('Instagram') || source.includes('YouTube')) {
    return meaningLength <= 18 ? 'high' : 'medium';
  }
  if (source.includes('NHK') || source.includes('書籍') || source.includes('伝統')) return 'medium';
  if (meaningLength > 22) return 'low';
  return 'medium';
}

function getConfidenceBonus(level) {
  return {
    high: 8,
    medium: 4,
    low: -2,
    review: -10
  }[level] || 0;
}

function getConfidenceWeightScore(level) {
  return {
    high: 92,
    medium: 78,
    low: 58,
    review: 28
  }[level] || 78;
}

function buildRecommendedTitle(word, styleBias = null) {
  const scene = getUsageScene(word);
  const mode = styleBias?.titleMode || getWordStyleModes(word).titleMode;
  const titleTemplates = {
    若者語: `日本年轻人常说「${word.kanji}」到底在表达什么？`,
    SNS: `小红书标题里很能打的日语词：「${word.kanji}」怎么讲才自然？`,
    感情: `日语里的「${word.kanji}」为什么特别适合做共鸣型内容？`,
    文化: `日本人常说的「${word.kanji}」，背后其实是文化差异`,
    日常: `原来日本人会用「${word.kanji}」来形容这种日常感受`,
    食: `除了好吃，日本人还会用「${word.kanji}」这样聊美食`,
    ファッション: `日系穿搭里常见的「${word.kanji}」到底是什么意思？`
  };
  const modeTemplates = {
    question: `日本人常说「${word.kanji}」到底是什么意思？`,
    explain: `日语词「${word.kanji}」为什么不适合直接按字面理解？`,
    scene: `原来在${scene}里，日本人会这样说「${word.kanji}」`,
    emotion: `为什么「${word.kanji}」特别容易做出共鸣感？`
  };
  if (styleBias?.titleScore >= 4 && modeTemplates[mode]) return modeTemplates[mode];
  return titleTemplates[word.category] || modeTemplates[mode] || `日语词「${word.kanji}」适合怎么做成${scene}内容？`;
}

function buildContentHook(word, styleBias = null) {
  const mode = styleBias?.hookMode || getWordStyleModes(word).hookMode;
  const hooks = {
    若者語: '先讲这个词在 SNS / 饭圈 / 评论区怎么被用，再补一句中文用户最容易误解的点。',
    SNS: '先展示一个平台常见标题，再拆这个词为什么适合做吸睛表达。',
    感情: '从“中文里很难一词说透的情绪”切入，会更容易引发收藏和评论。',
    文化: '把词义和文化场景一起讲，不只翻译意思，更讲“为什么日本人会这样说”。',
    日常: '适合做“原来这个生活场景日语会这样表达”的轻知识内容。',
    食: '可结合美食、探店、生活方式内容，用“表达感受”的角度切入。',
    ファッション: '适合搭配穿搭、审美、风格区分来讲，容易做成系列。'
  };
  const modeHooks = {
    trend: '先拿平台上真实会出现的说法开头，再拆这个词为什么在标题里更容易抓人。',
    emotion: '先讲它承载的情绪，再补一句中文用户最容易共鸣的使用场景。',
    scenario: '先给一个生活场景，再解释为什么这种场景下这个词比直译更自然。',
    mistake: '先讲大家最容易误解的点，再给正确用法，会更容易被收藏。',
    practical: '先解释它能解决什么表达问题，再给一个中文用户能立刻套用的句子。',
    spoken: '更适合做口播感表达：先抛一句常见说法，再快速解释怎么讲才自然。'
  };
  if (styleBias?.hookScore >= 4 && modeHooks[mode]) return modeHooks[mode];
  return hooks[word.category] || modeHooks[mode] || '适合先解释词义，再给一个生活或社交场景里的真实用法。';
}

function buildAudience(word) {
  const audience = {
    若者語: '日语学习者、追星用户、二次元用户、喜欢流行语的人',
    SNS: '想做标题、短内容表达、平台热点拆解的人',
    感情: '共鸣向内容读者、情绪表达型用户、轻心理兴趣用户',
    文化: '对日本文化感兴趣的用户、收藏型知识读者',
    日常: '零基础到中级日语学习者、生活表达类内容读者',
    食: '美食用户、日料兴趣用户、探店型内容读者',
    ファッション: '日系审美用户、穿搭用户、年轻女性用户'
  };
  return audience[word.category] || '对日语表达、文化差异或内容灵感感兴趣的用户';
}

function buildReferenceDirection(word, styleBias = null) {
  const source = String(word.source || '');
  const mode = styleBias?.referenceMode || getWordStyleModes(word).referenceMode;
  if (styleBias?.referenceScore >= 4) {
    if (mode === 'visual') return '更适合参考封面词组、图文排版和情绪感表达，做成一眼能看懂的收藏型内容。';
    if (mode === 'platform') return '更适合参考评论区、短标题和平台热词语气，重点看“怎么说更像日本人在用”。';
    if (mode === 'spoken') return '更适合参考视频标题、口播节奏和前 3 秒开场方式。';
    if (mode === 'knowledge') return '更适合参考知识拆解、文化差异和误用纠正的讲法。';
    if (mode === 'lifestyle') return '更适合参考日常分享、场景感文案和生活方式内容。';
  }
  if (source.includes('Instagram')) return '可参考图文排版、封面词组和情绪感表达';
  if (source.includes('Twitter') || source.includes('SNS')) return '可参考评论区口语、热点语气和短句表达';
  if (source.includes('YouTube')) return '可参考视频标题、内容结构和口播解释方式';
  if (source.includes('NHK') || source.includes('書籍')) return '更适合做知识解释和文化延展，而不是纯热点标题';
  return '适合先看这个词在平台里的真实语境，再做面向中文用户的转译';
}

function buildRecommendationReason(word, scores) {
  const parts = [];
  if (scores.platformHeatScore >= 85 || scores.dataScore >= 85) parts.push('平台热度高');
  if (scores.contentValueScore >= 85) parts.push('适合做标题和收藏型内容');
  if (scores.accountFitScore >= 78) parts.push('和你当前的选题偏好比较贴近');
  if (scores.dataFeedbackScore >= 78) parts.push('和你最近收藏、待发布、已发布方向形成了正向联动');
  if (scores.referenceQualityScore >= 82) parts.push('参考语境比较清楚，转成小红书内容会更顺手');
  if (scores.confidenceWeightScore >= 85) parts.push('词义和使用场景相对稳定');
  if (scores.directionCategorySignal >= 8 || scores.directionSceneSignal >= 8) parts.push('你发过的同类方向最近表现更好');
  if (scores.directionCategorySignal <= -6 || scores.directionSceneSignal <= -6) parts.push('同类方向最近表现偏弱，需要更看包装');
  if (scores.styleTitleSignal >= 6) parts.push('这种标题表达方式和你近期表现好的内容风格更接近');
  if (scores.styleHookSignal >= 6) parts.push('这个切入方式更贴近你容易做出数据的讲法');
  if (scores.extensionBoost >= 10) parts.push('延展关系强，适合继续往系列内容推进');
  if (scores.extensionBoost <= -8) parts.push('相关方向最近表现一般，当前更适合谨慎试探');
  if (scores.duplicatePenalty >= 8) parts.push('这个方向近期重复出现较多，这次是高分回流');
  if ((word.extensionWords || []).length >= 3) parts.push('有延展成系列内容的空间');
  if (!parts.length) parts.push('词义明确，适合做轻量解释型内容');
  return parts.join('，') + '。';
}

function buildRankingSignals(word, scores, candidateMeta = null) {
  const signals = [];
  if (scores.reviewState === 'ready') signals.push({ label: '可直接上首页', tone: 'fit' });
  if (scores.reviewState === 'watch') signals.push({ label: '值得继续观察', tone: 'info' });
  if (scores.reviewState === 'review') signals.push({ label: '需复核', tone: 'caution' });
  if (scores.platformHeatScore >= 88) signals.push({ label: '平台热词', tone: 'hot' });
  if (scores.accountFitScore >= 80) signals.push({ label: '账号匹配', tone: 'fit' });
  if (scores.contentValueScore >= 86) signals.push({ label: '适合做标题', tone: 'fit' });
  if (scores.dataFeedbackScore >= 80) signals.push({ label: '工作流联动', tone: 'fit' });
  if (scores.referenceQualityScore >= 84) signals.push({ label: '参考语境清晰', tone: 'info' });
  if (scores.confidenceWeightScore >= 88) signals.push({ label: '语义稳定', tone: 'info' });
  if (scores.directionCategorySignal >= 8 || scores.directionSceneSignal >= 8) signals.push({ label: '同类方向近期表现好', tone: 'fit' });
  if (scores.directionContentTypeSignal >= 6) signals.push({ label: '内容形式匹配', tone: 'info' });
  if (scores.styleTitleSignal >= 6) signals.push({ label: '标题风格匹配', tone: 'fit' });
  if (scores.styleHookSignal >= 6) signals.push({ label: '切入方式匹配', tone: 'info' });
  if (scores.extensionBoost >= 10) signals.push({ label: '延展空间强', tone: 'fit' });
  if ((word.extensionWords || []).length >= 4) signals.push({ label: '可做系列', tone: 'info' });
  if (safeArray(candidateMeta?.extensionFrom).length > 0) signals.push({ label: '延展补位', tone: 'info' });
  if (word.origin === 'history') signals.push({ label: '历史回流高分', tone: 'info' });
  if (scores.extensionBoost <= -8 || scores.feedbackPenalty >= 10) signals.push({ label: '建议谨慎试探', tone: 'caution' });
  if (scores.directionCategorySignal <= -6 || scores.directionSceneSignal <= -6) signals.push({ label: '同类方向近期偏弱', tone: 'caution' });
  if (scores.duplicatePenalty >= 8) signals.push({ label: '重复回流', tone: 'muted' });
  return signals.slice(0, 4);
}

function renderRankingSignals(signals = []) {
  const safeSignals = safeArray(signals).slice(0, 4);
  if (!safeSignals.length) return '';
  return `<div class="signal-chip-row">${safeSignals.map(signal => `<span class="signal-chip tone-${escapeHTML(signal.tone || 'info')}">${escapeHTML(signal.label || '')}</span>`).join('')}</div>`;
}

function getDetailTeamStatusLabel(kanji, status) {
  if (status === 'published' || cleanPublishedRecords(publishedRecords).some(record => record.word === kanji)) return '已发布';
  if (status === 'pending') return '待发布';
  if (favorites.includes(kanji)) return '已收藏';
  if (toInt(getFeedbackRecord(kanji)?.reasons?.uninterested, 0) > 0) return '已跳过';
  return '未处理';
}

function getDetailRecommendationConclusion(word = {}, entry = {}) {
  const action = entry.suggestedAction || '';
  if (entry.displayBucket === 'blocked' || entry.riskLevel === 'high' || action === '不建议') return '不建议直接发布';
  if (entry.displayBucket === 'review' || entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown' || word.reviewState === 'review') return '需查证';
  if (word.reviewState === 'ready' || entry.displayBucket === 'today' || toInt(word.finalScore || entry.lastScore || entry.xhsFitScore, 0) >= 78) return '可直接上首页';
  return '值得观察';
}

function getDetailRecommendationLevel(word = {}, entry = {}) {
  if (entry.displayBucket === 'blocked' || entry.riskLevel === 'high' || entry.suggestedAction === '不建议') return 'C';
  if (entry.displayBucket === 'review' || entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown' || word.reviewState === 'review') return 'B';
  const score = toInt(word.finalScore || entry.lastScore || entry.xhsFitScore || word.xhsFitScore, 0);
  if (score >= 88) return 'S';
  if (score >= 78) return 'A';
  if (score >= 62) return 'B';
  return 'C';
}

function getDetailRiskStatus(word = {}, entry = {}, riskText = '') {
  if (entry.displayBucket === 'blocked' || entry.riskLevel === 'high' || entry.suggestedAction === '不建议') return '高风险';
  if (entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown' || entry.displayBucket === 'review' || riskText || entry.reviewReason) return '需查证';
  if (entry.riskLevel === 'medium') return '中风险';
  return '低风险';
}

function getDetailJudgementTone(value = '') {
  if (['可直接上首页', 'S', 'A', '低风险', '已收藏', '待发布', '已发布'].includes(value)) return 'fit';
  if (['值得观察', 'B', '中风险', '未处理'].includes(value)) return 'info';
  if (['需查证', 'C', '高风险', '不建议直接发布', '已跳过'].includes(value)) return 'caution';
  return 'muted';
}

function renderDetailJudgementBoard(word = {}, entry = {}, status = 'none', riskText = '') {
  const items = [
    { label: '推荐结论', value: getDetailRecommendationConclusion(word, entry) },
    { label: '推荐等级', value: getDetailRecommendationLevel(word, entry) },
    { label: '风险状态', value: getDetailRiskStatus(word, entry, riskText) },
    { label: '当前状态', value: getDetailTeamStatusLabel(word.kanji, status) }
  ];
  return `<div class="detail-judgement-grid">${items.map(item => `
    <div class="detail-judgement-card tone-${getDetailJudgementTone(item.value)}">
      <span>${escapeHTML(item.label)}</span>
      <strong>${escapeHTML(item.value)}</strong>
    </div>`).join('')}</div>`;
}

function renderLabeledDetailItem(label, value) {
  const cleanValue = typeof value === 'string' ? value.trim() : value;
  if (!cleanValue) return '';
  return `<div class="usage-item"><div class="usage-head"><span class="usage-word">${escapeHTML(label)}</span></div><div class="usage-meaning">${escapeHTML(cleanValue)}</div></div>`;
}

function renderSystemScoreDetails(word = {}, entry = {}, scoreBreakdown = {}) {
  const addCard = (label, value) => `<div class="score-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(String(value))}</strong></div>`;
  const cards = [
    addCard('平台热度分', word.platformHeatScore || word.dataScore || 0),
    addCard('最终推荐分', word.finalScore || word.heat || 0),
    addCard('账号适配分', word.accountFitScore || 0),
    addCard('内容价值分', word.contentValueScore || 0),
    addCard('发布反馈分', word.dataFeedbackScore || 0),
    addCard('参考质量分', word.referenceQualityScore || 0),
    addCard('置信度权重', word.confidenceWeightScore || 0)
  ];
  const addSignedCard = (label, value) => {
    const amount = toInt(value, 0);
    if (!amount) return;
    cards.push(addCard(label, `${amount >= 0 ? '+' : ''}${amount}`));
  };
  const addPenaltyCard = (label, value) => {
    const amount = toInt(value, 0);
    if (amount <= 0) return;
    cards.push(addCard(label, `-${amount}`));
  };
  addSignedCard('时效加分', scoreBreakdown.freshnessBonus ?? word.freshnessBonus);
  addSignedCard('类型加分', scoreBreakdown.candidateTypeBonus ?? word.candidateTypeBonus);
  if (toInt(scoreBreakdown.expressionValueScore ?? word.expressionValueScore, 0) > 0) {
    cards.push(addCard('表达价值分', scoreBreakdown.expressionValueScore ?? word.expressionValueScore));
  }
  addSignedCard('账号学习加权', scoreBreakdown.accountLearningBonus ?? word.accountLearningBonus);
  addSignedCard('延展加权', word.extensionBoost);
  addPenaltyCard('风险扣分', scoreBreakdown.riskPenalty ?? word.riskPenalty);
  addPenaltyCard('重复惩罚', word.duplicatePenalty);
  addPenaltyCard('负反馈扣分', word.feedbackPenalty);

  const styleCards = [
    ['标题风格', word.styleBias?.titleScore],
    ['切入方式', word.styleBias?.hookScore],
    ['参考方向', word.styleBias?.referenceScore]
  ].filter(([, value]) => toInt(value, 0) !== 0);

  return `<details class="modal-section compact-section system-score-details">
    <summary class="system-score-summary">系统评分详情</summary>
    <div class="score-grid published-stats-grid">${cards.join('')}</div>
    <div class="published-score-note">准入判断：${escapeHTML(entry.displayBucket || 'long_term')} / ${escapeHTML(entry.riskLevel || 'low')} / ${escapeHTML(entry.confidenceLevel || 'medium')} / ${escapeHTML(entry.evidenceType || 'common_usage')}</div>
    ${styleCards.length ? `<div class="score-grid published-stats-grid system-score-subgrid">${styleCards.map(([label, value]) => addCard(label, toInt(value, 0))).join('')}</div>` : ''}
  </details>`;
}

function getCandidateReviewAssessment(word, scores, candidateMeta = null) {
  const manualReviewState = cleanCandidateReviewState(candidateMeta?.manualReviewState || '');
  const manualReviewNote = String(candidateMeta?.manualReviewNote || '').trim();
  if (manualReviewState && candidateMeta?.manualReviewState) {
    return {
      state: manualReviewState,
      note: manualReviewNote || `已人工调整为“${CANDIDATE_REVIEW_STATE_LABELS[manualReviewState]}”`
    };
  }
  if (candidateMeta?.riskLevel === 'high' || candidateMeta?.candidateType === '高风险话题词') {
    return { state: 'review', note: candidateMeta?.riskWarning || '高风险候选词只能进入复核池，不会自动进入今日热门。' };
  }
  if (candidateMeta?.confidenceLevel === 'review' || candidateMeta?.evidenceType === 'unknown') {
    return { state: 'review', note: candidateMeta?.reviewReason || '证据或流行度不确定，先进入人工复核。' };
  }
  const previousState = cleanCandidateReviewState(candidateMeta?.lastReviewState);
  const previousScore = toInt(candidateMeta?.lastScore, 0);
  const recommendationCount = toInt(candidateMeta?.recommendationCount, 0);
  const ignoredCount = toInt(candidateMeta?.ignoredCount, 0);
  const reasons = [];
  if (scores.confidenceWeightScore <= 40 || word.confidenceLevel === 'review') {
    reasons.push('词义或语境稳定性不足');
    return { state: 'review', note: reasons.join('，') };
  }
  if (scores.feedbackPenalty >= 16) {
    reasons.push('负反馈较多');
    return { state: 'review', note: reasons.join('，') };
  }
  if (previousState === 'ready' && (ignoredCount >= 4 || scores.finalScore < 62)) {
    reasons.push('近期被跳过较多或分数回落');
    return { state: 'watch', note: `从“可直接上首页”回落到观察：${reasons.join('，')}` };
  }
  if (previousState === 'watch' && previousScore >= 74 && scores.finalScore >= 78 && ignoredCount <= 2) {
    return { state: 'ready', note: '连续两轮评分都比较高，已从观察池晋级为可直接上首页' };
  }
  if (previousState === 'review' && scores.finalScore >= 66 && scores.feedbackPenalty < 10 && scores.confidenceWeightScore >= 58) {
    return { state: 'watch', note: '本轮分数和稳定性都有改善，先从复核池回到观察池继续跟踪' };
  }
  if (scores.directionCategorySignal <= -8 || scores.directionSceneSignal <= -8) reasons.push('同类方向近期表现弱');
  if (scores.duplicatePenalty >= 10 || ignoredCount >= 5) reasons.push('近期重复出现较多');
  if (scores.finalScore >= 78 && scores.platformHeatScore >= 72 && scores.contentValueScore >= 72 && scores.feedbackPenalty < 12) {
    return { state: 'ready', note: reasons[0] ? `综合分高，已进入可直接上首页：但需留意${reasons[0]}` : '综合分高，当前适合直接参与首页推荐' };
  }
  if (scores.finalScore >= 60 || safeArray(candidateMeta?.extensionFrom).length > 0 || scores.extensionBoost >= 8 || recommendationCount <= 1) {
    return { state: 'watch', note: reasons[0] ? `有潜力，但当前更适合继续观察：${reasons[0]}` : '有潜力，但更适合先观察后再上首页' };
  }
  return { state: 'review', note: reasons[0] || '综合分和稳定性暂时都不够，建议人工复核后再决定' };
}

function buildRiskWarning(word, confidenceLevel) {
  if (confidenceLevel === 'review') return '当前有“解释不准”反馈，发之前建议再人工复核词义和语境。';
  if (word.category === 'ビジネス') return '偏正式，直接做小红书标题时容易显得太教材，需要换成更生活化的讲法。';
  if (word.category === '自然' || word.category === '学習') return '内容价值不一定弱，但更吃讲法，需要避免做成纯词典解释。';
  return '';
}

function getExtensionBoost(word, publishedWordMap, candidateMeta = null) {
  const extensionWords = getUniqueWords([...(word.extensionWords || []), ...safeArray(candidateMeta?.extensionFrom)]);
  let bonus = 0;
  extensionWords.forEach(relatedKanji => {
    bonus += getWorkflowSignalForKanji(relatedKanji, publishedWordMap);
  });
  return clamp(bonus, -18, 24);
}

function getDataFeedbackScore(word, publishedWordMap, candidateMeta = null) {
  let score = 52;
  const directStatus = getFavoriteStatus(word.kanji);
  if (favorites.includes(word.kanji)) score += directStatus === 'pending' ? 14 : directStatus === 'published' ? 8 : 6;
  score += clamp((publishedWordMap[word.kanji] || 0) * 1.2, -14, 14);
  const feedbackPenalty = getFeedbackPenalty(word.kanji);
  score -= Math.round(feedbackPenalty * 0.4);
  const relationSignals = getUniqueWords([...(word.extensionWords || []), ...safeArray(candidateMeta?.extensionFrom)])
    .reduce((sum, relatedKanji) => sum + getWorkflowSignalForKanji(relatedKanji, publishedWordMap), 0);
  score += clamp(relationSignals, -12, 18);
  const ignoredCount = toInt(candidateMeta?.ignoredCount, 0);
  const recommendationCount = toInt(candidateMeta?.recommendationCount, 0);
  if (recommendationCount >= 3 && ignoredCount > 0) score -= Math.min(ignoredCount * 3, 14);
  if (safeArray(candidateMeta?.extensionFrom).length > 0) score += 4;
  return clamp(score, 8, 98);
}

function getDuplicatePenalty(candidateMeta = null) {
  const recommendationCount = toInt(candidateMeta?.recommendationCount, 0);
  const ignoredCount = toInt(candidateMeta?.ignoredCount, 0);
  let penalty = 0;
  if (recommendationCount >= 2) penalty += Math.min(recommendationCount - 1, 6);
  if (ignoredCount > 0) penalty += Math.min(ignoredCount * 2, 10);
  return clamp(penalty, 0, 16);
}

function getFreshnessBonus(candidateMeta = null) {
  return {
    长期: 2,
    中期: 4,
    短期: 7,
    需要尽快判断: 12
  }[candidateMeta?.freshness] || 0;
}

function getCandidateTypeBonus(candidateMeta = null) {
  return {
    稳定候选: 4,
    新鲜梗词: 8,
    审美氛围词: 7,
    美妆穿搭词: 6,
    追星兴趣词: 7,
    生活方式词: 5,
    网络口语词: 7,
    圈层词: 3,
    高风险话题词: -18
  }[candidateMeta?.candidateType] || 0;
}

function getRiskPenalty(candidateMeta = null) {
  return {
    low: 0,
    medium: 12,
    high: 100
  }[candidateMeta?.riskLevel] || 0;
}

function buildRecommendedWord(word, origin = 'global', candidateMeta = null) {
  const categoryPreferenceMap = getCategoryPreferenceMap();
  const sourcePreferenceMap = getSourcePreferenceMap();
  const directionProfile = getPublishedDirectionProfile();
  const styleProfile = getPublishedStyleProfile();
  const directionSignal = getDirectionSignal(word, directionProfile, '图文');
  const styleBias = getStyleBiasForWord(word, styleProfile, '图文');
  const publishedWordMap = getPublishedPerformanceWordMap();
  const platformHeatScore = getPlatformHeatScore(word, origin);
  const dataScore = platformHeatScore;
  const accountFitScore = getAccountFitScore(word, categoryPreferenceMap, sourcePreferenceMap, directionSignal);
  const contentValueScore = getContentValueScore(word, directionSignal);
  const dataFeedbackScore = getDataFeedbackScore(word, publishedWordMap, candidateMeta);
  const referenceQualityScore = getReferenceQualityScore(word);
  const confidenceLevel = candidateMeta?.confidenceLevel || getConfidenceLevel(word);
  const wordCardView = buildWordCardViewModel({
    word,
    entry: candidateMeta || {},
    aiCard: candidateMeta?.aiCard || word.aiCard || {}
  });
  const aiCard = wordCardView.card;
  const hasReadyAiCard = wordCardView.hasFormalCard;
  const aiCardStatus = wordCardView.status;
  const confidenceWeightScore = getConfidenceWeightScore(confidenceLevel);
  const feedbackPenalty = getFeedbackPenalty(word.kanji);
  const extensionBoost = getExtensionBoost(word, publishedWordMap, candidateMeta);
  const duplicatePenalty = getDuplicatePenalty(candidateMeta);
  const freshnessBonus = getFreshnessBonus(candidateMeta);
  const candidateTypeBonus = getCandidateTypeBonus(candidateMeta);
  const riskPenalty = getRiskPenalty(candidateMeta);
  const aiBaseScore = ['codex_generated', 'deepseek_generated'].includes(candidateMeta?.sourceType)
    ? clamp(toInt(candidateMeta.xhsFitScore, platformHeatScore), 0, 100)
    : null;
  const finalScore = clamp(Math.round(
    (aiBaseScore ?? platformHeatScore) * 0.28
    + accountFitScore * 0.16
    + contentValueScore * 0.18
    + dataFeedbackScore * 0.15
    + referenceQualityScore * 0.09
    + confidenceWeightScore * 0.08
    + extensionBoost
    + freshnessBonus
    + candidateTypeBonus
    + directionSignal.categorySignal * 0.22
    + directionSignal.sceneSignal * 0.18
    + styleBias.titleScore * 0.18
    + styleBias.hookScore * 0.16
    + styleBias.referenceScore * 0.10
    - riskPenalty
    - duplicatePenalty
    - feedbackPenalty * 0.45
  ), 0, 100);

  const reviewAssessment = getCandidateReviewAssessment(word, {
    platformHeatScore,
    dataScore,
    accountFitScore,
    contentValueScore,
    dataFeedbackScore,
    referenceQualityScore,
    confidenceWeightScore,
    extensionBoost,
    freshnessBonus,
    candidateTypeBonus,
    riskPenalty,
    feedbackPenalty,
    duplicatePenalty,
    directionCategorySignal: directionSignal.categorySignal,
    directionSourceSignal: directionSignal.sourceSignal,
    directionSceneSignal: directionSignal.sceneSignal,
    directionContentTypeSignal: directionSignal.contentTypeSignal,
    styleTitleSignal: styleBias.titleScore,
    styleHookSignal: styleBias.hookScore,
    styleReferenceSignal: styleBias.referenceScore,
    finalScore
  }, candidateMeta);

  const scores = {
    platformHeatScore,
    dataScore,
    accountFitScore,
    contentValueScore,
    dataFeedbackScore,
    referenceQualityScore,
    confidenceWeightScore,
    extensionBoost,
    freshnessBonus,
    candidateTypeBonus,
    riskPenalty,
    feedbackPenalty,
    duplicatePenalty,
    directionCategorySignal: directionSignal.categorySignal,
    directionSourceSignal: directionSignal.sourceSignal,
    directionSceneSignal: directionSignal.sceneSignal,
    directionContentTypeSignal: directionSignal.contentTypeSignal,
    styleTitleSignal: styleBias.titleScore,
    styleHookSignal: styleBias.hookScore,
    styleReferenceSignal: styleBias.referenceScore,
    reviewState: reviewAssessment.state,
    finalScore
  };
  return {
    ...word,
    imageUrl: wordCardView.referenceImageUrl || word.imageUrl,
    origin,
    dataScore,
    platformHeatScore,
    accountFitScore,
    contentValueScore,
    dataFeedbackScore,
    referenceQualityScore,
    confidenceWeightScore,
    extensionBoost,
    feedbackPenalty,
    duplicatePenalty,
    directionSignal,
    styleBias,
    reviewState: reviewAssessment.state,
    reviewStateLabel: CANDIDATE_REVIEW_STATE_LABELS[reviewAssessment.state],
    reviewNote: reviewAssessment.note,
    confidenceLevel,
    confidenceLabel: CONFIDENCE_LABELS[confidenceLevel],
    finalScore,
    scoreBreakdown: cleanCandidateScoreBreakdown(scores),
    rankingSignals: buildRankingSignals(word, scores, candidateMeta),
    aiCard,
    suggestedTitle: hasReadyAiCard ? wordCardView.title : (aiCardStatus === 'pending' ? 'DeepSeek 词卡生成中' : ''),
    contentHook: hasReadyAiCard ? (wordCardView.contentAngles[0] || '') : '',
    targetAudience: wordCardView.targetAudience,
    referenceDirection: wordCardView.referenceDirection,
    recommendationReason: hasReadyAiCard ? wordCardView.summary : (aiCardStatus === 'pending' ? 'DeepSeek 词卡生成中' : 'DeepSeek 词卡未生成'),
    detail: wordCardView.explanation,
    examples: wordCardView.examples,
    interactions: wordCardView.interactionPrompts,
    wrongUsage: wordCardView.wrongUsage,
    riskWarning: hasReadyAiCard ? wordCardView.riskWarning : (candidateMeta?.riskWarning || '')
  };
}

function getFavoriteBlockedWords() {
  const blocked = new Set(filterKnownFavorites(favorites));
  Object.entries(favoriteStatuses || {}).forEach(([kanji, status]) => {
    if (['pending', 'published'].includes(status)) blocked.add(kanji);
  });
  cleanPublishedRecords(publishedRecords).forEach(record => {
    if (record.word) blocked.add(record.word);
  });
  return blocked;
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
  return entry.displayBucket === 'seasonal' ? entry.freshness === '短期' : true;
}

function getRecentDailyHotBlockedWords(days = TODAY_HISTORY_DEDUP_DAYS, options = {}) {
  const targetDateKey = options.dateKey || todayKey();
  const blocked = new Set();
  const addWordsForDate = (dateKeyValue, words = []) => {
    const diff = diffDateKeysInDays(dateKeyValue, targetDateKey);
    if (diff < 0) return;
    if (diff === 0 && !options.includeToday) return;
    if (days > 0 && diff > days) return;
    safeArray(words).forEach(item => {
      const kanji = typeof item === 'string' ? item : item?.kanji;
      const cleanKanji = cleanShortText(kanji, 80);
      if (cleanKanji) blocked.add(cleanKanji);
    });
  };
  Object.values(cleanHistorySnapshots(historySnapshots)).forEach(snapshot => addWordsForDate(snapshot.dateKey, snapshot.words));
  cleanTodaySnapshotHistory(todaySnapshotHistory).forEach(snapshot => addWordsForDate(snapshot.dateKey, snapshot.words));
  Object.entries(rankingHistoryWords || {}).forEach(([dateKeyValue, words]) => addWordsForDate(dateKeyValue, words));
  const currentSnapshot = cleanTodaySnapshot(todaySnapshot);
  if (currentSnapshot.dateKey === targetDateKey && options.includeToday) currentSnapshot.words.forEach(word => blocked.add(word));
  safeArray(options.extraWords).forEach(word => {
    const cleanKanji = cleanShortText(word, 80);
    if (cleanKanji) blocked.add(cleanKanji);
  });
  return blocked;
}

function isTodayCandidateEligible(entry = {}, options = {}) {
  const cleanEntry = cleanCandidatePoolEntry(entry.kanji, entry);
  if (!cleanEntry) return false;
  const blocked = options.blockedWords || getFavoriteBlockedWords();
  const dismissed = options.dismissedWords || new Set(getTodayDismissedWords());
  const recentBlocked = options.recentBlockedWords || new Set();
  if (blocked.has(cleanEntry.kanji) || dismissed.has(cleanEntry.kanji)) return false;
  if (recentBlocked.has(cleanEntry.kanji)) return false;
  if (isLibraryAuditRemoved(cleanEntry)) return false;
  if (!['codex_generated', 'deepseek_generated', 'deepseek_reviewed', 'manual_keep'].includes(cleanEntry.sourceType)) return false;
  if (cleanEntry.sourceType === 'deepseek_reviewed' && ['delete', 'deleted', 'archived'].includes(cleanEntry.libraryReviewStatus)) return false;
  if (['review', 'blocked'].includes(cleanEntry.displayBucket)) return false;
  if (cleanEntry.riskLevel === 'high') return false;
  if (cleanEntry.confidenceLevel === 'review') return false;
  if (cleanEntry.evidenceType === 'unknown') return false;
  if (cleanEntry.lastReviewState === 'review') return false;
  if (isChineseReadableLowValueTodayWord(cleanEntry)) return false;
  if (isGenericTopicWord(cleanEntry)) return false;
  if (getExpressionValueScore(cleanEntry) < 55) return false;
  if (cleanEntry.displayBucket === 'seasonal' && !isSeasonalCandidateActive(cleanEntry)) return false;
  return Boolean(getDisplayWordByKanji(cleanEntry.kanji));
}

function getTodayBucketWeight(bucket) {
  return {
    today: 34,
    meme_fast: 18,
    long_term: 8,
    seasonal: 4
  }[bucket] || 0;
}

function getTodaySemanticGroup(word = {}) {
  const entry = word.candidateMeta || word;
  const explicitGroup = cleanShortText(entry.semanticGroup, 80);
  if (explicitGroup) return explicitGroup;
  return [
    getAccountLearningTone(entry),
    entry.candidateType || word.category || 'general',
    cleanShortText(entry.category || word.category || '', 40)
  ].filter(Boolean).join(':');
}

function isLaughWord(word = {}) {
  const text = `${word.kanji || ''} ${word.meaning || ''} ${word.candidateMeta?.meaning || ''}`;
  return /草|ワロタ|ウケる|笑|爆笑|笑える/.test(text);
}

function buildTodayWordFromCandidateEntry(entry, options = {}) {
  const cleanEntry = cleanCandidatePoolEntry(entry.kanji, entry);
  if (!cleanEntry) return null;
  if (!options.snapshotDisplay && !isTodayCandidateEligible(cleanEntry, options)) return null;
  const baseWord = getDisplayWordByKanji(cleanEntry.kanji);
  if (!baseWord) return null;
  const enriched = enrichWords([{ ...baseWord }], `snapshot_${cleanEntry.kanji}`)[0];
  const origin = cleanEntry.displayBucket === 'meme_fast'
    ? 'today'
    : cleanEntry.displayBucket === 'long_term'
      ? 'pool'
      : cleanEntry.displayBucket === 'seasonal'
        ? 'history'
        : 'pool';
  const recommended = buildRecommendedWord(enriched, origin, cleanEntry);
  if (!options.snapshotDisplay && recommended.reviewState === 'review') return null;
  const feedbackPenalty = getFeedbackPenalty(cleanEntry.kanji);
  const historicalBackfill = options.historicalBackfillWords?.has(cleanEntry.kanji) || Boolean(cleanEntry.historicalBackfill);
  const expressionValueScore = getExpressionValueScore(cleanEntry);
  const accountLearningTone = getAccountLearningTone(cleanEntry);
  const accountLearningBonus = getAccountLearningBonus(cleanEntry);
  const expressionBonus = Math.round((expressionValueScore - 70) / 3);
  const genericTopicPenalty = isGenericTopicWord(cleanEntry) ? 18 : 0;
  const candidateMeta = {
    ...cleanEntry,
    expressionValueScore,
    accountLearningTone,
    accountLearningBonus,
    ...(historicalBackfill ? { historicalBackfill: true } : {})
  };
  const adjustedScore = clamp(
    recommended.finalScore
      + getTodayBucketWeight(cleanEntry.displayBucket)
      + accountLearningBonus
      + expressionBonus
      - Math.min(toInt(cleanEntry.ignoredCount, 0) * 3, 18)
      - Math.min(toInt(cleanEntry.recommendationCount, 0) * 2, 10)
      - Math.min(feedbackPenalty, 20)
      - genericTopicPenalty,
    0,
    100
  );
  return {
    ...recommended,
    finalScore: adjustedScore,
    expressionValueScore,
    accountLearningTone,
    accountLearningBonus,
    scoreBreakdown: {
      ...(recommended.scoreBreakdown || {}),
      expressionValueScore,
      accountLearningBonus
    },
    candidateMeta,
    historicalBackfill
  };
}

function getTodayCandidateWordsFromPool(excludeWords = [], options = {}) {
  const excluded = new Set(excludeWords);
  const recentBlockedWords = options.recentBlockedWords || new Set();
  const historicalBackfillWords = options.historicalBackfillWords || new Set();
  return Object.values(cleanCandidatePool(candidatePool))
    .filter(entry => !excluded.has(entry.kanji))
    .filter(entry => ['today', 'meme_fast', 'long_term', 'seasonal'].includes(entry.displayBucket))
    .map(entry => buildTodayWordFromCandidateEntry(entry, { recentBlockedWords, historicalBackfillWords }))
    .filter(Boolean)
    .sort((left, right) => {
      const bucketDiff = getTodayBucketWeight(right.candidateMeta?.displayBucket) - getTodayBucketWeight(left.candidateMeta?.displayBucket);
      if (bucketDiff) return bucketDiff;
      return right.finalScore - left.finalScore || right.dataScore - left.dataScore || String(left.kanji).localeCompare(String(right.kanji), 'ja');
    });
}

function selectTodaySnapshotWords(candidates, existingWords = []) {
  const selected = [];
  const selectedKanji = new Set();
  const toneCounts = {};
  const learningToneCounts = {};
  const bucketCounts = {};
  const groupCounts = {};
  let laughCount = 0;
  const addWord = (word, options = {}) => {
    if (!word?.kanji || selectedKanji.has(word.kanji) || selected.length >= WORDS_PER_DAY) return false;
    const tone = getTodayEmotionTone(word);
    const learningTone = getAccountLearningTone(word.candidateMeta || word);
    const bucket = word.candidateMeta?.displayBucket || 'today';
    const group = getTodaySemanticGroup(word);
    if (tone === 'negative' && (toneCounts.negative || 0) >= TODAY_NEGATIVE_TONE_LIMIT) return false;
    if (isLaughWord(word) && laughCount >= 2) return false;
    if (!options.relaxed) {
      if (learningTone === 'aesthetic' && (learningToneCounts.aesthetic || 0) >= 3) return false;
      if (learningTone === 'seasonal_culture' && (learningToneCounts.seasonal_culture || 0) >= 3) return false;
      if (learningTone === 'fandom' && (learningToneCounts.fandom || 0) >= 4) return false;
      const groupLimit = learningTone === 'emotion_social' ? 5 : learningTone === 'lifestyle' ? 4 : 2;
      if ((groupCounts[group] || 0) >= groupLimit) return false;
    }
    selected.push(word);
    selectedKanji.add(word.kanji);
    toneCounts[tone] = (toneCounts[tone] || 0) + 1;
    learningToneCounts[learningTone] = (learningToneCounts[learningTone] || 0) + 1;
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    groupCounts[group] = (groupCounts[group] || 0) + 1;
    if (isLaughWord(word)) laughCount += 1;
    return true;
  };
  existingWords.forEach(addWord);
  const addMinimum = (predicate, minimum) => {
    candidates.filter(predicate).forEach(word => {
      if (selected.length >= WORDS_PER_DAY) return;
      if (selected.filter(predicate).length < minimum) addWord(word);
    });
  };
  addMinimum(word => getAccountLearningTone(word.candidateMeta || word) === 'emotion_social', TODAY_EMOTION_SOCIAL_TONE_MIN);
  addMinimum(word => getAccountLearningTone(word.candidateMeta || word) === 'lifestyle', TODAY_LIFESTYLE_TONE_MIN);
  addMinimum(word => getAccountLearningTone(word.candidateMeta || word) === 'fandom', TODAY_FANDOM_TONE_MIN);
  addMinimum(word => getAccountLearningTone(word.candidateMeta || word) === 'aesthetic', TODAY_AESTHETIC_TONE_MIN);
  addMinimum(word => getAccountLearningTone(word.candidateMeta || word) === 'seasonal_culture', TODAY_SEASONAL_CULTURE_TONE_MIN);
  candidates.forEach(addWord);
  if (selected.length < WORDS_PER_DAY) candidates.forEach(word => addWord(word, { relaxed: true }));
  return selected.slice(0, WORDS_PER_DAY);
}

function updateCandidatePoolAfterTodaySnapshot(selectedWords, previousWords = []) {
  const previous = new Set(previousWords);
  selectedWords.forEach(word => {
    const entry = word.candidateMeta || candidatePool[word.kanji] || {};
    const alreadyInSnapshot = previous.has(word.kanji);
    candidatePool[word.kanji] = cleanCandidatePoolEntry(word.kanji, {
      ...entry,
      lastScore: word.finalScore,
      lastScoredAt: nowIso(),
      lastRecommendedAt: nowIso(),
      wasRecommended: true,
      historicalBackfill: Boolean(word.historicalBackfill || word.candidateMeta?.historicalBackfill),
      recommendationCount: toInt(entry.recommendationCount, 0) + (alreadyInSnapshot ? 0 : 1),
      lastOrigin: word.origin,
      lastConfidenceLevel: word.confidenceLevel,
      lastReviewState: word.reviewState,
      lastReviewNote: word.reviewNote,
      lastBreakdown: word.scoreBreakdown,
      recommendationAudit: word.recommendationAudit || word.candidateMeta?.recommendationAudit || entry.recommendationAudit || {},
      updatedAt: nowIso()
    });
  });
}

function hydrateTodayWordsFromSnapshot() {
  const snapshot = cleanTodaySnapshot(todaySnapshot);
  if (!hasTodaySnapshotForToday(snapshot)) {
    todayWords = [];
    return false;
  }
  const auditByKanji = new Map(safeArray(snapshot.recommendationAudit?.items).map(item => [item.kanji, item]));
  const words = snapshot.words
    .map(kanji => {
      const auditItem = auditByKanji.get(kanji);
      const sourceEntry = candidatePool[kanji] || { kanji };
      const word = buildTodayWordFromCandidateEntry({
        ...sourceEntry,
        recommendationAudit: { ...(sourceEntry.recommendationAudit || {}), ...(auditItem || {}) }
      }, { snapshotDisplay: true });
      if (!word) return null;
      const audit = auditItem || word.candidateMeta?.recommendationAudit || {};
      return {
        ...word,
        recommendationAudit: audit,
        candidateMeta: {
          ...(word.candidateMeta || {}),
          recommendationAudit: audit
        }
      };
    })
    .filter(Boolean);
  todayWords = words;
  return todayWords.length > 0;
}

function getTodaySnapshotRepeatedWords(words = []) {
  const blocked = getRecentDailyHotBlockedWords(TODAY_HISTORY_DEDUP_DAYS, { dateKey: todayKey() });
  return getUniqueWords(words).filter(word => blocked.has(word));
}

function generateTodayFromCandidatePool(mode = 'create') {
  refreshCandidatePool();
  const currentSnapshot = cleanTodaySnapshot(todaySnapshot);
  const previousWords = currentSnapshot.dateKey === todayKey() ? currentSnapshot.words : [];
  const existingWords = mode === 'fill'
    ? previousWords.map(kanji => buildTodayWordFromCandidateEntry(candidatePool[kanji] || { kanji })).filter(Boolean)
    : [];
  const excluded = mode === 'fill' ? existingWords.map(word => word.kanji) : previousWords;
  let candidates = [];
  let selected = [];
  let dedupDaysUsed = TODAY_HISTORY_DEDUP_DAYS;
  let relaxedDedup = false;
  for (const dedupDays of TODAY_HISTORY_DEDUP_RELAX_STEPS) {
    const recentBlockedWords = getRecentDailyHotBlockedWords(dedupDays, { dateKey: todayKey() });
    candidates = getTodayCandidateWordsFromPool(excluded, {
      recentBlockedWords,
      historicalBackfillWords: new Set()
    });
    selected = selectTodaySnapshotWords(candidates, existingWords);
    dedupDaysUsed = dedupDays;
    relaxedDedup = dedupDays !== TODAY_HISTORY_DEDUP_DAYS;
    if (selected.length >= WORDS_PER_DAY || dedupDays === 0) break;
  }
  const generatedAt = nowIso();
  const freshBatchIds = getFreshAiBatchIdsForDate(todayKey());
  const latestBatchItems = getLatestBatchItemsForIds([...freshBatchIds]);
  const auditContext = {
    date: todayKey(),
    generatedAt,
    mode,
    dedupDaysUsed,
    relaxedDedup,
    freshBatchIds,
    existingWords: new Set(previousWords),
    latestBatchItems
  };
  selected = selected.map(word => {
    const audit = getRecommendationAuditTrace(word.candidateMeta || word, auditContext);
    return {
      ...word,
      recommendationAudit: audit,
      candidateMeta: {
        ...(word.candidateMeta || {}),
        recommendationAudit: audit
      }
    };
  });
  const recommendationAudit = buildTodayRecommendationAudit(selected, auditContext);
  const nextWords = selected.map(word => word.kanji);
  const selectedSet = new Set(nextWords);
  aiBatches = cleanAiBatches(aiBatches).map(batch => cleanAiBatch({
    ...batch,
    items: safeArray(batch.items).map(item => ({
      ...item,
      selectedForToday: selectedSet.has(item.kanji)
    }))
  }));
  const repeated30Words = getTodaySnapshotRepeatedWords(nextWords);
  const batchIds = getUniqueWords(selected.map(word => word.candidateMeta?.aiBatchId).filter(Boolean));
  const sameDay = currentSnapshot.dateKey === todayKey();
  todaySnapshot = cleanTodaySnapshot({
    dateKey: todayKey(),
    words: nextWords,
    generatedAt,
    source: 'candidatePool',
    batchIds,
    version: sameDay ? toInt(currentSnapshot.version, 0) + 1 : 1,
    generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
    createdBy: 'frontend',
    dedupDaysUsed,
    relaxedDedup,
    shortage: selected.length < WORDS_PER_DAY,
    repeated30Count: repeated30Words.length,
    repeated30Words,
    recommendationAudit
  });
  todayWords = selected;
  archiveTodaySnapshotHistory(todaySnapshot);
  updateCandidatePoolAfterTodaySnapshot(selected, previousWords);
  return {
    selectedCount: selected.length,
    availableCount: candidates.length + existingWords.length,
    dedupDaysUsed,
    relaxedDedup,
    shortage: selected.length < WORDS_PER_DAY
  };
}

function buildTodayRecommendations() {
  return generateTodayFromCandidatePool('create');
}

function isManualAddedEntry(entry = {}) {
  const tags = safeArray(entry?.sourceTags).map(item => String(item || '').trim());
  return entry?.sourceType === 'manual'
    || tags.includes('手动添加')
    || Boolean(entry?.discoverySource || entry?.discoveryContext);
}

function getFavoriteSourceLabel(wordOrEntry = {}) {
  const entry = wordOrEntry?.candidateMeta || wordOrEntry || {};
  return isManualAddedEntry(entry) ? '手动添加' : '每日热门';
}

function getDiscoverySourceLabel(entry = {}) {
  return cleanShortText(entry.discoverySource, 80);
}

function renderFavoriteSourceChip(wordOrEntry = {}) {
  const label = getFavoriteSourceLabel(wordOrEntry);
  return `<span class="card-source"><span class="card-source-icon">${escapeHTML(sourceIcons[label] || '•')}</span>来源：${escapeHTML(label)}</span>`;
}

function renderSourceInfoSection(entry = {}) {
  const sourceLabel = getFavoriteSourceLabel(entry);
  const discoverySource = getDiscoverySourceLabel(entry);
  const discoveryContext = cleanShortText(entry.discoveryContext, 1200);
  const importedAt = entry.importedAt ? String(entry.importedAt).slice(0, 16).replace('T', ' ') : '';
  const rows = [`<div class="modal-meta-item">来源：${escapeHTML(sourceLabel)}</div>`];
  if (sourceLabel === '手动添加') {
    if (discoverySource) rows.push(`<div class="modal-meta-item">发现渠道：${escapeHTML(discoverySource)}</div>`);
    if (discoveryContext) rows.push(`<div class="modal-meta-item source-context">补充语境：${escapeHTML(discoveryContext)}</div>`);
    if (importedAt) rows.push(`<div class="modal-meta-item">添加时间：${escapeHTML(importedAt)}</div>`);
  }
  return `<div class="modal-section compact-section"><div class="modal-section-title">来源信息</div><div class="modal-meta-bar source-info-bar">${rows.join('')}</div></div>`;
}

function getSourceOptions(words) {
  return [...new Set(safeArray(words).map(word => word.source).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans'));
}

function populateSourceFilter(tab, words) {
  const select = document.getElementById(`${tab}SourceFilter`);
  if (!select) return;
  const sources = getSourceOptions(words);
  const current = sources.includes(sourceFilters[tab]) ? sourceFilters[tab] : 'all';
  sourceFilters[tab] = current;
  select.innerHTML = ['<option value="all">全部来源</option>', ...sources.map(source => `<option value="${escapeHTML(source)}">${escapeHTML(source)}</option>`)].join('');
  select.value = current;
}

function populateDailyHotSourceFilter(tab, words) {
  const model = buildDailyHotSourceFilterModel({
    words,
    sourceFilter: sourceFilters[tab]
  });
  sourceFilters[tab] = model.sourceFilter;
  const select = document.getElementById(`${tab}SourceFilter`);
  if (select) {
    select.innerHTML = model.options
      .map(option => `<option value="${escapeHTML(option.value)}">${escapeHTML(option.label)}</option>`)
      .join('');
    select.value = model.sourceFilter;
  }
  return model;
}

function applySourceFilter(words, tab) {
  const source = sourceFilters[tab] || 'all';
  return source === 'all' ? words : words.filter(word => word.source === source);
}

function selectBalancedTodayWords(candidates, limit = WORDS_PER_DAY) {
  const uniqueCandidates = [];
  const seen = new Set();
  safeArray(candidates).forEach(word => {
    if (!word?.kanji || seen.has(word.kanji)) return;
    seen.add(word.kanji);
    uniqueCandidates.push(word);
  });
  const selected = [];
  const selectedKanji = new Set();
  const toneCounts = {};
  const addWord = word => {
    if (!word?.kanji || selectedKanji.has(word.kanji) || selected.length >= limit) return false;
    const tone = getTodayEmotionTone(word);
    if (tone === 'negative' && (toneCounts.negative || 0) >= TODAY_NEGATIVE_TONE_LIMIT) return false;
    selected.push(word);
    selectedKanji.add(word.kanji);
    toneCounts[tone] = (toneCounts[tone] || 0) + 1;
    return true;
  };
  const addToneMinimum = (tone, minimum) => {
    uniqueCandidates
      .filter(word => getTodayEmotionTone(word) === tone)
      .slice(0, minimum)
      .forEach(addWord);
  };
  addToneMinimum('aesthetic', TODAY_AESTHETIC_TONE_MIN);
  addToneMinimum('lifestyle', TODAY_LIFESTYLE_TONE_MIN);
  addToneMinimum('fandom', TODAY_FANDOM_TONE_MIN);
  uniqueCandidates.forEach(addWord);
  return selected.slice(0, limit);
}

function setSourceFilter(tab, value) {
  if (!Object.prototype.hasOwnProperty.call(sourceFilters, tab)) return;
  sourceFilters[tab] = value || 'all';
  localStorage.setItem(`${SOURCE_FILTER_STORAGE_PREFIX}${tab}`, sourceFilters[tab]);
  if (tab === 'history') {
    renderHistory();
    return;
  }
  refreshCurrentGrid();
}

function setStatusFilter(value) {
  statusFilter = cleanStatusFilter(value);
  localStorage.setItem(STATUS_FILTER_STORAGE_KEY, statusFilter);
  renderFavorites();
}

function normalizeAiPreviewItem(item = {}, batchId = '', sourceText = '', action = 'generate_candidates') {
  const normalized = normalizeAiCandidate(item);
  if (normalized?.blocked) {
    return {
      kanji: normalized.kanji,
      blocked: true,
      blockReason: normalized.blockReason,
      romaji: '',
      kana: '',
      meaning: '默认不导入',
      category: '屏蔽词',
      candidateType: '高风险话题词',
      freshness: '短期',
      xhsFitScore: 0,
      riskLevel: 'high',
      riskWarning: normalized.blockReason,
      emotionTone: 'negative',
      confidenceLevel: 'review',
      evidenceType: 'unknown',
      reviewReason: normalized.blockReason,
      reviewReasonType: 'offensive',
      displayBucket: 'blocked',
      reason: normalized.blockReason,
      suggestedAction: '不建议',
      sourceTags: ['AI候选', 'DeepSeek', '人工复核'],
      importState: ['new', 'imported', 'skipped'].includes(item.importState) ? item.importState : 'new',
      importedAt: typeof item.importedAt === 'string' ? item.importedAt : '',
      skippedAt: typeof item.skippedAt === 'string' ? item.skippedAt : ''
    };
  }
  const kanji = cleanShortText(normalized?.kanji || item.kanji, 80);
  if (!kanji) return null;
  const riskLevel = normalizeEnumValue(normalized.riskLevel, RISK_LEVEL_OPTIONS, 'low');
  const freshness = normalizeEnumValue(normalized.freshness, FRESHNESS_OPTIONS, '中期');
  const candidateType = normalizeEnumValue(normalized.candidateType, CANDIDATE_TYPE_OPTIONS, riskLevel === 'high' ? '高风险话题词' : '网络口语词');
  const sourceTags = getUniqueWords(normalized.sourceTags || ['AI候选', 'DeepSeek']).slice(0, 12);
  return {
    kanji,
    romaji: cleanShortText(normalized.romaji, 120),
    kana: cleanShortText(normalized.kana, 120),
    meaning: cleanShortText(normalized.meaning, 240),
    category: cleanShortText(normalized.category, 80),
    candidateType,
    freshness,
    xhsFitScore: clamp(toInt(normalized.xhsFitScore, 60), 0, 100),
    riskLevel,
    riskWarning: cleanShortText(normalized.riskWarning, 500),
    emotionTone: normalizeEnumValue(normalized.emotionTone, EMOTION_TONE_OPTIONS, inferAiEmotionTone(kanji, normalized, 'neutral')),
    confidenceLevel: normalizeEnumValue(normalized.confidenceLevel, CONFIDENCE_LEVEL_OPTIONS, 'low'),
    evidenceType: normalizeEnumValue(normalized.evidenceType, EVIDENCE_TYPE_OPTIONS, 'unknown'),
    reviewReason: cleanShortText(normalized.reviewReason, 500),
    reviewReasonType: normalizeEnumValue(normalized.reviewReasonType, REVIEW_REASON_TYPE_OPTIONS, ''),
    displayBucket: normalizeEnumValue(normalized.displayBucket, DISPLAY_BUCKET_OPTIONS, 'long_term'),
    reason: cleanShortText(normalized.reason, 1000),
    suggestedAction: normalizeEnumValue(normalized.suggestedAction, SUGGESTED_ACTION_OPTIONS, riskLevel === 'high' ? '暂缓' : '可以收藏观察'),
    examples: safeArray(normalized.examples).map(cleanAiExample).filter(Boolean).slice(0, 5),
    suggestedTitles: getUniqueWords(normalized.suggestedTitles || []).map(title => cleanShortText(title, 140)).slice(0, 8),
    coverSuggestion: cleanCoverSuggestion(normalized.coverSuggestion || {}),
    sourceType: 'deepseek_generated',
    sourcePromptType: action,
    sourcePromptVersion: getPromptVersion(action),
    sourceText,
    sourceTags,
    aiBatchId: batchId,
    updatedAt: nowIso(),
    importState: ['new', 'imported', 'skipped'].includes(item.importState) ? item.importState : 'new',
    importedAt: typeof item.importedAt === 'string' ? item.importedAt : '',
    skippedAt: typeof item.skippedAt === 'string' ? item.skippedAt : '',
    lastScore: clamp(toInt(normalized.xhsFitScore, 60), 0, 100),
    lastReviewState: normalized.lastReviewState || 'watch',
    lastReviewNote: cleanShortText(normalized.lastReviewNote || normalized.reviewReason, 240),
    manualReviewState: '',
    manualReviewNote: ''
  };
}

function loadAiPreviewState(options = {}) {
  if (aiPreview?.items?.length && !options.forceLocal) {
    aiPreview = cleanAiPreviewState(aiPreview);
    return;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(AI_PREVIEW_STORAGE_KEY) || '{}');
    aiPreview = cleanAiPreviewState(stored);
  } catch (error) {
    aiPreview = cleanAiPreviewState({});
  }
}

async function autoGenerateAiCandidates() {
  const payload = buildAutoAiCandidatePayload({
    favorites,
    negativeFeedback: wordFeedback,
    publishedRecords,
    candidatePool
  });
  const result = await requestAutoAiCandidateBatch({
    request: apiFetch,
    endpoint: getAiCandidatesEndpoint(),
    payload,
    normalizeItem: normalizeAiPreviewItem,
    buildBatchItems: buildAiBatchItems,
    buildTrace: getAiTraceFromUsage,
    cleanBatch: cleanAiBatch,
    nowIso
  });
  const { items, batch } = result;
  aiBatches = [batch, ...cleanAiBatches(aiBatches).filter(item => item.id !== batch.id)].slice(0, 100);
  return result;
}

function autoImportAiCandidates(items = [], batch = {}) {
  const publishedWords = new Set(cleanPublishedRecords(publishedRecords).map(record => record.word).filter(Boolean));
  const stats = {
    generated: safeArray(items).length,
    imported: 0,
    skipped: 0,
    review: 0,
    blocked: 0
  };
  safeArray(items).forEach(item => {
    if (item.blocked || getAiBlockWordReason(item.kanji)) {
      stats.blocked += 1;
      stats.skipped += 1;
      return;
    }
    const normalizedItem = normalizeAiCandidate(item, { forceImport: false });
    if (!normalizedItem || normalizedItem.blocked) {
      stats.blocked += 1;
      stats.skipped += 1;
      return;
    }
    if (favorites.includes(normalizedItem.kanji) || publishedWords.has(normalizedItem.kanji) || getFavoriteStatus(normalizedItem.kanji) === 'published') {
      stats.skipped += 1;
      return;
    }
    const existing = candidatePool[normalizedItem.kanji] || {};
    const isReview = normalizedItem.displayBucket === 'review'
      || normalizedItem.riskLevel === 'high'
      || normalizedItem.confidenceLevel === 'review'
      || normalizedItem.evidenceType === 'unknown';
    candidatePool[normalizedItem.kanji] = cleanCandidatePoolEntry(normalizedItem.kanji, {
      ...existing,
      ...normalizedItem,
      aiCard: existing.aiCard || normalizedItem.aiCard,
      aiCardHistory: existing.aiCardHistory || normalizedItem.aiCardHistory,
      manualReviewState: existing.manualReviewState || normalizedItem.manualReviewState || '',
      manualReviewNote: existing.manualReviewNote || normalizedItem.manualReviewNote || '',
      sourceTags: getUniqueWords([...(existing.sourceTags || []), ...(normalizedItem.sourceTags || []), 'DeepSeek', 'AI候选', '自动日更']),
      importedAt: existing.importedAt || nowIso(),
      updatedAt: nowIso(),
      lastReviewState: isReview ? 'review' : (normalizedItem.lastReviewState || existing.lastReviewState || 'watch')
    });
    stats.imported += 1;
    if (isReview) stats.review += 1;
  });
  if (batch?.id) updateAiBatchImportStats(batch.id, stats.imported, stats.skipped);
  return stats;
}

async function autoGenerateCardsForToday() {
  return Promise.resolve(0);
}

function queueAutoGenerateCardsForToday() {
  return Promise.resolve(0);
}

async function runDailyAutoRefreshIfNeeded(options = {}) {
  if (!shouldRunDailyAutoRefresh(options)) return { status: 'skipped' };
  if (isAutoDailyRefreshRunning && !options.force) return autoDailyRefreshPromise || { status: 'running' };

  const previousState = getAutoDailyRefreshState();
  const attempts = previousState.dateKey === todayKey() ? previousState.attempts + 1 : 1;
  isAutoDailyRefreshRunning = true;
  setTodayActionButtonsDisabled(true);
  setAutoDailyRefreshState({
    dateKey: todayKey(),
    status: 'running',
    startedAt: nowIso(),
    finishedAt: '',
    error: '',
    attempts
  });
  renderToday();

  try {
    const cloudLoaded = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    if (!cloudLoaded) throw new Error('云端同步失败，无法安全执行团队自动日更');
    hydrateTodayWordsFromSnapshot();
    if (!options.force && hasTodaySnapshotForToday(todaySnapshot)) {
      markAutoDailySuccess();
      renderToday();
      return { status: 'skipped', reason: 'cloud_snapshot_exists' };
    }

    const todayResult = await generateTodaySnapshotOnServerWithAiSupplement('create');
    const importStats = todayResult.aiSupplementStats || { generated: 0, imported: 0, skipped: 0, review: 0, blocked: 0 };
    hydrateTodayWordsFromSnapshot();
    saveLocalWorkflow();
    await saveCloudWorkflow(false);
    updateAllBadges();
    if (todayWords.length) {
      markAutoDailySuccess();
    } else {
      setAutoDailyRefreshState({
        dateKey: todayKey(),
        status: 'failed',
        startedAt: previousState.startedAt || nowIso(),
        finishedAt: nowIso(),
        error: '备选池可用词不足，自动生成没有选出今日候选。',
        attempts
      });
    }
    renderToday();
    showToast(`自动日更完成：导入 ${importStats.imported} 个，今日 ${todayWords.length} 个。可手动生成今日词卡。`);
    return {
      status: 'success',
      generatedCandidates: importStats.generated,
      importedCandidates: importStats.imported,
      todayCount: todayWords.length,
      generatedCards: 0,
      result: todayResult
    };
  } catch (error) {
    console.warn('自动日更失败', error);
    setAutoDailyRefreshState({
      dateKey: todayKey(),
      status: 'failed',
      startedAt: previousState.startedAt || nowIso(),
      finishedAt: nowIso(),
      error: error.message || '自动更新失败',
      attempts
    });
    renderToday();
    showToast('自动更新失败，可以手动点击生成。');
    return { status: 'failed', error };
  } finally {
    isAutoDailyRefreshRunning = false;
    setTodayActionButtonsDisabled(false);
    autoDailyRefreshPromise = null;
  }
}

function getAiCardStatusLabel(aiCard) {
  return buildWordCardViewModel({
    aiCard,
    stalePending: isAiCardStalePending(aiCard)
  }).statusLabel;
}

function isTodaySnapshotWord(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  return Boolean(cleanKanji && cleanTodaySnapshot(todaySnapshot).words.includes(cleanKanji));
}

function renderAiCardActionButton(kanji, aiCard = {}, className = 'btn btn-ghost') {
  const cleanKanji = cleanShortText(kanji, 80);
  const safeKanji = escapeHTML(cleanKanji);
  const card = cleanAiCard(aiCard || {}) || { cardStatus: 'none' };
  const inFlight = aiCardAutoInFlight.has(cleanKanji);
  if (isTodaySnapshotWord(cleanKanji)) {
    const entry = candidatePool?.[cleanKanji] || {};
    const actionState = getTodayAiCardActionState({ aiCard: card, entry, inFlight });
    return `<button class="${escapeHTML(className)}" ${actionState.disabled ? 'disabled' : ''} data-workflow-action="generate-today-card" data-kanji="${safeKanji}">${escapeHTML(actionState.label)}</button>`;
  }
  if (card.cardStatus === 'ready') {
    return `<button class="${escapeHTML(className)}" disabled>已生成词卡</button><button class="${escapeHTML(className)}" data-workflow-action="generate-deepseek-card" data-kanji="${safeKanji}" data-force="true">重新生成 DeepSeek 词卡</button>`;
  }
  if (card.cardStatus === 'pending') {
    return `<button class="${escapeHTML(className)}" disabled>DeepSeek 词卡生成中</button>`;
  }
  return `<button class="${escapeHTML(className)}" data-workflow-action="generate-deepseek-card" data-kanji="${safeKanji}" data-force="false">${card.cardStatus === 'failed' ? '重试 DeepSeek 词卡' : '生成 DeepSeek 词卡'}</button>`;
}

async function generateTodayAiCardsOnServer(kanjis = [], options = {}) {
  const endpoint = getAiCardsEndpoint();
  if (!endpoint) {
    showToast('云端后端还没有配置');
    return 0;
  }
  if (!hasTodaySnapshotForToday(todaySnapshot)) {
    showToast('今天还没有固定推荐，不能生成今日词卡');
    return 0;
  }
  const targets = getUniqueWords(kanjis).filter(isTodaySnapshotWord).slice(0, 5);
  if (!targets.length && options.wordsRequired !== false) {
    showToast('请选择今日热门里的词生成卡片');
    return 0;
  }
  targets.forEach(kanji => aiCardAutoInFlight.add(kanji));
  renderToday();
  try {
    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildTodayAiCardsRequest(targets, options))
    }, { workflowMutation: true, operationPrefix: 'today-ai-cards', timeoutMs: 110000 });
    const data = await response.json().catch(() => ({}));
    await loadCloudWorkflow(false);
    updateAllBadges();
    renderToday();
    if (currentWordForModal && targets.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
    if (!response.ok || data.error) throw new Error(getApiErrorMessage(data, response.status));
    const savedCount = toInt(data.savedCount, 0);
    showToast(savedCount ? `已生成 ${savedCount} 个今日词卡` : '没有需要生成的今日词卡');
    return savedCount;
  } catch (error) {
    console.warn('今日词卡生成失败', error);
    await loadCloudWorkflow(false);
    renderToday();
    if (currentWordForModal && targets.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
    showToast(`今日词卡生成失败：${error.message || '服务暂时不可用'}`);
    return 0;
  } finally {
    targets.forEach(kanji => aiCardAutoInFlight.delete(kanji));
    renderToday();
    if (currentWordForModal && targets.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
  }
}

function generateTodayAiCard(kanji, options = {}) {
  const entry = cleanCandidatePoolEntry(kanji, candidatePool[kanji] || {}) || {};
  const card = cleanAiCard(entry.aiCard || {});
  return generateTodayAiCardsOnServer([kanji], getSingleTodayAiCardGenerationOptions({
    aiCard: card,
    entry,
    options
  }));
}

function generateMissingTodayAiCards() {
  const targets = selectMissingTodayAiCardKanjis({
    kanjis: cleanTodaySnapshot(todaySnapshot).words,
    candidatePool,
    maxWords: 5
  });
  if (!targets.length) {
    showToast('今日没有缺失的词卡；失败项请在单词卡上点“重试”。');
    return Promise.resolve(0);
  }
  return generateTodayAiCardsOnServer(targets, { maxWords: 5 });
}

function getAiCardAutoAttemptsState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CARD_AUTO_ATTEMPTS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getAiCardAutoAttemptCount(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  const state = getAiCardAutoAttemptsState();
  return clamp(toInt(state?.[todayKey()]?.[cleanKanji], 0), 0, 20);
}

function incrementAiCardAutoAttempt(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return 0;
  const state = getAiCardAutoAttemptsState();
  const date = todayKey();
  const todayState = state[date] && typeof state[date] === 'object' ? state[date] : {};
  const nextCount = clamp(toInt(todayState[cleanKanji], 0) + 1, 1, 20);
  localStorage.setItem(AI_CARD_AUTO_ATTEMPTS_KEY, JSON.stringify({
    [date]: {
      ...todayState,
      [cleanKanji]: nextCount
    }
  }));
  return nextCount;
}

function shouldAutoGenerateAiCard(kanji, options = {}) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji || aiCardAutoInFlight.has(cleanKanji)) return false;
  const entry = ensureCandidatePoolEntryForCard(cleanKanji);
  if (!entry) return false;
  return canAutoGenerateAiCard({
    aiCard: entry.aiCard,
    inFlight: false,
    attemptCount: getAiCardAutoAttemptCount(cleanKanji),
    force: Boolean(options.force),
    maxAttempts: AI_CARD_AUTO_MAX_ATTEMPTS_PER_DAY
  });
}

function getMissingAiCardKanjis(kanjis = [], options = {}) {
  return getUniqueWords(kanjis).filter(kanji => shouldAutoGenerateAiCard(kanji, options));
}

async function queueAutoGenerateAiCards(kanjis = [], options = {}) {
  const targets = getMissingAiCardKanjis(kanjis, options);
  if (!targets.length) return 0;
  targets.forEach(kanji => {
    aiCardAutoInFlight.add(kanji);
    incrementAiCardAutoAttempt(kanji);
  });
  markAiCardStatus(targets, 'pending', 'DeepSeek 词卡生成中');
  saveLocalWorkflow();
  refreshCurrentGrid();

  const run = async () => {
    let generatedCards = 0;
    try {
      for (let index = 0; index < targets.length; index += 5) {
        const batch = targets.slice(index, index + 5);
        generatedCards += await generateDeepSeekWordCards(batch, { force: Boolean(options.force), silent: true });
      }
      saveLocalWorkflow();
      await saveCloudWorkflow(false);
      updateAllBadges();
      refreshCurrentGrid();
      if (currentWordForModal && targets.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
      if (options.toast !== false && generatedCards) showToast(`已自动生成 ${generatedCards} 个 DeepSeek 词卡`);
      return generatedCards;
    } catch (error) {
      console.warn('自动词卡生成失败', error);
      refreshCurrentGrid();
      return 0;
    } finally {
      targets.forEach(kanji => aiCardAutoInFlight.delete(kanji));
      aiCardAutoQueuePromise = null;
    }
  };

  aiCardAutoQueuePromise = aiCardAutoQueuePromise ? aiCardAutoQueuePromise.then(run) : run();
  return aiCardAutoQueuePromise;
}

function ensureCandidatePoolEntryForCard(kanji) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return null;
  const existing = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {});
  if (existing) return existing;
  const reviewedEntry = ensureReviewedSeedWordInCandidatePool(cleanKanji);
  if (reviewedEntry) return reviewedEntry;
  const displayWord = getDisplayWordByKanji(cleanKanji);
  if (!displayWord) return null;
  return cleanCandidatePoolEntry(cleanKanji, {
    kanji: cleanKanji,
    romaji: displayWord.romaji,
    kana: displayWord.kana || displayWord.reading,
    meaning: displayWord.meaning,
    category: displayWord.category,
    candidateType: '稳定候选',
    freshness: '中期',
    xhsFitScore: displayWord.xhsFitScore || displayWord.popularity || 60,
    riskLevel: 'low',
    confidenceLevel: 'medium',
    evidenceType: 'common_usage',
    displayBucket: 'long_term',
    sourceType: 'deepseek_reviewed',
    reviewSource: 'deepseek_library_audit',
    libraryReviewStatus: 'approved',
    aiCard: { cardStatus: 'none' },
    importedAt: nowIso(),
    updatedAt: nowIso()
  });
}

function buildWordCardPayloadItems(kanjis) {
  return getUniqueWords(kanjis).map(kanji => {
    const entry = ensureCandidatePoolEntryForCard(kanji);
    if (!entry) return null;
    if (isLegacyLibraryWord(kanji, entry) && isLibraryAuditMissing(kanji, entry)) return null;
    if (isLibraryAuditRemoved(entry)) return null;
    const word = getDisplayWordByKanji(kanji) || {};
    return {
      kanji: entry.kanji,
      romaji: entry.romaji || word.romaji || '',
      kana: entry.kana || word.kana || word.reading || '',
      meaning: entry.meaning || word.meaning || '',
      category: entry.category || word.category || '',
      candidateType: entry.candidateType || '',
      freshness: entry.freshness || '',
      xhsFitScore: entry.xhsFitScore || word.xhsFitScore || 0,
      riskLevel: entry.riskLevel || 'low',
      confidenceLevel: entry.confidenceLevel || 'medium',
      evidenceType: entry.evidenceType || 'common_usage',
      displayBucket: entry.displayBucket || 'long_term',
      emotionTone: entry.emotionTone || 'neutral',
      reason: entry.reason || word.recommendationReason || '',
      sourceTags: safeArray(entry.sourceTags).slice(0, 12),
      sourceType: entry.sourceType || '',
      discoverySource: entry.discoverySource || '',
      discoveryContext: entry.discoveryContext || '',
      reviewReason: entry.reviewReason || '',
      isManualAdded: isManualAddedEntry(entry),
      examples: safeArray(entry.examples).slice(0, 2),
      suggestedTitles: safeArray(entry.suggestedTitles),
      coverSuggestion: entry.coverSuggestion || {}
    };
  }).filter(Boolean);
}

function saveGeneratedAiCard(kanji, aiCard, usage = {}, force = false) {
  const entry = ensureCandidatePoolEntryForCard(kanji);
  if (!entry) return false;
  const previousCard = cleanAiCard(entry.aiCard || {});
  const history = safeArray(entry.aiCardHistory).map(cleanAiCard).filter(Boolean);
  const nextHistory = force && previousCard?.cardStatus === 'ready'
    ? [previousCard, ...history].slice(0, 3)
    : history.slice(0, 3);
  const cleanCard = cleanAiCard({
    ...(aiCard || {}),
    cardStatus: 'ready',
    cardSource: 'deepseek_api',
    cardModel: aiCard?.cardModel || usage.model || 'deepseek-v4-flash',
    cardVersion: force && previousCard ? toInt(previousCard.cardVersion, 1) + 1 : toInt(aiCard?.cardVersion, previousCard?.cardVersion || 1),
    generatedAt: aiCard?.generatedAt || usage.createdAt || nowIso()
  });
  candidatePool[kanji] = cleanCandidatePoolEntry(kanji, {
    ...entry,
    aiCard: cleanCard,
    aiCardHistory: nextHistory,
    updatedAt: nowIso()
  });
  return true;
}

function markAiCardStatus(kanjis, status, message = '') {
  getUniqueWords(kanjis).forEach(kanji => {
    const entry = ensureCandidatePoolEntryForCard(kanji);
    if (!entry) return;
    const previousCard = cleanAiCard(entry.aiCard || {});
    if (previousCard?.cardStatus === 'ready' && status === 'pending') return;
    candidatePool[kanji] = cleanCandidatePoolEntry(kanji, {
      ...entry,
      aiCard: {
        ...(previousCard || {}),
        cardStatus: status,
        cardSource: previousCard?.cardSource || 'deepseek_api',
        generatedAt: previousCard?.generatedAt || nowIso(),
        summary: previousCard?.summary || message
      },
      updatedAt: nowIso()
    });
  });
}

async function generateDeepSeekWordCards(kanjis, options = {}) {
  const targetKanjis = getUniqueWords(kanjis);
  if (!targetKanjis.length) {
    if (!options.silent) showToast('先选择要生成词卡的候选词');
    return 0;
  }
  const payload = buildAiCardRequestPayload({
    words: buildWordCardPayloadItems(targetKanjis),
    favorites,
    negativeFeedback: wordFeedback,
    publishedWords: cleanPublishedRecords(publishedRecords).map(record => record.word).filter(Boolean),
    accountLearningSummary: getAccountLearningSummary()
  });
  if (!payload.context.words.length) {
    if (!options.silent) showToast('没有找到可生成词卡的候选词');
    return 0;
  }
  const force = Boolean(options.force);
  const silent = Boolean(options.silent);
  markAiCardStatus(targetKanjis, 'pending', 'DeepSeek 词卡生成中');
  saveLocalWorkflow();
  if (!silent) refreshCurrentGrid();
  if (!silent) showToast(`正在生成 ${payload.context.words.length} 个 DeepSeek 词卡…`);
  try {
    const response = await apiFetch(getAiCandidatesEndpoint(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, { timeoutMs: 100000 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    let savedCount = 0;
    safeArray(data.items).forEach((item, index) => {
      const kanji = cleanShortText(item.kanji || payload.context.words[index]?.kanji, 80);
      if (kanji && saveGeneratedAiCard(kanji, item.aiCard || item.card || item, data.usage || {}, force)) savedCount += 1;
    });
    const trace = getAiTraceFromUsage(data.usage || {}, payload);
    const batch = cleanAiBatch({
      id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action: payload.action,
      model: data.usage?.model || 'deepseek-v4-flash',
      createdAt: data.usage?.createdAt || nowIso(),
      itemCount: payload.context.words.length,
      importedCount: savedCount,
      skippedCount: Math.max(0, payload.context.words.length - savedCount),
      ...trace,
      promptSummary: targetKanjis.slice(0, 20).join('、'),
      trendNotes: data.summary?.trendNotes || ''
    });
    aiBatches = [batch, ...cleanAiBatches(aiBatches).filter(item => item.id !== batch.id)].slice(0, 100);
    saveLocalWorkflow();
    if (!silent) refreshCurrentGrid();
    if (!silent && currentWordForModal && targetKanjis.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
    if (!silent) saveCloudWorkflow(false);
    if (!silent) showToast(savedCount ? `已生成 ${savedCount} 个 DeepSeek 词卡` : 'DeepSeek 没有返回可保存的词卡');
    return savedCount;
  } catch (error) {
    console.warn('DeepSeek 词卡生成失败', error);
    targetKanjis.forEach(kanji => {
      const entry = ensureCandidatePoolEntryForCard(kanji);
      const previousCard = cleanAiCard(entry?.aiCard || {});
      if (!entry || previousCard?.cardStatus === 'ready') return;
      candidatePool[kanji] = cleanCandidatePoolEntry(kanji, {
        ...entry,
        aiCard: {
          cardStatus: 'failed',
          cardSource: 'deepseek_api',
          cardModel: '',
          generatedAt: nowIso(),
          summary: cleanShortText(error.message || '生成失败', 300)
        },
        updatedAt: nowIso()
      });
    });
    saveLocalWorkflow();
    if (!silent) refreshCurrentGrid();
    if (!silent && currentWordForModal && targetKanjis.includes(currentWordForModal.kanji)) openDetail(currentWordForModal.kanji);
    if (!silent) showToast(`词卡生成失败：${error.message || '服务暂时不可用'}`);
    return 0;
  }
}

function generateDeepSeekWordCard(kanji, force = false) {
  return generateDeepSeekWordCards([kanji], { force });
}

function getFavoriteWords() {
  return filterKnownFavorites(favorites)
    .filter(kanji => getFavoriteStatus(kanji) !== 'published')
    .map((kanji, index) => {
    const candidateMeta = cleanCandidatePoolEntry(kanji, candidatePool[kanji] || {}) || null;
    const favoriteSource = getFavoriteSourceLabel(candidateMeta || {});
    const fromToday = todayWords.find(word => word.kanji === kanji);
    if (fromToday) return { ...fromToday, source: favoriteSource, candidateMeta: candidateMeta || fromToday.candidateMeta || null };
    const baseWord = getDisplayWordByKanji(kanji);
    if (!baseWord) return null;
    return {
      ...buildRecommendedWord(enrichWords([{ ...baseWord }], `fav_${kanji}`)[0], 'favorite', candidateMeta),
      source: favoriteSource,
      candidateMeta
    };
  }).filter(Boolean);
}

function getVisibleFavoriteWords() {
  return getFavoritesPageModel().visibleWords;
}

function getFavoritesPageModel(words = getFavoriteWords()) {
  return buildFavoritesPageModel({
    words,
    sourceFilter: sourceFilters.favorites,
    statusFilter,
    getStatus: word => getFavoriteStatus(word.kanji)
  });
}

function getRecordRating(record) {
  return ratePublishedRecord(record, {
    records: cleanPublishedRecords(publishedRecords),
    now: Date.now()
  });
}

function ensureFavoriteWord(kanji) {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(kanji, 80));
  if (cleanKanji && !favorites.includes(cleanKanji)) favorites.unshift(cleanKanji);
}

function ensureFavoriteWordsHaveCandidateEntries() {
  favorites = getUniqueWords(favorites).map(normalizeKanjiSpelling).filter(Boolean);
  favorites.forEach(kanji => {
    if (!candidatePool[kanji]) ensureManualKeepEntry(kanji);
  });
}

function ensureManualKeepEntry(kanji) {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(kanji, 80));
  if (!cleanKanji) return null;
  const existing = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {}) || {};
  const word = getDisplayWordByKanji(cleanKanji) || getWordByKanji(cleanKanji) || {};
  candidatePool[cleanKanji] = cleanCandidatePoolEntry(cleanKanji, {
    ...existing,
    kanji: cleanKanji,
    kana: existing.kana || word.kana || word.reading || '',
    romaji: existing.romaji || word.romaji || '',
    meaning: existing.meaning || word.meaning || '',
    category: existing.category || word.category || '',
    candidateType: existing.candidateType || '稳定候选',
    freshness: existing.freshness || '长期',
    xhsFitScore: existing.xhsFitScore || word.popularity || 60,
    riskLevel: existing.riskLevel || 'low',
    confidenceLevel: existing.confidenceLevel || 'medium',
    evidenceType: existing.evidenceType || 'common_usage',
    displayBucket: existing.displayBucket === 'blocked' ? 'review' : (existing.displayBucket || 'long_term'),
    sourceType: 'manual_keep',
    libraryReviewStatus: 'protected',
    libraryAuditStatus: 'protected',
    libraryAuditAction: 'protect',
    protected: true,
    reason: existing.reason || '用户已进入工作流，禁止自动删除',
    sourceTags: getUniqueWords([...(existing.sourceTags || []), '受保护']),
    importedAt: existing.importedAt || nowIso(),
    updatedAt: nowIso()
  });
  return candidatePool[cleanKanji];
}

function ensureManualWordCandidate(kanji, options = {}) {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(kanji, 80));
  if (!cleanKanji) return null;
  const now = nowIso();
  const existing = cleanCandidatePoolEntry(cleanKanji, candidatePool[cleanKanji] || {}) || {};
  const word = getDisplayWordByKanji(cleanKanji) || getWordByKanji(cleanKanji) || {};
  const discoverySource = cleanShortText(options.discoverySource || existing.discoverySource, 80);
  const discoveryContext = cleanShortText(options.discoveryContext || existing.discoveryContext, 1200);
  const sourceTags = getUniqueWords(['手动添加', '受保护', ...(existing.sourceTags || [])]).slice(0, 12);
  candidatePool[cleanKanji] = cleanCandidatePoolEntry(cleanKanji, {
    ...existing,
    kanji: cleanKanji,
    kana: existing.kana || word.kana || word.reading || '',
    romaji: existing.romaji || word.romaji || '',
    meaning: existing.meaning || word.meaning || discoveryContext || '手动添加词，等待 DeepSeek 生成词卡',
    category: existing.category || word.category || '手动添加',
    candidateType: existing.candidateType || '稳定候选',
    freshness: existing.freshness || '中期',
    xhsFitScore: existing.xhsFitScore || word.popularity || 60,
    riskLevel: existing.riskLevel || 'low',
    confidenceLevel: existing.confidenceLevel || 'medium',
    evidenceType: existing.evidenceType || (discoveryContext ? 'user_material' : 'ai_inferred'),
    displayBucket: existing.displayBucket === 'blocked' ? 'review' : (existing.displayBucket || 'long_term'),
    sourceType: 'manual_keep',
    libraryReviewStatus: 'protected',
    libraryAuditStatus: 'protected',
    libraryAuditAction: 'protect',
    protected: true,
    reason: discoveryContext || existing.reason || '手动添加词，等待 DeepSeek 生成词卡',
    sourceTags,
    discoverySource,
    discoveryContext,
    sourceText: discoveryContext || existing.sourceText || '',
    importedAt: existing.importedAt || now,
    firstSeenAt: existing.firstSeenAt || now,
    aiCard: existing.aiCard || { cardStatus: 'none' },
    aiCardHistory: existing.aiCardHistory || [],
    updatedAt: now
  });
  return candidatePool[cleanKanji];
}

function getManualWordExistingState(kanji) {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(kanji, 80));
  const published = cleanPublishedRecords(publishedRecords).some(record => record.word === cleanKanji);
  if (favorites.includes(cleanKanji)) return 'favorite';
  if (published) return 'published';
  if (candidatePool[cleanKanji]) return 'candidate';
  return '';
}

function openManualWordModal() {
  hasUnsavedFormChanges = false;
  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">添加单词</h2>
        <button class="modal-close" data-manual-word-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="form-grid two-col">
          <label class="form-field full"><span>日语单词 *</span><input class="form-input" id="manualWordKanji" maxlength="80" placeholder="请输入你发现的日语词，例如 エモい、抜け感、沼"></label>
          <label class="form-field"><span>发现渠道</span><select class="form-input" id="manualWordDiscoverySource"><option value="">未选择</option>${MANUAL_DISCOVERY_SOURCE_OPTIONS.map(source => `<option value="${escapeHTML(source)}">${escapeHTML(source)}</option>`).join('')}</select></label>
          <label class="form-field full"><span>看到它的语境 / 为什么想添加</span><textarea class="form-input form-textarea" id="manualWordDiscoveryContext" maxlength="1200" placeholder="可以粘贴一句原文，或写下你为什么觉得这个词适合做小红书内容。"></textarea></label>
        </div>
        <div class="published-score-note">添加后会先进入团队选题池；DeepSeek 词卡会随后生成。生成失败不会删除这个词。</div>
        <div class="modal-footer-actions form-actions">
          <button class="btn btn-ghost" data-manual-word-action="close">取消</button>
          <button class="btn btn-primary" data-manual-word-action="submit">添加并生成词卡</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('manualWordKanji')?.focus(), 0);
}

function openManualWordDuplicateModal(kanji, state, options = {}) {
  const cleanKanji = cleanShortText(kanji, 80);
  const copy = {
    favorite: {
      title: '这个词已经在团队选题池中',
      body: '不会重复创建。你可以直接打开详情查看或重新生成 DeepSeek 词卡。'
    },
    candidate: {
      title: '系统中已有这个词',
      body: '可以重新加入选题池，已有词卡和补充信息不会被覆盖。'
    },
    published: {
      title: '这个词已经有发布记录',
      body: '仍然可以加入选题池，但建议确认是否真的要重复做选题。'
    }
  }[state] || {
    title: '发现重复词',
    body: '请确认是否继续处理这个词。'
  };
  const optionsJson = escapeHTML(JSON.stringify({
    discoverySource: options.discoverySource || '',
    discoveryContext: options.discoveryContext || ''
  }));
  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">${escapeHTML(copy.title)}</h2>
        <button class="modal-close" data-manual-word-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="modal-section compact-section">
          <div class="modal-section-title">${escapeHTML(cleanKanji)}</div>
          <div class="modal-section-content">${escapeHTML(copy.body)}</div>
        </div>
        <div class="modal-footer-actions form-actions">
          ${state === 'favorite' ? '' : `<button class="btn btn-primary" data-manual-word-action="confirm-existing" data-kanji="${escapeHTML(cleanKanji)}" data-manual-options="${optionsJson}">加入选题池</button>`}
          <button class="btn btn-ghost" data-manual-word-action="open-detail" data-kanji="${escapeHTML(cleanKanji)}">打开详情</button>
          <button class="btn btn-ghost" data-manual-word-action="close">取消</button>
        </div>
      </div>
    </div>`;
}

async function syncManualWordWorkflow(successMessage = '', requiredKanji = '') {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(requiredKanji, 80));
  const prepareManualWord = () => {
    if (!cleanKanji) return;
    ensureManualWordCandidate(cleanKanji);
    ensureFavoriteWord(cleanKanji);
    saveLocalWorkflow();
  };
  const isSyncedManualWord = () => !cleanKanji || (favorites.includes(cleanKanji) && Boolean(candidatePool[cleanKanji]));

  prepareManualWord();
  let saved = await saveCloudWorkflow(false);
  if (!saved || !isSyncedManualWord()) {
    prepareManualWord();
    saved = await saveCloudWorkflow(false);
  }
  if (!saved || !isSyncedManualWord()) {
    showToast('团队同步失败，这个手动词还没有保存到团队后台，请稍后重试。');
    return false;
  }
  if (successMessage) showToast(successMessage);
  return true;
}

async function addManualWordToFavorites(kanji, options = {}) {
  const cleanKanji = cleanShortText(kanji, 80);
  if (!cleanKanji) return false;
  const entry = ensureManualWordCandidate(cleanKanji, options);
  if (!entry) return false;
  if (!favorites.includes(cleanKanji)) favorites.unshift(cleanKanji);
  delete favoriteStatuses[cleanKanji];
  saveLocalWorkflow();
  updateAllBadges();
  renderFavorites();
  const synced = await syncManualWordWorkflow(`已添加「${cleanKanji}」，正在生成 DeepSeek 词卡`, cleanKanji);
  if (!synced) {
    updateAllBadges();
    renderFavorites();
    return false;
  }
  const card = cleanAiCard(entry.aiCard || {});
  if (card?.cardStatus !== 'ready') {
    void generateDeepSeekWordCards([cleanKanji], { force: false, silent: true }).then(savedCount => {
      saveLocalWorkflow();
      saveCloudWorkflow(false);
      renderFavorites();
      if (savedCount > 0) showToast(`已为「${cleanKanji}」生成 DeepSeek 词卡`);
      else showToast(`「${cleanKanji}」词卡生成失败，可重新生成`);
    });
  }
  return true;
}

async function confirmAddExistingManualWord(kanji, rawOptions = '{}') {
  let options = {};
  try {
    options = JSON.parse(rawOptions || '{}');
  } catch (error) {
    options = {};
  }
  closeModal();
  await addManualWordToFavorites(kanji, options);
}

async function submitManualWord() {
  const kanji = normalizeKanjiSpelling(cleanShortText(document.getElementById('manualWordKanji')?.value, 80));
  const discoverySource = cleanShortText(document.getElementById('manualWordDiscoverySource')?.value, 80);
  const discoveryContext = cleanShortText(document.getElementById('manualWordDiscoveryContext')?.value, 1200);
  if (!kanji) {
    showToast('请先输入日语单词');
    document.getElementById('manualWordKanji')?.focus();
    return;
  }
  const options = { discoverySource, discoveryContext };
  const existingState = getManualWordExistingState(kanji);
  if (existingState) {
    openManualWordDuplicateModal(kanji, existingState, options);
    return;
  }
  closeModal();
  await addManualWordToFavorites(kanji, options);
}

async function toggleFavorite(kanji, forceState = null) {
  return runUiOperation(`favorite:${kanji}`, async () => {
    const previousFavorites = [...favorites];
    const previousStatuses = { ...favoriteStatuses };
    const previousTodaySnapshot = cleanTodaySnapshot(todaySnapshot);
    const previousCandidate = candidatePool[kanji]
      ? cleanCandidatePoolEntry(kanji, candidatePool[kanji])
      : null;
    const transition = transitionFavoriteToggle({
      kanji,
      favorites,
      statuses: favoriteStatuses,
      forceState
    });
    const action = transition.action;
    let entry = null;
    if (action === 'remove') {
      showToast('正在从选题池移除');
    } else if (action === 'add') {
      entry = ensureManualKeepEntry(kanji);
      removeWordFromTodaySnapshot(kanji);
      showToast('正在加入选题池');
    }
    if (!action) return true;
    favorites = transition.favorites;
    favoriteStatuses = transition.statuses;
    saveLocalWorkflow();
    updateAllBadges();
    refreshCurrentGrid();
    const synced = await syncFavoriteChange(kanji, action);
    if (!synced) {
      if (cloudWorkflowFailed) {
        favorites = previousFavorites;
        favoriteStatuses = previousStatuses;
        todaySnapshot = previousTodaySnapshot;
        if (previousCandidate) candidatePool[kanji] = previousCandidate;
        else delete candidatePool[kanji];
        hydrateTodayWordsFromSnapshot();
        saveLocalWorkflow();
        updateAllBadges();
        refreshCurrentGrid();
      }
      return false;
    }
    showToast(action === 'add' ? '已加入选题池' : '已从选题池移除');
    if (action === 'add' && cleanAiCard(entry?.aiCard || {})?.cardStatus !== 'ready') {
      void generateDeepSeekWordCards([kanji], { force: false, silent: true }).then(savedCount => {
        if (savedCount > 0) showToast(`已为「${kanji}」生成 DeepSeek 词卡`);
        saveLocalWorkflow();
        saveCloudWorkflow(false);
        refreshCurrentGrid();
      });
    }
    return true;
  });
}

async function markPending(kanji) {
  if (uiOperationsInFlight.has(`status:${kanji}`)) return;
  const transition = transitionFavoriteStatus({ kanji, status: 'pending', favorites, statuses: favoriteStatuses });
  favorites = transition.favorites;
  favoriteStatuses = transition.statuses;
  ensureManualKeepEntry(kanji);
  removeWordFromTodaySnapshot(kanji);
  activeStatusMenuKanji = null;
  saveLocalWorkflow();
  updateAllBadges();
  refreshCurrentGrid();
  showToast('已标记为待发布');
  await runUiOperation(`status:${kanji}`, () => syncFavoriteStatus(kanji, 'pending'));
}

async function markPublishedStatusOnly(kanji) {
  if (uiOperationsInFlight.has(`status:${kanji}`)) return;
  const transition = transitionFavoriteStatus({ kanji, status: 'published', favorites, statuses: favoriteStatuses });
  favorites = transition.favorites;
  favoriteStatuses = transition.statuses;
  ensureManualKeepEntry(kanji);
  removeWordFromTodaySnapshot(kanji);
  saveLocalWorkflow();
  updateAllBadges();
  refreshCurrentGrid();
  await runUiOperation(`status:${kanji}`, () => syncFavoriteStatus(kanji, 'published'));
}

function renderStatusControl(kanji, options = {}) {
  const status = getFavoriteStatus(kanji);
  const statusLabel = FAVORITE_STATUS_LABELS[status];
  const useFavoritesController = options.context === 'favorites';
  const isOpen = activeStatusMenuKanji === kanji;
  const optionButtons = FAVORITE_STATUS_ORDER.map(option => {
    const selected = option === status;
    const actionAttributes = useFavoritesController
      ? `data-favorites-action="select-status" data-kanji="${escapeHTML(kanji)}" data-status="${escapeHTML(option)}"`
      : `data-workflow-action="select-status" data-kanji="${escapeHTML(kanji)}" data-status="${escapeHTML(option)}"`;
    return `
      <button class="card-status-option status-${option} ${selected ? 'selected' : ''}" ${actionAttributes}>
        <span class="status-dot"></span>
        <span>${FAVORITE_STATUS_LABELS[option]}</span>
        <span class="status-check">${selected ? '✓' : ''}</span>
      </button>`;
  }).join('');
  const toggleAttributes = useFavoritesController
    ? `data-favorites-action="toggle-status" data-kanji="${escapeHTML(kanji)}"`
    : `data-workflow-action="toggle-status" data-kanji="${escapeHTML(kanji)}"`;
  const menuAttributes = useFavoritesController ? '' : 'data-workflow-stop';

  return `
    <div class="card-status-control" data-kanji="${escapeHTML(kanji)}" ${useFavoritesController ? 'data-favorites-stop' : ''}>
      <button class="card-status-btn status-${status}" aria-expanded="${isOpen ? 'true' : 'false'}" ${toggleAttributes} title="选择选题状态">
        <span class="status-dot"></span>${statusLabel}<span class="status-chevron">⌄</span>
      </button>
      <div class="card-status-menu ${isOpen ? 'open' : ''}" ${menuAttributes}>
        ${optionButtons}
      </div>
    </div>`;
}

function toggleStatusMenu(kanji) {
  activeStatusMenuKanji = activeStatusMenuKanji === kanji ? null : kanji;
  activeFeedbackMenuKanji = null;
  refreshStatusControls();
}

function closeStatusMenu() {
  if (!activeStatusMenuKanji) return;
  activeStatusMenuKanji = null;
  refreshStatusControls();
}

function refreshStatusControls() {
  document.querySelectorAll('.card-status-control:not(.card-feedback-control)').forEach(control => {
    const kanji = control.dataset.kanji;
    if (kanji) control.outerHTML = renderStatusControl(kanji, { context: control.closest('#page-favorites') ? 'favorites' : '' });
  });
  document.querySelectorAll('.card-feedback-control').forEach(control => {
    const kanji = control.dataset.kanji;
    if (kanji) control.outerHTML = renderFeedbackControl(kanji, { context: control.dataset.feedbackContext });
  });
}

async function selectFavoriteStatus(kanji, status) {
  if (uiOperationsInFlight.has(`status:${kanji}`)) return;
  const transition = transitionFavoriteStatus({ kanji, status, favorites, statuses: favoriteStatuses });
  const nextStatus = transition.status;
  favorites = transition.favorites;
  favoriteStatuses = transition.statuses;
  activeStatusMenuKanji = null;
  if (['pending', 'published'].includes(nextStatus)) removeWordFromTodaySnapshot(kanji);
  saveLocalWorkflow();
  updateAllBadges();
  refreshCurrentGrid();
  showToast(nextStatus === 'published' ? '已移到已发布页面' : `状态已更新为：${FAVORITE_STATUS_LABELS[nextStatus]}`);
  await runUiOperation(`status:${kanji}`, () => syncFavoriteStatus(kanji, nextStatus));
}

function renderFeedbackControl(kanji, options = {}) {
  const feedback = getFeedbackRecord(kanji);
  const totalCount = Object.values(feedback.reasons || {}).reduce((sum, count) => sum + toInt(count, 0), 0);
  const isOpen = activeFeedbackMenuKanji === kanji;
  const isCodexPreview = options.context === 'codex-preview';
  const feedbackOptions = Object.entries(NEGATIVE_FEEDBACK_TYPES).map(([key, label]) => `
    <button class="card-status-option ${feedback.lastReason === key ? 'selected' : ''}" data-workflow-action="apply-feedback" data-kanji="${escapeHTML(kanji)}" data-reason="${escapeHTML(key)}" data-context="${isCodexPreview ? 'codex-preview' : 'default'}">
      <span>${escapeHTML(label)}</span>
      <span class="status-check">${feedback.reasons[key] ? `×${feedback.reasons[key]}` : ''}</span>
    </button>`).join('');
  return `
    <div class="card-feedback-control card-status-control" data-kanji="${escapeHTML(kanji)}" data-feedback-context="${isCodexPreview ? 'codex-preview' : 'default'}" data-workflow-stop>
      <button class="card-action-btn ghost" aria-expanded="${isOpen ? 'true' : 'false'}" data-workflow-action="toggle-feedback" data-kanji="${escapeHTML(kanji)}">负反馈${totalCount ? ` (${totalCount})` : ''}</button>
      <div class="card-status-menu feedback-menu ${isOpen ? 'open' : ''}" data-workflow-stop>${feedbackOptions}</div>
    </div>`;
}

function toggleFeedbackMenu(kanji) {
  activeFeedbackMenuKanji = activeFeedbackMenuKanji === kanji ? null : kanji;
  activeStatusMenuKanji = null;
  refreshStatusControls();
}

function applyNegativeFeedback(kanji, reason, options = {}) {
  if (!NEGATIVE_FEEDBACK_TYPES[reason]) return;
  const current = getFeedbackRecord(kanji);
  const reasons = { ...current.reasons };
  reasons[reason] = toInt(reasons[reason], 0) + 1;
  const shouldDismissFromToday = Boolean(options.dismissFromToday);
  const wasVisibleToday = shouldDismissFromToday && todayWords.some(word => word.kanji === kanji);
  wordFeedback[kanji] = {
    reasons,
    lastReason: reason,
    updatedAt: nowIso(),
    needsReview: Boolean(current.needsReview || reason === 'inaccurate')
  };
  activeFeedbackMenuKanji = null;
  if (shouldDismissFromToday) {
    setTodayDismissedWords([...getTodayDismissedWords(), kanji]);
    if (candidatePool[kanji]) {
      candidatePool[kanji] = cleanCandidatePoolEntry(kanji, {
        ...candidatePool[kanji],
        ignoredCount: toInt(candidatePool[kanji]?.ignoredCount, 0) + 3,
        updatedAt: nowIso()
      });
    }
    removeWordFromTodaySnapshot(kanji);
  }
  saveLocalWorkflow();
  updateAllBadges();
  if (wasVisibleToday && document.body.dataset.activeTab === 'today') {
    renderToday();
  } else {
    refreshCurrentGrid();
  }
  showToast(options.toastMessage || `已记录反馈：${NEGATIVE_FEEDBACK_TYPES[reason]}`);
  updateAllBadges();
  refreshCurrentGrid();
  saveCloudWorkflow(false);
}

function dismissTodayRecommendation(kanji) {
  applyNegativeFeedback(kanji, 'uninterested', {
    dismissFromToday: true,
    toastMessage: '已取消首页推荐，后续尽量减少类似的推荐'
  });
}

function getWordConfidenceChip(word) {
  return `<span class="confidence-chip confidence-${escapeHTML(word.confidenceLevel || 'medium')}">置信度 · ${escapeHTML(word.confidenceLabel || '中')}</span>`;
}

function getDailyHotReason(word = {}) {
  const entry = word.candidateMeta || {};
  return cleanShortText(
    entry.reason
      || word.recommendationReason
      || entry.reviewReason
      || word.meaning
      || '适合作为日语内容灵感，建议打开详情确认是否符合账号调性。',
    140
  );
}

function getDailyHotDirectionTags(word = {}) {
  const entry = word.candidateMeta || {};
  const tags = [];
  const addTag = label => {
    const cleanLabel = cleanShortText(label, 16);
    if (cleanLabel && !tags.includes(cleanLabel)) tags.push(cleanLabel);
  };
  const tone = entry.emotionTone || getTodayEmotionTone(word);
  if (tone === 'aesthetic') addTag('审美氛围');
  if (tone === 'lifestyle') addTag('生活方式');
  if (tone === 'fandom') addTag('追星兴趣');
  if (tone === 'negative') addTag('情绪表达');
  if (entry.candidateType === '审美氛围词' || entry.candidateType === '美妆穿搭词') addTag('审美氛围');
  if (entry.candidateType === '生活方式词') addTag('生活方式');
  if (entry.candidateType === '追星兴趣词' || entry.candidateType === '圈层词') addTag('追星兴趣');
  if (entry.candidateType === '网络口语词' || entry.candidateType === '新鲜梗词') addTag('网络口语');
  if (entry.displayBucket === 'review' || entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown') addTag('需查证');
  if (!tags.length) addTag(word.category || entry.category || '日语表达');
  return tags.slice(0, 3);
}

function getDailyHotTeamState(word = {}) {
  const kanji = word.kanji || '';
  const status = getFavoriteStatus(kanji);
  const isPublished = status === 'published' || cleanPublishedRecords(publishedRecords).some(record => record.word === kanji);
  const isPending = status === 'pending';
  const isFav = favorites.includes(kanji);
  const feedback = getFeedbackRecord(kanji);
  const isSkipped = getTodayDismissedWords().includes(kanji) || feedback.lastReason === 'uninterested';
  const entry = word.candidateMeta || {};
  const needsReview = word.reviewState === 'review' || entry.displayBucket === 'review' || entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown';
  if (isPublished) return { key: 'published', label: '已发布', note: '已发布' };
  if (isPending) return { key: 'pending', label: '待发布', note: '待发布' };
  if (isFav) return { key: 'favorite', label: '已收藏', note: '已进入团队选题池' };
  if (isSkipped) return { key: 'skipped', label: '已跳过', note: '已跳过' };
  if (needsReview) return { key: 'review', label: '需查证', note: '需查证' };
  return { key: 'idle', label: '未处理', note: '未处理' };
}

function getRecommendationGrade(word = {}) {
  const entry = word.candidateMeta || {};
  const auditedGrade = word.recommendationAudit?.recommendationLevel || entry.recommendationAudit?.recommendationLevel;
  if (['S', 'A', 'B', 'C'].includes(auditedGrade)) return auditedGrade;
  const score = Number(word.finalScore || entry.lastScore || entry.xhsFitScore || word.dataScore || word.heat || 0);
  const riskLevel = word.riskLevel || entry.riskLevel || '';
  const reviewState = word.reviewState || entry.lastReviewState || '';
  const confidenceLevel = word.confidenceLevel || entry.confidenceLevel || '';
  if (riskLevel === 'high' || reviewState === 'review' || confidenceLevel === 'review') return 'B';
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  return 'C';
}

function getRiskStateLabel(word = {}) {
  const entry = word.candidateMeta || {};
  const riskLevel = word.riskLevel || entry.riskLevel || '';
  const reviewState = word.reviewState || entry.lastReviewState || '';
  const confidenceLevel = word.confidenceLevel || entry.confidenceLevel || '';
  const evidenceType = word.evidenceType || entry.evidenceType || '';
  if (entry.displayBucket === 'blocked' || entry.suggestedAction === '不建议') return '不建议直接发';
  if (riskLevel === 'high') return '高风险';
  if (reviewState === 'review' || confidenceLevel === 'review' || evidenceType === 'unknown') return '需查证';
  if (riskLevel === 'medium') return '中风险';
  return '低风险';
}

function getRiskStateKey(label = '') {
  if (label === '低风险') return 'low';
  if (label === '中风险') return 'medium';
  if (label === '需查证') return 'review';
  if (label === '高风险') return 'high';
  if (label === '不建议直接发') return 'blocked';
  return 'unknown';
}

function dismissDailyHotRecommendation(kanji) {
  if (isViewingTodayDailyHot()) {
    dismissTodayRecommendation(kanji);
    return;
  }
  applyNegativeFeedback(kanji, 'uninterested', {
    toastMessage: '已记录团队跳过'
  });
}

function renderTodayCard(word) {
  const teamState = getDailyHotTeamState(word);
  const isFav = teamState.key === 'favorite' || teamState.key === 'pending' || teamState.key === 'published';
  const isSkipped = teamState.key === 'skipped';
  const reason = getDailyHotReason(word);
  const directionTags = getDailyHotDirectionTags(word);
  const recommendationGrade = getRecommendationGrade(word);
  const riskStateLabel = getRiskStateLabel(word);
  const riskStateKey = getRiskStateKey(riskStateLabel);
  const entry = cleanCandidatePoolEntry(word.kanji, candidatePool[word.kanji] || word.candidateMeta || {}) || {};
  const aiCardInFlight = aiCardAutoInFlight.has(word.kanji);
  const rawAiCard = cleanAiCard(entry.aiCard || word.aiCard || {});
  const wordCardView = buildWordCardViewModel({
    word,
    entry,
    aiCard: rawAiCard,
    inFlight: aiCardInFlight,
    stalePending: isAiCardStalePending(rawAiCard, entry)
  });
  const aiCard = wordCardView.card;
  const hasReferenceImage = wordCardView.hasReferenceImage;
  const cardImageUrl = wordCardView.referenceImageUrl || word.imageUrl;
  const aiCardStatus = wordCardView.status;
  const aiCardActionState = getTodayAiCardActionState({ aiCard, entry, inFlight: aiCardInFlight });
  const aiCardActionLabel = aiCardActionState.label;
  const aiCardActionDisabled = aiCardActionState.disabled;
  const fallbackSvg = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 520 390%22><rect fill=%22%23fdeef0%22 width=%22520%22 height=%22390%22/><text x=%22260%22 y=%22195%22 text-anchor=%22middle%22 font-size=%2272%22 fill=%22%23f47a9a%22>${encodeURIComponent(word.kanji)}</text></svg>`;
  const safeId = escapeHTML(word.id || word.kanji);
  const safeKanjiAction = escapeHTML(word.kanji);
  return `
    <div class="word-card recommendation-card daily-hot-card${hasReferenceImage ? ' daily-hot-reference-card' : ''}" role="button" tabindex="0" aria-label="查看 ${safeKanjiAction} 词卡" data-daily-hot-action="open-detail" data-word-id="${safeId}">
      <div class="card-image-wrapper">
        <img class="card-image" src="${escapeHTML(cardImageUrl)}" alt="${escapeHTML(word.kanji)}" loading="lazy" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackSvg)}">
        ${hasReferenceImage ? '' : `<div class="card-image-overlay"></div>
        <div class="card-word-overlay">
          <div class="card-kanji">${escapeHTML(word.kanji)}</div>
          <div class="card-reading">${escapeHTML(word.reading)}</div>
        </div>
        <div class="card-top-actions" data-daily-hot-stop>
          <button class="card-fav-btn ${isFav ? 'favorited' : ''}" data-daily-hot-action="toggle-favorite" data-kanji="${safeKanjiAction}">
            <img class="fav-icon" src="assets/illustrations/dorayaki.png" alt="收藏">
          </button>
          <button class="card-dismiss-btn" title="不感兴趣" aria-label="不感兴趣" data-daily-hot-action="dismiss" data-kanji="${safeKanjiAction}">×</button>
        </div>`}
      </div>
      <div class="card-body">
        ${hasReferenceImage ? `<div class="daily-hot-reference-header">
          <div class="daily-hot-reference-title">
            <div class="daily-hot-reference-word">${escapeHTML(word.kanji)}</div>
            <div class="daily-hot-reference-reading">${escapeHTML(word.reading)}</div>
          </div>
          <div class="daily-hot-reference-controls" data-daily-hot-stop>
            <button class="card-fav-btn ${isFav ? 'favorited' : ''}" title="收藏" aria-label="收藏" data-daily-hot-action="toggle-favorite" data-kanji="${safeKanjiAction}">
              <img class="fav-icon" src="assets/illustrations/dorayaki.png" alt="收藏">
            </button>
            <button class="card-dismiss-btn" title="不感兴趣" aria-label="不感兴趣" data-daily-hot-action="dismiss" data-kanji="${safeKanjiAction}">×</button>
          </div>
        </div>` : ''}
        <div class="card-title-row">
          <div class="card-meaning">${escapeHTML(word.meaning)}</div>
        </div>
        <div class="daily-hot-reason line-2">${escapeHTML(reason)}</div>
        <div class="daily-hot-tags">
          ${directionTags.map(tag => `<span class="daily-hot-tag">${escapeHTML(tag)}</span>`).join('')}
          <span class="daily-hot-tag state-tag-${escapeHTML(teamState.key)}">${escapeHTML(teamState.note)}</span>
          <span class="daily-hot-tag recommendation-grade-chip grade-${escapeHTML(recommendationGrade.toLowerCase())}">推荐等级 ${escapeHTML(recommendationGrade)}</span>
          <span class="daily-hot-tag risk-state-chip risk-${escapeHTML(riskStateKey)}">${escapeHTML(riskStateLabel)}</span>
          <span class="daily-hot-tag ai-card-state-${escapeHTML(aiCardStatus)}">${escapeHTML(wordCardView.statusLabel)}</span>
        </div>
        <div class="daily-hot-actions" data-daily-hot-stop>
          <button class="card-action-btn ghost" ${aiCardActionDisabled ? 'disabled' : ''} data-daily-hot-action="generate-card" data-kanji="${safeKanjiAction}">${escapeHTML(aiCardActionLabel)}</button>
        </div>
      </div>
    </div>`;
}

function getCodexDraftAuditItem(item = {}) {
  return safeArray(codexTomorrowDraft?.validation?.recommendationAudit?.items)
    .find(auditItem => auditItem?.kanji === item.kanji) || {};
}

function getCodexDraftPreviewItem(kanji) {
  const cleanKanji = normalizeKanjiSpelling(cleanShortText(kanji, 80));
  return safeArray(codexTomorrowDraft?.items).find(item => item?.kanji === cleanKanji) || null;
}

function ensureCodexDraftPreviewCandidate(kanji) {
  const item = getCodexDraftPreviewItem(kanji);
  if (!item) return null;
  const existing = candidatePool[item.kanji]
    ? (cleanCandidatePoolEntry(item.kanji, candidatePool[item.kanji]) || {})
    : {};
  const existingCard = cleanAiCard(existing.aiCard || {});
  const previewCard = cleanAiCard(item.aiCard || {});
  const audit = getCodexDraftAuditItem(item);
  const gradeScore = { S: 92, A: 84, B: 74, C: 64 }[audit.recommendationLevel] || 80;
  candidatePool[item.kanji] = cleanCandidatePoolEntry(item.kanji, {
    ...item,
    ...existing,
    kanji: item.kanji,
    kana: existing.kana || item.kana || item.reading || '',
    romaji: existing.romaji || item.romaji || '',
    meaning: existing.meaning || item.meaning || '',
    category: existing.category || item.category || '日语表达',
    candidateType: existing.candidateType || item.candidateType || '生活方式词',
    xhsFitScore: existing.xhsFitScore || gradeScore,
    riskLevel: existing.riskLevel || item.riskLevel || 'low',
    confidenceLevel: existing.confidenceLevel || item.confidenceLevel || 'high',
    evidenceType: existing.evidenceType || item.evidenceType || 'common_usage',
    displayBucket: existing.displayBucket || 'today',
    reason: existing.reason || item.reason || previewCard.summary,
    sourceType: existing.sourceType || 'codex_generated',
    sourceTags: getUniqueWords([...(existing.sourceTags || []), 'Codex生成']),
    aiCard: existingCard?.cardStatus === 'ready' ? existingCard : previewCard,
    recommendationAudit: { ...(existing.recommendationAudit || {}), ...audit, fromCodex: true },
    importedAt: existing.importedAt || nowIso(),
    updatedAt: nowIso()
  });
  return item;
}

async function toggleCodexDraftFavorite(kanji) {
  const item = ensureCodexDraftPreviewCandidate(kanji);
  if (!item) return false;
  return toggleFavorite(item.kanji);
}

function applyCodexDraftFeedback(kanji, reason = 'uninterested') {
  const item = ensureCodexDraftPreviewCandidate(kanji);
  if (!item) return;
  closeModal();
  applyNegativeFeedback(item.kanji, reason, {
    toastMessage: '已记录负反馈；明日草稿内容保持不变'
  });
}

function getDailyQualityCategoryLabel(category = '') {
  return {
    strong_expression: '强表达',
    xhs_expression: '内容表达',
    basic_greeting: '基础寒暄',
    textbook_polite: '教材礼貌',
    generic_basic: '泛基础词',
    beauty_product: '品类词',
    beauty_expression: '美妆表达',
    general: '日常表达'
  }[category] || '日常表达';
}

function renderCodexDraftPreviewCard(item, index) {
  const wordCardView = buildWordCardViewModel({ word: item, entry: item, aiCard: item.aiCard || {} });
  const imageUrl = wordCardView.referenceImageUrl;
  const audit = getCodexDraftAuditItem(item);
  const recommendationGrade = audit.recommendationLevel || 'A';
  const categoryLabel = getDailyQualityCategoryLabel(audit.qualityCategory);
  const teamState = getDailyHotTeamState({ kanji: item.kanji, candidateMeta: item });
  const isFav = ['favorite', 'pending', 'published'].includes(teamState.key);
  const riskStateLabel = getRiskStateLabel({ ...item, candidateMeta: item });
  const riskStateKey = getRiskStateKey(riskStateLabel);
  const safeKanjiAction = escapeHTML(item.kanji);
  const fallbackSvg = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 900 1200%22><rect fill=%22%23fffdf9%22 width=%22900%22 height=%221200%22/><text x=%22450%22 y=%22220%22 text-anchor=%22middle%22 font-size=%22110%22 font-weight=%22700%22 fill=%22%23222222%22>${encodeURIComponent(item.kanji)}</text></svg>`;
  return `
    <article class="word-card codex-preview-card" role="button" tabindex="0" aria-label="预览 ${escapeHTML(item.kanji)} 词卡" data-daily-hot-action="open-codex-preview" data-index="${index}">
      <div class="codex-preview-image-wrapper">
        <img class="codex-preview-image" src="${escapeHTML(imageUrl || fallbackSvg)}" alt="${escapeHTML(item.kanji)} 参考插画" loading="lazy" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackSvg)}">
        <span class="codex-preview-readonly-badge">草稿内容只读</span>
        <div class="card-top-actions" data-daily-hot-stop>
          <button class="card-fav-btn ${isFav ? 'favorited' : ''}" title="${isFav ? '取消收藏' : '收藏'}" aria-label="${isFav ? '取消收藏' : '收藏'}" data-daily-hot-action="toggle-codex-favorite" data-kanji="${safeKanjiAction}">
            <img class="fav-icon" src="assets/illustrations/dorayaki.png" alt="收藏">
          </button>
          <button class="card-dismiss-btn" title="不感兴趣（记录负反馈）" aria-label="不感兴趣" data-daily-hot-action="codex-feedback" data-kanji="${safeKanjiAction}" data-reason="uninterested">×</button>
        </div>
      </div>
      <div class="card-body codex-preview-card-body">
        <div class="codex-preview-word-row">
          <div>
            <div class="codex-preview-word">${escapeHTML(item.kanji)}</div>
            <div class="codex-preview-reading">${escapeHTML(item.kana || item.reading || '')}</div>
          </div>
          <span class="daily-hot-tag recommendation-grade-chip grade-${escapeHTML(recommendationGrade.toLowerCase())}">${escapeHTML(recommendationGrade)}</span>
        </div>
        <div class="card-meaning">${escapeHTML(item.meaning || '—')}</div>
        <div class="daily-hot-reason line-2">${escapeHTML(wordCardView.summary || wordCardView.explanation || wordCardView.statusLabel)}</div>
        <div class="daily-hot-tags">
          <span class="daily-hot-tag">${escapeHTML(categoryLabel)}</span>
          <span class="daily-hot-tag state-tag-${escapeHTML(teamState.key)}">${escapeHTML(teamState.note)}</span>
          <span class="daily-hot-tag risk-state-chip risk-${escapeHTML(riskStateKey)}">${escapeHTML(riskStateLabel)}</span>
          <span class="daily-hot-tag codex-source-chip">Codex 草稿</span>
        </div>
      </div>
    </article>`;
}

function openCodexDraftPreview(index) {
  const item = safeArray(codexTomorrowDraft?.items)[index];
  if (!item) return;
  const wordCardView = buildWordCardViewModel({ word: item, entry: item, aiCard: item.aiCard || {} });
  const aiCard = wordCardView.hasFormalCard ? wordCardView.card : {};
  const audit = getCodexDraftAuditItem(item);
  const recommendationGrade = audit.recommendationLevel || 'A';
  const categoryLabel = getDailyQualityCategoryLabel(audit.qualityCategory);
  const qualitySummary = codexTomorrowDraft?.validation?.qualitySummary || {};
  const imageUrl = wordCardView.referenceImageUrl;
  const fallbackSvg = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 900 1200%22><rect fill=%22%23fffdf9%22 width=%22900%22 height=%221200%22/><text x=%22450%22 y=%22220%22 text-anchor=%22middle%22 font-size=%22110%22 font-weight=%22700%22 fill=%22%23222222%22>${encodeURIComponent(item.kanji)}</text></svg>`;
  const examples = wordCardView.examples;
  const suggestedTitles = wordCardView.suggestedTitles;
  const contentAngles = wordCardView.contentAngles;
  const usageScenes = wordCardView.usageScenes;
  const similarWords = wordCardView.similarWords;
  const interactionPrompts = wordCardView.interactionPrompts;
  const coverSuggestion = wordCardView.coverSuggestion;
  const hasCoverSuggestion = wordCardView.hasCoverSuggestion;
  const teamState = getDailyHotTeamState({ kanji: item.kanji, candidateMeta: item });
  const isFav = ['favorite', 'pending', 'published'].includes(teamState.key);
  const riskStateLabel = getRiskStateLabel({ ...item, candidateMeta: item });
  const riskStateKey = getRiskStateKey(riskStateLabel);
  const safeKanjiAction = escapeHTML(item.kanji);
  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell codex-preview-modal-shell">
      <div class="codex-preview-modal-layout">
        <div class="codex-preview-modal-art">
          <img src="${escapeHTML(imageUrl || fallbackSvg)}" alt="${escapeHTML(item.kanji)} 参考插画" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackSvg)}">
        </div>
        <div class="codex-preview-modal-content">
          <div class="codex-preview-modal-header">
            <div>
              <div class="codex-preview-modal-kicker">${escapeHTML(codexTomorrowDraft.targetDateKey || '')} · 明日草稿内容只读</div>
              <h2 class="codex-preview-modal-word">${escapeHTML(item.kanji)}</h2>
              <div class="codex-preview-modal-reading">${escapeHTML(item.kana || item.reading || '')}${item.romaji ? ` · ${escapeHTML(item.romaji)}` : ''}</div>
            </div>
            <button type="button" class="codex-preview-modal-close" data-modal-action="close" aria-label="关闭">×</button>
          </div>
          <div class="daily-hot-tags codex-preview-modal-tags">
            <span class="daily-hot-tag recommendation-grade-chip grade-${escapeHTML(recommendationGrade.toLowerCase())}">推荐等级 ${escapeHTML(recommendationGrade)}</span>
            <span class="daily-hot-tag">${escapeHTML(categoryLabel)}</span>
            <span class="daily-hot-tag state-tag-${escapeHTML(teamState.key)}">${escapeHTML(teamState.note)}</span>
            <span class="daily-hot-tag risk-state-chip risk-${escapeHTML(riskStateKey)}">${escapeHTML(riskStateLabel)}</span>
            ${Number.isFinite(Number(qualitySummary.estimatedHumanQualityScore)) ? `<span class="daily-hot-tag">整组人工估分 ${escapeHTML(qualitySummary.estimatedHumanQualityScore)}</span>` : ''}
          </div>
          <div class="codex-preview-modal-scroll">
            <section class="codex-preview-section">
              <h3>中文意思</h3>
              <div class="modal-meaning-main">${escapeHTML(item.meaning || '—')}</div>
              ${aiCard.summary ? `<p>${escapeHTML(aiCard.summary)}</p>` : ''}
              ${aiCard.explanation ? `<p>${renderMultiline(aiCard.explanation)}</p>` : ''}
            </section>
            <section class="codex-preview-section">
              <h3>小红书内容建议</h3>
              <div class="usage-list">
                ${suggestedTitles.length ? suggestedTitles.map(title => `<div class="usage-item"><div class="usage-head"><span class="usage-word">推荐标题</span></div><div class="usage-meaning">${escapeHTML(title)}</div></div>`).join('') : ''}
                ${contentAngles.length ? renderLabeledDetailItem('内容角度', contentAngles.join(' / ')) : ''}
                ${aiCard.targetAudience ? renderLabeledDetailItem('目标受众', aiCard.targetAudience) : ''}
                ${aiCard.referenceDirection ? renderLabeledDetailItem('适合方向', aiCard.referenceDirection) : ''}
                ${hasCoverSuggestion ? `<div class="usage-item">
                  <div class="usage-head"><span class="usage-word">封面建议</span></div>
                  ${coverSuggestion.coverText ? `<div class="usage-meaning">封面字：${escapeHTML(coverSuggestion.coverText)}</div>` : ''}
                  ${coverSuggestion.mainVisual ? `<div class="usage-note">主视觉：${escapeHTML(coverSuggestion.mainVisual)}</div>` : ''}
                  ${coverSuggestion.style ? `<div class="usage-note">风格：${escapeHTML(coverSuggestion.style)}</div>` : ''}
                  ${coverSuggestion.avoid ? `<div class="usage-note">避免：${escapeHTML(coverSuggestion.avoid)}</div>` : ''}
                </div>` : ''}
              </div>
              ${interactionPrompts.length ? `<div class="interaction-list detail-subblock">${interactionPrompts.map(prompt => `<div class="interaction-box"><div class="interaction-question">${renderMultiline(prompt)}</div></div>`).join('')}</div>` : ''}
            </section>
            ${usageScenes.length ? `<section class="codex-preview-section"><h3>使用场景</h3><div class="daily-hot-tags">${usageScenes.map(scene => `<span class="daily-hot-tag">${escapeHTML(scene)}</span>`).join('')}</div></section>` : ''}
            ${examples.length ? `<section class="codex-preview-section"><h3>例句</h3>${examples.map(example => `<div class="example-item"><div class="example-jp">${escapeHTML(example.jp)}</div>${example.kana ? `<div class="example-romaji">${escapeHTML(example.kana)}</div>` : ''}${example.romaji ? `<div class="example-romaji">${escapeHTML(example.romaji)}</div>` : ''}<div class="example-cn">${escapeHTML(example.cn)}</div>${example.note || example.source ? `<div class="example-source">${escapeHTML(example.note || example.source)}</div>` : ''}</div>`).join('')}</section>` : ''}
            ${similarWords.length ? `<section class="codex-preview-section"><h3>相近词</h3><div class="usage-list">${similarWords.map(similar => `<div class="usage-item"><div class="usage-head"><span class="usage-word">${escapeHTML(similar.word || similar.kanji || '')}</span><span class="usage-reading">${escapeHTML(similar.romaji || '')}</span></div><div class="usage-meaning">${escapeHTML(similar.meaning || '')}</div>${similar.difference ? `<div class="usage-note">${escapeHTML(similar.difference)}</div>` : ''}</div>`).join('')}</div></section>` : ''}
            ${aiCard.wrongUsage || aiCard.riskWarning ? `<section class="codex-preview-section"><h3>风险与使用提醒</h3>${aiCard.riskWarning ? `<div class="wrong-usage-box">${escapeHTML(aiCard.riskWarning)}</div>` : ''}${aiCard.wrongUsage ? `<div class="wrong-usage-box codex-preview-warning-gap">${escapeHTML(aiCard.wrongUsage)}</div>` : ''}</section>` : ''}
            <section class="codex-preview-section">
              <h3>团队操作</h3>
              <div class="modal-footer-actions codex-preview-modal-actions">
                <button class="btn ${isFav ? 'btn-ghost' : 'btn-primary'}" data-modal-action="toggle-codex-favorite" data-kanji="${safeKanjiAction}">${isFav ? '取消收藏' : '加入收藏 / 选题池'}</button>
                ${renderFeedbackControl(item.kanji, { context: 'codex-preview' })}
              </div>
              <p class="modal-section-subtle">收藏和负反馈会进入现有团队工作流；明日草稿内容本身保持只读。</p>
            </section>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function renderFavoriteCard(word) {
  const fallbackSvg = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 520 390%22><rect fill=%22%23fdeef0%22 width=%22520%22 height=%22390%22/><text x=%22260%22 y=%22195%22 text-anchor=%22middle%22 font-size=%2272%22 fill=%22%23f47a9a%22>${encodeURIComponent(word.kanji)}</text></svg>`;
  const isFav = favorites.includes(word.kanji);
  const entry = cleanCandidatePoolEntry(word.kanji, candidatePool[word.kanji] || word.candidateMeta || {}) || {};
  const wordCardView = buildWordCardViewModel({ word, entry, aiCard: entry.aiCard || word.aiCard || {} });
  const aiCardText = wordCardView.hasFormalCard
    ? (word.suggestedTitle || wordCardView.listTitle)
    : wordCardView.statusLabel;
  return `
    <div class="word-card workflow-card" data-favorites-action="open-detail" data-word-id="${escapeHTML(word.id || word.kanji)}">
      <div class="card-image-wrapper">
        <img class="card-image" src="${escapeHTML(word.imageUrl)}" alt="${escapeHTML(word.kanji)}" loading="lazy" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackSvg)}">
        <div class="card-image-overlay"></div>
        <div class="card-word-overlay">
          <div class="card-kanji">${escapeHTML(word.kanji)}</div>
          <div class="card-reading">${escapeHTML(word.reading)}</div>
        </div>
        <div class="card-top-actions" data-favorites-stop>
          <button class="card-fav-btn ${isFav ? 'favorited' : ''}" title="取消收藏" aria-label="取消收藏" data-favorites-action="toggle-favorite" data-kanji="${escapeHTML(word.kanji)}" data-force-state="false">
            <img class="fav-icon" src="assets/illustrations/dorayaki.png" alt="取消收藏">
          </button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title-row">
          <div class="card-meaning">${escapeHTML(word.meaning)}</div>
        </div>
        <div class="insight-block compact">
          <div class="insight-label">DeepSeek 词卡</div>
          <div class="insight-text line-2">${escapeHTML(aiCardText || 'DeepSeek 词卡未生成')}</div>
        </div>
        <div class="card-meta workflow-meta">
          ${renderFavoriteSourceChip(entry)}
          ${renderStatusControl(word.kanji, { context: 'favorites' })}
        </div>
      </div>
    </div>`;
}

function renderTodayGrid(words, options = {}) {
  const grid = document.getElementById('todayGrid');
  const mode = options.mode || 'today';
  if (mode === 'codex-preview') {
    if (codexTomorrowDraftPromise && !codexTomorrowDraft) {
      grid.innerHTML = '<div class="empty-state inline-empty"><div class="empty-title">正在读取明日草稿</div><div class="empty-desc">词卡和参考插画正在从只读接口加载。</div></div>';
      return;
    }
    if (words.length) {
      grid.innerHTML = words.map(renderCodexDraftPreviewCard).join('');
      return;
    }
    const missing = codexTomorrowDraft?.status === 'missing' || codexTomorrowDraftStatus?.status === 'missing';
    const errorMessage = codexTomorrowDraftError;
    grid.innerHTML = `<div class="empty-state inline-empty"><div class="empty-title">${missing ? '明日草稿尚未提交' : '暂时无法读取明日草稿'}</div><div class="empty-desc">${missing ? 'Codex 定时任务提交后会自动出现在这里。' : escapeHTML(errorMessage || '可以点击刷新重新读取，不会触发生成或写入。')}</div></div>`;
    return;
  }
  if (words.length) {
    grid.innerHTML = words.map(renderTodayCard).join('');
    return;
  }
  if (mode === 'history') {
    grid.innerHTML = '<div class="empty-state inline-empty"><div class="empty-title">这一天暂无历史推荐</div><div class="empty-desc">可以从右上角切换到别的日期，或等待云端历史归档同步完成。</div></div>';
    return;
  }
  const state = getRenderableAutoDailyRefreshState();
  if (state.dateKey === todayKey() && state.status === 'failed') {
    grid.innerHTML = `<div class="empty-state inline-empty"><div class="empty-title">今天暂无固定推荐</div><div class="empty-desc">${escapeHTML(state.error || '每日任务生成后会自动显示；需要立即使用时，可从“管理今日推荐”手动生成。')}</div><button class="btn btn-primary" data-today-action data-daily-hot-action="generate-today">立即生成今日 20 个</button></div>`;
    return;
  }
  grid.innerHTML = '<div class="empty-state inline-empty"><div class="empty-title">今天暂无固定推荐</div><div class="empty-desc">每日任务生成后会自动显示；需要立即使用时，可从“管理今日推荐”手动生成。</div><button class="btn btn-primary" data-today-action data-daily-hot-action="generate-today">立即生成今日 20 个</button></div>';
}

function renderHistoryGrid(words) {
  const grid = document.getElementById('historyGrid');
  if (!grid) return;
  grid.innerHTML = words.length ? words.map(renderTodayCard).join('') : '<div class="empty-state inline-empty"><div class="empty-title">这一天暂无历史推荐</div><div class="empty-desc">可以切换到别的日期看看，或者等云端榜单同步完成。</div></div>';
}

function renderFavoritesGrid(words) {
  const grid = document.getElementById('favGrid');
  grid.innerHTML = words.length ? words.map(renderFavoriteCard).join('') : '';
}

function getAutoRefreshSummary(record) {
  return getPublishedAutoRefreshSummary(cleanAutoRefreshState(record?.autoRefresh), {
    statusLabels: AUTO_REFRESH_STATUS_LABELS,
    sourceLabels: AUTO_REFRESH_SOURCE_LABELS
  });
}

function renderPublishedCard(item) {
  const record = item.record;
  const word = item.word || getDisplayWordByKanji(record.word) || { kanji: record.word, reading: '', meaning: '' };
  const latestStats = cleanPublishedStats(record.latestStats);
  const rating = getRecordRating(record);
  const refreshMeta = getAutoRefreshSummary(record);
  const safeRecordId = escapeHTML(record.id);
  const safeKanji = escapeHTML(word.kanji || record.word || '');
  const openAction = item.type === 'placeholder' ? 'edit-record' : 'open-detail';
  return `
    <div class="published-card" data-published-action="${openAction}" data-record-id="${item.type === 'placeholder' ? '' : safeRecordId}" data-preset-kanji="${item.type === 'placeholder' ? safeKanji : ''}">
      <div class="published-head">
        <div>
          <div class="published-word">${escapeHTML(word.kanji || '未关联词')}</div>
          <div class="published-title line-2">${escapeHTML(record.title || '还没填写笔记标题')}</div>
          <div class="published-sub">${escapeHTML(word.meaning || record.word || '')}</div>
        </div>
        <div class="published-rating rating-${escapeHTML(rating.level)}">${escapeHTML(rating.level)}</div>
      </div>
      <div class="published-meta">${record.link ? `<a class="published-link" href="${escapeHTML(record.link)}" target="_blank" rel="noopener" data-published-stop>查看链接 ↗</a>` : '<span class="published-link muted">待补充链接</span>'}</div>
      <div class="published-mini-stats">
        <span class="published-mini-chip">👍 ${latestStats.likes}</span>
        <span class="published-mini-chip">⭐ ${latestStats.favorites}</span>
        <span class="published-mini-chip">💬 ${latestStats.comments}</span>
        <span class="published-mini-chip strong">表现分 ${rating.performanceScore}</span>
      </div>
      <div class="tag-list">
        ${safeArray(record.performanceReason).map(item => `<span class="reason-chip">${escapeHTML(PERFORMANCE_REASON_LABELS[item])}</span>`).join('') || '<span class="reason-chip">待观察</span>'}
      </div>
      <div class="published-info-grid">
        <div><span>发布时间</span><strong>${escapeHTML(record.publishedAt || '待填写')}</strong></div>
        <div><span>内容类型</span><strong>${escapeHTML(record.contentType || '图文')}</strong></div>
        <div><span>点赞</span><strong>${latestStats.likes}</strong></div>
        <div><span>收藏</span><strong>${latestStats.favorites}</strong></div>
        <div><span>评论</span><strong>${latestStats.comments}</strong></div>
        <div><span>分享</span><strong>${latestStats.shares}</strong></div>
        <div><span>曝光/浏览</span><strong>${latestStats.views || '—'}</strong></div>
        <div><span>更新时间</span><strong>${escapeHTML(record.updatedAt ? record.updatedAt.slice(0, 16).replace('T', ' ') : '待更新')}</strong></div>
      </div>
      <div class="published-refresh-note">
        <strong>${escapeHTML(refreshMeta.label)}</strong>
        <span>${escapeHTML(refreshMeta.message)}</span>
      </div>
      <div class="published-reason line-2">${escapeHTML(record.performanceNote || rating.reason)}</div>
      <div class="published-actions" data-published-stop>
        ${item.type === 'placeholder' ? '' : `<button class="card-action-btn ghost" data-published-action="refresh" data-record-id="${safeRecordId}">尝试更新</button>`}
        <button class="card-action-btn ghost" data-published-action="edit-record" data-record-id="${item.type === 'placeholder' ? '' : safeRecordId}" data-preset-kanji="${item.type === 'placeholder' ? safeKanji : ''}">编辑记录</button>
      </div>
    </div>`;
}

function renderPublished() {
  if (!isWorkflowScopeLoaded('published')) {
    renderWorkflowScopeState('published');
    return;
  }
  const pageModel = buildPublishedPageModel(getPublishedDisplayItems());
  const items = pageModel.items;
  const grid = document.getElementById('publishedGrid');
  const empty = document.getElementById('publishedEmpty');
  const count = document.getElementById('publishedCount');
  if (!items.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    count.textContent = pageModel.countText;
  } else {
    empty.style.display = 'none';
    grid.innerHTML = items.map(renderPublishedCard).join('');
    count.textContent = pageModel.countText;
  }
  updatePublishedBadge();
}

function buildHistoryArchivedWord(kanji, dateKeyValue, index) {
  const archivedSnapshot = cleanHistorySnapshot(historySnapshots[dateKeyValue] || {}, dateKeyValue);
  const auditItem = safeArray(archivedSnapshot.recommendationAudit?.items).find(item => item.kanji === kanji) || null;
  const displayWord = getDisplayWordByKanji(kanji) || {
    kanji,
    reading: kanji,
    kana: kanji,
    romaji: '',
    meaning: '该词已不在词库，但曾出现在当天今日候选中。',
    category: '历史归档',
    source: '每日热门归档',
    popularity: 0,
    heat: 0,
    explanation: '该词已不在当前词库或候选池，但保留在历史归档中，用于还原当天真实展示列表。'
  };
  const candidateMeta = candidatePool[kanji] || null;
  const enriched = enrichWords([{
    ...displayWord,
    id: `history_snapshot_${dateKeyValue}_${index}`,
    imageUrl: getImageUrl(kanji, index)
  }], `history_snapshot_${dateKeyValue}`)[0];
  const recommended = buildRecommendedWord(enriched, 'history', {
    ...(candidateMeta || {}),
    recommendationAudit: { ...(candidateMeta?.recommendationAudit || {}), ...(auditItem || {}) }
  });
  const audit = auditItem || recommended.candidateMeta?.recommendationAudit || {};
  return {
    ...recommended,
    recommendationAudit: audit,
    candidateMeta: {
      ...(recommended.candidateMeta || {}),
      recommendationAudit: audit
    }
  };
}

function getHistorySourceLabel(dateKeyValue) {
  const snapshot = cleanHistorySnapshot(historySnapshots[dateKeyValue] || {}, dateKeyValue);
  return snapshot.words.length ? '来自每日热门归档' : '来自 DeepSeek 审核词历史数据';
}

function getCurrentHistoryWords() {
  refreshHistoryDates();
  const fallbackDateKey = rankingHistoryDates[0] || '';
  const selectedDateKey = rankingHistoryDates.includes(currentHistoryDateKey) ? currentHistoryDateKey : fallbackDateKey;
  currentHistoryDateKey = selectedDateKey;
  const archivedSnapshot = cleanHistorySnapshot(historySnapshots[selectedDateKey] || {}, selectedDateKey);
  if (archivedSnapshot.words.length) {
    return archivedSnapshot.words
      .map((kanji, index) => buildHistoryArchivedWord(kanji, selectedDateKey, index))
      .filter(Boolean);
  }
  return safeArray(rankingHistoryWords[selectedDateKey]).filter(word => canUseHistoricalSeedWord(word.kanji)).map((word, index) => {
    const enriched = enrichWords([{ ...word }], `history_${selectedDateKey}_${index}`)[0];
    return buildRecommendedWord(enriched, 'history');
  });
}

function closeDailyManageMenu() {
  document.querySelector('.action-menu')?.classList.remove('open');
}

function toggleDailyManageMenu(event) {
  event?.stopPropagation?.();
  document.querySelector('.action-menu')?.classList.toggle('open');
}

function getCurrentDailyHotAudit() {
  const isTodayView = isViewingTodayDailyHot();
  const dateKeyValue = isTodayView ? todayKey() : currentDailyHotDateKey;
  const snapshot = isTodayView
    ? cleanTodaySnapshot(todaySnapshot)
    : cleanHistorySnapshot(historySnapshots[dateKeyValue] || {}, dateKeyValue);
  const words = getCurrentDailyHotWords();
  if (snapshot.recommendationAudit?.total === words.length) return snapshot.recommendationAudit;
  const batchIds = getUniqueWords(snapshot.batchIds || []);
  const freshBatchIds = new Set(batchIds.length ? batchIds : [...getFreshAiBatchIdsForDate(dateKeyValue)]);
  const context = {
    date: dateKeyValue,
    generatedAt: snapshot.generatedAt || nowIso(),
    dedupDaysUsed: snapshot.dedupDaysUsed || TODAY_HISTORY_DEDUP_DAYS,
    relaxedDedup: snapshot.relaxedDedup,
    freshBatchIds,
    existingWords: new Set(snapshot.words || []),
    latestBatchItems: getLatestBatchItemsForIds([...freshBatchIds])
  };
  return buildTodayRecommendationAudit(words, context);
}

function renderAuditMetric(label, value, tone = '') {
  return `<div class="audit-metric ${tone ? `audit-metric-${escapeHTML(tone)}` : ''}"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
}

function openTodayRecommendationAuditModal() {
  const audit = getCurrentDailyHotAudit();
  const sourceRows = RECOMMENDATION_ORIGIN_TYPES
    .map(type => renderAuditMetric(RECOMMENDATION_ORIGIN_LABELS[type] || type, audit.sourceSummary?.[type] || 0))
    .join('');
  const quality = audit.qualitySummary || {};
  const qualityRows = [
    renderAuditMetric('平均最终分', quality.averageFinalScore || 0),
    renderAuditMetric('平均表达价值', quality.averageExpressionValueScore || 0),
    renderAuditMetric('平均中文透明度', quality.averageChineseTransparencyScore || 0),
    renderAuditMetric('泛话题词', quality.genericTopicCount || 0, quality.genericTopicCount ? 'warn' : ''),
    renderAuditMetric('中文透明度高', quality.highTransparencyCount || 0, quality.highTransparencyCount ? 'warn' : ''),
    renderAuditMetric('S/A/B/C', `${quality.sLevelCount || 0}/${quality.aLevelCount || 0}/${quality.bLevelCount || 0}/${quality.cLevelCount || 0}`)
  ].join('');
  const rows = safeArray(audit.items).map(item => `
    <tr>
      <td>${escapeHTML(item.kanji)}</td>
      <td>${escapeHTML(item.meaning)}</td>
      <td>${escapeHTML(item.recommendationLevel)}</td>
      <td>${escapeHTML(item.riskLevel || 'low')}</td>
      <td>${escapeHTML(item.originLabel)}</td>
      <td>${item.isBackfill ? '是' : '否'}</td>
      <td>${item.isDedupRelaxed ? `是 · ${item.dedupDaysUsed}天` : '否'}</td>
      <td>${escapeHTML(item.finalScore)}</td>
      <td>${escapeHTML(item.expressionValueScore)}</td>
      <td>${escapeHTML(item.chineseTransparencyScore)}</td>
      <td>${item.genericTopicPenalty ? '是' : '否'}</td>
      <td>${escapeHTML(safeArray(item.diagnosis).join('；') || '—')}</td>
    </tr>`).join('');
  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell audit-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">推荐审计 · ${escapeHTML(audit.date || todayKey())}</h2>
        <button class="modal-close" data-modal-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="modal-section compact-section">
          <div class="modal-section-title">来源比例</div>
          <div class="audit-metric-grid">${sourceRows}</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">质量摘要</div>
          <div class="audit-metric-grid">${qualityRows}</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">自动诊断</div>
          <div class="audit-diagnosis-list">${safeArray(audit.diagnosis).map(text => `<div>${escapeHTML(text)}</div>`).join('')}</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">逐词审计</div>
          <div class="audit-table-wrap">
            <table class="audit-table">
              <thead><tr><th>词</th><th>意思</th><th>等级</th><th>风险</th><th>来源</th><th>补位</th><th>去重放宽</th><th>最终分</th><th>表达价值</th><th>中文透明度</th><th>泛话题</th><th>诊断</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="12">暂无可审计的今日推荐。</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer-actions form-actions">
          <button class="btn btn-ghost" data-modal-action="export-recommendation-audit">导出推荐审计</button>
          <button class="btn btn-primary" data-modal-action="close">知道了</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
}

function downloadTextFile(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportTodayRecommendationAudit() {
  const audit = getCurrentDailyHotAudit();
  const wordsByKanji = new Map(getCurrentDailyHotWords().map(word => [word.kanji, word]));
  const riskStateByKanji = Object.fromEntries(safeArray(audit.items).map(item => {
    const word = wordsByKanji.get(item.kanji) || {};
    return [item.kanji, getRiskStateLabel(word.candidateMeta ? word : { candidateMeta: item })];
  }));
  const dateKeyValue = audit.date || todayKey();
  const csv = buildRecommendationAuditCsv({
    audit,
    words: [...wordsByKanji.values()],
    riskStateByKanji
  });
  downloadTextFile(getRecommendationAuditFilename(dateKeyValue), csv, 'text/csv;charset=utf-8');
  showToast('✅ 已导出推荐审计 CSV');
}

function handleDailyManageAction(action) {
  closeDailyManageMenu();
  if (action === 'audit') {
    openTodayRecommendationAuditModal();
    return;
  }
  if (action === 'exportAudit') {
    exportTodayRecommendationAudit();
    return;
  }
  if (!isViewingTodayDailyHot()) {
    showToast('历史推荐不能重新生成，请切回今天。');
    return;
  }
  if (action === 'generate') {
    handleGenerateTodaySnapshot();
    return;
  }
  if (action === 'fill') {
    handleFillTodaySnapshot();
    return;
  }
  if (action === 'regenerate') {
    handleRegenerateTodaySnapshot();
  }
}

function updateDailyHotViewControls(isTomorrowPreview) {
  const sourceFilter = document.getElementById('todaySourceFilter');
  if (sourceFilter) sourceFilter.disabled = isTomorrowPreview;
  document.querySelectorAll('[data-daily-preview-disabled]').forEach(element => {
    element.disabled = isTomorrowPreview;
  });
}

function renderDailyHot() {
  populateDailyHotDateSelect();
  const isTodayView = isViewingTodayDailyHot();
  const isTomorrowPreview = isViewingTomorrowDailyHot();
  if (isTomorrowPreview && !codexTomorrowDraft && !codexTomorrowDraftPromise && !codexTomorrowDraftError) {
    void loadCodexTomorrowDraft({ notifyOnError: true });
  }
  const words = isTomorrowPreview ? safeArray(codexTomorrowDraft?.items) : getCurrentDailyHotWords();
  const sourceModel = isTomorrowPreview ? null : populateDailyHotSourceFilter('today', words);
  const visibleWords = isTomorrowPreview ? words : sourceModel.visibleWords;
  renderTodayGrid(visibleWords, {
    mode: isTomorrowPreview ? 'codex-preview' : (isTodayView ? 'today' : 'history'),
    dateKey: currentDailyHotDateKey
  });
  updateDailyHotViewControls(isTomorrowPreview);
  const todayDate = document.getElementById('todayDate');
  if (todayDate) {
    if (isTomorrowPreview) {
      const targetDateKey = addDaysToDateKey(todayKey(), 1);
      const draft = codexTomorrowDraft || codexTomorrowDraftStatus;
      if (codexTomorrowDraftPromise && !codexTomorrowDraft) {
        todayDate.textContent = `${formatDisplayDate(targetDateKey)} · 正在读取明日草稿…`;
      } else {
        const qualitySummary = draft?.validation?.qualitySummary || {};
        const scoreMeta = Number.isFinite(Number(qualitySummary.estimatedHumanQualityScore))
          ? ` · 人工估分 ${qualitySummary.estimatedHumanQualityScore}`
          : '';
        const gradeMeta = Number.isFinite(Number(qualitySummary.sLevelCount))
          ? ` · S ${qualitySummary.sLevelCount} / A ${qualitySummary.aLevelCount || 0}`
          : '';
        todayDate.textContent = `${formatDisplayDate(targetDateKey)} · 明日只读预览 · ${draft?.wordCount || 0} 词 / 卡片 ${draft?.cardReadyCount || 0} / 图片 ${draft?.imageReadyCount || 0}${scoreMeta}${gradeMeta}`;
      }
    } else if (isTodayView) {
      const snapshot = cleanTodaySnapshot(todaySnapshot);
      const snapshotMeta = hasTodaySnapshotForToday(snapshot)
        ? `今天的固定推荐 · 今日固定 ${snapshot.words.length} 个 · 第 ${snapshot.version || 1} 版`
        : '今天还没有固定推荐，可等待每日任务生成或手动生成今日推荐。';
      const draft = codexTomorrowDraftStatus;
      const draftMeta = draft
        ? ` · 明日草稿 ${draft.status === 'missing' ? '未提交' : `${draft.wordCount || 0} 词 / 卡片 ${draft.cardReadyCount || 0} / 图片 ${draft.imageReadyCount || 0}`}`
        : '';
      todayDate.textContent = `${formatDisplayDate(todayKey())} · ${snapshotMeta}${draftMeta}`;
    } else {
      todayDate.textContent = `正在查看 ${currentDailyHotDateKey} 的历史推荐 · ${getHistorySourceLabel(currentDailyHotDateKey)}`;
    }
  }
  const manageBtn = document.getElementById('dailyManageBtn');
  if (manageBtn) {
    manageBtn.disabled = !isTodayView || isTomorrowPreview;
    manageBtn.title = isTomorrowPreview
      ? '明日预览为只读模式'
      : (isTodayView ? '管理今天的固定推荐' : '历史推荐不能重新生成，请切回今天。');
  }
}

function renderToday() {
  renderDailyHot();
}

async function finishTodaySnapshotGeneration(result, actionLabel, options = {}) {
  hydrateTodayWordsFromSnapshot();
  saveLocalWorkflow();
  updateAllBadges();
  renderToday();
  await saveCloudWorkflow(false);
  const supplementStats = result.aiSupplementStats || {};
  const supplementHint = supplementStats.attempts
    ? ` DeepSeek 已补充候选 ${supplementStats.imported || 0} 个。`
    : '';
  const shortageHint = result.shortage ? ' 备选池可用词不足，已尝试 DeepSeek 补充后仍不足 20 个。' : '';
  const dedupHint = result.relaxedDedup
    ? ' 注意：本次结果启用了去重放宽。'
    : '';
  const cardHint = result.selectedCount ? ' 可手动生成今日词卡。' : '';
  showToast(`${actionLabel}：${result.selectedCount} 个今日候选。${dedupHint}${supplementHint}${cardHint}${shortageHint}`);
}

async function generateTodaySnapshotOnServer(mode) {
  const response = await apiFetch(getTodaySnapshotEndpoint(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mode })
  }, { workflowMutation: true, operationPrefix: `today-${mode}`, timeoutMs: 30000 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(getApiErrorMessage(data, response.status));
  await loadCloudWorkflow(false);
  return data;
}

async function generateTodaySnapshotOnServerWithAiSupplement(mode) {
  let result = await generateTodaySnapshotOnServer(mode);
  const importStats = { generated: 0, imported: 0, skipped: 0, review: 0, blocked: 0 };
  for (let round = 0; result.shortage && round < 2; round += 1) {
    const generated = await autoGenerateAiCandidates();
    const stats = autoImportAiCandidates(generated.items, generated.batch);
    importStats.generated += stats.generated;
    importStats.imported += stats.imported;
    importStats.skipped += stats.skipped;
    importStats.review += stats.review;
    importStats.blocked += stats.blocked;
    saveLocalWorkflow();
    const cloudSaved = await saveCloudWorkflow(false);
    if (!cloudSaved) throw new Error('团队同步失败，DeepSeek 补充候选未保存');
    result = await generateTodaySnapshotOnServer(result.selectedCount ? 'fill' : mode);
    if (!stats.imported) break;
  }
  return {
    ...result,
    aiSupplementStats: importStats
  };
}

async function handleGenerateTodaySnapshot() {
  if (isAutoDailyRefreshRunning) {
    showToast('自动日更正在运行，稍等一下');
    return;
  }
  if (hasTodaySnapshotForToday(todaySnapshot)) {
    hydrateTodayWordsFromSnapshot();
    renderToday();
    showToast('今天已有固定候选，可点击“补满”或“重新生成”');
    return;
  }
  try {
    const result = await generateTodaySnapshotOnServerWithAiSupplement('create');
    await finishTodaySnapshotGeneration(result, '已生成今日 20 个', { cloudSaved: true });
  } catch (error) {
    console.warn('服务端生成今日候选失败', error);
    showToast(`服务端生成失败，未写入团队后台：${error.message || '请稍后重试'}`);
  }
}

async function handleFillTodaySnapshot() {
  if (isAutoDailyRefreshRunning) {
    showToast('自动日更正在运行，稍等一下');
    return;
  }
  if (!hasTodaySnapshotForToday(todaySnapshot)) {
    handleGenerateTodaySnapshot();
    return;
  }
  try {
    const result = await generateTodaySnapshotOnServerWithAiSupplement('fill');
    await finishTodaySnapshotGeneration(result, '已补满今日候选', { cloudSaved: true });
  } catch (error) {
    console.warn('服务端补满今日候选失败', error);
    showToast(`服务端补满失败，未写入团队后台：${error.message || '请稍后重试'}`);
  }
}

async function handleRegenerateTodaySnapshot() {
  if (isAutoDailyRefreshRunning) {
    showToast('自动日更正在运行，稍等一下');
    return;
  }
  if (!window.confirm('确定要重新生成今日 20 个吗？这会替换今天当前首页候选。')) return;
  try {
    const result = await generateTodaySnapshotOnServerWithAiSupplement('regenerate');
    await finishTodaySnapshotGeneration(result, '已重新生成今日候选', { cloudSaved: true });
  } catch (error) {
    console.warn('服务端重新生成今日候选失败', error);
    showToast(`服务端重新生成失败，未写入团队后台：${error.message || '请稍后重试'}`);
  }
}

function removeWordFromTodaySnapshot(kanji) {
  // Team mode: the daily snapshot is a shared historical record and must not be
  // shortened by individual actions such as favorite, pending, or dismiss.
  void kanji;
  return true;
}

function shiftHistoryDate(step) {
  const navigation = buildHistoryNavigationModel({
    dates: rankingHistoryDates,
    currentDate: currentHistoryDateKey
  });
  if (!navigation.currentDate) return;
  currentHistoryDateKey = navigation.shift(step);
  localStorage.setItem(HISTORY_DATE_STORAGE_KEY, currentHistoryDateKey);
  renderHistory();
}

function renderHistory() {
  const words = getCurrentHistoryWords();
  const sourceModel = populateDailyHotSourceFilter('history', words);
  renderHistoryGrid(sourceModel.visibleWords);
  const historyDate = document.getElementById('historyDateLabel');
  if (historyDate) historyDate.textContent = currentHistoryDateKey ? `${formatDisplayDate(currentHistoryDateKey)} · ${getHistorySourceLabel(currentHistoryDateKey)}` : '暂无历史日期';
  const prevBtn = document.getElementById('historyPrevBtn');
  const nextBtn = document.getElementById('historyNextBtn');
  const navigation = buildHistoryNavigationModel({
    dates: rankingHistoryDates,
    currentDate: currentHistoryDateKey
  });
  if (prevBtn) prevBtn.disabled = navigation.earlierDisabled;
  if (nextBtn) nextBtn.disabled = navigation.laterDisabled;
}

function renderFavorites() {
  if (!isWorkflowScopeLoaded('favorites')) {
    renderWorkflowScopeState('favorites');
    return;
  }
  const allFavWords = getFavoriteWords();
  populateSourceFilter('favorites', allFavWords);
  const statusSelect = document.getElementById('favoritesStatusFilter');
  if (statusSelect) statusSelect.value = statusFilter;
  const pageModel = getFavoritesPageModel(allFavWords);
  const visibleWords = pageModel.visibleWords;
  const empty = document.getElementById('favEmpty');
  const count = document.getElementById('favCount');
  if (!visibleWords.length) {
    renderFavoritesGrid([]);
    empty.style.display = 'flex';
    count.textContent = pageModel.countText;
  } else {
    empty.style.display = 'none';
    renderFavoritesGrid(visibleWords);
    count.textContent = pageModel.countText;
    void queueAutoGenerateAiCards(pageModel.autoGenerateWords, { source: 'favorites-visible', toast: false });
  }
  updateFavBadge();
}

function updateTodayBadge() {
  const badge = document.getElementById('todayBadge');
  if (!badge) return;
  badge.textContent = currentDailyHotDateKey === 'today'
    ? cleanTodaySnapshot(todaySnapshot).words.length
    : getCurrentHistoryWords().length;
}

function updateHistoryBadge() {
  const badge = document.getElementById('historyBadge');
  if (!badge) return;
  const count = getCurrentHistoryWords().length;
  badge.style.display = count > 0 ? '' : 'none';
  badge.textContent = count || 0;
}

function updateFavBadge() {
  const badge = document.getElementById('favBadge');
  if (!badge) return;
  const count = getUniqueWords(favorites).filter(kanji => getFavoriteStatus(kanji) !== 'published').length;
  if (count > 0) {
    badge.style.display = '';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

function updatePublishedBadge() {
  const badge = document.getElementById('publishedBadge');
  if (!badge) return;
  const count = getPublishedDisplayItems().length;
  if (count > 0) {
    badge.style.display = '';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

function updateAllBadges() {
  updateTodayBadge();
  updateHistoryBadge();
  updateFavBadge();
  updatePublishedBadge();
}

function findWord(idOrKanji) {
  let word = todayWords.find(item => item.id === idOrKanji || item.kanji === idOrKanji);
  if (word) return word;
  word = getFavoriteWords().find(item => item.id === idOrKanji || item.kanji === idOrKanji);
  if (word) return word;
  rankingHistoryDates.some(dateKeyValue => {
    const archivedSnapshot = cleanHistorySnapshot(historySnapshots[dateKeyValue] || {}, dateKeyValue);
    if (archivedSnapshot.words.length) {
      const foundIndex = archivedSnapshot.words.findIndex((kanji, index) => idOrKanji === `history_snapshot_${dateKeyValue}_${index}` || kanji === idOrKanji);
      if (foundIndex >= 0) {
        word = buildHistoryArchivedWord(archivedSnapshot.words[foundIndex], dateKeyValue, foundIndex);
        return true;
      }
      return false;
    }
    const historyWords = safeArray(rankingHistoryWords[dateKeyValue]).filter(item => canUseHistoricalSeedWord(item.kanji));
    const foundIndex = historyWords.findIndex(item => item.id === idOrKanji || item.kanji === idOrKanji);
    const found = foundIndex >= 0 ? historyWords[foundIndex] : null;
    if (found) {
      word = buildRecommendedWord(enrichWords([{ ...found }], `history_lookup_${dateKeyValue}_${foundIndex}`)[0], 'history');
      return true;
    }
    return false;
  });
  if (word) return word;
  const baseWord = getDisplayWordByKanji(idOrKanji);
  if (baseWord) return buildRecommendedWord(enrichWords([{ ...baseWord }], `lookup_${baseWord.kanji}`)[0], 'lookup');
  return null;
}

function renderWordDetailHero(word, wordCardView, fallbackHero) {
  const referenceImageUrl = wordCardView?.hasReferenceImage
    ? wordCardView.referenceImageUrl
    : '';
  const safeImageUrl = escapeHTML(referenceImageUrl || word.imageUrl || getHeroImageUrl(word.kanji));
  if (referenceImageUrl) {
    return `
      <div class="modal-hero modal-hero-recommendation modal-hero-full-reference">
        <img class="modal-hero-img" src="${safeImageUrl}" alt="${escapeHTML(word.kanji)} 完整参考图" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackHero)}">
        <button class="modal-close" data-modal-action="close">✕</button>
      </div>
      <div class="modal-reference-heading">
        <div>
          <div class="modal-reference-word">${escapeHTML(word.kanji)}</div>
          <div class="modal-reference-reading">${escapeHTML(word.reading || word.kana || '')}</div>
        </div>
        <a class="modal-reference-open" href="${escapeHTML(referenceImageUrl)}" target="_blank" rel="noopener">查看原图 ↗</a>
      </div>`;
  }
  return `
    <div class="modal-hero modal-hero-recommendation">
      <img class="modal-hero-img" src="${safeImageUrl}" alt="${escapeHTML(word.kanji)}" data-image-fallback="fallback-src" data-fallback-src="${escapeHTML(fallbackHero)}">
      <div class="modal-hero-overlay"></div>
      <div class="modal-hero-content">
        <div class="modal-kanji">${escapeHTML(word.kanji)}</div>
        <div class="modal-reading-hero">${escapeHTML(word.reading || '')}</div>
      </div>
      <button class="modal-close" data-modal-action="close">✕</button>
    </div>`;
}

function openDetail(idOrKanji) {
  const word = findWord(idOrKanji);
  if (!word) return;
  currentWordForModal = word;
  const status = getFavoriteStatus(word.kanji);
  const fallbackHero = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 900 400%22><rect fill=%22%23fdeef0%22 width=%22900%22 height=%22400%22/><text x=%22450%22 y=%22210%22 text-anchor=%22middle%22 font-size=%22110%22 fill=%22%23f47a9a%22>${encodeURIComponent(word.kanji)}</text></svg>`;
  const safeKanjiAction = escapeHTML(word.kanji);
  const entry = cleanCandidatePoolEntry(word.kanji, candidatePool[word.kanji] || word.candidateMeta || {}) || {};
  const aiCardInFlight = aiCardAutoInFlight.has(word.kanji);
  const rawAiCard = cleanAiCard(entry.aiCard || word.aiCard || {});
  const wordCardView = buildWordCardViewModel({
    word,
    entry,
    aiCard: rawAiCard,
    inFlight: aiCardInFlight,
    stalePending: isAiCardStalePending(rawAiCard, entry)
  });
  const aiCard = wordCardView.card;
  const hasReadyAiCard = wordCardView.hasFormalCard;
  const displayAiCard = aiCardInFlight ? { ...(aiCard || {}), cardStatus: 'pending' } : aiCard;
  if (!hasReadyAiCard) {
    document.getElementById('modalContainer').innerHTML = `
      ${renderWordDetailHero(word, wordCardView, fallbackHero)}
      <div class="modal-body">
        <div class="modal-section compact-section">
          <div class="modal-section-title">核心判断</div>
          ${renderDetailJudgementBoard(word, entry, status, entry.riskWarning || entry.reviewReason || '')}
          ${renderRankingSignals(word.rankingSignals)}
        </div>
        <div class="detail-grid">
          <div class="detail-item"><span>罗马音</span><strong>${escapeHTML(wordCardView.basic.romaji || '—')}</strong></div>
          <div class="detail-item"><span>假名</span><strong>${escapeHTML(wordCardView.basic.kana || '—')}</strong></div>
          <div class="detail-item"><span>中文意思</span><strong>${escapeHTML(wordCardView.basic.meaning || '—')}</strong></div>
          <div class="detail-item"><span>DeepSeek 词卡</span><strong>${escapeHTML(wordCardView.statusLabel)}</strong></div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">DeepSeek 词卡</div>
          <div class="wrong-usage-box">${escapeHTML(wordCardView.unavailableMessage)}</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">准入状态</div>
          <div class="modal-section-content">${escapeHTML(entry.libraryAuditReason || entry.reviewReason || (entry.sourceType === 'deepseek_generated' ? 'DeepSeek 生成词，等待生成正式词卡。' : 'DeepSeek 审核词，等待生成正式词卡。'))}</div>
        </div>
        ${renderSourceInfoSection(entry)}
        <div class="modal-footer-actions">
          ${renderAiCardActionButton(word.kanji, displayAiCard, 'btn btn-primary')}
        </div>
      </div>`;
    document.getElementById('modalOverlay').classList.add('open');
    return;
  }
  const displayTitle = wordCardView.title;
  const displayHook = wordCardView.contentAngles[0] || '';
  const displayAudience = wordCardView.targetAudience;
  const displayReference = wordCardView.referenceDirection;
  const displayReason = wordCardView.summary;
  const displayDetail = wordCardView.explanation;
  const displayRisk = wordCardView.riskWarning;
  const displayWrongUsage = wordCardView.wrongUsage;
  const displayExamples = wordCardView.examples;
  const displayInteractions = wordCardView.interactionPrompts;
  const displaySimilarWords = wordCardView.similarWords;
  const displayUsageScenes = wordCardView.usageScenes;
  const displayContentAngles = wordCardView.contentAngles;
  const displayCover = wordCardView.coverSuggestion;
  const hasCoverSuggestion = wordCardView.hasCoverSuggestion;
  const scoreBreakdown = word.scoreBreakdown || {};
  const reviewCheckText = entry.reviewReason || (entry.confidenceLevel === 'review' || entry.evidenceType === 'unknown' ? '证据或用法不够稳定，发布前建议人工查证。' : '');
  const avoidScenarioText = displayCover.avoid || entry.riskWarning || '';
  document.getElementById('modalContainer').innerHTML = `
    ${renderWordDetailHero(word, wordCardView, fallbackHero)}
    <div class="modal-body">
      <div class="modal-section compact-section">
        <div class="modal-section-title">核心判断</div>
        ${renderDetailJudgementBoard(word, entry, status, displayRisk)}
        ${renderRankingSignals(word.rankingSignals)}
        <div class="published-score-note">${escapeHTML(word.reviewNote || '系统会继续根据词义稳定性、负反馈和同类方向表现来判断是否适合进入首页推荐。')}</div>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">小红书内容建议</div>
        <div class="usage-list">
          ${renderLabeledDetailItem('推荐标题', displayTitle)}
          ${displayReason ? renderLabeledDetailItem('推荐理由', displayReason) : ''}
          ${displayReference ? renderLabeledDetailItem('适合方向', displayReference) : renderLabeledDetailItem('适合方向', entry.candidateType || word.category || '')}
          ${displayContentAngles.length ? renderLabeledDetailItem('内容角度', displayContentAngles.join(' / ')) : displayHook ? renderLabeledDetailItem('内容角度', displayHook) : ''}
          ${displayAudience ? renderLabeledDetailItem('目标受众', displayAudience) : ''}
          ${hasCoverSuggestion ? `<div class="usage-item">
            <div class="usage-head"><span class="usage-word">封面建议</span></div>
            ${displayCover.coverText ? `<div class="usage-meaning">封面字：${escapeHTML(displayCover.coverText)}</div>` : ''}
            ${displayCover.mainVisual ? `<div class="usage-note">主视觉：${escapeHTML(displayCover.mainVisual)}</div>` : ''}
            ${displayCover.style ? `<div class="usage-note">风格：${escapeHTML(displayCover.style)}</div>` : ''}
          </div>` : ''}
        </div>
        ${displayInteractions.length ? `<div class="interaction-list detail-subblock">${displayInteractions.map(prompt => `<div class="interaction-box"><div class="interaction-question">${renderMultiline(prompt)}</div></div>`).join('')}</div>` : ''}
      </div>
      <div class="modal-section">
        <div class="modal-section-title">日语词卡</div>
        <div class="modal-meaning-main">${escapeHTML(word.meaning)}</div>
        <div class="usage-list">
          ${displayUsageScenes.length ? renderLabeledDetailItem('使用场景', displayUsageScenes.join(' / ')) : ''}
          ${displayDetail ? renderLabeledDetailItem('详细解释', displayDetail) : ''}
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">例句</div>
          ${displayExamples.length ? displayExamples.map(example => `<div class="example-item"><div class="example-jp">${escapeHTML(example.jp)}</div>${example.kana ? `<div class="example-romaji">${escapeHTML(example.kana)}</div>` : ''}${example.romaji ? `<div class="example-romaji">${escapeHTML(example.romaji)}</div>` : ''}<div class="example-cn">${escapeHTML(example.cn)}</div><div class="example-source">${escapeHTML(example.note || example.source || 'DeepSeek 词卡例句')}</div></div>`).join('') : '<div class="usage-empty">DeepSeek 词卡暂未返回例句。</div>'}
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">相近词</div>
          <div class="usage-list">
            ${displaySimilarWords.length ? displaySimilarWords.map(item => `
              <div class="usage-item">
                <div class="usage-head"><span class="usage-word">${escapeHTML(item.word || item.kanji)}</span><span class="usage-reading">${escapeHTML(item.romaji || item.reading || '')}</span></div>
                <div class="usage-meaning">${escapeHTML(item.meaning)}</div>
                <div class="usage-note">${escapeHTML(item.difference || item.note || '')}</div>
              </div>`).join('') : '<div class="usage-empty">暂时还没有找到合适的对比词。</div>'}
          </div>
        </div>
        ${displayWrongUsage ? `<div class="modal-section compact-section"><div class="modal-section-title">错误用法</div><div class="wrong-usage-box">${escapeHTML(displayWrongUsage)}</div></div>` : ''}
      </div>
      <div class="modal-section">
        <div class="modal-section-title">风险与查证</div>
        <div class="usage-list">
          ${displayRisk ? `<div class="wrong-usage-box">${escapeHTML(displayRisk)}</div>` : renderLabeledDetailItem('风险提示', '当前未发现明显风险，但发布前仍建议确认语境是否贴合账号调性。')}
          ${reviewCheckText ? renderLabeledDetailItem('人工查证', reviewCheckText) : ''}
          ${avoidScenarioText ? renderLabeledDetailItem('不建议使用场景', avoidScenarioText) : ''}
        </div>
      </div>
      ${renderSourceInfoSection(entry)}
      ${renderSystemScoreDetails(word, entry, scoreBreakdown)}
      <div class="modal-meta-bar">
        <div class="modal-meta-item">📍 来源：${escapeHTML(word.source || '未知')}</div>
        <div class="modal-meta-item">📚 分类：${escapeHTML(word.category || '未分类')}</div>
        <div class="modal-meta-item">🤖 词卡：${escapeHTML(aiCard.cardSource === 'codex' ? 'Codex 生成' : 'DeepSeek 生成')}</div>
      </div>
      <div class="modal-footer-actions">
        <button class="btn btn-primary" data-modal-action="mark-pending" data-kanji="${safeKanjiAction}">标记待发布</button>
        <button class="btn btn-ghost" data-modal-action="open-published-record" data-preset-kanji="${safeKanjiAction}">添加已发布记录</button>
        ${renderAiCardActionButton(word.kanji, aiCard, 'btn btn-ghost')}
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function getProtectedLibraryWords() {
  const protectedWords = new Set();
  const add = value => {
    const word = String(value || '').trim();
    if (word) protectedWords.add(word);
  };
  favorites.forEach(add);
  Object.entries(favoriteStatuses || {}).forEach(([kanji, status]) => {
    if (['pending', 'published'].includes(status)) add(kanji);
  });
  cleanPublishedRecords(publishedRecords).forEach(record => add(record.word));
  safeArray(cleanTodaySnapshot(todaySnapshot).words).forEach(add);
  Object.entries(cleanCandidatePool(candidatePool)).forEach(([kanji, entry]) => {
    if (['ready', 'watch'].includes(entry.manualReviewState)) add(kanji);
    if (entry.sourceType === 'manual_keep' || entry.sourceType === 'manual') add(kanji);
  });
  return protectedWords;
}

function copyLibraryCleanupCommand(mode = 'run') {
  const command = mode === 'dry'
    ? 'npm run audit:library-delete -- --dry-run'
    : 'npm run audit:library-delete';
  navigator.clipboard.writeText(command).then(() => {
    showToast('已复制清洗命令');
  }).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = command;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('已复制清洗命令');
  });
}

function openLibraryCleanupModal() {
  const totalWords = getAllWords().length;
  const protectedCount = getProtectedLibraryWords().size;
  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">AI 清洗历史种子数据并删除不合适词</h2>
        <button class="modal-close" data-modal-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="modal-section compact-section">
          <div class="modal-section-title">执行方式</div>
          <div class="modal-section-content">真实删除需要在本地项目终端执行脚本。脚本会读取云端工作流保护词、分批提交 DeepSeek 审核，确认后写入备份并删除 data/words-data.json 中 auditAction=delete 的词。</div>
        </div>
        <div class="score-grid published-stats-grid">
          <div class="score-card"><span>历史种子数据词数</span><strong>${totalWords}</strong></div>
          <div class="score-card"><span>当前保护词估算</span><strong>${protectedCount}</strong></div>
          <div class="score-card"><span>备份文件</span><strong>deleted-words-backup.json</strong></div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">先预览建议删除清单</div>
          <div class="wrong-usage-box">npm run audit:library-delete -- --dry-run</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">确认后真实删除</div>
          <div class="wrong-usage-box">npm run audit:library-delete</div>
          <div class="published-score-note">终端会再次要求输入 DELETE。本操作会从 data/words-data.json 中真实删除词条，但会写入 data/deleted-words-backup.json 备份。收藏、待发布、已发布词不会删除。</div>
        </div>
        <div class="modal-section compact-section">
          <div class="modal-section-title">完成后</div>
          <div class="modal-section-content">脚本会自动运行 npm run build:words，更新 words-data.js 和 shared/words-data.mjs。删除后首页补位只会使用 DeepSeek 审核词。</div>
        </div>
        <div class="modal-footer-actions form-actions">
          <button class="btn btn-ghost" data-modal-action="copy-library-cleanup" data-mode="dry">复制预览命令</button>
          <button class="btn btn-primary" data-modal-action="copy-library-cleanup" data-mode="run">复制真实删除命令</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openPublishedRecordModal(recordId = '', presetKanji = '') {
  hasUnsavedFormChanges = false;
  const record = recordId ? cleanPublishedRecords(publishedRecords).find(item => item.id === recordId) : null;
  currentPublishedRecordId = record?.id || null;
  const initialWord = record?.word || presetKanji || '';
  const snapshotRows = SNAPSHOT_NODE_ORDER.map(nodeType => {
    const snapshot = record?.snapshots?.find(item => item.nodeType === nodeType) || cleanSnapshot({ nodeType }, nodeType);
    return `
      <div class="snapshot-form-row">
        <div class="snapshot-node">${nodeType}</div>
        <input class="form-input" data-snapshot="${nodeType}" data-field="likes" type="number" min="0" value="${snapshot.likes || ''}" placeholder="点赞">
        <input class="form-input" data-snapshot="${nodeType}" data-field="favorites" type="number" min="0" value="${snapshot.favorites || ''}" placeholder="收藏">
        <input class="form-input" data-snapshot="${nodeType}" data-field="comments" type="number" min="0" value="${snapshot.comments || ''}" placeholder="评论">
        <input class="form-input" data-snapshot="${nodeType}" data-field="shares" type="number" min="0" value="${snapshot.shares || ''}" placeholder="分享">
        <input class="form-input" data-snapshot="${nodeType}" data-field="views" type="number" min="0" value="${snapshot.views || ''}" placeholder="曝光/浏览">
        <input class="form-input" data-snapshot="${nodeType}" data-field="capturedAt" type="datetime-local" value="${snapshot.capturedAt ? snapshot.capturedAt.slice(0, 16) : ''}">
        <select class="form-input" data-snapshot="${nodeType}" data-field="source"><option value="manual" ${snapshot.source !== 'auto' ? 'selected' : ''}>手动填写</option><option value="auto" ${snapshot.source === 'auto' ? 'selected' : ''}>自动读取</option></select>
      </div>`;
  }).join('');

  const reasonCheckboxes = Object.entries(PERFORMANCE_REASON_LABELS).map(([key, label]) => `
    <label class="tag-check"><input type="checkbox" name="performanceReason" value="${escapeHTML(key)}" ${safeArray(record?.performanceReason).includes(key) ? 'checked' : ''}><span>${escapeHTML(label)}</span></label>`).join('');

  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">${record ? '编辑已发布记录' : '添加已发布记录'}</h2>
        <button class="modal-close" data-modal-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="form-grid two-col">
          <label class="form-field"><span>关联词</span><input class="form-input" id="recordWord" value="${escapeHTML(initialWord)}" placeholder="例如：尊い"></label>
          <label class="form-field"><span>内容类型</span><select class="form-input" id="recordContentType">${CONTENT_TYPE_OPTIONS.map(option => `<option value="${escapeHTML(option)}" ${(record?.contentType || '图文') === option ? 'selected' : ''}>${escapeHTML(option)}</option>`).join('')}</select></label>
          <label class="form-field full"><span>小红书链接 / 分享文案</span><div class="form-inline-actions"><textarea class="form-input published-share-input" id="recordLink" rows="3" placeholder="粘贴分享链接或整段分享文案">${escapeHTML(record?.link || '')}</textarea><button class="card-action-btn ghost" type="button" data-modal-action="autofill-published-record">自动识别</button></div></label>
          <label class="form-field"><span>发布时间</span><input class="form-input" id="recordPublishedAt" type="datetime-local" value="${record?.publishedAt ? record.publishedAt.slice(0, 16) : ''}"></label>
          <label class="form-field full"><span>笔记标题</span><input class="form-input" id="recordTitle" value="${escapeHTML(record?.title || '')}" placeholder="小红书标题"></label>
          <label class="form-field full"><span>笔记描述</span><textarea class="form-input form-textarea" id="recordDescription" placeholder="笔记描述 / 备注文案">${escapeHTML(record?.description || '')}</textarea></label>
          <label class="form-field"><span>作者昵称</span><input class="form-input" id="recordAuthorName" value="${escapeHTML(record?.authorName || '')}" placeholder="如可获取"></label>
          <label class="form-field"><span>数据更新时间</span><input class="form-input" id="recordUpdatedAt" type="datetime-local" value="${record?.updatedAt ? record.updatedAt.slice(0, 16) : nowIso().slice(0, 16)}"></label>
        </div>

        <div class="modal-section compact-section">
          <div class="modal-section-title">📊 最新数据快照</div>
          <div class="form-grid metrics-grid">
            <label class="form-field"><span>点赞数</span><input class="form-input" id="latestLikes" type="number" min="0" value="${record?.latestStats?.likes || ''}"></label>
            <label class="form-field"><span>收藏数</span><input class="form-input" id="latestFavorites" type="number" min="0" value="${record?.latestStats?.favorites || ''}"></label>
            <label class="form-field"><span>评论数</span><input class="form-input" id="latestComments" type="number" min="0" value="${record?.latestStats?.comments || ''}"></label>
            <label class="form-field"><span>分享数</span><input class="form-input" id="latestShares" type="number" min="0" value="${record?.latestStats?.shares || ''}"></label>
            <label class="form-field full"><span>曝光 / 浏览量</span><input class="form-input" id="latestViews" type="number" min="0" value="${record?.latestStats?.views || ''}"></label>
          </div>
        </div>

        <div class="modal-section compact-section">
          <div class="modal-section-title">⏱ 分时数据（手动记录）</div>
          <div class="snapshot-form-table">
            <div class="snapshot-form-row snapshot-form-head"><div>节点</div><div>赞</div><div>藏</div><div>评</div><div>转</div><div>曝光</div><div>采集时间</div><div>来源</div></div>
            ${snapshotRows}
          </div>
        </div>

        <div class="modal-section compact-section">
          <div class="modal-section-title">🏷 表现原因</div>
          <div class="tag-check-group">${reasonCheckboxes}</div>
          <label class="form-field full"><span>表现原因说明</span><textarea class="form-input form-textarea" id="recordPerformanceNote" placeholder="例如：词很好，但封面不够抓人">${escapeHTML(record?.performanceNote || '')}</textarea></label>
          <label class="form-field full"><span>备注</span><textarea class="form-input form-textarea" id="recordRemarks" placeholder="手动补充说明">${escapeHTML(record?.remarks || '')}</textarea></label>
        </div>

        <div class="modal-footer-actions form-actions">
          <button class="btn btn-primary" data-modal-action="save-published-record">保存记录</button>
          ${record ? `<button class="btn btn-ghost" data-modal-action="open-published-detail" data-record-id="${escapeHTML(record.id)}">返回详情</button>` : ''}
        </div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function readRecordFormStats(prefix = 'latest') {
  return cleanPublishedStats({
    likes: document.getElementById(`${prefix}Likes`)?.value,
    favorites: document.getElementById(`${prefix}Favorites`)?.value,
    comments: document.getElementById(`${prefix}Comments`)?.value,
    shares: document.getElementById(`${prefix}Shares`)?.value,
    views: document.getElementById(`${prefix}Views`)?.value
  });
}

function autofillPublishedRecordFromLink() {
  const input = document.getElementById('recordLink');
  if (!input) return;
  const parsed = parseXiaohongshuSharePayload(input.value);
  if (!parsed.url && !parsed.title && !parsed.authorName) {
    showToast('暂时没识别出可用信息，可以先手动填写');
    return;
  }

  if (parsed.url) input.value = parsed.url;
  const titleInput = document.getElementById('recordTitle');
  const descriptionInput = document.getElementById('recordDescription');
  const authorInput = document.getElementById('recordAuthorName');
  const contentTypeInput = document.getElementById('recordContentType');
  const publishedAtInput = document.getElementById('recordPublishedAt');
  const remarksInput = document.getElementById('recordRemarks');
  const latestLikes = document.getElementById('latestLikes');
  const latestFavorites = document.getElementById('latestFavorites');
  const latestComments = document.getElementById('latestComments');
  const latestShares = document.getElementById('latestShares');
  const latestViews = document.getElementById('latestViews');

  if (titleInput && !titleInput.value.trim() && parsed.title) titleInput.value = parsed.title;
  if (descriptionInput && !descriptionInput.value.trim() && parsed.description) descriptionInput.value = parsed.description;
  if (authorInput && !authorInput.value.trim() && parsed.authorName) authorInput.value = parsed.authorName;
  if (contentTypeInput && parsed.contentType) contentTypeInput.value = parsed.contentType;
  if (publishedAtInput && !publishedAtInput.value && parsed.publishedAt) publishedAtInput.value = parsed.publishedAt;
  if (latestLikes && !latestLikes.value && parsed.latestStats.likes) latestLikes.value = parsed.latestStats.likes;
  if (latestFavorites && !latestFavorites.value && parsed.latestStats.favorites) latestFavorites.value = parsed.latestStats.favorites;
  if (latestComments && !latestComments.value && parsed.latestStats.comments) latestComments.value = parsed.latestStats.comments;
  if (latestShares && !latestShares.value && parsed.latestStats.shares) latestShares.value = parsed.latestStats.shares;
  if (latestViews && !latestViews.value && parsed.latestStats.views) latestViews.value = parsed.latestStats.views;
  if (remarksInput && parsed.noteId) {
    const existing = remarksInput.value.trim();
    if (!existing.includes(parsed.noteId)) remarksInput.value = existing ? `${existing}\n识别到 noteId：${parsed.noteId}` : `识别到 noteId：${parsed.noteId}`;
  }

  showToast(parsed.url ? '已自动识别链接并预填字段，能识别到的数据也一起带上了' : '已从分享文案提取标题、作者和可识别数据');
}

function savePublishedRecord() {
  const word = String(document.getElementById('recordWord')?.value || '').trim();
  if (!word) {
    showToast('请先填写关联词');
    return;
  }
  hasUnsavedFormChanges = false;
  ensureFavoriteWord(word);
  const existingRecord = currentPublishedRecordId
    ? cleanPublishedRecords(publishedRecords).find(item => item.id === currentPublishedRecordId)
    : cleanPublishedRecords(publishedRecords).find(item => item.word === word && item.sourceStatus !== 'placeholder');
  const snapshots = SNAPSHOT_NODE_ORDER.map(nodeType => cleanSnapshot({
    nodeType,
    likes: document.querySelector(`[data-snapshot="${nodeType}"][data-field="likes"]`)?.value,
    favorites: document.querySelector(`[data-snapshot="${nodeType}"][data-field="favorites"]`)?.value,
    comments: document.querySelector(`[data-snapshot="${nodeType}"][data-field="comments"]`)?.value,
    shares: document.querySelector(`[data-snapshot="${nodeType}"][data-field="shares"]`)?.value,
    views: document.querySelector(`[data-snapshot="${nodeType}"][data-field="views"]`)?.value,
    capturedAt: document.querySelector(`[data-snapshot="${nodeType}"][data-field="capturedAt"]`)?.value,
    source: document.querySelector(`[data-snapshot="${nodeType}"][data-field="source"]`)?.value
  }, nodeType));

  const record = cleanPublishedRecord({
    id: currentPublishedRecordId || `record_${word}_${Date.now()}`,
    word,
    link: document.getElementById('recordLink')?.value,
    title: document.getElementById('recordTitle')?.value,
    description: document.getElementById('recordDescription')?.value,
    contentType: document.getElementById('recordContentType')?.value,
    authorName: document.getElementById('recordAuthorName')?.value,
    publishedAt: document.getElementById('recordPublishedAt')?.value,
    latestStats: readRecordFormStats('latest'),
    snapshots,
    updatedAt: document.getElementById('recordUpdatedAt')?.value || nowIso(),
    performanceReason: [...document.querySelectorAll('input[name="performanceReason"]:checked')].map(item => item.value),
    performanceNote: document.getElementById('recordPerformanceNote')?.value,
    remarks: document.getElementById('recordRemarks')?.value,
    sourceStatus: 'record',
    autoRefresh: existingRecord?.autoRefresh
  });

  publishedRecords = cleanPublishedRecords([
    ...publishedRecords.filter(item => item.id !== record.id && !(item.sourceStatus === 'placeholder' && item.word === word)),
    record
  ]);
  favoriteStatuses[word] = 'published';
  removeWordFromTodaySnapshot(word);
  currentPublishedRecordId = record.id;
  saveLocalWorkflow();
  updateAllBadges();
  renderPublished();
  refreshCurrentGrid();
  saveCloudWorkflow(false);
  showToast('已保存发布记录');
  openPublishedDetail(record.id);
}

function openPublishedDetail(recordId) {
  const record = cleanPublishedRecords(publishedRecords).find(item => item.id === recordId);
  if (!record) return;
  currentPublishedRecordId = record.id;
  const word = findWord(record.word) || getDisplayWordByKanji(record.word) || { kanji: record.word, reading: '', meaning: '' };
  const rating = getRecordRating(record);
  const latestStats = cleanPublishedStats(record.latestStats);
  const refreshMeta = getAutoRefreshSummary(record);
  const snapshotRows = SNAPSHOT_NODE_ORDER.map(nodeType => {
    const snapshot = record.snapshots.find(item => item.nodeType === nodeType) || cleanSnapshot({ nodeType }, nodeType);
    return `
      <div class="timeline-card">
        <div class="timeline-title">${nodeType}</div>
        <div class="timeline-metrics">
          <span>赞 ${snapshot.likes || '—'}</span>
          <span>藏 ${snapshot.favorites || '—'}</span>
          <span>评 ${snapshot.comments || '—'}</span>
          <span>转 ${snapshot.shares || '—'}</span>
          <span>曝光 ${snapshot.views || '—'}</span>
        </div>
        <div class="timeline-meta">${snapshot.capturedAt ? snapshot.capturedAt.replace('T', ' ').slice(0, 16) : '待补录'} · ${snapshot.source === 'auto' ? '自动读取' : '手动填写'}</div>
      </div>`;
  }).join('');

  document.getElementById('modalContainer').innerHTML = `
    <div class="modal-shell record-shell">
      <div class="modal-header settings-header">
        <h2 class="modal-title">已发布详情</h2>
        <button class="modal-close" data-modal-action="close">×</button>
      </div>
      <div class="modal-body form-modal-body">
        <div class="published-detail-head">
          <div>
            <div class="published-word">${escapeHTML(word.kanji || '未关联词')}</div>
            <div class="published-title">${escapeHTML(record.title || '还没填写笔记标题')}</div>
            <div class="published-detail-sub">${escapeHTML(word.meaning || '')}</div>
          </div>
          <div class="published-rating rating-${escapeHTML(rating.level)}">${escapeHTML(rating.level)}</div>
        </div>
        <div class="published-detail-hero-card">
          <div class="published-mini-stats">
            <span class="published-mini-chip">👍 ${latestStats.likes}</span>
            <span class="published-mini-chip">⭐ ${latestStats.favorites}</span>
            <span class="published-mini-chip">💬 ${latestStats.comments}</span>
            <span class="published-mini-chip">📤 ${latestStats.shares}</span>
            <span class="published-mini-chip strong">表现分 ${rating.performanceScore}</span>
          </div>
          <div class="tag-list">
            ${safeArray(record.performanceReason).map(item => `<span class="reason-chip">${escapeHTML(PERFORMANCE_REASON_LABELS[item])}</span>`).join('') || '<span class="reason-chip">待观察</span>'}
          </div>
        </div>
        <div class="detail-grid two-col">
          <div class="detail-item"><span>小红书链接</span><strong>${record.link ? `<a href="${escapeHTML(record.link)}" target="_blank" rel="noopener">打开链接 ↗</a>` : '待填写'}</strong></div>
          <div class="detail-item"><span>内容类型</span><strong>${escapeHTML(record.contentType)}</strong></div>
          <div class="detail-item"><span>作者信息</span><strong>${escapeHTML(record.authorName || '待填写')}</strong></div>
          <div class="detail-item"><span>发布时间</span><strong>${escapeHTML(record.publishedAt || '待填写')}</strong></div>
          <div class="detail-item"><span>数据更新时间</span><strong>${escapeHTML(record.updatedAt ? record.updatedAt.slice(0, 16).replace('T', ' ') : '待更新')}</strong></div>
          <div class="detail-item"><span>数据评级</span><strong>${escapeHTML(rating.level)}</strong></div>
          <div class="detail-item"><span>自动更新状态</span><strong>${escapeHTML(refreshMeta.label)}</strong></div>
          <div class="detail-item"><span>最近尝试时间</span><strong>${escapeHTML(refreshMeta.timeLabel)}</strong></div>
        </div>
        <div class="modal-section compact-section"><div class="modal-section-title">📊 当前最新数据</div><div class="score-grid published-stats-grid"><div class="score-card"><span>点赞</span><strong>${latestStats.likes}</strong></div><div class="score-card"><span>收藏</span><strong>${latestStats.favorites}</strong></div><div class="score-card"><span>评论</span><strong>${latestStats.comments}</strong></div><div class="score-card"><span>分享</span><strong>${latestStats.shares}</strong></div><div class="score-card"><span>曝光/浏览</span><strong>${latestStats.views || '—'}</strong></div><div class="score-card"><span>表现分</span><strong>${rating.performanceScore}</strong></div></div></div>
        <div class="modal-section compact-section"><div class="modal-section-title">🔄 自动更新说明</div><div class="modal-section-content">${escapeHTML(refreshMeta.message)}</div>${refreshMeta.sourceLabel ? `<div class="modal-section-subtle">最近成功来源：${escapeHTML(refreshMeta.sourceLabel)}</div>` : ''}</div>
        <div class="modal-section compact-section"><div class="modal-section-title">🧠 表现原因</div><div class="modal-section-content">${escapeHTML(record.performanceNote || rating.reason)}</div></div>
        <div class="modal-section compact-section"><div class="modal-section-title">📝 笔记描述</div><div class="modal-section-content">${escapeHTML(record.description || '待填写')}</div></div>
        <div class="modal-section compact-section"><div class="modal-section-title">📒 备注</div><div class="modal-section-content">${escapeHTML(record.remarks || '暂无')}</div></div>
        <div class="modal-section compact-section"><div class="modal-section-title">⏱ 分时数据节点</div><div class="timeline-grid">${snapshotRows}</div></div>
        <div class="modal-footer-actions form-actions"><button class="btn btn-ghost" data-modal-action="refresh-published-record" data-record-id="${escapeHTML(record.id)}">尝试自动更新</button><button class="btn btn-primary" data-modal-action="open-published-record" data-record-id="${escapeHTML(record.id)}">编辑这条记录</button></div>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  currentWordForModal = null;
  currentPublishedRecordId = null;
  hasUnsavedFormChanges = false;
}

function resetTransientUiState() {
  activeStatusMenuKanji = null;
  activeFeedbackMenuKanji = null;
  currentWordForModal = null;
  currentPublishedRecordId = null;
  document.getElementById('modalOverlay')?.classList.remove('open');
  document.getElementById('settingsOverlay')?.classList.remove('open');
  const modalContainer = document.getElementById('modalContainer');
  if (modalContainer) modalContainer.innerHTML = '';
  document.body.style.overflow = '';
}

function ensureTodayGridVisible(force = false) {
  const grid = document.getElementById('todayGrid');
  if (!grid) return;
  const hasRenderedContent = grid.childElementCount > 0 || String(grid.textContent || '').trim().length > 0;
  if ((force || !hasRenderedContent) && todayWords.length) {
    renderToday();
  }
}

function renderWorkflowScopeState(tab, state = 'loading') {
  const config = {
    today: { gridId: 'todayGrid', emptyId: '', countId: '', title: '每日热门' },
    favorites: { gridId: 'favGrid', emptyId: 'favEmpty', countId: 'favCount', title: '收藏 / 选题池' },
    published: { gridId: 'publishedGrid', emptyId: 'publishedEmpty', countId: 'publishedCount', title: '已发布记录' }
  }[normalizeWorkflowScope(tab)];
  if (!config) return;
  const failed = state === 'error';
  const grid = document.getElementById(config.gridId);
  if (grid) {
    grid.innerHTML = `<div class="empty-state inline-empty"><div class="empty-title">${failed ? `${config.title}加载失败` : `正在加载${config.title}`}</div><div class="empty-desc">${failed ? '请点击刷新后重试，当前没有改动云端数据。' : '只读取当前页面需要的词卡，减少手机流量。'}</div></div>`;
  }
  const empty = config.emptyId ? document.getElementById(config.emptyId) : null;
  if (empty) empty.style.display = 'none';
  const count = config.countId ? document.getElementById(config.countId) : null;
  if (count) count.textContent = failed ? '云端读取失败' : '正在读取云端数据…';
}

function ensureWorkflowScopeLoaded(scope, options = {}) {
  const cleanScope = normalizeWorkflowScope(scope);
  const historyDate = cleanShortText(options.historyDate || getWorkflowScopeHistoryDate(cleanScope), 20);
  const scopeKey = getWorkflowScopeKey(cleanScope, historyDate);
  if (isWorkflowScopeLoaded(cleanScope, historyDate)) return Promise.resolve(true);
  return workflowStore.loadScope(scopeKey, () => loadCloudWorkflow({
    mode: 'remote-first',
    showMessages: false,
    scope: cleanScope,
    historyDate,
    mergeCandidatePool: true
  }).then(loaded => {
    if (!loaded && getPreferredWorkflowScope() === cleanScope && !isWorkflowScopeLoaded(cleanScope, historyDate)) {
      renderWorkflowScopeState(cleanScope, 'error');
    }
    return loaded;
  }));
}

function switchTab(tab) {
  const normalizedTab = tab === 'history' ? 'today' : tab;
  const targetTab = ['today', 'favorites', 'published'].includes(normalizedTab) ? normalizedTab : 'today';
  document.body.dataset.activeTab = targetTab;
  document.querySelectorAll('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.tab === targetTab));
  document.querySelectorAll('.page').forEach(element => element.classList.toggle('active', element.id === `page-${targetTab}`));
  localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, targetTab);
  const historyDate = getWorkflowScopeHistoryDate(targetTab);
  if (!isWorkflowScopeLoaded(targetTab, historyDate)) {
    renderWorkflowScopeState(targetTab);
    void ensureWorkflowScopeLoaded(targetTab, { historyDate });
    document.getElementById('sidebar')?.classList.remove('open');
    return;
  }
  if (targetTab === 'today') {
    renderToday();
  }
  else if (targetTab === 'favorites') renderFavorites();
  else if (targetTab === 'published') renderPublished();
  document.getElementById('sidebar')?.classList.remove('open');
}

function refreshCurrentGrid() {
  const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
  const historyDate = getWorkflowScopeHistoryDate(activeTab);
  if (!isWorkflowScopeLoaded(activeTab, historyDate)) {
    renderWorkflowScopeState(activeTab || 'today');
    return;
  }
  if (activeTab === 'today') renderToday();
  else if (activeTab === 'favorites') renderFavorites();
  else if (activeTab === 'published') renderPublished();
}

function exportSelected() {
  const favWords = getVisibleFavoriteWords();
  if (!favWords.length) {
    showToast('请先把词加入选题池再导出');
    return;
  }
  const items = favWords.map(word => {
    const entry = cleanCandidatePoolEntry(word.kanji, candidatePool[word.kanji] || word.candidateMeta || {}) || {};
    const wordCardView = buildWordCardViewModel({ word, entry, aiCard: entry.aiCard || {} });
    return {
      word,
      wordCardView,
      statusLabel: FAVORITE_STATUS_LABELS[getFavoriteStatus(word.kanji)]
    };
  });
  const text = buildFavoriteSelectionExportText({
    dateLabel: new Date().toLocaleDateString('zh-CN'),
    items
  });
  navigator.clipboard.writeText(text).then(() => showToast('✅ 已复制到剪贴板')).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('✅ 已复制到剪贴板');
  });
}

function selectWorkflowBackupForRestore() {
  const input = document.getElementById('workflowRestoreInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function restoreWorkflowBackup(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  if (file.size > MAX_WORKFLOW_BACKUP_BYTES) {
    showToast('备份文件不能超过 10 MB');
    if (event?.target) event.target.value = '';
    return;
  }
  try {
    const restored = parseWorkflowBackupText(await file.text(), { cleanWorkflow: cleanStoredWorkflow });
    const summary = formatWorkflowBackupSummary(restored);
    if (!window.confirm(`备份校验通过：${summary}。\n\n确认用这份备份覆盖当前团队工作流吗？`)) return;

    const currentMetadata = workflowStore.getMetadata();
    applyWorkflowData(restored);
    workflowStore.replaceMetadata(currentMetadata);
    saveLocalWorkflow();
    const saved = await saveCloudWorkflow(false);
    if (!saved) {
      await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
      throw new Error('团队后台拒绝了恢复操作，已重新载入云端数据');
    }
    updateAllBadges();
    refreshCurrentGrid();
    showToast(`备份恢复完成：${summary}`);
  } catch (error) {
    console.warn('恢复 workflow 备份失败', error);
    showToast(`备份恢复失败：${error.message || '文件格式无效'}`);
  } finally {
    if (event?.target) event.target.value = '';
  }
}

function exportWorkflowBackup() {
  const backup = buildWorkflowBackup({
    words: filterKnownFavorites(favorites),
    statuses: favoriteStatuses,
    feedback: wordFeedback,
    publishedRecords,
    candidatePool,
    aiBatches,
    aiPreview,
    todaySnapshot,
    todayDismissed,
    historySnapshots,
    todaySnapshotHistory,
    revision: workflowStore.getRevision(),
    auditLog: workflowStore.getAuditLog(),
    updated: nowIso(),
    schemaVersion: 2
  }, { cleanWorkflow: cleanStoredWorkflow });
  downloadTextFile(
    getWorkflowBackupFilename(todayKey()),
    serializeWorkflowBackup(backup),
    'application/json;charset=utf-8'
  );
  showToast('✅ 已导出全部选题数据备份');
}

async function refreshData() {
  showToast('🔄 刷新中…');
  const synced = await loadCloudRankings(false);
  if (!synced) generateFallbackRankings();
  const workflowSynced = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
  if (!workflowSynced) loadLocalWorkflow();
  await loadCodexTomorrowDraftStatus();
  hydrateTodayWordsFromSnapshot();
  updateAllBadges();
  refreshCurrentGrid();
  showToast(synced && workflowSynced ? '✅ 已同步云端榜单和团队工作流' : '⚠️ 云端同步失败，正在使用本地缓存');
}

async function ensureTodayRecommendationsLoaded() {
  if (todayWords.length) return true;
  if (todayRecoveryPromise) return todayRecoveryPromise;
  todayRecoveryPromise = (async () => {
    const synced = await loadCloudRankings(false);
    if (!synced) generateFallbackRankings();
    const workflowSynced = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    if (!workflowSynced) loadLocalWorkflow();
    hydrateTodayWordsFromSnapshot();
    updateAllBadges();
    if (todayWords.length) refreshCurrentGrid();
    return todayWords.length > 0;
  })();
  try {
    return await todayRecoveryPromise;
  } finally {
    todayRecoveryPromise = null;
  }
}

function syncRemoteDataInBackground() {
  if (backgroundSyncPromise) return backgroundSyncPromise;
  const operation = (async () => {
    const rankingsLoaded = await loadCloudRankings(false);
    if (!rankingsLoaded) generateFallbackRankings();
    const cloudLoaded = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
    if (!cloudLoaded) return false;
    hydrateTodayWordsFromSnapshot();
    updateAllBadges();
    refreshCurrentGrid();
    return true;
  });
  const trackedOperation = operation().finally(() => {
    if (backgroundSyncPromise === trackedOperation) backgroundSyncPromise = null;
  });
  backgroundSyncPromise = trackedOperation;
  return backgroundSyncPromise;
}

function openSettingsModal() {
  const overlay = document.getElementById('settingsOverlay');
  const intro = document.getElementById('syncIntro');
  const snapshot = cleanTodaySnapshot(todaySnapshot);
  if (intro) {
    intro.textContent = SYNC_API_URL
      ? '当前模式：团队共享。云端 workflow 是唯一真实数据源，localStorage 只作为最近一次云端数据缓存。'
      : '当前还没有接上 Cloudflare 后端，无法进入完整团队共享模式。';
  }
  const syncMessage = SYNC_API_URL
    ? [
      '当前模式：团队共享',
      '云端工作区：team-main',
      `最近云端同步：${lastCloudSyncAt ? lastCloudSyncAt.slice(0, 19).replace('T', ' ') : '尚未同步'}`,
      `本地缓存：${lastLocalCacheAt ? lastLocalCacheAt.slice(0, 19).replace('T', ' ') : '暂无缓存'}`,
      `团队选题池：${getFavoriteWords().length} 个`,
      `已发布记录：${getPublishedDisplayItems().length} 条`,
      `今日快照版本：${snapshot.dateKey || '未生成'} / v${snapshot.version || 0}`,
      cloudWorkflowFailed ? '云端同步失败，当前显示的是本地缓存，可能与队友不一致。' : '云端同步正常。'
    ].join(' · ')
    : '还没有配置云端同步，正在使用本地缓存，可能与队友不一致。';
  updateSyncStatus(syncMessage, cloudWorkflowFailed ? '#c0392b' : 'var(--text-secondary)');
  overlay?.classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settingsOverlay')?.classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

document.addEventListener('click', event => {
  if (!event.target.closest('.action-menu')) {
    closeDailyManageMenu();
  }
  if (!event.target.closest('.card-status-control')) {
    activeStatusMenuKanji = null;
    activeFeedbackMenuKanji = null;
    refreshStatusControls();
  }
});

document.addEventListener('input', event => {
  if (event.target instanceof Element && event.target.matches('.modal-container input, .modal-container textarea, .modal-container select')) {
    hasUnsavedFormChanges = true;
  }
});

window.addEventListener('beforeunload', event => {
  if (!hasUnsavedFormChanges && pendingCloudSaveCount === 0) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('error', event => {
  console.error('页面运行异常', event.error || event.message);
  updateSyncStatus('页面发生异常，请刷新后重试。', '#c0392b');
  showToast('页面发生异常，请刷新后重试');
});

window.addEventListener('unhandledrejection', event => {
  if (event.reason?.code === 'REQUEST_ABORTED') return;
  console.error('未处理的异步异常', event.reason);
  updateSyncStatus('后台操作发生异常，请刷新数据后重试。', '#c0392b');
  showToast('后台操作失败，请刷新后重试');
});

async function init() {
  if (!getAllWords().length) {
    console.error('ALL_WORDS not loaded! Check words-data.js');
    document.getElementById('todayGrid').innerHTML = '<div style="padding:40px;text-align:center;color:#999">词库数据加载失败，请检查 words-data.js</div>';
    return;
  }

  resetTransientUiState();
  await loadLibraryReviewRecords();
  const rankingsLoaded = await loadCloudRankings(false);
  if (!rankingsLoaded) generateFallbackRankings();
  const cloudLoaded = await loadCloudWorkflow({ mode: 'remote-first', showMessages: false });
  if (!cloudLoaded) {
    loadLocalWorkflow();
    loadAiPreviewState({ forceLocal: true });
    updateSyncStatus('云端同步失败，正在使用本地缓存，可能与队友不一致。', '#c0392b');
    showToast('云端同步失败，正在使用本地缓存');
  }
  void loadCodexTomorrowDraftStatus();
  verifyDeepSeekLibraryAuditCoverage();
  hydrateTodayWordsFromSnapshot();
  updateAllBadges();
  const savedTab = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  const initialTab = savedTab === 'history'
    ? 'today'
    : (['today', 'favorites', 'published'].includes(savedTab) ? savedTab : 'today');
  try {
    switchTab(initialTab);
  } catch (error) {
    console.warn('恢复上次页面失败，已回退到每日热门', error);
    localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
    switchTab('today');
  }
  ensureTodayGridVisible(true);
  requestAnimationFrame(() => ensureTodayGridVisible());
  setTimeout(() => ensureTodayGridVisible(), 0);
}

window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  cloudWorkflowLoadEpoch += 1;
  apiClient.abortAll();
  backgroundSyncPromise = null;
  resetTransientUiState();
  ensureTodayGridVisible();
  void syncRemoteDataInBackground();
});

window.addEventListener('offline', () => {
  cloudWorkflowFailed = true;
  updateSyncStatus('当前网络不可用，正在显示最近一次云端缓存。', '#c0392b');
});

window.addEventListener('online', () => {
  updateSyncStatus('网络已恢复，正在重新同步云端数据...');
  void syncRemoteDataInBackground().then(synced => {
    if (!synced) return;
    updateSyncStatus('网络已恢复，云端数据已同步。', '#4caf50');
    showToast('网络已恢复，数据已重新同步');
  });
});

createAppShellController({
  root: document,
  onToggleSidebar: toggleSidebar,
  onSwitchTab: switchTab,
  onOpenSettings: openSettingsModal,
  onCloseSettings: closeSettingsModal,
  onCloseModal: closeModal,
  onExportBackup: exportWorkflowBackup,
  onSelectRestore: selectWorkflowBackupForRestore,
  onRestoreWorkflow: restoreWorkflowBackup,
  onEscape: () => {
    closeStatusMenu();
    closeDailyManageMenu();
    closeModal();
    closeSettingsModal();
  },
  onError: error => {
    console.warn('应用外壳操作失败', error);
    showToast('页面操作失败，请刷新后重试');
  }
});

createManualWordModalController({
  root: document.getElementById('modalContainer'),
  onClose: closeModal,
  onSubmit: submitManualWord,
  onConfirmExisting: confirmAddExistingManualWord,
  onOpenDetail: openDetail,
  onError: error => {
    console.warn('手动词弹窗操作失败', error);
    showToast('手动词操作失败，请稍后重试');
  }
});

createWorkflowActionsController({
  root: document,
  onGenerateTodayCard: generateTodayAiCard,
  onGenerateDeepSeekCard: generateDeepSeekWordCard,
  onToggleStatus: toggleStatusMenu,
  onSelectStatus: selectFavoriteStatus,
  onToggleFeedback: toggleFeedbackMenu,
  onNegativeFeedback: applyNegativeFeedback,
  onCodexFeedback: applyCodexDraftFeedback,
  onError: error => {
    console.warn('工作流卡片操作失败', error);
    showToast('卡片操作失败，请稍后重试');
  }
});

createModalActionsController({
  root: document.getElementById('modalContainer'),
  onClose: closeModal,
  onToggleCodexFavorite: toggleCodexDraftFavorite,
  onExportRecommendationAudit: exportTodayRecommendationAudit,
  onMarkPending: markPending,
  onOpenPublishedRecord: openPublishedRecordModal,
  onCopyLibraryCleanup: copyLibraryCleanupCommand,
  onAutofillPublishedRecord: autofillPublishedRecordFromLink,
  onSavePublishedRecord: savePublishedRecord,
  onOpenPublishedDetail: openPublishedDetail,
  onRefreshPublishedRecord: refreshPublishedMetrics,
  onError: error => {
    console.warn('弹窗操作失败', error);
    showToast('弹窗操作失败，请稍后重试');
  }
});

createImageFallbackController({ root: document });

createDailyHotPageController({
  root: document.getElementById('mainContent'),
  onDateChange: setDailyHotDate,
  onSourceChange: setSourceFilter,
  onRefresh: refreshData,
  onToggleManage: toggleDailyManageMenu,
  onManage: handleDailyManageAction,
  onGenerateCards: generateMissingTodayAiCards,
  onExport: exportSelected,
  onShiftHistory: shiftHistoryDate,
  onOpenDetail: openDetail,
  onToggleFavorite: toggleFavorite,
  onDismiss: dismissDailyHotRecommendation,
  onGenerateCard: generateTodayAiCard,
  onGenerateToday: handleGenerateTodaySnapshot,
  onOpenCodexPreview: openCodexDraftPreview,
  onToggleCodexFavorite: toggleCodexDraftFavorite,
  onCodexFeedback: applyCodexDraftFeedback,
  onError: error => {
    console.warn('每日热门页面操作失败', error);
    showToast('每日热门页面操作失败，请刷新后重试');
  }
});

createFavoritesPageController({
  root: document.getElementById('page-favorites'),
  onOpenDetail: openDetail,
  onToggleFavorite: toggleFavorite,
  onToggleStatus: toggleStatusMenu,
  onSelectStatus: selectFavoriteStatus,
  onAddManualWord: openManualWordModal,
  onExport: exportSelected,
  onSourceFilter: value => setSourceFilter('favorites', value),
  onStatusFilter: setStatusFilter,
  onError: error => {
    console.warn('收藏页操作失败', error);
    showToast('收藏页操作失败，请刷新后重试');
  }
});

createPublishedPageController({
  root: document.getElementById('page-published'),
  onOpenDetail: openPublishedDetail,
  onEditRecord: openPublishedRecordModal,
  onAddRecord: openPublishedRecordModal,
  onRefresh: refreshPublishedMetrics,
  onRender: renderPublished,
  onError: error => {
    console.warn('已发布页面操作失败', error);
    showToast('已发布页面操作失败，请刷新后重试');
  }
});

init();

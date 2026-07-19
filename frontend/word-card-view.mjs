import { cleanAiCard } from '../shared/workflow-schema.mjs';

const WORD_CARD_STATUS_LABELS = {
  none: '未生成词卡',
  pending: '生成中',
  ready: '已生成词卡',
  failed: '生成失败',
  stale: '需重新生成'
};

const EMPTY_FORMAL_CONTENT = Object.freeze({
  summary: '',
  explanation: '',
  usageScenes: [],
  examples: [],
  suggestedTitles: [],
  coverSuggestion: {},
  contentAngles: [],
  targetAudience: '',
  referenceDirection: '',
  riskWarning: '',
  wrongUsage: '',
  similarWords: [],
  interactionPrompts: []
});

function text(value = '') {
  return String(value || '').trim();
}

export function buildWordCardViewModel(options = {}) {
  const word = options.word || {};
  const entry = options.entry || {};
  const card = cleanAiCard(options.aiCard || entry.aiCard || word.aiCard || {});
  const storedStatus = card.cardStatus || 'none';
  const status = options.inFlight ? 'pending' : storedStatus;
  const hasFormalCard = storedStatus === 'ready';
  const formalContent = hasFormalCard ? {
    summary: card.summary,
    explanation: card.explanation,
    usageScenes: card.usageScenes,
    examples: card.examples,
    suggestedTitles: card.suggestedTitles,
    coverSuggestion: card.coverSuggestion,
    contentAngles: card.contentAngles,
    targetAudience: card.targetAudience,
    referenceDirection: card.referenceDirection,
    riskWarning: card.riskWarning,
    wrongUsage: card.wrongUsage,
    similarWords: card.similarWords,
    interactionPrompts: card.interactionPrompts
  } : EMPTY_FORMAL_CONTENT;
  const referenceImageUrl = hasFormalCard
    && card.referenceImage?.status === 'ready'
    && text(card.referenceImage.url)
      ? text(card.referenceImage.url)
      : '';
  const coverSuggestion = formalContent.coverSuggestion || {};
  const statusLabel = status === 'pending' && options.stalePending
    ? '生成超时'
    : (WORD_CARD_STATUS_LABELS[status] || WORD_CARD_STATUS_LABELS.none);
  const title = formalContent.suggestedTitles[0] || '';
  const unavailableMessage = status === 'pending'
    ? (options.stalePending
        ? 'DeepSeek 词卡生成已超时，请重新生成。正式内容就绪前不会展示推荐标题、例句或参考图。'
        : 'DeepSeek 词卡生成中。生成完成后会刷新为正式词卡内容。')
    : status === 'failed'
      ? 'DeepSeek 词卡生成失败，请重试。失败结果不会作为正式词卡展示。'
      : status === 'stale'
        ? '这张 DeepSeek 词卡需要重新生成。更新完成前不会展示旧的正式内容。'
        : '该词还没有生成 DeepSeek 词卡。未生成前不展示推荐标题、例句、详细解释、错误用法或互动引导。';

  return {
    card,
    storedStatus,
    status,
    statusLabel,
    hasFormalCard,
    hasReferenceImage: Boolean(referenceImageUrl),
    referenceImageUrl,
    formalContent,
    title,
    summary: formalContent.summary,
    explanation: formalContent.explanation,
    usageScenes: formalContent.usageScenes,
    examples: formalContent.examples,
    suggestedTitles: formalContent.suggestedTitles,
    coverSuggestion,
    hasCoverSuggestion: Boolean(coverSuggestion.coverText || coverSuggestion.mainVisual || coverSuggestion.style || coverSuggestion.avoid),
    contentAngles: formalContent.contentAngles,
    targetAudience: formalContent.targetAudience,
    referenceDirection: formalContent.referenceDirection,
    riskWarning: formalContent.riskWarning,
    wrongUsage: formalContent.wrongUsage,
    similarWords: formalContent.similarWords,
    interactionPrompts: formalContent.interactionPrompts,
    listTitle: hasFormalCard ? (title || 'DeepSeek 词卡已生成') : statusLabel,
    basic: {
      kanji: text(word.kanji || entry.kanji),
      kana: text(entry.kana || word.kana || word.reading),
      romaji: text(entry.romaji || word.romaji),
      meaning: text(word.meaning || entry.meaning)
    },
    unavailableMessage
  };
}

export { EMPTY_FORMAL_CONTENT, WORD_CARD_STATUS_LABELS };

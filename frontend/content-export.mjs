export const RECOMMENDATION_AUDIT_HEADERS = Object.freeze([
  '日期', '日语词', '读音', '中文意思', '推荐等级', '风险状态', '来源类型', '来源说明',
  '是否 DeepSeek 新生成', '是否候选池旧词', '是否补位', '是否本地兜底', '是否去重放宽',
  '使用的去重天数', '最终分', '账号学习加分', '账号学习扣分', '表达价值分', '中文透明度',
  '是否泛话题词', '入选原因', '诊断结论'
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function csvCell(value) {
  const text = safeArray(value).join('；') || String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildRecommendationAuditCsv({ audit = {}, words = [], riskStateByKanji = {} } = {}) {
  const wordsByKanji = new Map(safeArray(words).map(word => [word?.kanji, word || {}]));
  const lines = [RECOMMENDATION_AUDIT_HEADERS.map(csvCell).join(',')];
  safeArray(audit.items).forEach(item => {
    const word = wordsByKanji.get(item?.kanji) || {};
    lines.push([
      audit.date,
      item?.kanji,
      word.reading || word.kana || word.romaji || '',
      item?.meaning || word.meaning || '',
      item?.recommendationLevel,
      riskStateByKanji?.[item?.kanji] || item?.riskLevel || '',
      item?.originType,
      item?.originLabel,
      item?.fromDeepSeekNew ? '是' : '否',
      item?.fromCandidatePool ? '是' : '否',
      item?.isBackfill ? '是' : '否',
      item?.fromLocalFallback ? '是' : '否',
      item?.isDedupRelaxed ? '是' : '否',
      item?.dedupDaysUsed,
      item?.finalScore,
      item?.accountLearningBonus,
      item?.accountLearningPenalty,
      item?.expressionValueScore,
      item?.chineseTransparencyScore,
      item?.genericTopicPenalty ? '是' : '否',
      item?.selectedReason,
      safeArray(item?.diagnosis).join('；')
    ].map(csvCell).join(','));
  });
  return lines.join('\n');
}

export function getRecommendationAuditFilename(dateKey) {
  return `daily-hot-audit-${String(dateKey || '').trim()}.csv`;
}

export function buildFavoriteSelectionExportText({ dateLabel = '', items = [] } = {}) {
  let text = '🍞 记忆面包 — 小红书日语选题导出\n';
  text += `📅 ${String(dateLabel || '').trim()}\n\n`;
  safeArray(items).forEach((item, index) => {
    const word = item?.word || {};
    const wordCardView = item?.wordCardView || {};
    text += `${index + 1}. 【${word.kanji || ''}】${word.reading || ''}\n`;
    text += `   中文：${word.meaning || ''}\n`;
    text += `   状态：${item?.statusLabel || ''}\n`;
    if (!wordCardView.hasFormalCard) {
      text += `   ${wordCardView.unavailableMessage || 'DeepSeek 正式词卡未生成'}\n\n`;
      return;
    }
    text += `   推荐标题：${safeArray(wordCardView.suggestedTitles).join(' / ') || '—'}\n`;
    text += `   摘要：${wordCardView.summary || '—'}\n`;
    text += `   详细解释：${wordCardView.explanation || '—'}\n`;
    text += `   内容角度：${safeArray(wordCardView.contentAngles).join(' / ') || '—'}\n`;
    text += `   例句：${safeArray(wordCardView.examples).map(example => `${example?.jp || ''}${example?.cn ? `（${example.cn}）` : ''}`).join('；') || '—'}\n`;
    text += `   封面建议：${wordCardView.coverSuggestion?.coverText || ''} ${wordCardView.coverSuggestion?.mainVisual || ''} ${wordCardView.coverSuggestion?.style || ''}`.trim() + '\n';
    text += `   互动引导：${safeArray(wordCardView.interactionPrompts).join(' / ') || '—'}\n\n`;
  });
  return text;
}

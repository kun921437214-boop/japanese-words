// Existing sanitized Codex test fixture; no private exports.
const CODEX_DAILY_WORD_COUNT = 10;
const DAILY_CURATED_WORDS = ['モヤる','しんみり','かぶる','気を遣う','タイパ','サブスク','メロい','オーロラ肌','シアーレイヤード','余裕'];
function makeCard(word, imageReady = false) {
  return {
    cardStatus: 'ready',
    cardSource: 'codex',
    cardModel: 'codex',
    generatedAt: '2026-07-13T06:00:00.000Z',
    summary: `${word} 是一个适合中文用户收藏的日语表达。`,
    explanation: `先从真实生活场景理解 ${word}，再说明语感边界，不写成教材释义。`,
    usageScenes: ['朋友聊天', '记录生活状态'],
    examples: [
      { jp: `${word}って感じ。`, kana: `${word}ってかんじ。`, romaji: `${word} tte kanji.`, cn: '就是这种感觉。', note: '朋友聊天时的自然说法。' },
      { jp: `今日は${word}。`, kana: `きょうは${word}。`, romaji: `kyou wa ${word}.`, cn: '今天很有这种状态。', note: '记录当天状态。' }
    ],
    suggestedTitles: [`日本人说「${word}」，其实是这种感觉`, `「${word}」不是直译那么简单`, `这个日语词，太适合形容我的状态了`],
    coverSuggestion: { coverText: word, mainVisual: '真实生活场景，主体明确', style: '自然', avoid: '教材课件' },
    contentAngles: ['语感差异', '生活场景', '容易误用的边界'],
    targetAudience: '想积累自然日语表达的中文用户',
    referenceDirection: '使用无文字、无品牌标识的生活场景图',
    riskWarning: '低风险口语表达，正式场合仍需结合语境。',
    wrongUsage: '不要脱离语境机械套用。',
    similarWords: [{ word: '似た表現', romaji: 'nita hyougen', meaning: '相近表达', difference: '语气和使用场景不同。' }],
    interactionPrompts: ['你会在什么场景用它？', '你还见过哪些相近表达？'],
    referenceImage: {
      status: imageReady ? 'ready' : 'missing',
      url: imageReady ? `/codex-image?key=codex-daily/2026-07-14/${encodeURIComponent(word)}.webp` : '',
      visualBrief: '真实生活场景',
      prompt: `为 ${word} 生成参考图片`,
      provider: 'codex',
      generatedAt: imageReady ? '2026-07-13T06:00:00.000Z' : ''
    }
  };
}

function makeDraft(words = DAILY_CURATED_WORDS, options = {}) {
  return {
    targetDateKey: options.targetDateKey || '2026-07-14',
    threadId: '019f5c0e-3d15-75b2-92b1-5f6cb05610aa',
    generatorVersion: 'codex-daily-v1',
    items: words.map((kanji, index) => ({
      ...(() => {
        const emotionWords = new Set(['モヤる', 'しんみり']);
        const socialWords = new Set(['かぶる', '気を遣う']);
        const abbreviationWords = new Set(['タイパ', 'サブスク']);
        const beautyWords = new Set(['オーロラ肌', 'シアーレイヤード']);
        if (emotionWords.has(kanji)) return {
          category: '情绪状态',
          candidateType: '网络口语词',
          reason: '情绪状态表达，中文不好直译，有收藏价值。'
        };
        if (socialWords.has(kanji)) return {
          category: '人际语感',
          candidateType: '稳定候选',
          reason: '人际关系和社交语感表达，适合中文用户收藏。'
        };
        if (abbreviationWords.has(kanji)) return {
          category: '日常缩略语',
          candidateType: '网络口语词',
          meaning: kanji === 'タイパ'
            ? '时间性价比；「タイムパフォーマンス」的缩略语'
            : '订阅制；「サブスクリプション」的缩略语',
          reason: '成熟日常缩略语，说明完整形式与稳定用法。'
        };
        if (kanji === 'メロい') return {
          category: '流行表达',
          candidateType: '新鲜梗词',
          freshness: '短期',
          evidenceType: 'trend_claim',
          displayBucket: 'meme_fast',
          reason: '有时间证据的低风险流行表达。',
          evidenceCheckedAt: '2026-07-10T06:00:00.000Z',
          evidenceSources: [{ label: '公开青年趋势调查', url: 'https://example.invalid/trend' }],
          realUsageExamples: ['メロい表情で話題になった。', 'この仕草が本当にメロい。'],
          usageScope: '年轻人社交媒体口语',
          stabilityLevel: 'short_term',
          trendPeriod: '2026年7月',
          qualityGateStatus: 'ready'
        };
        if (beautyWords.has(kanji)) return {
          category: '美妆穿搭表达',
          candidateType: '美妆穿搭词',
          reason: '具体美妆穿搭表达，可视化且能讲语感差异。'
        };
        return {
          category: '生活状态',
          candidateType: '生活方式词',
          reason: '有生活状态场景和收藏价值，作为灵活补位。'
        };
      })(),
      kanji,
      kana: kanji,
      romaji: `word-${index + 1}`,
      meaning: kanji === 'タイパ'
        ? '时间性价比；「タイムパフォーマンス」的缩略语'
        : kanji === 'サブスク'
          ? '订阅制；「サブスクリプション」的缩略语'
          : `${kanji} 的中文含义说明`,
      xhsFitScore: index < 6 ? 92 : 84,
      riskLevel: 'low',
      confidenceLevel: 'high',
      aiCard: makeCard(kanji, Boolean(options.imageReady))
    }))
  };
}


export { makeDraft };

// Sanitized interaction examples. Used only after explicitly choosing the demo.
const dateKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const entries = [
  ['余白', 'よはく', '给生活留一点空白', '生活状态', '行程没有排满的周末，反而让人重新找回自己的节奏。'],
  ['気分転換', 'きぶんてんかん', '换个心情，再继续', '情绪状态', '工作卡住时，去楼下散散步，也是一种认真对待自己。'],
  ['寄り道', 'よりみち', '偶尔绕个路，也很好', '生活场景', '回家的路上，走进一家一直想去的小店。'],
  ['木漏れ日', 'こもれび', '树叶间漏下来的阳光', '季节文化', '散步时抬头，那一小片光就值得停一下。']
];
function workflow() {
  const pool = {};
  entries.forEach(([kanji, kana, meaning, category, summary], i) => {
    pool[kanji] = { kanji, kana, meaning, category, candidateProjection: 'detail', aiCard: i === 3 ? { cardStatus: 'pending' } : {
      cardStatus: 'ready', projection: 'detail', summary,
      explanation: `示例内容：${meaning}。这张卡用于体验阅读、收藏和复制操作，不能作为已审核的发布内容。`,
      usageScenes: ['忙碌一天后的片刻放松', '记录一个普通但值得分享的瞬间'],
      examples: [{ jp: i === 0 ? '週末は予定を詰め込まず、余白を残したい。' : '少し歩いて、気分転換しよう。', kana: '', romaji: '', cn: i === 0 ? '周末不想把日程排满，想留一点空白。' : '走一走，换换心情吧。', note: '交互演示例句' }],
      suggestedTitles: [`${meaning}，日语里原来这样说`, `今天想把「${kanji}」送给你`],
      coverSuggestion: { coverText: meaning, mainVisual: '浅色背景，柔和光影，生活感画面。' },
      similarWords: [], interactionPrompts: ['最近有什么小事，让你放松了一下？'], referenceImage: { status: 'missing' }
    } };
  });
  return { words: ['寄り道'], statuses: {}, candidatePool: pool, todaySnapshot: { dateKey: dateKey(), words: entries.map(e => e[0]) }, publishedRecords: [], revision: 1, updated: new Date().toISOString() };
}
module.exports = { workflow };

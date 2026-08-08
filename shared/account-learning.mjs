export const ACCOUNT_LEARNING_VERSION = 'xhs-account-learning-v2-content-mix';

const ACCOUNT_LEARNING_SUMMARY = Object.freeze({
  version: ACCOUNT_LEARNING_VERSION,
  sourceReport: 'account-intelligence/xhs-account-learning-report.md',
  accountPositioning: '小红书日语选题后台，优先服务中文用户共鸣、收藏、标题封面和图文内容制作，不是普通日语词典。',
  preferredDirections: [
    '情绪状态',
    '人际关系',
    '社交语感',
    '成熟日常缩略语',
    '有时间证据的低风险流行表达',
    '具体且可视化的美妆穿搭表达',
    '生活场景',
    '学习状态',
    '大众可理解的圈层兴趣'
  ],
  avoidDirections: [
    '过度谐音梗',
    '过度圈层',
    '太基础',
    '太教材',
    '不好配图',
    '浏览高但收藏弱',
    '词义不稳定',
    '没有时间证据却包装成流行词',
    '泛美妆或泛时尚标签',
    '同日完整词组过多',
    '高风险或需复核'
  ],
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
  coverPatterns: [
    '中文大字 + 日语小字',
    '情绪 / 场景优先',
    '短句优先',
    '不要全日语封面',
    '不要像教材课件'
  ],
  selectionRules: [
    '收藏率比浏览量更重要',
    '互动率比单纯点赞更重要',
    '浏览高但收藏低不要强加权',
    '如果表现差来自标题、封面、发布时间或曝光不足，不要过度惩罚词本身',
    '如果表现差来自词本身不适合账号，降低类似词权重',
    '圈层词必须能翻译成大众可理解的情绪或生活场景',
    '每 10 词按 4 个情绪/人际核心、2 个成熟日常缩略语、1 个已验证流行表达、2 个具体美妆/穿搭表达、1 个灵活补位组织',
    '完整词组同日最多 2 个，长句式或惯用语最多 1 个',
    '成熟缩略语要说明完整形式；来源不明或疑似自造缩写进入复核',
    '泛“流行词”标题不自动加权，仍以成熟选题表现为准'
  ],
  wordCardRules: [
    '不要像词典',
    '不要像教材',
    '先给场景，再解释词',
    '标题要有小红书感',
    '封面文案要短',
    '例句要自然',
    '风险要诚实',
    '优先生成适合收藏、适合发布、适合做图文的内容'
  ]
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getAccountLearningSummary() {
  return clone(ACCOUNT_LEARNING_SUMMARY);
}

export function getAccountLearningPromptContext() {
  const summary = getAccountLearningSummary();
  return {
    accountPositioning: summary.accountPositioning,
    preferredDirections: summary.preferredDirections,
    avoidDirections: summary.avoidDirections,
    titlePatterns: summary.titlePatterns,
    coverPatterns: summary.coverPatterns,
    selectionRules: summary.selectionRules,
    wordCardRules: summary.wordCardRules,
    scoringRules: summary.scoringRules
  };
}

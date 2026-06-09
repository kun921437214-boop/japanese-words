export const ACCOUNT_LEARNING_VERSION = 'xhs-account-learning-v1';

const ACCOUNT_LEARNING_SUMMARY = Object.freeze({
  version: ACCOUNT_LEARNING_VERSION,
  sourceReport: 'account-intelligence/xhs-account-learning-report.md',
  accountPositioning: '小红书日语选题后台，优先服务中文用户共鸣、收藏、标题封面和图文内容制作，不是普通日语词典。',
  preferredDirections: [
    '情绪状态',
    '人际关系',
    '社交语感',
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
    '圈层词必须能翻译成大众可理解的情绪或生活场景'
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

const words = [
  { kanji: 'モヤる', meaning: '说不清道不明的烦躁感', finalScore: 96, expressionValueScore: 100 },
  { kanji: 'テンション', meaning: '情绪高涨或低落', finalScore: 96, expressionValueScore: 82 },
  { kanji: '甘えん坊', meaning: '爱撒娇、粘人的人', finalScore: 96, expressionValueScore: 80 },
  { kanji: 'もやもや', meaning: '心里堵得慌、说不清的烦躁', finalScore: 82, expressionValueScore: 86 },
  { kanji: '失礼します', meaning: '打扰了、先告辞了', finalScore: 96, expressionValueScore: 85 },
  { kanji: '心地よい', meaning: '舒适、惬意', finalScore: 96, expressionValueScore: 85 },
  { kanji: 'ツンデレ', meaning: '傲娇、外冷内热', finalScore: 96, expressionValueScore: 82 },
  { kanji: '余裕', meaning: '从容、有余地', finalScore: 96, expressionValueScore: 83 },
  { kanji: '充実', meaning: '充实、满足', finalScore: 96, expressionValueScore: 82 },
  { kanji: '積み重ね', meaning: '日积月累', finalScore: 96, expressionValueScore: 79 },
  { kanji: '仕切り直し', meaning: '重新调整、重启', finalScore: 96, expressionValueScore: 78 },
  { kanji: 'ツヤ肌', meaning: '有光泽、水润的皮肤状态', finalScore: 96, expressionValueScore: 90 },
  { kanji: '涙袋メイク', meaning: '卧蚕妆、眼下提亮妆', finalScore: 96, expressionValueScore: 86 },
  { kanji: 'アンニュイ', meaning: '慵懒倦怠中带点时髦的忧郁感', finalScore: 96, expressionValueScore: 84 },
  { kanji: 'ソロキャンプ', meaning: '独自露营', finalScore: 96, expressionValueScore: 78 },
  { kanji: '見切り', meaning: '主动判断该放手了、及时止损', finalScore: 96, expressionValueScore: 77 },
  { kanji: 'リフレッシュ', meaning: '主动让自己焕然一新', finalScore: 96, expressionValueScore: 76 },
  { kanji: 'おけまる', meaning: 'OK 的可爱变体，没问题', finalScore: 96, expressionValueScore: 76 },
  { kanji: '頑張る', meaning: '努力、坚持、不放弃', finalScore: 96, expressionValueScore: 75 },
  { kanji: '集中', meaning: '专注、排除干扰', finalScore: 96, expressionValueScore: 74 }
];

const clusterMap = new Map([
  ['モヤる', 'moya_state'],
  ['もやもや', 'moya_state'],
  ['テンション', 'tension_mood'],
  ['テンション上がる', 'tension_mood'],
  ['テンション下がる', 'tension_mood'],
  ['空気読む', 'read_the_room'],
  ['空気を読む', 'read_the_room'],
  ['空気読める', 'read_the_room'],
  ['気を遣う', 'consideration'],
  ['気遣い', 'consideration'],
  ['推し', 'oshi_identity'],
  ['自担', 'oshi_identity'],
  ['同担', 'oshi_identity']
]);
const basicPoliteWords = new Set(['失礼します']);
const genericBasicWords = new Set(['テンション', '頑張る', '集中', '充実']);
const beautyWords = new Set(['ツヤ肌', '涙袋メイク']);

function clusterKey(word) {
  return clusterMap.get(word.kanji) || `word:${word.kanji}`;
}

function grade(word, options) {
  const blocksS = options.isDuplicateClusterSecondary
    || options.isBeautyCategorySecondary
    || options.isBasicPolite
    || options.isGenericBasic
    || word.expressionValueScore < 78;
  if (word.finalScore >= 90 && !blocksS) return 'S';
  if (word.finalScore >= 80) return 'A';
  if (word.finalScore >= 70) return 'B';
  return 'C';
}

const clusterBuckets = words.reduce((result, word) => {
  const key = clusterKey(word);
  result[key] = result[key] || [];
  result[key].push(word.kanji);
  return result;
}, {});
const duplicateClusters = Object.entries(clusterBuckets)
  .filter(([, list]) => list.length > 1)
  .map(([key, list]) => ({ key, words: list }));
const beautyList = words.filter(word => beautyWords.has(word.kanji));
const items = words.map(word => {
  const key = clusterKey(word);
  const isDuplicateClusterSecondary = clusterBuckets[key].length > 1 && clusterBuckets[key][0] !== word.kanji;
  const isBeautyCategorySecondary = beautyList.length > 1 && beautyList[0].kanji !== word.kanji && beautyWords.has(word.kanji);
  const isBasicPolite = basicPoliteWords.has(word.kanji);
  const isGenericBasic = genericBasicWords.has(word.kanji);
  return {
    ...word,
    semanticClusterKey: key,
    isDuplicateCluster: clusterBuckets[key].length > 1,
    qualityCategory: isBasicPolite ? 'basic_polite' : beautyWords.has(word.kanji) ? 'beauty_category' : isGenericBasic ? 'generic_basic' : 'xhs_expression',
    recommendationLevel: grade(word, { isDuplicateClusterSecondary, isBeautyCategorySecondary, isBasicPolite, isGenericBasic })
  };
});

const sLevelCount = items.filter(item => item.recommendationLevel === 'S').length;
const beautyCategoryCount = beautyList.length;
const basicPoliteCount = items.filter(item => item.qualityCategory === 'basic_polite').length;
const genericBasicCount = items.filter(item => item.qualityCategory === 'generic_basic').length;
const averageFinalScore = Math.round(items.reduce((sum, item) => sum + item.finalScore, 0) / items.length);
const rawHealthPenalty = duplicateClusters.length * 7
  + Math.max(0, beautyCategoryCount - 1) * 5
  + basicPoliteCount * 6
  + genericBasicCount * 4
  + (sLevelCount >= 10 ? 6 : 0);
const estimatedPenalty = Math.round(Math.min(rawHealthPenalty, 28) * 0.45);
const estimatedHumanQualityScore = Math.max(0, Math.min(100, averageFinalScore - estimatedPenalty));
const healthWarnings = [
  ...duplicateClusters.map(cluster => `同语义簇重复：${cluster.words.join(' / ')}`),
  beautyCategoryCount > 1 ? `美妆品类词同日 ${beautyCategoryCount} 个，建议最多 1 个强推` : '',
  basicPoliteCount ? `基础礼貌 / 教材寒暄词 ${basicPoliteCount} 个，不应默认 S` : '',
  genericBasicCount >= 3 ? `泛基础词 ${genericBasicCount} 个，S/A 分层需要更保守` : '',
  sLevelCount >= 10 ? '推荐等级过松，需要收紧 S/A 评分标准。' : ''
].filter(Boolean);

const summary = {
  duplicateClusterCount: duplicateClusters.length,
  duplicateClusters,
  beautyCategoryCount,
  basicPoliteCount,
  genericBasicCount,
  healthWarnings,
  estimatedHumanQualityScore,
  sLevelCount,
  aLevelCount: items.filter(item => item.recommendationLevel === 'A').length,
  bLevelCount: items.filter(item => item.recommendationLevel === 'B').length,
  cLevelCount: items.filter(item => item.recommendationLevel === 'C').length
};

const failures = [];
if (summary.duplicateClusterCount < 1) failures.push('duplicateClusterCount should be >= 1');
if (summary.beautyCategoryCount !== 2) failures.push('beautyCategoryCount should equal 2');
if (summary.basicPoliteCount < 1) failures.push('basicPoliteCount should be >= 1');
if (summary.genericBasicCount < 3) failures.push('genericBasicCount should be >= 3');
if (!summary.healthWarnings.some(text => text.includes('推荐等级过松'))) failures.push('healthWarnings should include loose grading warning');
if (summary.estimatedHumanQualityScore > 90) failures.push('estimatedHumanQualityScore should not exceed 90');
if (summary.sLevelCount < 8 || summary.sLevelCount > 12) failures.push('sLevelCount should be around 8-12');

console.log(JSON.stringify({ summary, items }, null, 2));

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

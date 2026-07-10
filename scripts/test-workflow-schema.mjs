import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cleanStoredWorkflow,
  mergeWorkflow,
  mergeWorkflowForFullSave,
  stripInvalidCurrentTodaySnapshot
} from '../shared/workflow-schema.mjs';
import {
  generateTodaySnapshot,
  getRecentDailyHotBlockedWords,
  TODAY_HISTORY_DEDUP_DAYS,
  TODAY_SNAPSHOT_GENERATOR_VERSION,
  isCurrentGeneratorSnapshot
} from '../shared/today-snapshot.mjs';
import {
  buildDailyQualityContext,
  buildDailyQualitySummary,
  getDailyQualityCategory,
  getDailyQualityScoreDelta
} from '../shared/today-quality.mjs';
import { getAccountLearningSummary } from '../shared/account-learning.mjs';
import { buildDeepSeekExclusionContext } from '../shared/deepseek-exclusion.mjs';
import { applyFavoriteAction } from '../functions/favorites.js';
import {
  applyAiCardGenerationResult,
  isAiCardStalePending,
  selectTodayAiCardTargets,
  summarizeTodayAiCards
} from '../functions/ai-cards.js';
import { getTodayAiCardBatchPlan } from '../worker/favorites-worker.js';

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const readyCard = {
  cardStatus: 'ready',
  cardSource: 'deepseek_api',
  cardModel: 'deepseek-v4-flash',
  generatedAt: '2026-05-30T01:00:00.000Z',
  summary: '小红书审美表达。',
  explanation: '用于描述自然又不费力的审美氛围。',
  examples: [{ jp: 'こなれ感がある。', cn: '很有随性的高级感。' }],
  suggestedTitles: ['日本人说「こなれ」，不是普通熟练'],
  interactionPrompts: ['你会用它形容哪种穿搭？']
};

test('前端初始化不会自动触发今日推荐生成', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal((appSource.match(/queueDailyAutoRefreshIfNeeded\(/g) || []).length, 1);
  assert.ok(appSource.includes('if (!options.force) return false;'));
  assert.equal(appSource.includes('正在自动生成今日推荐'), false);
  assert.equal(appSource.includes('自动生成中'), false);
  assert.ok(appSource.includes('function handleGenerateTodaySnapshot()'));
});

test('scheduled Worker 分离日更和 aiCard 批量 cron', () => {
  const workerConfig = fs.readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  const workerSource = fs.readFileSync(new URL('../worker/favorites-worker.js', import.meta.url), 'utf8');

  assert.ok(workerConfig.includes('"0 16 * * *"'));
  assert.ok(workerConfig.includes('"10,20,30,40,50 16 * * *"'));
  assert.ok(workerConfig.includes('"0 17 * * *"'));
  assert.ok(workerSource.includes("const DAILY_REFRESH_CRON = '0 16 * * *';"));
  assert.ok(workerSource.includes("const AI_CARD_BATCH_MAX_WORDS = 5;"));
  assert.ok(workerSource.includes("new URL(`${siteUrl}/daily-refresh`)"));
  assert.ok(workerSource.includes("refreshUrl.searchParams.set('mode', 'manual')"));
  assert.ok(workerSource.includes("refreshUrl.searchParams.set('skipCards', 'true')"));
  assert.ok(workerSource.includes('Authorization: `Bearer ${autoRefreshSecret}`'));
  assert.ok(workerSource.includes("new URL(`${siteUrl}/ai-cards`)"));
  assert.ok(workerSource.includes("mode: 'today'"));
  assert.ok(workerSource.includes('maxWords: AI_CARD_BATCH_MAX_WORDS'));
  assert.ok(workerSource.includes('retryStalePending: plan.retryStalePending'));
  assert.ok(workerSource.includes('if (plan.activePendingCount > 0)'));
  assert.ok(workerSource.includes('cron !== DAILY_REFRESH_CRON'));
  assert.equal(workerSource.includes('force: true'), false);
  assert.equal(workerSource.includes('retryFailed: true'), false);
});

test('scheduled Worker retries stale pending cards without blocking missing cards', () => {
  const plan = getTodayAiCardBatchPlan({
    readyCount: 1,
    missingCount: 14,
    pendingCount: 5,
    stalePendingCount: 5
  });
  assert.equal(plan.activePendingCount, 0);
  assert.equal(plan.retryStalePending, true);
  assert.equal(plan.shouldRun, true);
});

test('scheduled Worker still waits while card generation is actively pending', () => {
  const plan = getTodayAiCardBatchPlan({
    readyCount: 8,
    missingCount: 10,
    pendingCount: 2,
    stalePendingCount: 1
  });
  assert.equal(plan.activePendingCount, 1);
  assert.equal(plan.retryStalePending, true);
  assert.equal(plan.shouldRun, false);
});

function makeQualityCandidate(kanji, overrides = {}) {
  return {
    kanji,
    meaning: `${kanji} 的小红书表达场景`,
    sourceType: 'deepseek_generated',
    displayBucket: 'today',
    riskLevel: 'low',
    confidenceLevel: 'high',
    evidenceType: 'common_usage',
    lastReviewState: 'approved',
    expressionValueScore: 84,
    xhsFitScore: 82,
    candidateType: '生活方式词',
    reason: '有情绪、社交或生活状态画面，适合标题封面收藏。',
    ...overrides
  };
}

test('daily quality audit flags 2026-06-29 basic greeting heavy set', () => {
  const entries = [
    'ありがとうございます',
    'おはようございます',
    'お願いします',
    'ぐっと',
    'こんにちは',
    'こんばんは',
    'しんみり',
    'ほのぼの',
    'かぶる',
    'だらける',
    '胸きゅん',
    'お疲れ気味',
    'やる気',
    '神回',
    'かわちい',
    'ちゅき',
    'アイシャドウベース',
    'くすみ',
    'わくわく',
    'グロスリップ'
  ].map(kanji => makeQualityCandidate(kanji));
  const summary = buildDailyQualitySummary(entries);
  assert.equal(summary.categoryCounts.basic_greeting, 4);
  assert.equal(summary.categoryCounts.textbook_polite, 1);
  assert.equal(summary.categoryCounts.beauty_product, 2);
  assert.equal(summary.categoryCounts.cute_slang, 3);
  assert.equal(summary.relaxed, true);
  assert.ok(summary.warnings.some(text => text.includes('basic_greeting_textbook_polite')));
  assert.ok(summary.warnings.some(text => text.includes('beauty_product')));
  assert.ok(summary.warnings.some(text => text.includes('cute_slang')));
});

test('daily snapshot selection limits basic, beauty, fandom and keeps account-fit categories', () => {
  const emotionWords = ['ぐっと', 'しんみり', 'ほのぼの', 'わくわく', 'お疲れ気味'];
  const socialWords = ['かぶる', '気が合う', '気が置けない', '気を遣う'];
  const lifeWords = ['だらける', '追い込み', '積みゲー', '気分転換', '気が散る'];
  const basicWords = ['ありがとうございます', 'おはようございます', 'こんにちは', 'こんばんは'];
  const politeWords = ['お願いします', 'よろしくお願いします'];
  const beautyWords = ['アイシャドウベース', 'グロスリップ', 'マスカラ'];
  const fandomWords = ['推し増し', '尊み', '沼落ち', '解釈一致'];
  const neutralWords = ['落ち合う', 'やりくり', '煮詰まる', 'そわそわ', 'ドキドキ'];
  const candidatePool = {};
  [
    ...emotionWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '网络口语词', reason: '情绪状态，中文不好直译，有收藏价值。' })),
    ...socialWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '稳定候选', reason: '人际关系和社交语感表达。' })),
    ...lifeWords.map(kanji => makeQualityCandidate(kanji, { candidateType: '生活方式词', reason: '生活学习状态场景。' })),
    ...basicWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 95, candidateType: '稳定候选', reason: '基础问候。' })),
    ...politeWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 94, candidateType: '稳定候选', reason: '教材礼貌表达。' })),
    ...beautyWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 93, candidateType: '美妆穿搭词', reason: '美妆品类名。' })),
    ...fandomWords.map(kanji => makeQualityCandidate(kanji, { xhsFitScore: 92, candidateType: '追星兴趣词', reason: '追星圈层表达。' })),
    ...neutralWords.map(kanji => makeQualityCandidate(kanji))
  ].forEach(entry => {
    candidatePool[entry.kanji] = entry;
  });
  const { result } = generateTodaySnapshot({ candidatePool }, {
    now: new Date('2026-06-30T01:00:00.000Z'),
    createdBy: 'server'
  });
  const words = result.todaySnapshot.words;
  const categories = words.map(word => getDailyQualityCategory(candidatePool[word]));
  const countCategory = category => categories.filter(item => item === category).length;
  assert.equal(words.length, 20);
  assert.ok(countCategory('basic_greeting') + countCategory('textbook_polite') <= 1);
  assert.ok(countCategory('beauty_product') <= 1);
  assert.ok(countCategory('fandom_circle') <= 2);
  assert.ok(countCategory('emotion_state') >= 4);
  assert.ok(countCategory('social_nuance') >= 3);
  assert.ok(countCategory('life_state') >= 4);
  assert.equal(result.recommendationAudit.qualitySummary.relaxed, false);
});

test('daily quality scoring penalizes recent semantic cluster repeats', () => {
  const workflow = {
    historySnapshots: {
      '2026-06-20': { dateKey: '2026-06-20', words: ['気が合う'] },
      '2026-05-01': { dateKey: '2026-05-01', words: ['気が置けない'] }
    }
  };
  const entry = makeQualityCandidate('気が楽', { reason: '情绪状态和気が表达。' });
  const repeatedContext = buildDailyQualityContext(workflow, { today: '2026-06-29' });
  const emptyContext = buildDailyQualityContext({}, { today: '2026-06-29' });
  assert.ok(getDailyQualityScoreDelta(entry, repeatedContext) < getDailyQualityScoreDelta(entry, emptyContext));
});

test('getAccountLearningSummary 提供账号学习规则入口', () => {
  const summary = getAccountLearningSummary();
  assert.ok(summary.preferredDirections.includes('情绪状态'));
  assert.ok(summary.avoidDirections.includes('太教材'));
  assert.ok(summary.titlePatterns.length >= 3);
  assert.ok(summary.coverPatterns.includes('不要像教材课件'));
});

test('cleanStoredWorkflow 补齐缺失字段', () => {
  const cleaned = cleanStoredWorkflow({});
  assert.deepEqual(cleaned.words, []);
  assert.deepEqual(cleaned.statuses, {});
  assert.deepEqual(cleaned.feedback, {});
  assert.deepEqual(cleaned.publishedRecords, []);
  assert.deepEqual(cleaned.candidatePool, {});
  assert.deepEqual(cleaned.aiBatches, []);
  assert.deepEqual(cleaned.todaySnapshot.words, []);
  assert.equal(cleaned.schemaVersion, 1);
});

test('cleanStoredWorkflow 不删除 candidatePool.aiCard', () => {
  const cleaned = cleanStoredWorkflow({
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        meaning: '自然熟练的高级感',
        aiCard: readyCard
      }
    }
  });
  assert.equal(cleaned.candidatePool['こなれ'].aiCard.cardStatus, 'ready');
  assert.equal(cleaned.candidatePool['こなれ'].aiCard.summary, readyCard.summary);
});

test('cleanStoredWorkflow 不删除手动添加来源元数据', () => {
  const cleaned = cleanStoredWorkflow({
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '很有情绪氛围',
        sourceTags: ['手动添加'],
        discoverySource: '小红书',
        discoveryContext: '在穿搭内容里看到，适合做标题。'
      }
    }
  });
  assert.equal(cleaned.candidatePool['エモい'].discoverySource, '小红书');
  assert.equal(cleaned.candidatePool['エモい'].discoveryContext, '在穿搭内容里看到，适合做标题。');
  assert.ok(cleaned.candidatePool['エモい'].sourceTags.includes('手动添加'));
});

test('mergeWorkflowForFullSave 保存手动添加词时同时保留收藏和候选库', () => {
  const saved = mergeWorkflowForFullSave(cleanStoredWorkflow({
    words: ['既存词'],
    candidatePool: {
      '既存词': {
        kanji: '既存词',
        sourceType: 'manual_keep',
        meaning: '已有手动词'
      }
    }
  }), {
    words: ['顔面コンプ', '既存词'],
    candidatePool: {
      '顔面コンプ': {
        kanji: '顔面コンプ',
        sourceType: 'manual_keep',
        meaning: '外貌相关自卑感',
        sourceTags: ['手动添加', '受保护'],
        discoverySource: '手动添加',
        discoveryContext: '从评论区看到，想做成选题。',
        aiCard: { cardStatus: 'none' }
      }
    },
    updated: '2026-06-08T10:00:00.000Z'
  });

  assert.ok(saved.words.includes('顔面コンプ'));
  assert.equal(saved.candidatePool['顔面コンプ'].sourceType, 'manual_keep');
  assert.equal(saved.candidatePool['顔面コンプ'].protected, true);
  assert.equal(saved.candidatePool['顔面コンプ'].discoveryContext, '从评论区看到，想做成选题。');
});

test('cleanStoredWorkflow 不删除 todaySnapshot', () => {
  const cleaned = cleanStoredWorkflow({
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['こなれ'],
      generatedAt: '2026-05-31T00:00:00.000Z',
      source: 'candidatePool',
      batchIds: ['batch-a'],
      version: 2
    }
  });
  assert.equal(cleaned.todaySnapshot.dateKey, '2026-05-31');
  assert.deepEqual(cleaned.todaySnapshot.words, ['こなれ']);
});

test('cleanStoredWorkflow 不删除 aiBatches', () => {
  const cleaned = cleanStoredWorkflow({
    aiBatches: [{
      id: 'batch-a',
      action: 'wild_ideas',
      model: 'deepseek-v4-flash',
      createdAt: '2026-05-31T01:00:00.000Z',
      itemCount: 20,
      rawOutput: '{"items":[]}'
    }]
  });
  assert.equal(cleaned.aiBatches.length, 1);
  assert.equal(cleaned.aiBatches[0].id, 'batch-a');
  assert.equal(cleaned.aiBatches[0].rawOutput, '{"items":[]}');
});

test('cleanStoredWorkflow 不删除团队 AI 预览和团队跳过记录', () => {
  const cleaned = cleanStoredWorkflow({
    aiPreview: {
      items: [{ kanji: '抜け感', romaji: 'nukekan', meaning: '松弛留白感', displayBucket: 'today' }],
      selected: ['抜け感'],
      batchId: 'batch-preview',
      savedAt: '2026-05-31T01:00:00.000Z'
    },
    todayDismissed: {
      dateKey: '2026-05-31',
      words: ['ワロタ'],
      updatedAt: '2026-05-31T01:05:00.000Z'
    }
  });
  assert.equal(cleaned.aiPreview.items[0].kanji, '抜け感');
  assert.deepEqual(cleaned.aiPreview.selected, ['抜け感']);
  assert.deepEqual(cleaned.todayDismissed.words, ['ワロタ']);
});

test('mergeWorkflow 合并 candidatePool 时空字段不覆盖 aiCard/reason/riskWarning', () => {
  const merged = mergeWorkflow({
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        reason: '适合穿搭和审美内容。',
        riskWarning: '不要用于正式商务说明。',
        aiCard: readyCard,
        updatedAt: '2026-05-30T01:00:00.000Z'
      }
    }
  }, {
    candidatePool: {
      'こなれ': {
        kanji: 'こなれ',
        sourceType: 'deepseek_generated',
        reason: '',
        riskWarning: '',
        aiCard: {},
        updatedAt: '2026-05-31T01:00:00.000Z'
      }
    }
  });
  const entry = merged.candidatePool['こなれ'];
  assert.equal(entry.aiCard.cardStatus, 'ready');
  assert.equal(entry.reason, '适合穿搭和审美内容。');
  assert.equal(entry.riskWarning, '不要用于正式商务说明。');
});

test('mergeWorkflow 合并 candidatePool 时保留手动添加来源元数据', () => {
  const merged = mergeWorkflow({
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '情绪化、有氛围',
        sourceTags: ['手动添加'],
        discoverySource: 'YouTube',
        discoveryContext: '视频标题里看到。',
        updatedAt: '2026-05-30T01:00:00.000Z'
      }
    }
  }, {
    candidatePool: {
      'エモい': {
        kanji: 'エモい',
        sourceType: 'manual_keep',
        meaning: '',
        sourceTags: ['受保护'],
        updatedAt: '2026-05-31T01:00:00.000Z'
      }
    }
  });
  const entry = merged.candidatePool['エモい'];
  assert.equal(entry.discoverySource, 'YouTube');
  assert.equal(entry.discoveryContext, '视频标题里看到。');
  assert.ok(entry.sourceTags.includes('手动添加'));
});

test('mergeWorkflow 合并 publishedRecords 时新 updatedAt 胜出但不丢备注', () => {
  const merged = mergeWorkflow({
    publishedRecords: [{
      id: 'record-1',
      word: 'こなれ',
      title: '旧标题',
      remarks: '人工复盘备注',
      performanceNote: '标题可以更生活化',
      latestStats: { likes: 1, favorites: 2, comments: 0, shares: 0, views: 100 },
      updatedAt: '2026-05-30T01:00:00.000Z'
    }]
  }, {
    publishedRecords: [{
      id: 'record-1',
      word: 'こなれ',
      latestStats: { likes: 10, favorites: 5, comments: 1, shares: 0, views: 1000 },
      updatedAt: '2026-05-31T01:00:00.000Z'
    }]
  });
  const record = merged.publishedRecords[0];
  assert.equal(record.remarks, '人工复盘备注');
  assert.equal(record.performanceNote, '标题可以更生活化');
  assert.equal(record.latestStats.views, 1000);
  assert.equal(record.updatedAt, '2026-05-31T01:00:00.000Z');
});

test('mergeWorkflow 合并 todaySnapshot 时同一天 version 高者优先', () => {
  const merged = mergeWorkflow({
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['旧词'],
      generatedAt: '2026-05-31T01:00:00.000Z',
      version: 1
    }
  }, {
    todaySnapshot: {
      dateKey: '2026-05-31',
      words: ['新词'],
      generatedAt: '2026-05-31T00:00:00.000Z',
      version: 2
    }
  });
  assert.deepEqual(merged.todaySnapshot.words, ['新词']);
  assert.equal(merged.todaySnapshot.version, 2);
});

test('published-refresh 类写回不会导致 aiBatches/todaySnapshot 丢失', () => {
  const current = cleanStoredWorkflow({
    aiBatches: [{ id: 'batch-a', action: 'wild_ideas', createdAt: '2026-05-31T01:00:00.000Z' }],
    todaySnapshot: { dateKey: '2026-05-31', words: ['こなれ'], generatedAt: '2026-05-31T01:00:00.000Z', version: 1 },
    publishedRecords: [{ id: 'record-1', word: 'こなれ', remarks: '保留备注', updatedAt: '2026-05-30T01:00:00.000Z' }]
  });
  const saved = mergeWorkflow(current, {
    publishedRecords: [{ id: 'record-1', word: 'こなれ', latestStats: { likes: 3 }, updatedAt: '2026-05-31T01:00:00.000Z' }]
  });
  assert.equal(saved.aiBatches[0].id, 'batch-a');
  assert.deepEqual(saved.todaySnapshot.words, ['こなれ']);
  assert.equal(saved.publishedRecords[0].remarks, '保留备注');
});

test('worker PUT 类保存不会导致 aiBatches/todaySnapshot 丢失', () => {
  const current = cleanStoredWorkflow({
    words: ['こなれ'],
    aiBatches: [{ id: 'batch-a', action: 'wild_ideas', createdAt: '2026-05-31T01:00:00.000Z' }],
    todaySnapshot: { dateKey: '2026-05-31', words: ['こなれ'], generatedAt: '2026-05-31T01:00:00.000Z', version: 1 }
  });
  const saved = mergeWorkflowForFullSave(current, {
    words: ['抜け感'],
    statuses: {},
    updated: '2026-05-31T02:00:00.000Z'
  });
  assert.deepEqual(saved.words, ['抜け感']);
  assert.equal(saved.aiBatches[0].id, 'batch-a');
  assert.deepEqual(saved.todaySnapshot.words, ['こなれ']);
});

test('收藏增量同步不会用客户端空 todaySnapshot 覆盖服务端今日快照', () => {
  const snapshotWords = Array.from({ length: 20 }, (_, index) => `今日词${index + 1}`);
  const current = cleanStoredWorkflow({
    words: ['こなれ'],
    todaySnapshot: {
      dateKey: '2026-06-21',
      words: snapshotWords,
      generatedAt: '2026-06-21T02:57:40.000Z',
      generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
      version: 1
    },
    todayDismissed: {
      dateKey: '2026-06-21',
      words: ['跳过词'],
      updatedAt: '2026-06-21T03:00:00.000Z'
    },
    historySnapshots: {
      '2026-06-20': {
        dateKey: '2026-06-20',
        words: ['历史词'],
        generatedAt: '2026-06-20T02:00:00.000Z',
        version: 1
      }
    },
    todaySnapshotHistory: [{
      dateKey: '2026-06-19',
      words: ['快照历史词'],
      generatedAt: '2026-06-19T02:00:00.000Z',
      version: 1
    }]
  });
  const saved = applyFavoriteAction(current, {
    action: 'add',
    word: '新收藏',
    todaySnapshot: {},
    todayDismissed: {},
    historySnapshots: {},
    todaySnapshotHistory: []
  });

  assert.ok(saved.words.includes('新收藏'));
  assert.equal(saved.todaySnapshot.dateKey, '2026-06-21');
  assert.deepEqual(saved.todaySnapshot.words, snapshotWords);
  assert.deepEqual(saved.todayDismissed.words, ['跳过词']);
  assert.ok(saved.historySnapshots['2026-06-20']);
  assert.ok(saved.todaySnapshotHistory.some(snapshot => snapshot.dateKey === '2026-06-19'));
});

function makeCardWorkflow(overrides = {}) {
  const todayWords = Array.from({ length: 20 }, (_, index) => `今日卡片词${index + 1}`);
  const candidatePool = todayWords.reduce((pool, kanji, index) => {
    pool[kanji] = makeTodayCandidate(kanji, index + 1, {
      aiCard: { cardStatus: 'none' }
    });
    return pool;
  }, {});
  return cleanStoredWorkflow({
    words: ['既有收藏'],
    statuses: { '既有收藏': 'pending' },
    feedback: { 既有收藏: { reasons: { notFresh: 1 }, lastReason: 'notFresh' } },
    publishedRecords: [{ id: 'published-1', word: '既有收藏', title: '已发布记录' }],
    candidatePool,
    todaySnapshot: {
      dateKey: '2026-06-21',
      words: todayWords,
      generatedAt: '2026-06-21T02:57:40.000Z',
      generatorVersion: TODAY_SNAPSHOT_GENERATOR_VERSION,
      version: 1
    },
    historySnapshots: {
      '2026-06-20': { dateKey: '2026-06-20', words: ['历史保留词'], generatedAt: '2026-06-20T02:00:00.000Z', version: 1 }
    },
    todaySnapshotHistory: [{ dateKey: '2026-06-19', words: ['历史快照词'], generatedAt: '2026-06-19T02:00:00.000Z', version: 1 }],
    ...overrides
  });
}

test('ai-cards 单词生成只写回 aiCard 且不改变 todaySnapshot', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  const selection = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], maxWords: 5 });
  assert.deepEqual(selection.targets, [target]);
  const result = applyAiCardGenerationResult(workflow, {
    targets: selection.targets,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T03:00:00.000Z' },
    items: [{
      kanji: target,
      aiCard: {
        cardStatus: 'ready',
        summary: '适合做小红书选题的情绪词。',
        explanation: '有明确场景和标题价值。'
      }
    }]
  });

  assert.equal(result.savedCount, 1);
  assert.equal(result.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(result.workflow.candidatePool[target].aiCard.cardModel, 'deepseek-test');
  assert.deepEqual(result.workflow.todaySnapshot.words, workflow.todaySnapshot.words);
  assert.deepEqual(result.workflow.words, workflow.words);
  assert.deepEqual(result.workflow.statuses, workflow.statuses);
  assert.equal(result.workflow.publishedRecords[0].id, 'published-1');
  assert.ok(result.workflow.historySnapshots['2026-06-20']);
});

test('ai-cards 批量选择最多 5 个且跳过非 today 词', () => {
  const workflow = makeCardWorkflow();
  const requested = [...workflow.todaySnapshot.words.slice(0, 7), '不属于今日'];
  const selection = selectTodayAiCardTargets(workflow, { mode: 'today', words: requested, maxWords: 10 });
  assert.equal(selection.targets.length, 5);
  assert.equal(selection.skipped.notToday.includes('不属于今日'), true);
  assert.deepEqual(selection.skipped.limited, workflow.todaySnapshot.words.slice(5, 7));
});

test('ai-cards ready 默认不重复生成，force=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = readyCard;
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target] });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.ready, [target]);
  const forced = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], force: true });
  assert.deepEqual(forced.targets, [target]);

  const applied = applyAiCardGenerationResult(workflow, {
    targets: [target],
    force: true,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T04:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '新版词卡' } }]
  });
  assert.equal(applied.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(applied.workflow.candidatePool[target].aiCardHistory.length, 1);
});

test('ai-cards failed 默认不重试，retryFailed=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'failed',
    summary: '上次失败',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target] });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.failed, [target]);
  const retry = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], retryFailed: true });
  assert.deepEqual(retry.targets, [target]);
});

test('ai-cards stale pending 默认不重试，retryStalePending=true 才允许', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  workflow.candidatePool[target].updatedAt = '2026-06-21T03:01:00.000Z';
  const nowMs = Date.parse('2026-06-21T03:12:01.000Z');

  assert.equal(isAiCardStalePending(workflow.candidatePool[target], nowMs), true);
  const skipped = selectTodayAiCardTargets(workflow, { mode: 'today', words: [target], nowMs });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.pending, [target]);
  assert.deepEqual(skipped.skipped.stalePending, [target]);

  const retry = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(retry.targets, [target]);
});

test('ai-cards fresh pending 即使 retryStalePending=true 也不重试', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:08:00.000Z'
  };
  const nowMs = Date.parse('2026-06-21T03:12:00.000Z');

  assert.equal(isAiCardStalePending(workflow.candidatePool[target], nowMs), false);
  const skipped = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(skipped.targets, []);
  assert.deepEqual(skipped.skipped.pending, [target]);
  assert.deepEqual(skipped.skipped.stalePending, []);
});

test('ai-cards stale pending 汇总统计正确', () => {
  const workflow = makeCardWorkflow();
  workflow.candidatePool[workflow.todaySnapshot.words[0]].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  workflow.candidatePool[workflow.todaySnapshot.words[1]].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:11:00.000Z'
  };

  const summary = summarizeTodayAiCards(workflow, { nowMs: Date.parse('2026-06-21T03:12:01.000Z') });
  assert.equal(summary.pendingCount, 2);
  assert.equal(summary.stalePendingCount, 1);
  assert.equal(summary.items[0].stalePending, true);
  assert.equal(summary.items[1].stalePending, false);
});

test('ai-cards stale pending 重试写回不改变 todaySnapshot / favorites', () => {
  const workflow = makeCardWorkflow();
  const target = workflow.todaySnapshot.words[0];
  workflow.candidatePool[target].aiCard = {
    cardStatus: 'pending',
    summary: 'DeepSeek 词卡生成中',
    generatedAt: '2026-06-21T03:00:00.000Z'
  };
  const nowMs = Date.parse('2026-06-21T03:12:01.000Z');
  const selection = selectTodayAiCardTargets(workflow, {
    mode: 'today',
    words: [target],
    retryStalePending: true,
    nowMs
  });
  assert.deepEqual(selection.targets, [target]);

  const result = applyAiCardGenerationResult(workflow, {
    targets: selection.targets,
    usage: { model: 'deepseek-test', createdAt: '2026-06-21T04:00:00.000Z' },
    items: [{ kanji: target, aiCard: { cardStatus: 'ready', summary: '重试成功词卡' } }]
  });
  assert.equal(result.savedCount, 1);
  assert.equal(result.workflow.candidatePool[target].aiCard.cardStatus, 'ready');
  assert.equal(result.workflow.candidatePool[target].aiCard.summary, '重试成功词卡');
  assert.deepEqual(result.workflow.todaySnapshot.words, workflow.todaySnapshot.words);
  assert.deepEqual(result.workflow.words, workflow.words);
  assert.deepEqual(result.workflow.statuses, workflow.statuses);
  assert.ok(result.workflow.historySnapshots['2026-06-20']);
});

test('ai-cards 状态汇总统计 ready missing failed', () => {
  const workflow = makeCardWorkflow();
  workflow.candidatePool[workflow.todaySnapshot.words[0]].aiCard = readyCard;
  workflow.candidatePool[workflow.todaySnapshot.words[1]].aiCard = { cardStatus: 'failed', summary: '失败' };
  const summary = summarizeTodayAiCards(workflow);
  assert.equal(summary.todaySnapshot.words.length, 20);
  assert.equal(summary.readyCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.missingCount, 18);
});

test('worker PUT 类保存不会导致 aiPreview/todayDismissed 丢失', () => {
  const current = cleanStoredWorkflow({
    aiPreview: {
      items: [{ kanji: '抜け感', meaning: '松弛留白感', displayBucket: 'today' }],
      selected: ['抜け感'],
      savedAt: '2026-05-31T01:00:00.000Z'
    },
    todayDismissed: {
      dateKey: '2026-05-31',
      words: ['ワロタ'],
      updatedAt: '2026-05-31T01:05:00.000Z'
    }
  });
  const saved = mergeWorkflowForFullSave(current, {
    words: ['抜け感'],
    updated: '2026-05-31T02:00:00.000Z'
  });
  assert.equal(saved.aiPreview.items[0].kanji, '抜け感');
  assert.deepEqual(saved.todayDismissed.words, ['ワロタ']);
});

test('cleanStoredWorkflow 不删除 todaySnapshotHistory', () => {
  const cleaned = cleanStoredWorkflow({
    todaySnapshotHistory: [{
      dateKey: '2026-06-07',
      words: ['旧推荐'],
      generatedAt: '2026-06-07T00:00:00.000Z',
      version: 1
    }]
  });
  assert.equal(cleaned.todaySnapshotHistory.length, 1);
  assert.equal(cleaned.todaySnapshotHistory[0].dateKey, '2026-06-07');
  assert.deepEqual(cleaned.todaySnapshotHistory[0].words, ['旧推荐']);
});

test('mergeWorkflow 合并 todaySnapshotHistory 不丢日期', () => {
  const merged = mergeWorkflow({
    todaySnapshotHistory: [{ dateKey: '2026-06-06', words: ['本地词'], generatedAt: '2026-06-06T00:00:00.000Z', version: 1 }]
  }, {
    todaySnapshotHistory: [{ dateKey: '2026-06-07', words: ['云端词'], generatedAt: '2026-06-07T00:00:00.000Z', version: 1 }]
  });
  const dates = merged.todaySnapshotHistory.map(snapshot => snapshot.dateKey);
  assert.ok(dates.includes('2026-06-06'));
  assert.ok(dates.includes('2026-06-07'));
});

function makeTodayCandidate(kanji, index, overrides = {}) {
  return {
    kanji,
    kana: `かな${index}`,
    romaji: `word${index}`,
    meaning: `测试词 ${index}`,
    category: `测试分类${index}`,
    candidateType: '审美氛围词',
    displayBucket: 'today',
    emotionTone: index % 3 === 0 ? 'lifestyle' : 'aesthetic',
    reason: '有情绪共鸣和生活场景，适合做标题封面并被收藏。',
    expressionValueScore: 86,
    sourceType: 'deepseek_generated',
    xhsFitScore: 88,
    riskLevel: 'low',
    confidenceLevel: 'high',
    evidenceType: 'common_usage',
    suggestedAction: '可以收藏观察',
    ...overrides
  };
}

test('getRecentDailyHotBlockedWords 收集最近 30 天历史词', () => {
  const blocked = getRecentDailyHotBlockedWords({
    historySnapshots: {
      '2026-06-01': { dateKey: '2026-06-01', words: ['历史归档词'], generatedAt: '2026-06-01T00:00:00.000Z', version: 1 }
    },
    todaySnapshotHistory: [{ dateKey: '2026-05-20', words: ['快照历史词'], generatedAt: '2026-05-20T00:00:00.000Z', version: 1 }]
  }, TODAY_HISTORY_DEDUP_DAYS, { today: '2026-06-08' });
  assert.ok(blocked.has('历史归档词'));
  assert.ok(blocked.has('快照历史词'));
});

test('buildDeepSeekExclusionContext 构建 DeepSeek 避重清单并保留原因', () => {
  const exclusion = buildDeepSeekExclusionContext({
    recentHistoryWords: ['モヤる', '抜け感', '清潔感'],
    favoriteWords: ['しんどい'],
    pendingWords: ['気を遣う'],
    publishedWords: ['距離感'],
    selectedTodayWords: ['空気読む'],
    currentBatchWords: ['だるい', '気まずい'],
    protectedWords: ['刺さる'],
    existingRecentCandidateWords: ['透け感']
  }, { limit: 20 });
  ['モヤる', '抜け感', '清潔感', 'しんどい', '気を遣う', '距離感', '空気読む', 'だるい', '気まずい', '刺さる', '透け感'].forEach(word => {
    assert.ok(exclusion.excludedWords.includes(word), `${word} 应进入 DeepSeek 禁止列表`);
  });
  assert.deepEqual(exclusion.excludedReasons.current_batch_duplicate, ['だるい', '気まずい']);
  assert.deepEqual(exclusion.excludedReasons.favorite_or_pending, ['しんどい', '気を遣う']);
  assert.deepEqual(exclusion.excludedReasons.published, ['距離感']);
  assert.deepEqual(exclusion.excludedReasons.selected_today, ['空気読む']);
});

test('generateTodaySnapshot 硬排除最近 30 天历史词', () => {
  const candidatePool = {};
  ['回流词A', '回流词B', '回流词C'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1);
  });
  Array.from({ length: 20 }, (_, index) => `新候选${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 10);
  });
  const { result } = generateTodaySnapshot({
    candidatePool,
    historySnapshots: {
      '2026-06-03': { dateKey: '2026-06-03', words: ['回流词A', '回流词B', '回流词C'], generatedAt: '2026-06-03T00:00:00.000Z', version: 1 }
    }
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(result.dedupDaysUsed, 30);
  assert.equal(result.relaxedDedup, false);
  assert.equal(result.todaySnapshot.generatorVersion, TODAY_SNAPSHOT_GENERATOR_VERSION);
  assert.equal(isCurrentGeneratorSnapshot(result.todaySnapshot, new Date('2026-06-08T01:00:00.000Z')), true);
  assert.equal(words.length, 20);
  assert.equal(words.some(word => word.startsWith('回流词')), false);
});

test('generateTodaySnapshot 硬排除中文直读低价值首页词', () => {
  const candidatePool = {};
  ['副業', '資格勉強', '自己投資', '転職', '在宅勤務', '寿司', '部屋', 'ガチ恋'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, {
      meaning: '偏泛的职场主题词',
      category: '职场',
      candidateType: '生活方式词',
      xhsFitScore: 95
    });
  });
  Array.from({ length: 24 }, (_, index) => `補充かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 10);
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(words.length, 20);
  assert.equal(words.includes('副業'), false);
  assert.equal(words.includes('資格勉強'), false);
  assert.equal(words.includes('自己投資'), false);
  assert.equal(words.includes('転職'), false);
  assert.equal(words.includes('在宅勤務'), false);
  assert.equal(words.includes('寿司'), false);
  assert.equal(words.includes('部屋'), false);
  assert.equal(words.includes('ガチ恋'), false);
});

test('generateTodaySnapshot 降级泛话题词并优先表达价值高的词', () => {
  const candidatePool = {};
  const strongWords = ['清潔感', '木漏れ日', '大正解', '布教', '小確幸', '自己肯定感', '推し変'];
  strongWords.forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, {
      meaning: '中文不好直译但有共鸣的日语表达',
      category: index >= 3 ? '追星兴趣' : '情绪语感',
      candidateType: index >= 3 ? '追星兴趣词' : '稳定候选',
      displayBucket: index >= 5 ? 'meme_fast' : 'today',
      emotionTone: index >= 3 ? 'fandom' : 'positive',
      xhsFitScore: 94,
      expressionValueScore: 92,
      reason: '有情绪共鸣、人际语感和明确小红书标题封面角度，适合收藏。'
    });
  });
  ['ネイル', 'ベースメイク', 'オーバサイズ', 'メンズメイク', '資格勉強', '自己投資', 'おじさん構文', '紅葉', 'お弁当', '地雷系', '祭り', '副業', '転職'].forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 20, {
      meaning: '偏泛话题分类词',
      category: '话题分类',
      candidateType: '生活方式词',
      xhsFitScore: 96,
      reason: '更像搜索标签或话题分类，单独做标题和配图价值弱。'
    });
  });
  Array.from({ length: 24 }, (_, index) => `表現かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 40, {
      meaning: '有场景的日语表达',
      category: index % 2 ? '生活场景' : '人际语感',
      candidateType: index % 2 ? '生活方式词' : '网络口语词',
      displayBucket: index % 2 ? 'today' : 'meme_fast',
      emotionTone: index % 2 ? 'lifestyle' : 'positive',
      xhsFitScore: 86,
      expressionValueScore: 84,
      reason: '有生活场景和情绪共鸣，能做收藏型小红书标题。'
    });
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  const words = result.todaySnapshot.words;
  assert.equal(words.length, 20);
  strongWords.forEach(word => assert.ok(words.includes(word), `${word} 应进入每日热门候选`));
  ['ネイル', 'ベースメイク', 'オーバサイズ', 'オーバーサイズ', 'メンズメイク', '資格勉強', '自己投資', 'おじさん構文', '紅葉', 'お弁当', '地雷系', '祭り', '副業', '転職'].forEach(word => {
    assert.equal(words.includes(word), false, `${word} 不应默认进入每日热门`);
  });
});

test('generateTodaySnapshot 候选不足时不再回流 30 天内历史词', () => {
  const candidatePool = {};
  Array.from({ length: 20 }, (_, index) => `历史高分${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1, { xhsFitScore: 92 });
  });
  const { result } = generateTodaySnapshot({
    candidatePool,
    historySnapshots: {
      '2026-06-03': { dateKey: '2026-06-03', words: Object.keys(candidatePool), generatedAt: '2026-06-03T00:00:00.000Z', version: 1 }
    }
  }, { mode: 'create', now: new Date('2026-06-08T01:00:00.000Z') });
  assert.equal(result.dedupDaysUsed, 30);
  assert.equal(result.relaxedDedup, false);
  assert.equal(result.shortage, true);
  assert.equal(result.todaySnapshot.words.length, 0);
  assert.equal(result.words.some(word => word.historicalBackfill), false);
});

test('generateTodaySnapshot 保留 DeepSeek 新鲜度审计统计', () => {
  const candidatePool = {};
  Array.from({ length: 20 }, (_, index) => `新鮮かな${index + 1}`).forEach((word, index) => {
    candidatePool[word] = makeTodayCandidate(word, index + 1);
  });
  const { result } = generateTodaySnapshot({
    candidatePool
  }, {
    mode: 'create',
    now: new Date('2026-06-08T01:00:00.000Z'),
    noveltySummary: {
      generatedUniqueCount: 37,
      importedUniqueCount: 31,
      recentHistoryRejectedCount: 19,
      favoriteProtectedRejectedCount: 6,
      currentBatchDuplicateRejectedCount: 8,
      reviewRejectedCount: 6,
      duplicateRate: 35,
      historyCollisionRate: 51
    }
  });
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.generatedUniqueCount, 37);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.importedUniqueCount, 31);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.recentHistoryRejectedCount, 19);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.duplicateRate, 35);
  assert.equal(result.todaySnapshot.recommendationAudit.noveltySummary.historyCollisionRate, 51);
});

test('isCurrentGeneratorSnapshot 拒绝旧逻辑快照', () => {
  const legacySnapshot = {
    dateKey: '2026-06-08',
    words: ['旧词'],
    generatedAt: '2026-06-08T00:00:00.000Z',
    source: 'candidatePool',
    version: 1
  };
  assert.equal(isCurrentGeneratorSnapshot(legacySnapshot, new Date('2026-06-08T01:00:00.000Z')), false);
});

test('stripInvalidCurrentTodaySnapshot 清除当天旧逻辑快照但保留归档', () => {
  const cleaned = stripInvalidCurrentTodaySnapshot({
    todaySnapshot: {
      dateKey: '2026-06-08',
      words: ['旧逻辑词'],
      generatedAt: '2026-06-08T00:00:00.000Z',
      source: 'candidatePool',
      version: 1
    }
  }, new Date('2026-06-08T01:00:00.000Z'));
  assert.equal(cleaned.todaySnapshot.words.length, 0);
  assert.deepEqual(cleaned.historySnapshots['2026-06-08'].words, ['旧逻辑词']);
});

console.log('workflow schema smoke tests passed');

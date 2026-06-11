import assert from 'node:assert/strict';
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
import { getAccountLearningSummary } from '../shared/account-learning.mjs';

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

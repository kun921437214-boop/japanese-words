import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPublishedImport,
  buildPublishedLearningSummary,
  computePublishedThirtyDayMedians,
  inferPublishedSelectionSource,
  normalizePublishedImportRow
} from '../shared/published-import.mjs';
import { onRequest as handlePublishedImport } from '../functions/published-import.js';
import { cleanPublishedRecord, mergeWorkflow } from '../shared/workflow-schema.mjs';
import {
  onRequest as getPublishedCover,
  persistPublishedRecordCovers
} from '../functions/published-cover.js';
import {
  buildPublishedMetricRows,
  buildPublishedPageModel,
  getPublishedUpdateState
} from '../frontend/published-page.mjs';

const NOW = new Date('2026-07-20T14:30:00+08:00');

function row(overrides = {}) {
  return {
    title: '日本人说「尊い」是什么感觉？',
    publishedAt: '2026-07-19T12:00:00+08:00',
    contentType: '图文',
    impressions: 12000,
    views: 3000,
    coverClickRate: 0.18,
    likes: 200,
    comments: 30,
    favorites: 90,
    follows: 12,
    shares: 24,
    avgWatchSeconds: 18,
    danmaku: 0,
    ...overrides
  };
}

function batch(rows, overrides = {}) {
  return {
    id: 'xhs-export:2026-07-20:test',
    capturedAt: '2026-07-20T14:30:00+08:00',
    capturedAtSource: 'official_export',
    source: 'xiaohongshu_creator_export',
    sourceFileName: '笔记列表明细表.xlsx',
    rows,
    ...overrides
  };
}

function createKv(initialValue = null) {
  let value = structuredClone(initialValue);
  return {
    putCalls: 0,
    async get() {
      return structuredClone(value);
    },
    async put(_key, nextValue) {
      this.putCalls += 1;
      value = JSON.parse(nextValue);
    }
  };
}

test('官方导出字段完整拆分，标题中的日语词可自动映射', () => {
  const normalized = normalizePublishedImportRow(row());
  assert.equal(normalized.word, '尊い');
  assert.equal(normalized.contentCategory, 'word_card');
  assert.deepEqual(normalized.metrics, {
    impressions: 12000,
    views: 3000,
    coverClickRate: 0.18,
    likes: 200,
    comments: 30,
    favorites: 90,
    follows: 12,
    shares: 24,
    avgWatchSeconds: 18,
    danmaku: 0
  });
});

test('旧的小红书电脑端错误链接会在导入和读取时恢复为标准笔记链接', () => {
  const wrappedLink = 'https://www.xiaohongshu.com/404?source=%2F404%2Fsec_test&redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore%2F6a5cc0930000000011004cf7&error_code=300031';
  const normalized = normalizePublishedImportRow(row({ link: wrappedLink }));
  assert.equal(normalized.noteId, '6a5cc0930000000011004cf7');
  assert.equal(normalized.link, 'https://www.xiaohongshu.com/explore/6a5cc0930000000011004cf7');

  const cleaned = cleanPublishedRecord({
    id: 'legacy-wrapper',
    word: '尊い',
    link: wrappedLink,
    contentLocked: true
  });
  assert.equal(cleaned.noteId, '6a5cc0930000000011004cf7');
  assert.equal(cleaned.link, 'https://www.xiaohongshu.com/explore/6a5cc0930000000011004cf7');
});

test('同一批次可幂等重放，内容只保存一次，超过 15 天的数据不再变化', () => {
  const rows = [
    row({ description: '首次获取的正文', coverUrl: 'https://example.com/first.jpg' }),
    row({
      title: '日本人说「木漏れ日」是什么感觉？',
      publishedAt: '2026-06-01T12:00:00+08:00',
      views: 9000
    })
  ];
  const first = applyPublishedImport({}, batch(rows), { now: NOW });
  assert.equal(first.summary.createdCount, 2);
  assert.equal(first.summary.activeCount, 1);
  assert.equal(first.summary.frozenCount, 1);

  const repeated = applyPublishedImport({ publishedRecords: first.records }, batch(rows), { now: NOW });
  assert.equal(repeated.summary.updatedCount, 0);
  assert.equal(repeated.summary.unchangedCount, 1);
  assert.equal(repeated.summary.skippedOlderCount, 1);

  const changedRows = [
    row({
      description: '不应覆盖的新正文',
      coverUrl: 'https://example.com/second.jpg',
      views: 3600,
      comments: 45
    }),
    row({
      title: '日本人说「木漏れ日」是什么感觉？',
      publishedAt: '2026-06-01T12:00:00+08:00',
      views: 19000
    })
  ];
  const nextDay = applyPublishedImport(
    { publishedRecords: first.records },
    batch(changedRows, {
      id: 'xhs-export:2026-07-21:test',
      capturedAt: '2026-07-21T14:30:00+08:00'
    }),
    { now: new Date('2026-07-21T14:30:00+08:00') }
  );
  const active = nextDay.records.find(record => record.word === '尊い');
  const frozen = nextDay.records.find(record => record.word === '木漏れ日');
  assert.equal(active.description, '首次获取的正文');
  assert.equal(active.coverUrl, 'https://example.com/first.jpg');
  assert.equal(active.latestMetrics.views, 3600);
  assert.equal(active.metricSnapshots.length, 2);
  assert.equal(frozen.latestMetrics.views, 9000);
  assert.equal(frozen.metricSnapshots.length, 1);
});

test('发布导入自动留档当前内容版本并生成72小时分层复盘', () => {
  const workflow = {
    candidatePool: {
      '抜け感': {
        kanji: '抜け感',
        sourceType: 'manual_keep',
        publicationSnapshot: {
          capturedAt: '2026-07-16T10:00:00+08:00',
          cardVersion: 4,
          cardGeneratedAt: '2026-07-15T10:00:00+08:00',
          suggestedTitle: '日语里的松弛感原来叫抜け感',
          coverVersion: 3,
          coverSuggestion: { coverText: '日系松弛感' }
        }
      }
    }
  };
  const baselineRows = ['余白', 'こなれ', '透明感'].map((word, index) => row({
    title: `日本人说「${word}」是什么感觉？`,
    publishedAt: `2026-07-${String(10 + index).padStart(2, '0')}T12:00:00+08:00`,
    impressions: 5000,
    views: 1000,
    coverClickRate: 0.2,
    likes: 50,
    comments: 3,
    favorites: 20,
    follows: 2,
    shares: 5,
    avgWatchSeconds: 10
  }));
  const imported = applyPublishedImport(workflow, batch([
    row({
      title: '日本人说「抜け感」是什么感觉？',
      publishedAt: '2026-07-16T12:00:00+08:00',
      impressions: 5000,
      views: 1000,
      coverClickRate: 0.06,
      favorites: 80,
      shares: 20,
      follows: 10,
      comments: 10,
      avgWatchSeconds: 6
    }),
    ...baselineRows
  ]), { now: NOW });
  const target = imported.records.find(record => record.word === '抜け感');
  assert.equal(target.creativeSnapshot.cardVersion, 4);
  assert.equal(target.creativeSnapshot.coverVersion, 3);
  assert.equal(target.performanceAssessment.stage, 'early');
  assert.equal(target.performanceAssessment.topic.level, 'strong');
  assert.equal(target.performanceAssessment.cover.level, 'weak');
  const learning = buildPublishedLearningSummary(imported.records, NOW);
  assert.ok(learning.strongTopics.some(item => item.word === '抜け感'));
  assert.ok(learning.weakCovers.some(item => item.word === '抜け感'));
});

test('已发布封面首次同步到本站后永久复用，不再重新下载或覆盖', async () => {
  const stored = new Map();
  const imageKv = {
    async getWithMetadata(key) {
      return stored.get(key) || null;
    },
    async put(key, value, options = {}) {
      stored.set(key, { value, metadata: options.metadata || null });
    }
  };
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response(new Uint8Array([255, 216, 255, 217]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4' }
    });
  };
  const sourceRecord = cleanPublishedRecord({
    id: 'published-cover-once',
    word: '尊い',
    description: '首次获取的正文',
    coverUrl: `https://sns-webpic-qc.xhscdn.com/${'a'.repeat(40)}`,
    contentLocked: true,
    contentImportedAt: '2026-07-20T06:30:00.000Z'
  });
  const first = await persistPublishedRecordCovers([sourceRecord], { REFERENCE_IMAGES_KV: imageKv }, {
    fetchImpl,
    nowIso: '2026-07-20T06:31:00.000Z'
  });
  assert.equal(first.summary.storedCount, 1);
  assert.equal(fetchCount, 1);
  assert.match(first.records[0].coverUrl, /^\/published-cover\?key=/);
  assert.match(first.records[0].coverStorageKey, /^published-covers\/v1\/[a-f0-9]{32}$/);
  assert.equal(first.records[0].coverStoredAt, '2026-07-20T06:31:00.000Z');

  const second = await persistPublishedRecordCovers(first.records, { REFERENCE_IMAGES_KV: imageKv }, {
    fetchImpl: async () => {
      throw new Error('冻结后的封面不应再次下载');
    },
    nowIso: '2026-07-21T06:30:00.000Z'
  });
  assert.equal(second.summary.reusedCount, 1);
  assert.equal(second.records[0].coverStorageKey, first.records[0].coverStorageKey);
  assert.equal(second.records[0].coverStoredAt, first.records[0].coverStoredAt);

  const response = await getPublishedCover({
    request: new Request(`https://bijinihaitan.cn${first.records[0].coverUrl}`),
    env: { REFERENCE_IMAGES_KV: imageKv }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await response.arrayBuffer()).byteLength, 4);

  const merged = mergeWorkflow({ publishedRecords: [sourceRecord] }, { publishedRecords: second.records });
  assert.equal(merged.publishedRecords[0].coverStorageKey, first.records[0].coverStorageKey);
  assert.equal(merged.publishedRecords[0].coverUrl, first.records[0].coverUrl);
});

test('未锁定内容和非小红书外链不会触发封面下载', async () => {
  let fetchCount = 0;
  const imageKv = {
    async getWithMetadata() { return null; },
    async put() {}
  };
  const result = await persistPublishedRecordCovers([
    cleanPublishedRecord({ id: 'pending', coverUrl: `https://sns-webpic-qc.xhscdn.com/${'b'.repeat(40)}` }),
    cleanPublishedRecord({ id: 'external', coverUrl: 'https://example.com/cover.jpg', contentLocked: true })
  ], { REFERENCE_IMAGES_KV: imageKv }, {
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('不应下载');
    }
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.summary.skippedCount, 2);
});

test('近 30 天中位数与卡片红底判断使用曝光、观看、点击率和评论等独立指标', () => {
  const records = [
    cleanPublishedRecord({
      id: 'a',
      word: '尊い',
      title: 'A',
      publishedAt: '2026-07-19T12:00:00+08:00',
      latestMetrics: row()
    }),
    cleanPublishedRecord({
      id: 'b',
      word: '木漏れ日',
      title: 'B',
      publishedAt: '2026-07-10T12:00:00+08:00',
      latestMetrics: row({ impressions: 20000, views: 5000, coverClickRate: 0.22, comments: 50, favorites: 200, shares: 50, follows: 25 })
    })
  ];
  const medians = computePublishedThirtyDayMedians(records, NOW);
  assert.equal(medians.sampleSize, 2);
  assert.equal(medians.impressions, 16000);
  assert.equal(medians.views, 4000);
  assert.equal(medians.coverClickRate, 0.2);
  assert.equal(medians.comments, 40);
  const rowsForFirst = buildPublishedMetricRows(records[0], medians);
  assert.equal(rowsForFirst.find(item => item.key === 'impressions').belowMedian, true);
  assert.equal(rowsForFirst.find(item => item.key === 'coverClickRate').belowMedian, true);
  assert.equal(rowsForFirst.find(item => item.key === 'comments').belowMedian, true);
  assert.equal(buildPublishedPageModel(records, { now: NOW }).count, 2);
});

test('来源能区分 Codex 每日热门与自选，旧字段只留下 latestStats 兼容镜像', () => {
  const workflow = {
    todaySnapshotHistory: [{
      dateKey: '2026-07-18',
      words: ['尊い'],
      source: 'codex',
      recommendationAudit: {
        items: [{ kanji: '尊い', originType: 'codex_generated' }]
      }
    }]
  };
  assert.equal(inferPublishedSelectionSource('尊い', '2026-07-19T12:00:00+08:00', workflow).type, 'daily_hot_codex');
  assert.equal(inferPublishedSelectionSource('木漏れ日', '2026-07-19T12:00:00+08:00', workflow).type, 'self_selected');

  const unmapped = applyPublishedImport(workflow, batch([
    row({ title: '中文标题待映射', word: '' })
  ]), { now: NOW });
  assert.equal(unmapped.records[0].selectionSource.type, 'unknown');
  assert.equal(unmapped.records[0].contentCategory, 'unknown');
  const remapped = applyPublishedImport({ ...workflow, publishedRecords: unmapped.records }, batch([
    row({ title: '中文标题待映射', word: '尊い' })
  ], { id: 'xhs-export:2026-07-20:remapped' }), { now: NOW });
  assert.equal(remapped.records[0].selectionSource.type, 'daily_hot_codex');

  const cleaned = cleanPublishedRecord({
    id: 'legacy',
    word: '尊い',
    title: '旧记录',
    publishedAt: '2026-07-19T12:00:00+08:00',
    latestMetrics: row(),
    snapshots: [{ nodeType: '1h', views: 20 }],
    rating: '优秀',
    performanceNote: '旧备注',
    autoRefresh: { status: 'success' }
  });
  assert.equal(cleaned.latestStats.views, 3000);
  assert.equal('snapshots' in cleaned, false);
  assert.equal('rating' in cleaned, false);
  assert.equal('performanceNote' in cleaned, false);
  assert.equal('autoRefresh' in cleaned, false);
  assert.equal(getPublishedUpdateState(cleaned, NOW).active, true);
});

test('只读详情确认的宣传帖保留为非单词内容，不计入待映射', () => {
  const imported = applyPublishedImport({}, batch([
    row({
      title: '🍞面包的插画书！旅行&日常&年轻人💡',
      word: '',
      contentCategory: 'non_word',
      noteId: '69720c51000000000a0285a9',
      link: 'https://www.xiaohongshu.com/explore/69720c51000000000a0285a9',
      description: '书籍宣传正文',
      coverUrl: 'https://example.com/book.jpg'
    })
  ]), { now: NOW });
  const record = cleanPublishedRecord(imported.records[0]);
  assert.equal(imported.summary.unmappedCount, 0);
  assert.equal(imported.summary.nonWordCount, 1);
  assert.equal(record.word, '');
  assert.equal(record.contentCategory, 'non_word');
  assert.equal(record.selectionSource.type, 'self_selected');
  assert.equal(record.contentLocked, true);
});

test('已有锁定记录先参与匹配，中文标题不再产生待映射误报', () => {
  const existingRows = [
    cleanPublishedRecord({
      id: 'locked-word',
      word: '足元を見る',
      title: '🍞樱花妹怎么说“看人下菜碟”？',
      publishedAt: '2026-07-19T12:00:00+08:00',
      contentCategory: 'word_card',
      contentLocked: true
    }),
    cleanPublishedRecord({
      id: 'locked-non-word',
      title: '🍞面包的插画书！旅行&日常&年轻人💡',
      publishedAt: '2026-01-22T19:38:57+08:00',
      contentCategory: 'non_word',
      contentLocked: true,
      metricsFrozen: true
    })
  ];
  const imported = applyPublishedImport({ publishedRecords: existingRows }, batch([
    row({
      title: '🍞樱花妹怎么说“看人下菜碟”？',
      publishedAt: '2026-07-19T12:00:00+08:00',
      word: ''
    }),
    row({
      title: '🍞面包的插画书！旅行&日常&年轻人💡',
      publishedAt: '2026-01-22T19:38:57+08:00',
      word: ''
    })
  ]), { now: NOW });

  assert.equal(imported.summary.unmappedCount, 0);
  assert.equal(imported.summary.nonWordCount, 1);
  assert.equal(imported.records.find(record => record.id === 'locked-word').word, '足元を見る');
  assert.equal(imported.records.find(record => record.id === 'locked-non-word').contentCategory, 'non_word');
});

test('滚动 180 天窗口外的缺行作为保留历史，不阻止活跃数据同步', () => {
  const existingRows = [
    cleanPublishedRecord({
      id: 'active-row',
      word: '尊い',
      title: '日本人说「尊い」是什么感觉？',
      publishedAt: '2026-07-19T12:00:00+08:00',
      contentLocked: true
    }),
    cleanPublishedRecord({
      id: 'aged-out-row',
      title: '🍞面包的插画书！旅行&日常&年轻人💡',
      publishedAt: '2026-01-22T19:38:57+08:00',
      contentCategory: 'non_word',
      contentLocked: true,
      metricsFrozen: true
    })
  ];
  const imported = applyPublishedImport(
    { publishedRecords: existingRows },
    batch([row()]),
    { now: new Date('2026-07-22T14:30:00+08:00') }
  );

  assert.equal(imported.summary.missingActiveCount, 0);
  assert.equal(imported.summary.retainedAbsentCount, 1);
  assert.equal(imported.summary.outsideExportWindowCount, 1);
  assert.equal(imported.records.length, 2);
  assert.equal(imported.previewRows.find(item => item.id === 'aged-out-row').status, 'retained_outside_window');
});

test('正式导入在 15 天内活跃帖子缺失时拒绝提交', async () => {
  const currentTime = Date.now();
  const activePublishedAt = new Date(currentTime - 86400000).toISOString();
  const historicalPublishedAt = new Date(currentTime - 200 * 86400000).toISOString();
  const kv = createKv({
    revision: 3,
    publishedRecords: [cleanPublishedRecord({
      id: 'missing-active',
      word: '尊い',
      title: '活跃帖子',
      publishedAt: activePublishedAt,
      contentLocked: true
    })]
  });
  const request = new Request('https://bijinihaitan.cn/published-import', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mode: 'commit',
      batchId: 'xhs-export:active-missing-test',
      capturedAt: new Date(currentTime).toISOString(),
      capturedAtSource: 'official_export',
      source: 'xiaohongshu_creator_export',
      rows: [row({
        title: '历史帖子「木漏れ日」',
        publishedAt: historicalPublishedAt
      })]
    })
  });
  const response = await handlePublishedImport({
    request,
    env: {
      FAVORITES: kv,
      AUTO_REFRESH_SECRET: 'test-secret',
      SITE_URL: 'https://bijinihaitan.cn'
    }
  });
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.error.code, 'ACTIVE_PUBLISHED_ROWS_MISSING');
  assert.equal(kv.putCalls, 0);
});

test('正式导入允许 180 天窗口外历史帖缺行并保留原记录', async () => {
  const currentTime = Date.now();
  const activePublishedAt = new Date(currentTime - 86400000).toISOString();
  const historicalPublishedAt = new Date(currentTime - 200 * 86400000).toISOString();
  const kv = createKv({
    revision: 3,
    publishedRecords: [cleanPublishedRecord({
      id: 'retained-history',
      title: '历史宣传帖',
      publishedAt: historicalPublishedAt,
      contentCategory: 'non_word',
      contentLocked: true,
      metricsFrozen: true
    })]
  });
  const request = new Request('https://bijinihaitan.cn/published-import', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mode: 'commit',
      batchId: 'xhs-export:retained-history-test',
      capturedAt: new Date(currentTime).toISOString(),
      capturedAtSource: 'official_export',
      source: 'xiaohongshu_creator_export',
      rows: [row({ publishedAt: activePublishedAt })]
    })
  });
  const response = await handlePublishedImport({
    request,
    env: {
      FAVORITES: kv,
      AUTO_REFRESH_SECRET: 'test-secret',
      SITE_URL: 'https://bijinihaitan.cn'
    }
  });
  const data = await response.json();
  const stored = await kv.get();

  assert.equal(response.status, 200);
  assert.equal(data.summary.missingActiveCount, 0);
  assert.equal(data.summary.retainedAbsentCount, 1);
  assert.equal(data.summary.outsideExportWindowCount, 1);
  assert.equal(kv.putCalls, 1);
  assert.ok(stored.publishedRecords.some(record => record.id === 'retained-history'));
});

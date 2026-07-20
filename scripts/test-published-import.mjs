import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPublishedImport,
  computePublishedThirtyDayMedians,
  inferPublishedSelectionSource,
  normalizePublishedImportRow
} from '../shared/published-import.mjs';
import { cleanPublishedRecord } from '../shared/workflow-schema.mjs';
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

test('官方导出字段完整拆分，标题中的日语词可自动映射', () => {
  const normalized = normalizePublishedImportRow(row());
  assert.equal(normalized.word, '尊い');
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

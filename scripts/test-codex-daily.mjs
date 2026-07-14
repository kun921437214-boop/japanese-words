import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest as handleCodexDaily } from '../functions/codex-daily.js';
import {
  KV_IMAGE_MAX_BYTES,
  KV_IMAGE_TTL_SECONDS,
  onRequest as handleCodexImage
} from '../functions/codex-image.js';
import { onRequest as handleFavorites } from '../functions/favorites.js';
import {
  promoteCodexDailyDraft,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
import { buildTodayRecommendationAudit } from '../shared/today-snapshot.mjs';
import { triggerDailyPublishOrFallback } from '../worker/favorites-worker.js';

const CURATED_WORDS = [
  'モヤる', '甘えん坊', '心地よい', 'ツンデレ', '余裕',
  '仕切り直し', 'アンニュイ', '見切り', 'リフレッシュ', 'おけまる',
  'しんみり', 'ほのぼの', 'わくわく', 'かぶる', 'だらける',
  '追い込み', 'やりくり', '煮詰まる', 'そわそわ', 'ドキドキ'
];

const JUNE_30_WORDS = [
  'モヤる', 'テンション', '甘えん坊', 'もやもや', '失礼します',
  '心地よい', 'ツンデレ', '余裕', '充実', '積み重ね',
  '仕切り直し', 'ツヤ肌', '涙袋メイク', 'アンニュイ', 'ソロキャンプ',
  '見切り', 'リフレッシュ', 'おけまる', '頑張る', '集中'
];

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
      { jp: `${word}って感じ。`, kana: `${word}ってかんじ。`, cn: '就是这种感觉。' },
      { jp: `今日は${word}。`, kana: `きょうは${word}。`, cn: '今天很有这种状态。' }
    ],
    suggestedTitles: [`日本人说「${word}」，其实是这种感觉`, `「${word}」不是直译那么简单`],
    coverSuggestion: { coverText: word, mainVisual: '真实生活场景，主体明确', style: '自然', avoid: '教材课件' },
    contentAngles: ['语感差异', '生活场景'],
    targetAudience: '想积累自然日语表达的中文用户',
    referenceDirection: '使用无文字、无品牌标识的生活场景图',
    riskWarning: '',
    wrongUsage: '不要脱离语境机械套用。',
    similarWords: [],
    interactionPrompts: ['你会在什么场景用它？'],
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

function makeDraft(words = CURATED_WORDS, options = {}) {
  return {
    targetDateKey: options.targetDateKey || '2026-07-14',
    threadId: '019f5c0e-3d15-75b2-92b1-5f6cb05610aa',
    generatorVersion: 'codex-daily-v1',
    items: words.map((kanji, index) => ({
      kanji,
      kana: kanji,
      romaji: `word-${index + 1}`,
      meaning: `${kanji} 的中文语感说明`,
      category: '情绪与生活表达',
      candidateType: '生活方式词',
      reason: index < 6
        ? '有情绪状态、真实场景和收藏价值，适合标题与封面。'
        : index < 10
          ? '有人际关系与社交语感，适合中文用户收藏和做标题。'
          : index < 16
            ? '有生活场景和状态画面，适合中文用户收藏和做标题。'
            : '有自然语感和真实场景，适合中文用户收藏和做标题。',
      xhsFitScore: index < 10 ? 92 : 84,
      riskLevel: 'low',
      confidenceLevel: 'high',
      aiCard: makeCard(kanji, Boolean(options.imageReady))
    }))
  };
}

function makeKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    values,
    putCalls: 0,
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      this.putCalls += 1;
      values.set(key, String(value));
    }
  };
}

function apiRequest(path, options = {}) {
  return new Request(`https://jiyimianbao.pages.dev${path}`, options);
}

test('2026-06-30 audit reports the known quality risks and lowers S grades', () => {
  const entries = makeDraft(JUNE_30_WORDS, { targetDateKey: '2026-06-30' }).items.map(item => ({
    ...item,
    finalScore: 95,
    lastScore: 95,
    xhsFitScore: 95,
    sourceType: 'codex_generated'
  }));
  const audit = buildTodayRecommendationAudit(entries, {
    date: '2026-06-30',
    generatedAt: '2026-06-29T06:00:00.000Z',
    dedupDaysUsed: 30
  });
  assert.ok(audit.qualitySummary.duplicateClusterCount >= 1);
  assert.equal(audit.qualitySummary.beautyCategoryCount, 2);
  assert.ok(audit.qualitySummary.basicPoliteCount >= 1);
  assert.ok(audit.qualitySummary.genericBasicCount >= 3);
  assert.ok(audit.qualitySummary.estimatedHumanQualityScore <= 90);
  assert.ok(audit.qualitySummary.sLevelCount >= 8 && audit.qualitySummary.sLevelCount <= 12);
  assert.ok(audit.qualitySummary.healthWarnings.some(message => message.includes('推荐等级过松')));
});

test('a complete 20-word Codex draft passes while missing images remain non-blocking', () => {
  const draft = validateCodexDailyDraft(makeDraft(), { workflow: {}, expectedDateKey: '2026-07-14' });
  assert.equal(draft.validation.valid, true);
  assert.equal(draft.status, 'valid');
  assert.equal(draft.wordCount, 20);
  assert.equal(draft.cardReadyCount, 20);
  assert.equal(draft.imageReadyCount, 0);
  assert.ok(draft.validation.warnings.some(message => message.includes('参考图片未全部就绪')));
});

test('semantic duplicates and recent 30-day repeats block a Codex draft', () => {
  const words = [...CURATED_WORDS];
  words[1] = 'もやもや';
  const draft = validateCodexDailyDraft(makeDraft(words), {
    workflow: { todaySnapshot: { dateKey: '2026-07-13', words: ['余裕'], generatedAt: '2026-07-13T01:00:00.000Z' } },
    expectedDateKey: '2026-07-14'
  });
  assert.equal(draft.validation.valid, false);
  assert.ok(draft.validation.errors.some(message => message.includes('同日语义重复')));
  assert.ok(draft.validation.errors.some(message => message.includes('余裕')));
});

test('promotion preserves team-owned fields and publishes Codex cards', () => {
  const workflow = {
    words: ['余裕'],
    statuses: { '余裕': 'pending' },
    publishedRecords: [{ id: 'record-1', word: '心地よい', title: '人工标题' }]
  };
  const result = promoteCodexDailyDraft(workflow, makeDraft(), { expectedDateKey: '2026-07-14' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.workflow.words, ['余裕']);
  assert.equal(result.workflow.statuses['余裕'], 'pending');
  assert.equal(result.workflow.publishedRecords[0].title, '人工标题');
  assert.equal(result.workflow.todaySnapshot.source, 'codex_draft');
  assert.equal(result.workflow.todaySnapshot.createdBy, 'codex');
  assert.equal(result.workflow.todaySnapshot.words.length, 20);
  assert.equal(result.workflow.candidatePool['モヤる'].aiCard.cardStatus, 'ready');
});

test('Codex token can submit drafts but cannot publish or write favorites', async () => {
  const kv = makeKv({ 'favorites:global': { words: [] } });
  const env = { FAVORITES: kv, CODEX_AUTOMATION_SECRET: 'codex-secret', AUTO_REFRESH_SECRET: 'cron-secret' };
  const submitResponse = await handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeDraft())
    }),
    env
  });
  assert.equal(submitResponse.status, 200);

  const promoteResponse = await handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'POST',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', targetDateKey: '2026-07-14' })
    }),
    env
  });
  assert.equal(promoteResponse.status, 401);

  const favoriteResponse = await handleFavorites({
    request: apiRequest('/favorites', { headers: { Authorization: 'Bearer codex-secret' } }),
    env
  });
  assert.equal(favoriteResponse.status, 401);
});

test('scheduled Worker promotion writes the workflow and is idempotent', async () => {
  const kv = makeKv({ 'favorites:global': { words: ['余裕'] } });
  const env = { FAVORITES: kv, CODEX_AUTOMATION_SECRET: 'codex-secret', AUTO_REFRESH_SECRET: 'cron-secret' };
  await handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeDraft())
    }),
    env
  });
  const promote = () => handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'POST',
      headers: { Authorization: 'Bearer cron-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', targetDateKey: '2026-07-14' })
    }),
    env
  });
  const first = await promote();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).source, 'codex_draft');
  const stored = await kv.get('favorites:global', 'json');
  assert.equal(stored.todaySnapshot.dateKey, '2026-07-14');
  assert.deepEqual(stored.words, ['余裕']);
  const second = await promote();
  assert.equal((await second.json()).alreadyPublished, true);
});

test('reference image upload is scoped to Codex and can be read by its opaque key', async () => {
  const objects = new Map();
  const r2 = {
    async put(key, bytes, options) {
      objects.set(key, { bytes, contentType: options.httpMetadata.contentType });
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return { body: item.bytes, httpMetadata: { contentType: item.contentType }, httpEtag: 'etag' };
    }
  };
  const upload = await handleCodexImage({
    request: apiRequest('/codex-image?date=2026-07-14&word=%E3%83%A2%E3%83%A4%E3%82%8B', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'image/webp' },
      body: new Uint8Array([1, 2, 3])
    }),
    env: { REFERENCE_IMAGES: r2, CODEX_AUTOMATION_SECRET: 'codex-secret' }
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  const image = await handleCodexImage({
    request: apiRequest(uploaded.url),
    env: { REFERENCE_IMAGES: r2 }
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/webp');
});

test('reference image falls back to expiring KV storage with public edge caching', async () => {
  const objects = new Map();
  let writeOptions = null;
  const kv = {
    async put(key, bytes, options) {
      writeOptions = options;
      objects.set(key, { bytes, metadata: options.metadata });
    },
    async getWithMetadata(key, options) {
      assert.deepEqual(options, { type: 'arrayBuffer', cacheTtl: 86400 });
      const item = objects.get(key);
      return item ? { value: item.bytes, metadata: item.metadata } : { value: null, metadata: null };
    }
  };
  const upload = await handleCodexImage({
    request: apiRequest('/codex-image?date=2026-07-14&word=%E4%BD%99%E8%A3%95', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([4, 5, 6])
    }),
    env: { REFERENCE_IMAGES_KV: kv, CODEX_AUTOMATION_SECRET: 'codex-secret' }
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.storage, 'kv');
  assert.equal(uploaded.expiresInSeconds, KV_IMAGE_TTL_SECONDS);
  assert.equal(writeOptions.expirationTtl, KV_IMAGE_TTL_SECONDS);
  assert.equal(writeOptions.metadata.contentType, 'image/jpeg');

  const image = await handleCodexImage({
    request: apiRequest(uploaded.url),
    env: { REFERENCE_IMAGES_KV: kv }
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.match(image.headers.get('Cache-Control'), /s-maxage=604800/);
});

test('KV reference images reject payloads above the bounded storage budget', async () => {
  const kv = {
    async put() {
      assert.fail('oversized image must not be stored');
    }
  };
  const upload = await handleCodexImage({
    request: apiRequest('/codex-image?date=2026-07-14&word=%E4%BD%99%E8%A3%95', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'image/webp' },
      body: new Uint8Array(KV_IMAGE_MAX_BYTES + 1)
    }),
    env: { REFERENCE_IMAGES_KV: kv, CODEX_AUTOMATION_SECRET: 'codex-secret' }
  });
  assert.equal(upload.status, 413);
  assert.equal((await upload.json()).error.code, 'IMAGE_TOO_LARGE');
});

test('midnight trigger prefers Codex and calls DeepSeek only as fallback', async () => {
  const codexCalls = [];
  const codexResult = await triggerDailyPublishOrFallback({
    SITE_URL: 'https://jiyimianbao.pages.dev',
    AUTO_REFRESH_SECRET: 'cron-secret'
  }, async (url, options) => {
    codexCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, published: true, source: 'codex_draft' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal(codexResult.source, 'codex');
  assert.equal(codexCalls.length, 1);
  assert.match(codexCalls[0].url, /\/codex-daily/);

  const fallbackCalls = [];
  const fallbackResult = await triggerDailyPublishOrFallback({
    SITE_URL: 'https://jiyimianbao.pages.dev',
    AUTO_REFRESH_SECRET: 'cron-secret'
  }, async (url, options) => {
    fallbackCalls.push({ url, options });
    if (url.includes('/codex-daily')) {
      return new Response(JSON.stringify({ error: { code: 'CODEX_DRAFT_MISSING' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(fallbackResult.source, 'deepseek');
  assert.equal(fallbackCalls.length, 2);
  assert.match(fallbackCalls[1].url, /\/daily-refresh/);
  assert.equal(fallbackCalls[1].options.headers['Content-Type'], 'application/json');
});

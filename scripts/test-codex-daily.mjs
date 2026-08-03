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
  CODEX_DAILY_WORD_COUNT,
  buildCodexDailyContext,
  getCodexDraftStorageKey,
  promoteCodexDailyDraft,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
import {
  CODEX_BATCH_IMAGE_MAX_BYTES,
  applyCodexImageManifestResult,
  applyCodexImageUploadResult,
  getCodexImageContentType,
  getPendingCodexImageItems,
  isRetryableCodexImageUploadError
} from '../shared/codex-image-batch.mjs';
import { addDays, dateKey } from '../shared/rankings.mjs';
import { buildTodayRecommendationAudit } from '../shared/today-snapshot.mjs';
import {
  runDailyOperationsHealthCheck,
  triggerCodexPromotionIfAvailable,
  triggerDailyPublishOrFallback
} from '../worker/favorites-worker.js';

const CURATED_WORDS = [
  'モヤる', 'しんみり', 'かぶる', '気を遣う', 'だらける',
  '追い込み', '余裕', 'アンニュイ', '見切り', 'おけまる',
  '甘えん坊', '心地よい', 'ツンデレ', '仕切り直し', 'リフレッシュ',
  'ほのぼの', 'わくわく', 'やりくり', '煮詰まる', 'そわそわ'
];
const DAILY_CURATED_WORDS = CURATED_WORDS.slice(0, CODEX_DAILY_WORD_COUNT);

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

function makeDraft(words = DAILY_CURATED_WORDS, options = {}) {
  return {
    targetDateKey: options.targetDateKey || '2026-07-14',
    threadId: '019f5c0e-3d15-75b2-92b1-5f6cb05610aa',
    generatorVersion: 'codex-daily-v1',
    items: words.map((kanji, index) => ({
      kanji,
      kana: kanji,
      romaji: `word-${index + 1}`,
      meaning: `${kanji} 的中文含义说明`,
      category: index < 2 ? '情绪状态' : index < 4 ? '人际语感' : index < 6 ? '生活状态' : '自然日语表达',
      candidateType: index < 2 ? '网络口语词' : index < 4 ? '稳定候选' : index < 6 ? '生活方式词' : '稳定候选',
      reason: index < 6
        ? '有情绪状态、真实场景和收藏价值，适合标题与封面。'
        : index < 10
          ? '有人际关系与社交语感，适合中文用户收藏和做标题。'
          : index < 16
            ? '有生活场景和状态画面，适合中文用户收藏和做标题。'
            : '有自然语感和真实场景，适合中文用户收藏和做标题。',
      xhsFitScore: index < 6 ? 92 : 84,
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

test('a complete 10-word Codex draft passes while missing images remain non-blocking', () => {
  const draft = validateCodexDailyDraft(makeDraft(), { workflow: {}, expectedDateKey: '2026-07-14' });
  assert.equal(draft.validation.valid, true);
  assert.equal(draft.status, 'valid');
  assert.equal(draft.wordCount, CODEX_DAILY_WORD_COUNT);
  assert.equal(draft.cardReadyCount, CODEX_DAILY_WORD_COUNT);
  assert.equal(draft.imageReadyCount, 0);
  assert.ok(draft.validation.warnings.some(message => message.includes('参考图片未全部就绪')));
});

test('Codex batch image helpers skip ready cards and preserve local generation metadata', () => {
  const draft = makeDraft(CURATED_WORDS.slice(0, 2));
  draft.items[0].aiCard.referenceImage = {
    status: 'ready',
    url: '/codex-image?key=existing',
    prompt: 'existing prompt',
    provider: 'openai-imagegen',
    generatedAt: '2026-07-13T06:00:00.000Z'
  };
  const pending = getPendingCodexImageItems(draft);
  assert.deepEqual(pending.map(entry => [entry.order, entry.word]), [[2, CURATED_WORDS[1]]]);

  const upload = {
    key: 'codex-daily/2026-07-14/new.webp',
    url: '/codex-image?key=new',
    storage: 'kv',
    contentType: 'image/webp',
    size: 1234
  };
  const image = applyCodexImageUploadResult(
    draft,
    CURATED_WORDS[1],
    upload,
    '2026-07-13T07:00:00.000Z'
  );
  assert.equal(image.status, 'ready');
  assert.equal(image.url, upload.url);
  assert.equal(image.key, upload.key);
  assert.equal(image.provider, 'codex');
  assert.equal(image.prompt, `为 ${CURATED_WORDS[1]} 生成参考图片`);

  const manifest = {};
  const saved = applyCodexImageManifestResult(manifest, CURATED_WORDS[1], upload, {
    file: '02-word.webp',
    generatedAt: '2026-07-13T07:00:00.000Z'
  });
  assert.equal(saved.storage, 'kv');
  assert.equal(saved.file, '02-word.webp');
  assert.equal(saved.size, 1234);
  assert.equal(manifest[CURATED_WORDS[1]].status, 'ready');
});

test('Codex batch image helpers enforce supported formats and retry only transient failures', () => {
  assert.equal(CODEX_BATCH_IMAGE_MAX_BYTES, 800 * 1024);
  assert.equal(getCodexImageContentType('card.WEBP'), 'image/webp');
  assert.equal(getCodexImageContentType('card.gif'), '');
  assert.equal(isRetryableCodexImageUploadError(new Error('network')), true);
  assert.equal(isRetryableCodexImageUploadError({ status: 429 }), true);
  assert.equal(isRetryableCodexImageUploadError({ status: 502 }), true);
  assert.equal(isRetryableCodexImageUploadError({
    status: 503,
    data: { error: { code: 'IMAGE_STORAGE_NOT_CONFIGURED' } }
  }), false);
  assert.equal(isRetryableCodexImageUploadError({ status: 403 }), false);
  assert.equal(isRetryableCodexImageUploadError({ status: 413 }), false);
});

test('tomorrow preview is public and sanitized while the full draft stays protected', async () => {
  const targetDateKey = addDays(dateKey(), 1);
  const storedDraft = makeDraft(DAILY_CURATED_WORDS, { targetDateKey, imageReady: true });
  storedDraft.notes = 'internal notes';
  storedDraft.operationId = 'internal-operation';
  const kv = makeKv({
    'favorites:global': { words: [] },
    [getCodexDraftStorageKey(targetDateKey)]: storedDraft
  });
  const env = { FAVORITES: kv, CODEX_AUTOMATION_SECRET: 'codex-secret' };

  const previewResponse = await handleCodexDaily({
    request: apiRequest(`/codex-daily?date=${targetDateKey}&view=preview`),
    env
  });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).draft;
  assert.equal(preview.wordCount, CODEX_DAILY_WORD_COUNT);
  assert.equal(preview.items.length, CODEX_DAILY_WORD_COUNT);
  assert.equal(preview.threadId, undefined);
  assert.equal(preview.notes, undefined);
  assert.equal(preview.operationId, undefined);
  assert.equal(preview.items[0].aiCard.referenceImage.prompt, undefined);
  assert.match(preview.items[0].aiCard.referenceImage.url, /^\/codex-image\?key=/);
  assert.equal(preview.items[0].aiCard.targetAudience, storedDraft.items[0].aiCard.targetAudience);
  assert.equal(preview.items[0].aiCard.referenceDirection, storedDraft.items[0].aiCard.referenceDirection);
  assert.deepEqual(preview.items[0].aiCard.coverSuggestion, storedDraft.items[0].aiCard.coverSuggestion);
  assert.deepEqual(preview.items[0].aiCard.similarWords, storedDraft.items[0].aiCard.similarWords);
  assert.deepEqual(preview.items[0].aiCard.interactionPrompts, storedDraft.items[0].aiCard.interactionPrompts);

  const statusResponse = await handleCodexDaily({
    request: apiRequest(`/codex-daily?date=${targetDateKey}&view=preview-status`),
    env
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).draft.items, undefined);

  const fullDraftResponse = await handleCodexDaily({
    request: apiRequest(`/codex-daily?date=${targetDateKey}&view=draft`),
    env
  });
  assert.equal(fullDraftResponse.status, 401);

  const wrongDateResponse = await handleCodexDaily({
    request: apiRequest(`/codex-daily?date=${addDays(targetDateKey, 1)}&view=preview`),
    env
  });
  assert.equal(wrongDateResponse.status, 404);
});

test('semantic duplicates and recent 30-day repeats block a Codex draft', () => {
  const words = [...DAILY_CURATED_WORDS];
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
  assert.equal(result.workflow.todaySnapshot.words.length, CODEX_DAILY_WORD_COUNT);
  assert.equal(result.workflow.candidatePool['モヤる'].aiCard.cardStatus, 'ready');
});

test('Codex daily context receives separated published learning signals', () => {
  const baselineRecords = ['余白', 'こなれ', '透明感'].map((word, index) => ({
    id: `baseline-${index}`,
    word,
    title: word,
    publishedAt: `2026-07-${String(1 + index).padStart(2, '0')}T09:00:00+08:00`,
    latestMetrics: { impressions: 5000, views: 1000, coverClickRate: 0.2, likes: 50, comments: 3, favorites: 20, follows: 2, shares: 5, avgWatchSeconds: 10 }
  }));
  const context = buildCodexDailyContext({
    publishedRecords: [{
      id: 'target',
      word: '抜け感',
      title: '抜け感',
      publishedAt: '2026-07-10T09:00:00+08:00',
      latestMetrics: { impressions: 5000, views: 1000, coverClickRate: 0.05, likes: 20, comments: 10, favorites: 80, follows: 10, shares: 20, avgWatchSeconds: 5 }
    }, ...baselineRecords]
  }, '2026-07-22');
  assert.ok(context.publishedLearning);
  assert.match(context.publishedLearning.rule, /选题表现只用于学习词/);
  assert.equal(context.publishedLearning.guidanceEnabled, false);

  const futureContext = buildCodexDailyContext({
    publishedRecords: [{
      id: 'target',
      word: '抜け感',
      title: '抜け感',
      publishedAt: '2026-07-10T09:00:00+08:00',
      latestMetrics: { impressions: 5000, views: 1000, coverClickRate: 0.05, likes: 20, comments: 10, favorites: 80, follows: 10, shares: 20, avgWatchSeconds: 5 }
    }, ...baselineRecords]
  }, '2026-08-10');
  assert.equal(futureContext.publishedLearning.guidanceEnabled, true);
  assert.equal(futureContext.publishedLearning.guidanceTargetDateKey, '2026-08-10');
  assert.equal(futureContext.publishedLearning.guidance.topic.destination, 'topic_selection_only');
  assert.equal(futureContext.publishedLearning.guidance.cover.destination, 'visual_brief_only');
  assert.equal(futureContext.publishedLearning.guidance.content.destination, 'card_structure_only');
  assert.ok(!('rankAdjustment' in futureContext.publishedLearning.guidance.topic));
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

test('a valid Codex draft replaces a same-day non-Codex fallback snapshot', async () => {
  const fallbackWords = Array.from({ length: 20 }, (_, index) => `候选词${index + 1}`);
  const kv = makeKv({
    'favorites:global': {
      words: ['余裕'],
      todaySnapshot: {
        dateKey: '2026-07-14',
        words: fallbackWords,
        generatedAt: '2026-07-13T16:00:00.000Z',
        source: 'candidatePool',
        version: 1,
        createdBy: 'server'
      }
    }
  });
  const env = { FAVORITES: kv, CODEX_AUTOMATION_SECRET: 'codex-secret', AUTO_REFRESH_SECRET: 'cron-secret' };
  await handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'PUT',
      headers: { Authorization: 'Bearer codex-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeDraft())
    }),
    env
  });

  const response = await handleCodexDaily({
    request: apiRequest('/codex-daily?date=2026-07-14', {
      method: 'POST',
      headers: { Authorization: 'Bearer cron-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', targetDateKey: '2026-07-14' })
    }),
    env
  });
  const result = await response.json();
  const stored = await kv.get('favorites:global', 'json');

  assert.equal(response.status, 200);
  assert.equal(result.published, true);
  assert.equal(result.alreadyPublished, false);
  assert.equal(result.source, 'codex_draft');
  assert.deepEqual(stored.todaySnapshot.words, DAILY_CURATED_WORDS);
  assert.equal(stored.todaySnapshot.source, 'codex_draft');
  assert.equal(stored.todaySnapshot.version, 2);
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
    env: {
      REFERENCE_IMAGES_KV: kv,
      CODEX_AUTOMATION_SECRET: 'codex-secret',
      ALLOW_PUBLIC_APP: 'true'
    }
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
    return new Response(JSON.stringify({ ok: true, status: 'completed', queued: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal(fallbackResult.ok, true);
  assert.equal(fallbackResult.source, 'deepseek');
  assert.equal(fallbackCalls.length, 2);
  assert.match(fallbackCalls[1].url, /\/daily-refresh/);
  assert.match(fallbackCalls[1].url, /runInline=true/);
  assert.equal(fallbackCalls[1].options.headers['Content-Type'], 'application/json');
});

test('midnight fallback reports queued or failed refreshes as incomplete', async () => {
  const result = await triggerDailyPublishOrFallback({
    SITE_URL: 'https://jiyimianbao.pages.dev',
    AUTO_REFRESH_SECRET: 'cron-secret'
  }, async url => {
    if (url.includes('/codex-daily')) {
      return new Response(JSON.stringify({ error: { code: 'CODEX_DRAFT_MISSING' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, status: 'running', queued: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'deepseek');
  assert.equal(result.reason, 'running');
});

test('daily operations health check persists valid tomorrow draft state', async () => {
  const targetDateKey = '2026-07-27';
  const kv = makeKv({
    [getCodexDraftStorageKey(targetDateKey)]: {
      targetDateKey,
      status: 'valid',
      wordCount: CODEX_DAILY_WORD_COUNT,
      cardReadyCount: CODEX_DAILY_WORD_COUNT,
      imageReadyCount: CODEX_DAILY_WORD_COUNT,
      validation: { valid: true }
    }
  });
  const result = await runDailyOperationsHealthCheck({
    FAVORITES: kv
  }, {
    kind: 'tomorrow-draft',
    now: new Date('2026-07-26T09:15:00.000Z')
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.targetDateKey, targetDateKey);
  assert.equal(result.notification.configured, false);
  const stored = await kv.get(`operations-health:daily:tomorrow-draft:${targetDateKey}`, 'json');
  assert.equal(stored.status, 'healthy');
});

test('daily operations health check alerts and rejects a missing current snapshot', async () => {
  const kv = makeKv({
    'favorites:global': {
      todaySnapshot: {
        dateKey: '2026-07-26',
        words: DAILY_CURATED_WORDS
      }
    }
  });
  const alertCalls = [];
  await assert.rejects(() => runDailyOperationsHealthCheck({
    FAVORITES: kv,
    OPS_ALERT_WEBHOOK_URL: 'https://alerts.example.invalid/daily'
  }, {
    kind: 'today-snapshot',
    now: new Date('2026-07-26T16:10:00.000Z'),
    async fetchImpl(url, options) {
      alertCalls.push({ url, body: JSON.parse(options.body) });
      return new Response('{}', { status: 200 });
    }
  }), /snapshot_date_mismatch/);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].body.status, 'unhealthy');
  assert.equal(alertCalls[0].body.targetDateKey, '2026-07-27');
  const stored = await kv.get('operations-health:daily:today-snapshot:2026-07-27', 'json');
  assert.equal(stored.status, 'unhealthy');
  assert.equal(stored.notification.sent, true);
});

test('late Codex promotion skips missing drafts without triggering a fallback', async () => {
  let fetchCalls = 0;
  const result = await triggerCodexPromotionIfAvailable({
    SITE_URL: 'https://jiyimianbao.pages.dev',
    AUTO_REFRESH_SECRET: 'cron-secret',
    FAVORITES: { async get() { return null; } }
  }, async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 500 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'draft_missing');
  assert.equal(fetchCalls, 0);
});

test('late Codex promotion publishes a valid unpublished draft without DeepSeek', async () => {
  const calls = [];
  const result = await triggerCodexPromotionIfAvailable({
    SITE_URL: 'https://jiyimianbao.pages.dev',
    AUTO_REFRESH_SECRET: 'cron-secret',
    FAVORITES: {
      async get() {
        return { status: 'valid', publishedAt: '', validation: { valid: true } };
      }
    }
  }, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, published: true, source: 'codex_draft' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'codex');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/codex-daily/);
  assert.equal(JSON.parse(calls[0].options.body).action, 'promote');
});

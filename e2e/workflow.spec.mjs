import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppWorkflowView, buildFavoriteCommandView, applyFavoriteAction } from '../functions/favorites.js';
import { mergeWorkflowForFullSave } from '../shared/workflow-schema.mjs';

const GENERATOR_VERSION = 'daily-v4-dedup30-server';
const STATIC_BUILD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const STATIC_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

async function installStaticBuildFixture(page) {
  if (process.env.E2E_ROUTE_STATIC !== '1') return;
  await page.route('http://app.test/**', async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(STATIC_BUILD_ROOT, relativePath);
    const isSafeFile = filePath.startsWith(`${STATIC_BUILD_ROOT}${path.sep}`)
      && fs.existsSync(filePath)
      && fs.statSync(filePath).isFile();
    if (!isSafeFile) {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      path: filePath
    });
  });
}

function shanghaiDateKey(offsetDays = 0) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date(Date.now() + offsetDays * 86400000));
}

function candidate(kanji, kana, meaning) {
  return {
    kanji,
    kana,
    meaning,
    category: '感情',
    candidateType: '生活方式词',
    freshness: '长期',
    xhsFitScore: 88,
    riskLevel: 'low',
    confidenceLevel: 'high',
    evidenceType: 'common_usage',
    displayBucket: 'today',
    reason: '适合解释细微情绪和日常使用场景',
    suggestedAction: '可以收藏观察',
    sourceType: 'codex_generated',
    sourceTags: ['Codex生成', '自动日更'],
    updatedAt: '2026-07-19T00:00:00.000Z'
  };
}

function createWorkflow() {
  const today = shanghaiDateKey();
  const candidatePool = {
    そわそわ: candidate('そわそわ', 'そわそわ', '坐立不安、心神不宁'),
    気が重い: candidate('気が重い', 'きがおもい', '心情沉重、不太想面对')
  };
  return {
    words: [],
    statuses: {},
    feedback: {},
    publishedRecords: [],
    candidatePool,
    aiBatches: [],
    aiPreview: {},
    todaySnapshot: {
      dateKey: today,
      words: ['そわそわ', '気が重い'],
      version: 1,
      generatorVersion: GENERATOR_VERSION,
      generatedAt: '2026-07-19T00:00:00.000Z',
      source: 'codex',
      selectionMethod: 'E2E fixture'
    },
    todayDismissed: { dateKey: today, words: [], updatedAt: '' },
    historySnapshots: {},
    todaySnapshotHistory: [],
    revision: 1,
    auditLog: [],
    updated: '2026-07-19T00:00:00.000Z',
    schemaVersion: 2
  };
}

function createPerformanceWorkflow() {
  const state = createWorkflow();
  const words = Array.from({ length: 30 }, (_, index) => `検証語${index + 1}`);
  words.forEach((word, index) => {
    state.candidatePool[word] = {
      ...candidate(word, `けんしょうご${index + 1}`, `性能验收词 ${index + 1}`),
      aiCard: { cardStatus: 'ready', summary: `性能验收词卡 ${index + 1}` }
    };
  });
  state.words = words;
  state.publishedRecords = Array.from({ length: 25 }, (_, index) => ({
    id: `published-performance-${index + 1}`,
    word: words[index],
    title: `已发布性能验收 ${index + 1}`,
    description: `🍞${words[index]}\n（けんしょうご）\n性能验收词 ${index + 1}\n这是只读帖子正文。`,
    contentType: '图文',
    contentCategory: 'word_card',
    contentLocked: true,
    contentImportedAt: '2026-07-20T08:00:00.000Z',
    contentSource: 'xhs_note_manager',
    publishedAt: `2026-07-${String(20 - (index % 10)).padStart(2, '0')}T09:00:00+08:00`,
    latestMetrics: {
      impressions: 1000 + index * 50,
      views: 500 + index * 20,
      coverClickRate: 0.08,
      likes: 50 + index,
      comments: 5 + index,
      favorites: 20 + index,
      follows: 2 + index,
      shares: 3 + index,
      avgWatchSeconds: 8,
      danmaku: 0
    },
    metricSnapshots: [],
    lastMetricsImportedAt: '2026-07-21T06:30:00.000Z',
    selectionSource: { type: 'daily_hot_codex', label: 'Codex 每日热门' },
    noteId: index === 0 ? '6a5cc0930000000011004cf7' : '',
    link: index === 0
      ? 'https://www.xiaohongshu.com/404?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore%2F6a5cc0930000000011004cf7'
      : '',
    updatedAt: '2026-07-21T06:30:00.000Z'
  }));
  return state;
}

async function installApiFixture(page, options = {}) {
  await installStaticBuildFixture(page);
  const state = options.workflow || createWorkflow();
  const controls = {
    state,
    lastFullSavePayload: null,
    mutationFailuresRemaining: options.mutationFailures || 0,
    commandRequests: 0,
    fullSaveRequests: 0,
    candidateDetailRequests: 0,
    publishedDetailRequests: 0,
    candidateDetailRequestWords: [],
    publishedDetailRequestIds: [],
    pageErrors: []
  };
  page.on('pageerror', error => controls.pageErrors.push(error.message));

  await page.route('**/rankings?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      days: [{
        dateKey: shanghaiDateKey(),
        words: state.todaySnapshot.words.map(word => state.candidatePool[word])
      }]
    })
  }));

  await page.route('**/codex-daily?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      draft: { status: 'missing', targetDateKey: shanghaiDateKey(1), wordCount: 0, cardReadyCount: 0, imageReadyCount: 0 }
    })
  }));

  await page.route('**/ai-candidates', async route => {
    const payload = route.request().postDataJSON();
    const words = Array.isArray(payload?.context?.words) ? payload.context.words : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: words.map(word => ({ kanji: word.kanji, aiCard: { cardStatus: 'none' } })),
        usage: { model: 'e2e-fixture' },
        summary: {}
      })
    });
  });

  await page.route('**/favorites?*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.searchParams.get('view') === 'candidate-detail') {
        controls.candidateDetailRequests += 1;
        const word = url.searchParams.get('word') || '';
        controls.candidateDetailRequestWords.push(word);
        const candidateItem = state.candidatePool[word] || null;
        await route.fulfill({
          status: candidateItem ? 200 : 404,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: Boolean(candidateItem),
            candidate: candidateItem ? {
              ...candidateItem,
              candidateProjection: 'detail',
              aiCard: {
                ...(candidateItem.aiCard || {}),
                projection: 'detail'
              }
            } : null,
            revision: state.revision,
            updated: state.updated,
            schemaVersion: 2
          })
        });
        return;
      }
      if (url.searchParams.get('view') === 'published-detail') {
        controls.publishedDetailRequests += 1;
        const recordId = url.searchParams.get('recordId') || '';
        controls.publishedDetailRequestIds.push(recordId);
        const record = state.publishedRecords.find(item => item.id === recordId) || null;
        await route.fulfill({
          status: record ? 200 : 404,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: Boolean(record),
            record,
            candidate: record?.word ? (state.candidatePool[record.word] || null) : null,
            revision: state.revision,
            updated: state.updated,
            schemaVersion: 2
          })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(url.searchParams.get('view') === 'command'
          ? buildFavoriteCommandView(state, url.searchParams.get('word'))
          : buildAppWorkflowView(state, { scope: url.searchParams.get('scope') || 'today' }))
      });
      return;
    }
    if (request.method() === 'PUT') {
      controls.fullSaveRequests += 1;
      controls.lastFullSavePayload = request.postDataJSON();
      Object.assign(state, mergeWorkflowForFullSave(state, controls.lastFullSavePayload), {
        revision: state.revision + 1,
        updated: new Date().toISOString()
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildAppWorkflowView(state, { scope: url.searchParams.get('scope') || 'today' })) });
      return;
    }

    controls.commandRequests += 1;
    if (controls.mutationFailuresRemaining > 0) {
      controls.mutationFailuresRemaining -= 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'WORKFLOW_CONFLICT', message: '版本冲突，请重试' } })
      });
      return;
    }
    const payload = request.postDataJSON();
    Object.assign(state, applyFavoriteAction(state, payload));
    state.revision += 1;
    state.updated = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        words: state.words,
        statuses: state.statuses,
        candidate: state.candidatePool[payload.word] || null,
        revision: state.revision,
        auditEvent: null,
        updated: state.updated,
        schemaVersion: 2
      })
    });
  });
  return controls;
}

async function openApp(page, options = {}) {
  const controls = await installApiFixture(page, options);
  await page.goto('/');
  await expect(page.locator('#todayGrid .daily-hot-card')).toHaveCount(2);
  return controls;
}

test('daily recommendations load without the retired candidate workbench', async ({ page }) => {
  const controls = await openApp(page);
  await expect(page.getByRole('heading', { name: '每日热门' })).toBeVisible();
  await expect(page.locator('#todayGrid')).toContainText('そわそわ');
  await expect(page.locator('#todayGrid')).toContainText('気が重い');
  await expect(page.getByText('候选池后台')).toHaveCount(0);
  await expect(page.locator('.ai-workbench, .candidate-admin-panel')).toHaveCount(0);
  expect(controls.pageErrors).toEqual([]);
});

test('cached startup and refresh avoid full-list work and reuse scoring within each batch', async ({ page }) => {
  const workflow = createPerformanceWorkflow();
  for (let index = 30; index < 120; index += 1) {
    const word = `検証語${index + 1}`;
    workflow.words.push(word);
    workflow.candidatePool[word] = {
      ...candidate(word, 'けんしょうご', `缓存性能验收词 ${index + 1}`),
      aiCard: { cardStatus: 'ready', summary: '缓存性能验收词卡' }
    };
  }
  workflow.publishedRecords = Array.from({ length: 54 }, (_, index) => ({
    ...workflow.publishedRecords[index % 25],
    id: `cached-published-${index}`,
    // Reproduce historical records whose word is absent from a scoped cache.
    word: index >= 51 ? ['缺失甲词', '缺失乙词', '缺失丙词'][index - 51] : `検証語${index + 1}`,
    title: `历史已发布 ${index + 1}`
  }));
  workflow.todaySnapshot.words.forEach(word => {
    workflow.candidatePool[word].aiCard = { cardStatus: 'ready', summary: '已有正式词卡' };
  });
  const controls = await installApiFixture(page, { workflow });
  await page.addInitScript(value => {
    localStorage.setItem('kotoba_workflow_state_v2', JSON.stringify(value));
    localStorage.setItem('kotoba_active_tab', 'today');
  }, workflow);

  // Instrument only this test's served module; production has no test facade.
  const counters = ['getFavoriteWords', 'getCategoryPreferenceMap', 'buildRecommendedWord', 'getProtectedLibraryWords'];
  const appSource = fs.readFileSync(path.join(STATIC_BUILD_ROOT, 'app.js'), 'utf8');
  const probes = counters.map(name => `${name} = ((original) => function (...args) {
    window.__startupCounts['${name}'] += 1;
    return original.apply(this, args);
  })(${name});`).join('\n');
  const scoringCheck = `window.__checkScoringBatch = () => {
    const word = todayWords[0];
    const previousFavorites = favorites;
    const previousStatuses = favoriteStatuses;
    const context = buildRecommendationScoringContext();
    const individual = buildRecommendedWord(word, word.origin, word.candidateMeta);
    const batched = buildRecommendedWord(word, word.origin, word.candidateMeta, context);
    const separateAggregates = {
      categoryPreferenceMap: getCategoryPreferenceMap(),
      sourcePreferenceMap: getSourcePreferenceMap(),
      directionProfile: getPublishedDirectionProfile(),
      styleProfile: getPublishedStyleProfile(),
      publishedWordMap: getPublishedPerformanceWordMap()
    };
    try {
      favorites = [...favorites, word.kanji];
      favoriteStatuses = { ...favoriteStatuses, [word.kanji]: 'pending' };
      const nextContext = buildRecommendationScoringContext();
      return {
        sameScore: JSON.stringify(individual.scoreBreakdown) === JSON.stringify(batched.scoreBreakdown),
        sameCard: JSON.stringify(individual.aiCard) === JSON.stringify(batched.aiCard),
        sameAggregates: JSON.stringify(context) === JSON.stringify(separateAggregates),
        freshCategorySignal: nextContext.categoryPreferenceMap[word.category] - context.categoryPreferenceMap[word.category]
      };
    } finally {
      favorites = previousFavorites;
      favoriteStatuses = previousStatuses;
    }
  };`;
  await page.route('**/app.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: appSource.replace(/\ninit\(\);\s*$/, `
      window.__startupCounts = ${JSON.stringify(Object.fromEntries(counters.map(name => [name, 0])))};
      ${probes}
      ${scoringCheck}
      init();
    `)
  }));

  await page.goto('/');
  await expect(page.locator('#todayGrid .daily-hot-card')).toHaveCount(2);
  await expect(page.locator('#publishedBadge')).toHaveText('54');
  await page.getByRole('button', { name: '🔄 刷新', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('已同步云端榜单和团队工作流');
  const calls = await page.evaluate(() => window.__startupCounts);
  expect(calls.getFavoriteWords).toBe(0);
  expect(calls.getCategoryPreferenceMap).toBeLessThan(calls.buildRecommendedWord);
  expect(calls.getProtectedLibraryWords).toBeLessThan(30);
  expect(await page.evaluate(() => window.__checkScoringBatch())).toEqual({
    sameScore: true,
    sameCard: true,
    sameAggregates: true,
    freshCategorySignal: 6
  });
  expect(controls.pageErrors).toEqual([]);
});

test('scoped saves preserve unloaded favorites and full cards, and undo survives reload', async ({ page }, testInfo) => {
  const workflow = createWorkflow();
  const hiddenFavorite = '検証のお気に入り';
  workflow.words = [hiddenFavorite];
  workflow.statuses = { [hiddenFavorite]: 'pending' };
  workflow.candidatePool[hiddenFavorite] = candidate(hiddenFavorite, 'けんしょうのおきにいり', '未加载的收藏');
  const fullCard = {
    cardStatus: 'ready', cardSource: 'codex', generatedAt: '2026-07-19T00:00:00.000Z',
    summary: '列表测试摘要', explanation: '完整词卡说明必须在列表保存后保留。',
    examples: [{ jp: 'そわそわする。', cn: '心神不宁。' }],
    suggestedTitles: ['第一个标题', '第二个标题'],
    referenceImage: { status: 'ready', url: '/assets/brand/memory-bread-favicon-32.png', prompt: '完整图片提示词' }
  };
  Object.values(workflow.candidatePool).forEach(entry => { entry.aiCard = { ...fullCard }; });
  const controls = await openApp(page, { workflow });
  await expect(page.locator('#favBadge')).toHaveText('1');
  const card = page.locator('#todayGrid .daily-hot-card').filter({ hasText: 'そわそわ' });
  await card.getByRole('button', { name: '不感兴趣', exact: true }).click();
  await expect.poll(() => controls.fullSaveRequests).toBe(1);
  expect(controls.state.words).toEqual([hiddenFavorite]);
  expect(controls.lastFullSavePayload.candidatePool[hiddenFavorite]).toBeUndefined();
  expect(controls.lastFullSavePayload.candidatePool['そわそわ'].aiCard.projection).toBe('list');
  expect(controls.state.candidatePool['そわそわ'].aiCard.explanation).toBe(fullCard.explanation);
  expect(controls.state.candidatePool['そわそわ'].aiCard.referenceImage.prompt).toBe(fullCard.referenceImage.prompt);
  expect(controls.state.candidatePool[hiddenFavorite].sourceType).toBe('codex_generated');
  await page.locator('#toast .toast-action').click();
  await expect.poll(() => controls.fullSaveRequests).toBe(2);
  expect(controls.state.todayDismissed.words).toEqual([]);
  expect(controls.state.candidatePool['そわそわ'].ignoredCount).toBe(0);
  await page.reload();
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('已跳过');
  await expect(page.locator('#favBadge')).toHaveText('1');
  await card.locator('.card-fav-btn').click();
  await expect.poll(() => controls.commandRequests).toBe(1);
  await expect(page.locator('#favBadge')).toHaveText('2');
  expect(controls.state.words).toContain(hiddenFavorite);
  expect(controls.state.candidatePool['そわそわ'].aiCard.examples).toHaveLength(1);
  if (testInfo.project.name.startsWith('iphone-')) await page.locator('.mobile-toggle').click();
  await page.locator('[data-app-shell-action="switch-tab"][data-tab="favorites"]').click();
  await expect(page.locator('#favGrid')).toContainText(hiddenFavorite);
  const favoriteCard = page.locator('#favGrid .workflow-card').filter({ hasText: hiddenFavorite });
  await favoriteCard.click();
  await expect(page.locator('#modalContainer')).toContainText(fullCard.explanation);
  expect(controls.pageErrors).toEqual([]);
});

test('favorite and pending status persist through command synchronization', async ({ page }, testInfo) => {
  const controls = await openApp(page);
  await page.locator('#todayGrid .daily-hot-card').filter({ hasText: 'そわそわ' }).locator('.card-fav-btn').click();
  await expect.poll(() => controls.commandRequests).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#favBadge')).toContainText('1');
  if (testInfo.project.name.startsWith('iphone-')) await page.locator('.mobile-toggle').click();
  await page.locator('[data-app-shell-action="switch-tab"][data-tab="favorites"]').click();
  const card = page.locator('#favGrid .workflow-card').filter({ hasText: 'そわそわ' });
  await expect(card).toBeVisible();
  await card.locator('[data-favorites-action="toggle-status"]').click();
  await card.locator('[data-favorites-action="select-status"][data-status="pending"]').click();
  await expect(card.locator('[data-favorites-action="toggle-status"]')).toContainText('待发布');
  expect(controls.commandRequests).toBeGreaterThanOrEqual(2);
  expect(controls.pageErrors).toEqual([]);
});

test('failed favorite writes stay visible across reload and sync automatically after recovery', async ({ page }) => {
  const controls = await openApp(page, { mutationFailures: Number.POSITIVE_INFINITY });
  const favoriteButton = page.locator('#todayGrid .daily-hot-card').filter({ hasText: 'そわそわ' }).locator('.card-fav-btn');
  await favoriteButton.click();
  await expect(page.locator('#toast')).toContainText('收藏已记下');
  await expect(page.locator('#favBadge')).toContainText('1');
  await expect(favoriteButton).toBeDisabled();
  await expect(favoriteButton).toHaveClass(/waiting-sync/);

  await page.reload();
  const restoredButton = page.locator('#todayGrid .daily-hot-card').filter({ hasText: 'そわそわ' }).locator('.card-fav-btn');
  await expect(page.locator('#favBadge')).toContainText('1');
  await expect(restoredButton).toBeDisabled();
  await expect(restoredButton).toHaveClass(/(?:syncing|waiting-sync)/);

  controls.mutationFailuresRemaining = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(restoredButton).toBeEnabled();
  await expect(restoredButton).toHaveClass(/favorited/);
  await expect(restoredButton).not.toHaveClass(/waiting-sync/);
  expect(controls.commandRequests).toBeGreaterThanOrEqual(3);
  expect(controls.pageErrors).toEqual([]);
});

test('validated backup stays read-only when restore confirmation is cancelled', async ({ page }) => {
  const controls = await openApp(page);
  await expect(page.locator('[data-app-shell-action="open-settings"]')).toHaveCount(0);
  await page.locator('#settingsOverlay').evaluate(element => element.classList.add('open'));
  await expect(page.locator('#settingsOverlay')).toHaveClass(/open/);
  const dialogPromise = page.waitForEvent('dialog');
  await page.locator('#workflowRestoreInput').setInputFiles({
    name: 'workflow-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createWorkflow()))
  });
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('备份校验通过');
  await dialog.dismiss();
  expect(controls.fullSaveRequests).toBe(0);
  expect(controls.pageErrors).toEqual([]);
});

test('mobile layout has no page-level horizontal overflow', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('iphone-'), 'mobile-only layout assertion');
  const controls = await openApp(page);
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    animationNames: [...document.querySelectorAll('.page.active, #todayGrid .word-card')]
      .map(element => window.getComputedStyle(element).animationName)
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.animationNames.every(name => name === 'none')).toBe(true);
  expect(controls.pageErrors).toEqual([]);
});

test('favorites and published pages progressively render cards and open responsive details', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const controls = await openApp(page, { workflow: createPerformanceWorkflow() });
  const switchWorkflowTab = async (tab, cards, expectedCount) => {
    if (testInfo.project.name.startsWith('iphone-')) {
      await page.locator('.mobile-toggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/open/);
    }
    await page.locator(`[data-app-shell-action="switch-tab"][data-tab="${tab}"]`).evaluate(element => {
      element.click();
    });
    await expect.poll(
      () => page.evaluate(() => document.body.dataset.activeTab),
      { timeout: 15_000 }
    ).toBe(tab);
    if (cards) await expect(cards).toHaveCount(expectedCount, { timeout: 15_000 });
  };

  const favoriteCards = page.locator('#favGrid .workflow-card');
  await switchWorkflowTab('favorites', favoriteCards, 12);
  await expect(page.locator('[data-progressive-list="favorites"]')).toContainText('已显示 12 / 30');
  await page.locator('[data-favorites-action="load-more"]').click();
  await expect(favoriteCards).toHaveCount(24);
  await favoriteCards.first().evaluate(card => {
    card.click();
  });
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect(page.locator('#modalContainer')).toContainText('検証語1', { timeout: 15_000 });
  await expect(page.locator('#modalContainer .modal-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  expect(controls.candidateDetailRequestWords.filter(word => word === '検証語1').length).toBeLessThanOrEqual(1);
  await page.locator('#modalContainer [data-modal-action="close"]').first().evaluate(button => {
    button.click();
  });
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);

  const publishedCards = page.locator('#publishedGrid .published-card');
  await switchWorkflowTab('published', publishedCards, 10);
  await expect(page.locator('[data-progressive-list="published"]')).toContainText('已显示 10 / 25');
  await page.locator('[data-published-action="load-more"]').evaluate(button => {
    button.click();
  });
  await expect(publishedCards).toHaveCount(20);
  const firstPublishedCard = publishedCards.first();
  const detailOpenedIn = await firstPublishedCard.evaluate(card => {
    const startedAt = performance.now();
    card.click();
    return performance.now() - startedAt;
  });
  expect(detailOpenedIn).toBeLessThan(100);
  await expect(page.locator('#modalOverlay')).toHaveClass(/open/);
  await expect.poll(
    () => controls.publishedDetailRequestIds.filter(recordId => recordId === 'published-performance-1').length,
    { timeout: 15_000 }
  ).toBe(1);
  await expect(page.locator('.published-detail-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#modalContainer')).toContainText('这是只读帖子正文');
  await expect(page.locator('.published-open-link')).toHaveAttribute(
    'href',
    'https://www.xiaohongshu.com/explore/6a5cc0930000000011004cf7'
  );
  await expect(page.locator('.published-note-desktop-action').first()).toHaveAttribute(
    'href',
    'https://creator.xiaohongshu.com/new/note-manager'
  );
  await page.locator('#modalContainer [data-modal-action="close"]').first().evaluate(button => {
    button.click();
  });
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/open/);
  await switchWorkflowTab('today', page.locator('#todayGrid .daily-hot-card'), 2);
  await switchWorkflowTab('published', publishedCards, 10);
  await expect(page.locator('[data-progressive-list="published"]')).toContainText('已显示 10 / 25');
  expect(controls.candidateDetailRequestWords.filter(word => word === '検証語1').length).toBeLessThanOrEqual(1);
  expect(controls.publishedDetailRequestIds.filter(recordId => recordId === 'published-performance-1')).toHaveLength(1);
  expect(controls.pageErrors).toEqual([]);
});

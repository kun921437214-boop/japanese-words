const SITE_URL = String(process.env.SITE_URL || 'https://jiyimianbao.pages.dev').replace(/\/+$/, '');
const TIMEOUT_MS = 30000;

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function fetchJson(path) {
  const response = await fetch(`${SITE_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache'
    },
    signal: globalThis.AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    fail(`${path} 返回了非 JSON 内容`, { status: response.status, bytes: Buffer.byteLength(text) });
  }
  if (!response.ok) {
    fail(`${path} 请求失败`, {
      status: response.status,
      code: data?.error?.code || '',
      requestId: data?.requestId || response.headers.get('X-Request-Id') || ''
    });
  }
  return { data, bytes: Buffer.byteLength(text), requestId: data?.requestId || response.headers.get('X-Request-Id') || '' };
}

try {
  const health = await fetchJson('/healthz');
  if (!health.data.storageConfigured) fail('Production FAVORITES binding 未生效');
  if (!health.data.workflowCoordinatorConfigured) fail('Production Durable Object 写入协调 binding 未生效');
  if (!health.data.imageStorageConfigured) fail('Production 图片 KV binding 未生效');

  const workflow = await fetchJson('/favorites?view=app&scope=today');
  const favoritesWorkflow = await fetchJson('/favorites?view=app&scope=favorites');
  const dateKey = todayKey();
  const snapshot = workflow.data.todaySnapshot || {};
  const words = Array.isArray(snapshot.words) ? snapshot.words : [];
  if (snapshot.dateKey !== dateKey) fail('Production 今日快照日期不正确', { expected: dateKey, actual: snapshot.dateKey || '' });
  if (words.length !== 20) fail('Production 今日推荐不是 20 个', { count: words.length });

  const candidatePool = workflow.data.candidatePool || {};
  const readyCards = words.filter(word => candidatePool[word]?.aiCard?.cardStatus === 'ready');
  const readyImages = words.filter(word => candidatePool[word]?.aiCard?.referenceImage?.status === 'ready');
  if (readyCards.length !== words.length) fail('Production 今日词卡尚未全部 ready', { ready: readyCards.length, total: words.length });
  if (readyImages.length !== words.length) fail('Production 今日图片尚未全部 ready', { ready: readyImages.length, total: words.length });
  if (workflow.data.appView?.scope !== 'today') fail('Production 今日页面未返回 scoped app view');
  if (favoritesWorkflow.data.appView?.scope !== 'favorites') fail('Production 收藏页面未返回 scoped app view');
  const favoriteWords = Array.isArray(favoritesWorkflow.data.words) ? favoritesWorkflow.data.words : [];
  const favoriteCandidates = Object.keys(favoritesWorkflow.data.candidatePool || {});
  if (favoriteCandidates.length < favoriteWords.length) {
    fail('Production 收藏页面候选词卡不完整', { favorites: favoriteWords.length, candidates: favoriteCandidates.length });
  }

  const revision = Number(workflow.data.revision) || 0;
  const auditLog = Array.isArray(workflow.data.auditLog) ? workflow.data.auditLog : [];
  const latestAudit = auditLog[0] || null;
  if (revision < 1) fail('Production workflow revision 尚未建立');
  if (!latestAudit) fail('Production workflow 缺少写入审计记录', { revision });
  if (Number(latestAudit.revision) !== revision) {
    fail('Production workflow revision 与最新审计记录不一致', {
      revision,
      auditRevision: Number(latestAudit.revision) || 0,
      action: latestAudit.action || ''
    });
  }
  if (latestAudit.after?.todaySnapshotDateKey !== dateKey || Number(latestAudit.after?.todaySnapshotCount) !== 20) {
    fail('Production 最新审计记录未保留今日 20 词快照', {
      dateKey: latestAudit.after?.todaySnapshotDateKey || '',
      count: Number(latestAudit.after?.todaySnapshotCount) || 0,
      action: latestAudit.action || ''
    });
  }

  console.log(JSON.stringify({
    ok: true,
    site: SITE_URL,
    dateKey,
    favorites: favoriteWords.length,
    todayWords: words.length,
    readyCards: readyCards.length,
    readyImages: readyImages.length,
    todayResponseBytes: workflow.bytes,
    favoritesResponseBytes: favoritesWorkflow.bytes,
    revision,
    latestMutation: {
      action: latestAudit.action || '',
      actor: latestAudit.actor || '',
      at: latestAudit.at || '',
      revision: Number(latestAudit.revision) || 0
    },
    requestId: workflow.requestId
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    site: SITE_URL,
    error: error?.message || String(error),
    details: error?.details || {}
  }, null, 2));
  process.exitCode = 1;
}

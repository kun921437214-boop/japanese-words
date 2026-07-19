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
  if (!health.data.imageStorageConfigured) fail('Production 图片 KV binding 未生效');

  const workflow = await fetchJson('/favorites?view=app');
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

  console.log(JSON.stringify({
    ok: true,
    site: SITE_URL,
    dateKey,
    favorites: Array.isArray(workflow.data.words) ? workflow.data.words.length : 0,
    todayWords: words.length,
    readyCards: readyCards.length,
    readyImages: readyImages.length,
    appResponseBytes: workflow.bytes,
    revision: Number(workflow.data.revision) || 0,
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

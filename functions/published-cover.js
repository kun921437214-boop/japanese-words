import {
  errorResponse,
  getRequestId,
  optionsResponse
} from '../shared/api-security.mjs';

const METHODS = ['GET', 'HEAD', 'OPTIONS'];
const COVER_KEY_PATTERN = /^published-covers\/v1\/[a-f0-9]{32}$/;
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const COVER_FETCH_TIMEOUT_MS = 12_000;
const COVER_CACHE_SECONDS = 365 * 24 * 60 * 60;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function getImageStorage(env = {}) {
  if (env.REFERENCE_IMAGES) return { kind: 'r2', binding: env.REFERENCE_IMAGES };
  if (env.REFERENCE_IMAGES_KV) return { kind: 'kv', binding: env.REFERENCE_IMAGES_KV };
  return null;
}

function cleanCoverKey(value) {
  const key = String(value || '').trim().slice(0, 160);
  return COVER_KEY_PATTERN.test(key) ? key : '';
}

function isXiaohongshuImageHost(hostname = '') {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'xhscdn.com' || normalized.endsWith('.xhscdn.com');
}

function normalizeSourceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    return isXiaohongshuImageHost(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function buildSourceCandidates(value) {
  const sourceUrl = normalizeSourceUrl(value);
  if (!sourceUrl) return [];
  const parsed = new URL(sourceUrl);
  const assetMatch = parsed.pathname.match(/\/([a-z0-9_-]{30,160})(?:![^/]*)?$/i);
  if (!assetMatch) return [sourceUrl];
  const assetKey = assetMatch[1];
  const sourceUsesNotesNamespace = parsed.pathname.split('/').includes('notes_pre_post');
  const stablePaths = sourceUsesNotesNamespace
    ? [`notes_pre_post/${assetKey}`, assetKey]
    : [assetKey, `notes_pre_post/${assetKey}`];
  const stableUrls = stablePaths.map(path => `https://sns-na-i6.xhscdn.com/${path}?imageView2/2/w/720/format/jpg&origin=0`);
  return [...new Set([...stableUrls, sourceUrl])];
}

function parseStoredCoverKey(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';
  try {
    const parsed = new URL(rawValue, 'https://bijinihaitan.cn');
    if (parsed.pathname !== '/published-cover') return '';
    return cleanCoverKey(parsed.searchParams.get('key'));
  } catch {
    return '';
  }
}

function buildPublicCoverUrl(key) {
  const cleanKey = cleanCoverKey(key);
  return cleanKey ? `/published-cover?key=${encodeURIComponent(cleanKey)}` : '';
}

async function digestRecordKey(record = {}) {
  const identity = String(record.id || record.noteId || record.sourceKey || '').trim();
  if (!identity) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `published-covers/v1/${hex.slice(0, 32)}`;
}

async function readImage(storage, key) {
  if (storage.kind === 'r2') {
    const object = await storage.binding.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType || 'image/jpeg',
      etag: object.httpEtag || ''
    };
  }
  const object = await storage.binding.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!object?.value) return null;
  return {
    body: object.value,
    contentType: object.metadata?.contentType || 'image/jpeg',
    etag: object.metadata?.etag || ''
  };
}

async function writeImage(storage, key, bytes, contentType, metadata = {}) {
  if (storage.kind === 'r2') {
    await storage.binding.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: metadata
    });
    return;
  }
  await storage.binding.put(key, bytes, {
    metadata: {
      ...metadata,
      contentType,
      size: bytes.byteLength
    }
  });
}

async function fetchImageResponse(url, fetchImpl, signal) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; KotobaBreadCoverBot/1.0; +https://bijinihaitan.cn)'
      },
      redirect: 'manual',
      signal
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get('Location');
    const nextUrl = normalizeSourceUrl(location ? new URL(location, currentUrl).toString() : '');
    if (!nextUrl) throw new Error('封面重定向到了非小红书图片域名');
    currentUrl = nextUrl;
  }
  throw new Error('封面重定向次数过多');
}

async function downloadCover(sourceUrl, fetchImpl = fetch) {
  let lastError = null;
  for (const candidateUrl of buildSourceCandidates(sourceUrl)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImageResponse(candidateUrl, fetchImpl, controller.signal);
      if (!response.ok) throw new Error(`封面下载失败（HTTP ${response.status}）`);
      const contentType = String(response.headers?.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('封面返回的不是受支持图片');
      const declaredLength = Number.parseInt(response.headers?.get('Content-Length') || '0', 10);
      if (declaredLength > MAX_COVER_BYTES) throw new Error('封面超过 2 MB 限制');
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) throw new Error('封面为空或超过 2 MB 限制');
      return { bytes, contentType };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('没有可下载的封面地址');
}

async function persistOneCover(record, storage, options = {}) {
  if (!record?.contentLocked) return { record, status: 'skipped' };
  const existingKey = cleanCoverKey(record.coverStorageKey) || parseStoredCoverKey(record.coverUrl);
  if (existingKey) {
    return {
      record: {
        ...record,
        coverUrl: buildPublicCoverUrl(existingKey),
        coverStorageKey: existingKey
      },
      status: 'reused'
    };
  }
  const sourceUrl = normalizeSourceUrl(record.coverUrl);
  if (!sourceUrl) return { record, status: 'skipped' };
  const key = await digestRecordKey(record);
  if (!key) return { record, status: 'skipped' };
  const existingObject = await readImage(storage, key);
  const storedAt = record.coverStoredAt || options.nowIso || new Date().toISOString();
  if (!existingObject) {
    const downloaded = await downloadCover(sourceUrl, options.fetchImpl || fetch);
    await writeImage(storage, key, downloaded.bytes, downloaded.contentType, {
      recordId: String(record.id || '').slice(0, 120),
      storedAt
    });
  }
  return {
    record: {
      ...record,
      coverUrl: buildPublicCoverUrl(key),
      coverStorageKey: key,
      coverStoredAt: storedAt,
      updatedAt: options.nowIso || new Date().toISOString()
    },
    status: existingObject ? 'reused' : 'stored'
  };
}

export async function persistPublishedRecordCovers(records = [], env = {}, options = {}) {
  const storage = getImageStorage(env);
  const sourceRecords = Array.isArray(records) ? records : [];
  const recordId = String(options.recordId || '').trim();
  const summary = { storedCount: 0, reusedCount: 0, failedCount: 0, skippedCount: 0 };
  if (!storage) {
    return {
      records: sourceRecords,
      summary: { ...summary, unavailable: true }
    };
  }

  const results = new Array(sourceRecords.length);
  let cursor = 0;
  async function processNext() {
    while (cursor < sourceRecords.length) {
      const index = cursor;
      cursor += 1;
      const record = sourceRecords[index];
      if (recordId && record?.id !== recordId) {
        results[index] = record;
        summary.skippedCount += 1;
        continue;
      }
      try {
        const persisted = await persistOneCover(record, storage, options);
        results[index] = persisted.record;
        if (persisted.status === 'stored') summary.storedCount += 1;
        else if (persisted.status === 'reused') summary.reusedCount += 1;
        else summary.skippedCount += 1;
      } catch (error) {
        results[index] = record;
        summary.failedCount += 1;
      }
    }
  }
  const concurrency = Math.min(4, Math.max(1, sourceRecords.length));
  await Promise.all(Array.from({ length: concurrency }, processNext));
  return { records: results, summary };
}

export async function onRequest({ request, env }) {
  const requestId = getRequestId(request);
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods: METHODS, requestId });
  if (request.method === 'OPTIONS') return optionsResponse(request, env, METHODS);
  if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  const storage = getImageStorage(env);
  if (!storage) return fail(503, 'IMAGE_STORAGE_NOT_CONFIGURED', '已发布封面存储尚未配置');
  const url = new URL(request.url);
  const key = cleanCoverKey(url.searchParams.get('key'));
  if (!key) return fail(400, 'INVALID_COVER_KEY', '封面 key 无效');
  const object = await readImage(storage, key);
  if (!object) return fail(404, 'COVER_NOT_FOUND', '封面不存在');
  const headers = new Headers({
    'Cache-Control': `public, max-age=${COVER_CACHE_SECONDS}, immutable`,
    'Content-Type': object.contentType,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId
  });
  if (object.etag) headers.set('ETag', object.etag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

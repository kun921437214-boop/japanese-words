import {
  cleanPublishedMetricSnapshot,
  cleanPublishedMetrics,
  isPublishedMetricUpdateActive,
  mergePublishedMetricSnapshots
} from './published-import.mjs';
import { cleanPublishedRecord } from './workflow-schema.mjs';

export const SNAPSHOT_NODE_ORDER = ['1h', '2h', '4h', '24h', '72h'];

const REFRESH_STATUS_VALUES = ['idle', 'success', 'failed', 'partial'];
const PUBLISHED_FETCH_TIMEOUT_MS = 12 * 1000;
const PUBLISHED_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const PUBLISHED_FETCH_MAX_REDIRECTS = 4;
const XHS_HOSTS = ['xhslink.com', 'xiaohongshu.com'];

export function cleanAutoRefreshState(state = {}) {
  return {
    status: REFRESH_STATUS_VALUES.includes(state?.status) ? state.status : 'idle',
    lastAttemptAt: typeof state?.lastAttemptAt === 'string' ? state.lastAttemptAt : '',
    lastSuccessAt: typeof state?.lastSuccessAt === 'string' ? state.lastSuccessAt : '',
    lastMessage: String(state?.lastMessage || '').trim().slice(0, 1000),
    source: ['remote', 'text'].includes(state?.source) ? state.source : '',
    updatedFields: Array.isArray(state?.updatedFields)
      ? [...new Set(state.updatedFields.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20)
      : []
  };
}

function toSafeInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function cleanPublishedStats(stats = {}) {
  return {
    likes: clamp(toSafeInt(stats.likes), 0, 99999999),
    favorites: clamp(toSafeInt(stats.favorites), 0, 99999999),
    comments: clamp(toSafeInt(stats.comments), 0, 99999999),
    shares: clamp(toSafeInt(stats.shares), 0, 99999999),
    views: clamp(toSafeInt(stats.views), 0, 999999999)
  };
}

export function cleanSnapshot(snapshot = {}, fallbackNodeType = '1h') {
  const nodeType = SNAPSHOT_NODE_ORDER.includes(snapshot?.nodeType) ? snapshot.nodeType : fallbackNodeType;
  return {
    nodeType,
    ...cleanPublishedStats(snapshot),
    capturedAt: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt : '',
    source: snapshot?.source === 'auto' ? 'auto' : 'manual'
  };
}

export function cleanPublishedRecordForRefresh(record = {}, index = 0) {
  return cleanPublishedRecord(record, index);
}

function hasAnyStats(stats = {}) {
  return Object.values(cleanPublishedStats(stats)).some(value => value > 0);
}

function mergeStatsPreferHigher(baseStats = {}, incomingStats = {}) {
  const base = cleanPublishedStats(baseStats);
  const incoming = cleanPublishedStats(incomingStats);
  return {
    likes: Math.max(base.likes, incoming.likes),
    favorites: Math.max(base.favorites, incoming.favorites),
    comments: Math.max(base.comments, incoming.comments),
    shares: Math.max(base.shares, incoming.shares),
    views: Math.max(base.views, incoming.views)
  };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseCountValue(rawValue) {
  const value = String(rawValue || '').trim().replace(/,/g, '');
  if (!value) return 0;
  const match = value.match(/(\d+(?:\.\d+)?)(万|w|W|k|K)?/);
  if (!match) return toSafeInt(value);
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(number * 10000);
  if (unit === 'k' || unit === 'K') return Math.round(number * 1000);
  return Math.round(number);
}

function extractMetaContent(html, pattern) {
  const match = html.match(pattern);
  return decodeHtml(match?.[1] || '').trim();
}

function toDatetimeLocalLike(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const asTimestamp = Number(raw);
  if (Number.isFinite(asTimestamp) && asTimestamp > 1000000000) {
    const date = new Date(asTimestamp > 1000000000000 ? asTimestamp : asTimestamp * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 16);
  }
  const normalized = raw.replace(/\//g, '-').replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 16);
}

function extractJsonNumber(text, keys) {
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"?([\\d.,]+(?:万|w|W|k|K)?)"?`, 'i');
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseCountValue(match[1]);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

function extractLabeledNumber(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*([\\d.,]+(?:万|w|W|k|K)?)`, 'i');
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseCountValue(match[1]);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

export function extractStatsFromText(text = '') {
  const normalized = decodeHtml(String(text || ''));
  return cleanPublishedStats({
    likes: extractJsonNumber(normalized, ['likedCount', 'likeCount', 'likes', 'diggCount', 'digg_count'])
      || extractLabeledNumber(normalized, ['点赞', '赞', 'likes?', 'digg']),
    favorites: extractJsonNumber(normalized, ['collectedCount', 'collectCount', 'favoriteCount', 'favorites', 'collect_count'])
      || extractLabeledNumber(normalized, ['收藏', 'favorites?', 'collect']),
    comments: extractJsonNumber(normalized, ['commentCount', 'comments', 'comment_count'])
      || extractLabeledNumber(normalized, ['评论', 'comments?']),
    shares: extractJsonNumber(normalized, ['shareCount', 'shares', 'share_count'])
      || extractLabeledNumber(normalized, ['分享', '转发', 'shares?']),
    views: extractJsonNumber(normalized, ['viewCount', 'views', 'browseCount', 'impressionCount', 'exposureCount', 'view_count'])
      || extractLabeledNumber(normalized, ['浏览', '曝光', '阅读', '观看', 'views?', 'impressions?'])
  });
}

function isAllowedXiaohongshuHostname(hostname) {
  const cleanHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return XHS_HOSTS.some(host => cleanHostname === host || cleanHostname.endsWith(`.${host}`));
}

export function normalizeXiaohongshuUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (parsed.port && parsed.port !== '443') return '';
    if (isAllowedXiaohongshuHostname(parsed.hostname)) return parsed.toString();
  } catch (error) {
    return '';
  }
  return '';
}

async function readResponseTextWithLimit(response, maxBytes = PUBLISHED_FETCH_MAX_BYTES) {
  const declaredLength = Number.parseInt(response.headers?.get('Content-Length') || '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('页面内容超过安全读取上限');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('页面内容超过安全读取上限');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('response too large').catch(() => {});
      throw new Error('页面内容超过安全读取上限');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchAllowedXiaohongshuPage(link, fetchImpl, signal) {
  let currentUrl = link;
  for (let redirectCount = 0; redirectCount <= PUBLISHED_FETCH_MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; KotobaBreadBot/1.0; +https://jiyimianbao.pages.dev)'
      },
      redirect: 'manual',
      signal
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: currentUrl };
    const location = response.headers?.get('Location');
    if (!location) throw new Error('页面重定向缺少目标地址');
    const nextUrl = normalizeXiaohongshuUrl(new URL(location, currentUrl).toString());
    if (!nextUrl) throw new Error('页面重定向到了非小红书域名');
    currentUrl = nextUrl;
  }
  throw new Error('页面重定向次数过多');
}

function extractRecordMetadataFromHtml(html = '', finalUrl = '') {
  const title = extractMetaContent(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"]+)["']/i)
    || extractMetaContent(html, /<title>([^<]+)<\/title>/i);
  const description = extractMetaContent(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"]+)["']/i)
    || extractMetaContent(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"]+)["']/i);
  const coverUrl = extractMetaContent(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"]+)["']/i);
  const authorName = extractMetaContent(html, /"nickname"\s*:\s*"([^"]+)"/i)
    || extractMetaContent(html, /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i);
  const contentTypeMatch = html.match(/"(?:noteType|type)"\s*:\s*"(video|normal|image)"/i);
  const noteIdMatch = html.match(/"(?:noteId|note_id|id)"\s*:\s*"([a-zA-Z0-9]+)"/i)
    || String(finalUrl || '').match(/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i);
  const publishedAt = toDatetimeLocalLike(
    extractMetaContent(html, /"(?:publishTime|publishedTime|time|uploadTime|createTime)"\s*:\s*"?(.*?)"?(?:,|})/i)
  );
  return {
    title: title.replace(/\s*-\s*小红书.*$/, '').trim(),
    description,
    coverUrl,
    authorName,
    contentType: contentTypeMatch?.[1] === 'video' ? '视频' : contentTypeMatch ? '图文' : '',
    noteId: noteIdMatch?.[1] || '',
    publishedAt,
    latestStats: extractStatsFromText(html)
  };
}

export async function fetchPublishedRecordRemote(link, fetchImpl = fetch) {
  const normalizedLink = normalizeXiaohongshuUrl(link);
  if (!normalizedLink) {
    return { ok: false, message: '链接不是可识别的小红书地址' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLISHED_FETCH_TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchAllowedXiaohongshuPage(normalizedLink, fetchImpl, controller.signal);
    if (!response.ok) {
      return { ok: false, message: `页面读取失败（HTTP ${response.status}）` };
    }
    const contentType = String(response.headers?.get('Content-Type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return { ok: false, message: '链接返回的不是可识别网页' };
    }

    const html = await readResponseTextWithLimit(response);
    const extracted = extractRecordMetadataFromHtml(html, finalUrl);
    const hasUsefulData = hasAnyStats(extracted.latestStats) || Boolean(extracted.title || extracted.description || extracted.authorName);
    return {
      ok: hasUsefulData,
      message: hasUsefulData ? '已从页面识别到可用数据' : '页面可打开，但暂时没识别到结构化数据',
      finalUrl,
      ...extracted
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, message: '页面读取超时，已保留上一次数据' };
    return { ok: false, message: String(error?.message || '页面读取失败').slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshPublishedRecord(recordInput, { fetchImpl = fetch, now = new Date() } = {}) {
  const record = cleanPublishedRecordForRefresh(recordInput);
  const nowIsoValue = now.toISOString();
  if (!isPublishedMetricUpdateActive(record, now)) {
    return {
      record,
      changed: false,
      success: false,
      skipped: true,
      message: '发布已超过 15 天，数据已停止更新'
    };
  }

  let updatedRecord = { ...record };
  let message = '缺少可读取的小红书链接，已保留上一次数据';
  let success = false;

  if (record.link) {
    try {
      const remote = await fetchPublishedRecordRemote(record.link, fetchImpl);
      if (remote.ok) {
        updatedRecord.link = remote.finalUrl || updatedRecord.link;
        updatedRecord.noteId = updatedRecord.noteId || remote.noteId || '';
        updatedRecord.authorName = updatedRecord.authorName || remote.authorName || '';
        updatedRecord.publishedAt = updatedRecord.publishedAt || remote.publishedAt || '';
        if (!updatedRecord.contentLocked && (remote.description || remote.coverUrl)) {
          updatedRecord.title = updatedRecord.title || remote.title || '';
          updatedRecord.description = remote.description || '';
          updatedRecord.coverUrl = remote.coverUrl || '';
          updatedRecord.contentType = remote.contentType || updatedRecord.contentType;
          updatedRecord.contentStatus = 'complete';
          updatedRecord.contentLocked = true;
          updatedRecord.contentImportedAt = nowIsoValue;
          updatedRecord.contentSource = 'xiaohongshu_remote_page';
        }
        if (hasAnyStats(remote.latestStats)) {
          const currentMetrics = cleanPublishedMetrics(updatedRecord.latestMetrics);
          const mergedStats = mergeStatsPreferHigher(updatedRecord.latestStats, remote.latestStats);
          const latestMetrics = cleanPublishedMetrics({
            ...currentMetrics,
            likes: mergedStats.likes,
            favorites: mergedStats.favorites,
            comments: mergedStats.comments,
            shares: mergedStats.shares,
            views: mergedStats.views
          });
          const snapshot = cleanPublishedMetricSnapshot({
            ...latestMetrics,
            capturedAt: nowIsoValue,
            capturedAtSource: 'remote_page',
            source: 'xiaohongshu_remote_page',
            batchId: `remote:${nowIsoValue.slice(0, 10)}`
          });
          updatedRecord.latestMetrics = latestMetrics;
          updatedRecord.latestStats = mergedStats;
          updatedRecord.metricSnapshots = mergePublishedMetricSnapshots(updatedRecord.metricSnapshots, [snapshot]);
          updatedRecord.lastMetricsImportedAt = nowIsoValue;
        }
        success = true;
        message = remote.message;
      } else {
        message = remote.message;
      }
    } catch (error) {
      message = '自动读取页面失败，已保留上一次数据';
    }
  }

  updatedRecord.updatedAt = success ? nowIsoValue : updatedRecord.updatedAt;
  updatedRecord.syncState = {
    status: success ? 'success' : 'failed',
    lastAttemptAt: nowIsoValue,
    lastSuccessAt: success ? nowIsoValue : record.syncState?.lastSuccessAt || '',
    lastMessage: message,
    source: success ? 'xiaohongshu_remote_page' : ''
  };

  return {
    record: updatedRecord,
    changed: JSON.stringify(updatedRecord) !== JSON.stringify(record),
    success,
    skipped: false,
    message
  };
}

export async function refreshPublishedRecords(records = [], { recordId = '', fetchImpl = fetch, now = new Date() } = {}) {
  const cleanRecords = Array.isArray(records) ? records.map((record, index) => cleanPublishedRecordForRefresh(record, index)) : [];
  const refreshed = [];
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  for (const record of cleanRecords) {
    if (recordId && record.id !== recordId) {
      refreshed.push(record);
      continue;
    }
    const result = await refreshPublishedRecord(record, { fetchImpl, now });
    refreshed.push(result.record);
    if (result.skipped) skippedCount += 1;
    else if (result.success) successCount += 1;
    else failureCount += 1;
  }

  return {
    records: refreshed,
    summary: {
      total: recordId ? (cleanRecords.some(record => record.id === recordId) ? 1 : 0) : cleanRecords.length,
      successCount,
      failureCount,
      skippedCount,
      refreshedAt: now.toISOString(),
      message: recordId
        ? (skippedCount ? '这条记录已超过 15 天，数据不再更新' : successCount ? '这条记录已更新' : '这条记录暂时没更新成功，已保留原数据')
        : (successCount ? `已更新 ${successCount} 条，跳过 ${skippedCount} 条超过 15 天的记录` : `没有拿到新数据，已跳过 ${skippedCount} 条超过 15 天的记录`)
    }
  };
}

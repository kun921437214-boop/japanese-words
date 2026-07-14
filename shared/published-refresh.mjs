export const SNAPSHOT_NODE_ORDER = ['1h', '2h', '4h', '24h', '72h'];

const SNAPSHOT_NODE_HOURS = {
  '1h': 1,
  '2h': 2,
  '4h': 4,
  '24h': 24,
  '72h': 72
};

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
  const snapshots = SNAPSHOT_NODE_ORDER.map(nodeType => {
    const matched = Array.isArray(record?.snapshots) ? record.snapshots.find(item => item?.nodeType === nodeType) : null;
    return cleanSnapshot(matched || { nodeType }, nodeType);
  });
  return {
    id: String(record?.id || `record_${index}`).trim().slice(0, 120),
    word: String(record?.word || '').trim().slice(0, 80),
    link: String(record?.link || '').trim().slice(0, 1000),
    title: String(record?.title || '').trim().slice(0, 200),
    description: String(record?.description || '').trim().slice(0, 4000),
    contentType: ['图文', '视频', '其他'].includes(record?.contentType) ? record.contentType : '图文',
    authorName: String(record?.authorName || '').trim().slice(0, 120),
    publishedAt: typeof record?.publishedAt === 'string' ? record.publishedAt : '',
    latestStats: cleanPublishedStats(record?.latestStats || record),
    snapshots,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : '',
    rating: String(record?.rating || '').trim().slice(0, 40),
    performanceReason: Array.isArray(record?.performanceReason) ? record.performanceReason.slice(0, 8) : [],
    performanceNote: String(record?.performanceNote || '').trim().slice(0, 1000),
    remarks: String(record?.remarks || '').trim().slice(0, 2000),
    sourceStatus: record?.sourceStatus === 'placeholder' ? 'placeholder' : 'record',
    autoRefresh: cleanAutoRefreshState(record?.autoRefresh)
  };
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

function pickSnapshotNodeForRefresh(record, ageHours, nowIsoValue) {
  const dueNodes = SNAPSHOT_NODE_ORDER
    .map(nodeType => ({ nodeType, threshold: SNAPSHOT_NODE_HOURS[nodeType] }))
    .filter(item => ageHours >= item.threshold && ageHours <= item.threshold + 18);

  for (const { nodeType } of dueNodes.reverse()) {
    const snapshot = record.snapshots.find(item => item.nodeType === nodeType) || cleanSnapshot({ nodeType }, nodeType);
    if (!snapshot.capturedAt && !hasAnyStats(snapshot)) {
      return {
        nodeType,
        snapshot: {
          ...snapshot,
          ...record.latestStats,
          capturedAt: nowIsoValue,
          source: 'auto'
        }
      };
    }
  }
  return null;
}

export async function refreshPublishedRecord(recordInput, { fetchImpl = fetch, now = new Date() } = {}) {
  const record = cleanPublishedRecordForRefresh(recordInput);
  const nowIsoValue = now.toISOString();
  let updatedRecord = {
    ...record,
    snapshots: record.snapshots.map(snapshot => ({ ...snapshot }))
  };
  let updatedFields = [];
  let successSource = '';
  let message = '';

  const textExtractedStats = extractStatsFromText([record.title, record.description, record.remarks].filter(Boolean).join('\n'));
  const extractedFromText = hasAnyStats(textExtractedStats);

  if (record.link) {
    try {
      const remote = await fetchPublishedRecordRemote(record.link, fetchImpl);
      if (remote.ok) {
        if (remote.finalUrl && remote.finalUrl !== updatedRecord.link) {
          updatedRecord.link = remote.finalUrl;
          updatedFields.push('link');
        }
        if (!updatedRecord.title && remote.title) {
          updatedRecord.title = remote.title;
          updatedFields.push('title');
        }
        if (!updatedRecord.description && remote.description) {
          updatedRecord.description = remote.description;
          updatedFields.push('description');
        }
        if (!updatedRecord.authorName && remote.authorName) {
          updatedRecord.authorName = remote.authorName;
          updatedFields.push('author');
        }
        if (!updatedRecord.contentType && remote.contentType) {
          updatedRecord.contentType = remote.contentType;
          updatedFields.push('contentType');
        }
        if (!updatedRecord.publishedAt && remote.publishedAt) {
          updatedRecord.publishedAt = remote.publishedAt;
          updatedFields.push('publishedAt');
        }
        if (remote.noteId && !updatedRecord.remarks.includes(remote.noteId)) {
          updatedRecord.remarks = updatedRecord.remarks
            ? `${updatedRecord.remarks}\n识别到 noteId：${remote.noteId}`.trim()
            : `识别到 noteId：${remote.noteId}`;
          updatedFields.push('remarks');
        }
        if (hasAnyStats(remote.latestStats)) {
          updatedRecord.latestStats = mergeStatsPreferHigher(updatedRecord.latestStats, remote.latestStats);
          updatedFields.push('latestStats');
        }
        successSource = 'remote';
        message = remote.message;
      } else {
        message = remote.message;
      }
    } catch (error) {
      message = '自动读取页面失败，已保留上一次数据';
    }
  } else if (extractedFromText) {
    message = '已从分享文案或备注中识别出一部分数据';
  } else {
    message = '缺少可读取的小红书链接，暂时只能手动维护数据';
  }

  if (!successSource && extractedFromText) {
    updatedRecord.latestStats = mergeStatsPreferHigher(updatedRecord.latestStats, textExtractedStats);
    updatedFields.push('latestStats');
    successSource = 'text';
  }

  const ageHours = updatedRecord.publishedAt
    ? Math.max(0, (now.getTime() - new Date(updatedRecord.publishedAt).getTime()) / 3600000)
    : 0;
  const snapshotPatch = successSource && hasAnyStats(updatedRecord.latestStats)
    ? pickSnapshotNodeForRefresh(updatedRecord, ageHours, nowIsoValue)
    : null;

  if (snapshotPatch) {
    updatedRecord.snapshots = updatedRecord.snapshots.map(snapshot => (
      snapshot.nodeType === snapshotPatch.nodeType ? snapshotPatch.snapshot : snapshot
    ));
    updatedFields.push(`snapshot:${snapshotPatch.nodeType}`);
  }

  const succeeded = Boolean(successSource);
  updatedRecord.updatedAt = succeeded || !updatedRecord.updatedAt ? nowIsoValue : updatedRecord.updatedAt;
  updatedRecord.autoRefresh = cleanAutoRefreshState({
    status: succeeded ? (updatedFields.length > 1 ? 'success' : 'partial') : 'failed',
    lastAttemptAt: nowIsoValue,
    lastSuccessAt: succeeded ? nowIsoValue : record.autoRefresh?.lastSuccessAt,
    lastMessage: message,
    source: successSource,
    updatedFields
  });

  return {
    record: updatedRecord,
    changed: JSON.stringify(updatedRecord) !== JSON.stringify(record),
    success: succeeded,
    message
  };
}

export async function refreshPublishedRecords(records = [], { recordId = '', fetchImpl = fetch, now = new Date() } = {}) {
  const cleanRecords = Array.isArray(records) ? records.map((record, index) => cleanPublishedRecordForRefresh(record, index)) : [];
  const refreshed = [];
  let successCount = 0;
  let failureCount = 0;

  for (const record of cleanRecords) {
    if (recordId && record.id !== recordId) {
      refreshed.push(record);
      continue;
    }
    const result = await refreshPublishedRecord(record, { fetchImpl, now });
    refreshed.push(result.record);
    if (result.success) successCount += 1;
    else failureCount += 1;
  }

  return {
    records: refreshed,
    summary: {
      total: recordId ? (cleanRecords.some(record => record.id === recordId) ? 1 : 0) : cleanRecords.length,
      successCount,
      failureCount,
      refreshedAt: now.toISOString(),
      message: recordId
        ? (successCount ? '这条记录已尝试自动更新' : '这条记录暂时没自动更新成功，已保留原数据')
        : (successCount ? `已尝试更新 ${successCount} 条记录` : '这次自动更新没有拿到新数据，已保留原数据')
    }
  };
}

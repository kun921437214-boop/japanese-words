import { cleanPublishedStats, normalizeXiaohongshuUrl } from '../shared/published-refresh.mjs';

const METRIC_LINE_PATTERN = /[赞藏评分享浏览曝光]\s*[:：]?\s*\d/;
const DATE_LINE_PATTERN = /^(?:发布(?:于|时间)?\s*[:：]?\s*)?20\d{2}[./-]\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2})?$/;

function isShareMetadataLine(line) {
  return (
    /https?:\/\//i.test(line)
    || METRIC_LINE_PATTERN.test(line)
    || /^@\S+/.test(line)
    || DATE_LINE_PATTERN.test(line)
    || /^(?:图文|视频|笔记)$/.test(line)
    || /^复制/.test(line)
    || /^打开小红书/.test(line)
    || line.startsWith('😆')
  );
}

export function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[）)\]}＞>，,。.!！?？]+$/, '') : '';
}

export function parseCountLikeValue(value) {
  const raw = String(value || '').trim().replace(/,/g, '');
  if (!raw) return 0;
  const match = raw.match(/(\d+(?:\.\d+)?)(万|w|W|k|K)?/);
  if (!match) return 0;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return 0;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(number * 10000);
  if (unit === 'k' || unit === 'K') return Math.round(number * 1000);
  return Math.round(number);
}

export function extractShareMetric(text, labels = []) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*([\\d.,]+(?:万|w|W|k|K)?)`, 'i');
    const match = String(text || '').match(pattern);
    if (match?.[1]) {
      const parsed = parseCountLikeValue(match[1]);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

export function extractPublishedAtFromShareText(text) {
  const rawText = String(text || '');
  const dateMatch = rawText.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!dateMatch) return '';
  const [, year, month, day, hour = '00', minute = '00'] = dateMatch;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseXiaohongshuSharePayload(text) {
  const rawText = String(text || '').trim();
  const normalizedLines = rawText.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const url = normalizeXiaohongshuUrl(extractFirstUrl(rawText));
  const titleLine = normalizedLines.find(line => (
    !isShareMetadataLine(line)
    && line.length <= 60
  )) || '';
  const authorMatch = rawText.match(/@([^\s：:，,]+)/);
  const typeMatch = rawText.match(/(图文|视频|笔记)/);
  const noteIdMatch = url.match(/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i);
  const latestStats = cleanPublishedStats({
    likes: extractShareMetric(rawText, ['点赞', '赞']),
    favorites: extractShareMetric(rawText, ['收藏']),
    comments: extractShareMetric(rawText, ['评论']),
    shares: extractShareMetric(rawText, ['分享', '转发']),
    views: extractShareMetric(rawText, ['浏览', '曝光', '阅读'])
  });
  const description = normalizedLines
    .filter(line => line !== titleLine && !isShareMetadataLine(line))
    .join('\n');
  return {
    url,
    noteId: noteIdMatch?.[1] || '',
    title: titleLine,
    description,
    authorName: authorMatch?.[1] || '',
    contentType: typeMatch ? (typeMatch[1] === '视频' ? '视频' : '图文') : '',
    publishedAt: extractPublishedAtFromShareText(rawText),
    latestStats
  };
}

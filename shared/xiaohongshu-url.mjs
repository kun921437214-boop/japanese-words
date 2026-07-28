const XHS_HOSTS = ['xhslink.com', 'xiaohongshu.com'];
const XHS_NOTE_ID_PATTERN = /^[a-zA-Z0-9]{3,120}$/;
const XHS_ERROR_PATH_PATTERN = /^\/404(?:\/|$)/;
const XHS_NOTE_PATH_PATTERN = /\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i;

function isAllowedXiaohongshuHostname(hostname) {
  const cleanHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return XHS_HOSTS.some(host => cleanHostname === host || cleanHostname.endsWith(`.${host}`));
}

function parseAllowedXiaohongshuUrl(value, base = undefined) {
  try {
    const parsed = new URL(String(value || '').trim(), base);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== '443') return null;
    return isAllowedXiaohongshuHostname(parsed.hostname) ? parsed : null;
  } catch (error) {
    return null;
  }
}

export function normalizeXiaohongshuNoteId(value) {
  const noteId = String(value || '').trim();
  return XHS_NOTE_ID_PATTERN.test(noteId) ? noteId : '';
}

export function buildXiaohongshuNoteUrl(noteId) {
  const cleanNoteId = normalizeXiaohongshuNoteId(noteId);
  return cleanNoteId ? `https://www.xiaohongshu.com/explore/${cleanNoteId}` : '';
}

export function normalizeXiaohongshuUrl(url, fallbackNoteId = '') {
  const fallbackUrl = buildXiaohongshuNoteUrl(fallbackNoteId);
  let parsed = parseAllowedXiaohongshuUrl(url);
  if (!parsed) return fallbackUrl;

  for (let depth = 0; depth < 3 && XHS_ERROR_PATH_PATTERN.test(parsed.pathname); depth += 1) {
    const redirectPath = parsed.searchParams.get('redirectPath');
    if (!redirectPath) return fallbackUrl;
    parsed = parseAllowedXiaohongshuUrl(redirectPath, parsed.origin);
    if (!parsed) return fallbackUrl;
  }

  if (XHS_ERROR_PATH_PATTERN.test(parsed.pathname)) return fallbackUrl;
  return parsed.toString();
}

export function extractXiaohongshuNoteId(url, fallbackNoteId = '') {
  const cleanFallback = normalizeXiaohongshuNoteId(fallbackNoteId);
  const normalizedUrl = normalizeXiaohongshuUrl(url, cleanFallback);
  return normalizedUrl.match(XHS_NOTE_PATH_PATTERN)?.[1] || cleanFallback;
}

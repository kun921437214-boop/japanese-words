import path from 'node:path';

export const CODEX_BATCH_IMAGE_MAX_BYTES = 800 * 1024;

const IMAGE_CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

export function getCodexImageContentType(file) {
  return IMAGE_CONTENT_TYPES.get(path.extname(String(file || '')).toLowerCase()) || '';
}

export function isCodexReferenceImageReady(item) {
  const image = item?.aiCard?.referenceImage;
  return image?.status === 'ready' && Boolean(String(image?.url || '').trim());
}

export function getPendingCodexImageItems(draft = {}) {
  return (Array.isArray(draft?.items) ? draft.items : [])
    .map((item, index) => ({
      index,
      order: index + 1,
      word: String(item?.kanji || '').trim(),
      item
    }))
    .filter(entry => entry.word && !isCodexReferenceImageReady(entry.item));
}

export function isRetryableCodexImageUploadError(error) {
  const status = Number(error?.status);
  const code = String(error?.data?.error?.code || '');
  if (!Number.isFinite(status) || status <= 0) return true;
  if (status === 429) return true;
  if (status === 503 && code === 'IMAGE_STORAGE_NOT_CONFIGURED') return false;
  return status >= 500;
}

export function applyCodexImageUploadResult(draft, word, upload = {}, generatedAt = new Date().toISOString()) {
  const item = (Array.isArray(draft?.items) ? draft.items : []).find(entry => entry?.kanji === word);
  if (!item?.aiCard) throw new Error(`草稿中找不到词卡：${word}`);
  if (!String(upload.url || '').trim() || !String(upload.key || '').trim()) {
    throw new Error(`图片上传结果缺少 url/key：${word}`);
  }
  const current = item.aiCard.referenceImage || {};
  item.aiCard.referenceImage = {
    ...current,
    status: 'ready',
    url: String(upload.url || ''),
    key: String(upload.key || ''),
    provider: current.provider || 'codex',
    generatedAt: current.generatedAt || generatedAt
  };
  return item.aiCard.referenceImage;
}

export function applyCodexImageManifestResult(
  manifest,
  word,
  upload = {},
  { file = '', generatedAt = new Date().toISOString() } = {}
) {
  const current = manifest?.[word] && typeof manifest[word] === 'object' ? manifest[word] : {};
  const next = {
    ...current,
    key: String(upload.key || ''),
    url: String(upload.url || ''),
    status: 'ready',
    storage: String(upload.storage || ''),
    contentType: String(upload.contentType || ''),
    size: Number(upload.size) || 0,
    generatedAt: current.generatedAt || generatedAt
  };
  if (file) next.file = file;
  manifest[word] = next;
  return next;
}

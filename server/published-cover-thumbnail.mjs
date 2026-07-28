import sharp from 'sharp';

const SOURCE_KEY_PATTERN = /^published-covers\/v1\/([a-f0-9]{32})$/;
const CACHE_SECONDS = 365 * 24 * 60 * 60;
const THUMBNAIL_WIDTH = 480;

function cleanSourceKey(value) {
  const key = String(value || '').trim().slice(0, 160);
  return SOURCE_KEY_PATTERN.test(key) ? key : '';
}

function buildThumbnailKey(sourceKey) {
  const match = cleanSourceKey(sourceKey).match(SOURCE_KEY_PATTERN);
  return match ? `published-cover-thumbs/v1/${match[1]}.webp` : '';
}

function imageResponse(request, object) {
  const headers = new Headers({
    'Cache-Control': `public, max-age=${CACHE_SECONDS}, immutable`,
    'Content-Type': object.metadata?.contentType || 'image/webp',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff'
  });
  return new Response(request.method === 'HEAD' ? null : object.value, { status: 200, headers });
}

export async function onRequest({ request, env }) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return Response.json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, { status: 405 });
  }
  if (!env.REFERENCE_IMAGES_KV) {
    return Response.json({ ok: false, error: { code: 'IMAGE_STORAGE_NOT_CONFIGURED', message: '封面存储尚未配置' } }, { status: 503 });
  }
  const url = new URL(request.url);
  const sourceKey = cleanSourceKey(url.searchParams.get('key'));
  const thumbnailKey = buildThumbnailKey(sourceKey);
  if (!thumbnailKey) {
    return Response.json({ ok: false, error: { code: 'INVALID_COVER_KEY', message: '封面 key 无效' } }, { status: 400 });
  }
  const cached = await env.REFERENCE_IMAGES_KV.getWithMetadata(thumbnailKey, { type: 'arrayBuffer' });
  if (cached?.value) return imageResponse(request, cached);

  const source = await env.REFERENCE_IMAGES_KV.getWithMetadata(sourceKey, { type: 'arrayBuffer' });
  if (!source?.value) {
    return Response.json({ ok: false, error: { code: 'COVER_NOT_FOUND', message: '封面不存在' } }, { status: 404 });
  }
  const output = await sharp(Buffer.from(source.value))
    .rotate()
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true, fit: 'inside' })
    .webp({ quality: 76, effort: 4 })
    .toBuffer();
  const bytes = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  await env.REFERENCE_IMAGES_KV.put(thumbnailKey, bytes, {
    metadata: {
      contentType: 'image/webp',
      sourceKey,
      width: THUMBNAIL_WIDTH,
      generatedAt: new Date().toISOString()
    }
  });
  return imageResponse(request, { value: bytes, metadata: { contentType: 'image/webp' } });
}

export { buildThumbnailKey };

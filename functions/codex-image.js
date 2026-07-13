import { cleanDateKey } from '../shared/rankings.mjs';
import {
  API_LIMITS,
  authorizeRequest,
  errorResponse,
  getRequestId,
  jsonResponse,
  optionsResponse,
  unauthorizedResponse
} from '../shared/api-security.mjs';

const METHODS = ['GET', 'PUT', 'OPTIONS'];
const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp']
]);

function cleanKey(value) {
  const key = String(value || '').trim().slice(0, 500);
  return /^codex-daily\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_%.-]+\.(png|jpg|webp)$/.test(key) ? key : '';
}

export async function onRequest({ request, env }) {
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods: METHODS, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods: METHODS, requestId });
  if (request.method === 'OPTIONS') return optionsResponse(request, env, METHODS);
  if (!env.REFERENCE_IMAGES) return fail(503, 'IMAGE_STORAGE_NOT_CONFIGURED', '参考图片 R2 存储尚未配置');
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const key = cleanKey(url.searchParams.get('key'));
    if (!key) return fail(400, 'INVALID_IMAGE_KEY', '图片 key 无效');
    const object = await env.REFERENCE_IMAGES.get(key);
    if (!object) return fail(404, 'IMAGE_NOT_FOUND', '参考图片不存在');
    const headers = new Headers({
      'Cache-Control': 'public, max-age=86400, immutable',
      'Content-Type': object.httpMetadata?.contentType || 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId
    });
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  }

  if (request.method !== 'PUT') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  const authorization = await authorizeRequest(request, env, { allowCodexAutomation: true });
  if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods: METHODS, requestId });
  if (!['codex_automation_secret', 'admin_token', 'local_dev'].includes(authorization.method)) {
    return fail(403, 'IMAGE_WRITE_FORBIDDEN', '当前身份不能上传参考图片');
  }
  const targetDateKey = cleanDateKey(url.searchParams.get('date'));
  const word = String(url.searchParams.get('word') || '').trim().slice(0, 80);
  const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const extension = IMAGE_TYPES.get(contentType);
  if (!targetDateKey || !word) return fail(400, 'INVALID_IMAGE_TARGET', 'date 和 word 为必填项');
  if (!extension) return fail(415, 'UNSUPPORTED_IMAGE_TYPE', '仅支持 PNG、JPEG 和 WebP');
  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > API_LIMITS.image) return fail(413, 'IMAGE_TOO_LARGE', '参考图片不能超过 5 MB');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > API_LIMITS.image) return fail(413, 'IMAGE_TOO_LARGE', '参考图片不能为空且不能超过 5 MB');

  const safeWord = encodeURIComponent(word).replace(/%/g, '_');
  const key = `codex-daily/${targetDateKey}/${safeWord}-${crypto.randomUUID()}.${extension}`;
  await env.REFERENCE_IMAGES.put(key, bytes, { httpMetadata: { contentType } });
  const imageUrl = new URL('/codex-image', url.origin);
  imageUrl.searchParams.set('key', key);
  return respond({ ok: true, key, url: `${imageUrl.pathname}${imageUrl.search}`, contentType, size: bytes.byteLength });
}

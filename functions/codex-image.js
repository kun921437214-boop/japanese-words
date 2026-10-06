import { cleanDateKey } from '../shared/rankings.mjs';
import {
  codexBytesSha256,
  codexOperationFailure,
  codexOperationIdFromHeader,
  codexOperationScope,
  codexValueSha256,
  executeCodexOperation,
  lookupCodexOperation,
  requireCodexOperationId,
  withCodexWrite
} from '../shared/codex-operation.mjs';
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
export const KV_IMAGE_MAX_BYTES = 800 * 1024;
export const KV_IMAGE_TTL_SECONDS = 60 * 24 * 60 * 60;
const IMAGE_CACHE_SECONDS = 24 * 60 * 60;
const IMAGE_EDGE_CACHE_SECONDS = 7 * IMAGE_CACHE_SECONDS;

function cleanKey(value) {
  const key = String(value || '').trim().slice(0, 500);
  return /^codex-daily\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_%.-]+\.(png|jpg|webp)$/.test(key) ? key : '';
}

function getImageStorage(env) {
  if (env.REFERENCE_IMAGES) return { kind: 'r2', binding: env.REFERENCE_IMAGES };
  if (env.REFERENCE_IMAGES_KV) return { kind: 'kv', binding: env.REFERENCE_IMAGES_KV };
  return null;
}

async function readImage(storage, key) {
  if (storage.kind === 'r2') {
    const object = await storage.binding.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType || 'image/webp',
      etag: object.httpEtag || ''
    };
  }

  const object = await storage.binding.getWithMetadata(key, {
    type: 'arrayBuffer',
    cacheTtl: IMAGE_CACHE_SECONDS
  });
  if (!object?.value) return null;
  return {
    body: object.value,
    contentType: object.metadata?.contentType || 'image/webp',
    etag: object.metadata?.etag || ''
  };
}

async function writeImage(storage, key, bytes, contentType) {
  if (storage.kind === 'r2') {
    await storage.binding.put(key, bytes, { httpMetadata: { contentType } });
    return;
  }

  await storage.binding.put(key, bytes, {
    expirationTtl: KV_IMAGE_TTL_SECONDS,
    metadata: {
      contentType,
      size: bytes.byteLength,
      createdAt: new Date().toISOString()
    }
  });
}

async function inspectImageEffect(storage, record) {
  if (record.effect.storage !== storage.kind) return 'conflict';
  const object = await readImage(storage, record.effect.key);
  if (!object) return 'absent';
  const bytes = await new Response(object.body).arrayBuffer();
  return object.contentType === record.effect.contentType && bytes.byteLength === record.effect.size
    && await codexBytesSha256(bytes) === record.effect.bytesSha256 ? 'complete' : 'conflict';
}

export async function onRequest({ request, env }) {
  const requestId = getRequestId(request);
  const respond = (body, status = 200) => jsonResponse(request, env, body, status, { methods: METHODS, requestId });
  const fail = (status, code, message) => errorResponse(request, env, status, code, message, { methods: METHODS, requestId });
  if (request.method === 'OPTIONS') return optionsResponse(request, env, METHODS);
  const storage = getImageStorage(env);
  if (!storage) return fail(503, 'IMAGE_STORAGE_NOT_CONFIGURED', '参考图片存储尚未配置');
  const url = new URL(request.url);

  if (request.method === 'GET' && url.searchParams.has('operationId')) {
    const authorization = await authorizeRequest(request, env, { allowCodexAutomation: true });
    if (!authorization.ok) return unauthorizedResponse(request, env, authorization, { methods: METHODS, requestId });
    if (!['codex_automation_secret', 'admin_token', 'local_dev'].includes(authorization.method)) {
      return fail(403, 'OPERATION_LOOKUP_FORBIDDEN', '当前身份不能查询上传操作');
    }
    try {
      const identity = { scope: codexOperationScope(url), kind: 'image',
        operationId: requireCodexOperationId(url.searchParams.get('operationId')) };
      const operation = await lookupCodexOperation(env, identity, record => inspectImageEffect(storage, record));
      return respond({ ok: true, operation });
    } catch (error) {
      const failure = codexOperationFailure(error);
      return fail(failure.status, failure.code, '上传操作状态无法确认');
    }
  }

  if (request.method === 'GET') {
    const key = cleanKey(url.searchParams.get('key'));
    if (!key) return fail(400, 'INVALID_IMAGE_KEY', '图片 key 无效');
    const object = await readImage(storage, key);
    if (!object) return fail(404, 'IMAGE_NOT_FOUND', '参考图片不存在');
    const headers = new Headers({
      'Cache-Control': `public, max-age=${IMAGE_CACHE_SECONDS}, s-maxage=${IMAGE_EDGE_CACHE_SECONDS}, immutable`,
      'Content-Type': object.contentType,
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId
    });
    if (object.etag) headers.set('ETag', object.etag);
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
  const maxBytes = storage.kind === 'kv' ? KV_IMAGE_MAX_BYTES : API_LIMITS.image;
  const sizeLimit = storage.kind === 'kv' ? '800 KiB' : '5 MB';
  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > maxBytes) return fail(413, 'IMAGE_TOO_LARGE', `参考图片不能超过 ${sizeLimit}`);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    return fail(413, 'IMAGE_TOO_LARGE', `参考图片不能为空且不能超过 ${sizeLimit}`);
  }

  const scope = codexOperationScope(url);
  const resultForKey = key => {
    const imageUrl = new URL('/codex-image', url.origin);
    imageUrl.searchParams.set('key', key);
    return { ok: true, key, url: `${imageUrl.pathname}${imageUrl.search}`, contentType,
      size: bytes.byteLength, storage: storage.kind,
      expiresInSeconds: storage.kind === 'kv' ? KV_IMAGE_TTL_SECONDS : null };
  };
  try {
    const operationId = codexOperationIdFromHeader(request);
    if (!operationId) {
      return await withCodexWrite(env, scope, async () => {
        const safeWord = encodeURIComponent(word).replace(/%/g, '_');
        const key = `codex-daily/${targetDateKey}/${safeWord}-${crypto.randomUUID()}.${extension}`;
        await writeImage(storage, key, bytes, contentType);
        return respond(resultForKey(key));
      });
    }
    const bytesSha256 = await codexBytesSha256(bytes);
    const inputSha256 = await codexValueSha256({ targetDateKey, word, contentType, bytesSha256 });
    const identity = { scope, kind: 'image', operationId, target: `${targetDateKey}:${word}`, inputSha256 };
    const result = await executeCodexOperation(env, identity, {
      prepare: async () => {
        const keyHash = await codexValueSha256({ scope, operationId });
        const key = `codex-daily/${targetDateKey}/${keyHash}.${extension}`;
        return { effect: { key, bytesSha256, contentType, size: bytes.byteLength, storage: storage.kind },
          response: { status: 200, body: resultForKey(key) } };
      },
      inspect: record => inspectImageEffect(storage, record),
      apply: record => writeImage(storage, record.effect.key, bytes, record.effect.contentType)
    });
    return respond({ ...result.body, operation: result.operation }, result.status);
  } catch (error) {
    const failure = codexOperationFailure(error);
    return fail(failure.status, failure.code, '上传操作未能确认完成');
  }
}

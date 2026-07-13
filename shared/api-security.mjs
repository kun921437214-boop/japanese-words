const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'OPTIONS'];
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const ACCESS_JWKS_CACHE_MS = 10 * 60 * 1000;
const accessJwksCache = new Map();

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(value => cleanText(value, 500)).filter(Boolean))];
}

function parseList(value) {
  return uniqueStrings(String(value || '').split(',').map(item => item.trim()));
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function getBearerToken(request) {
  const header = cleanText(request?.headers?.get('Authorization'), 2000);
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function getAllowedOrigins(request, env = {}) {
  const requestOrigin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      return '';
    }
  })();
  const siteOrigin = (() => {
    try {
      return env.SITE_URL ? new URL(env.SITE_URL).origin : '';
    } catch {
      return '';
    }
  })();
  return new Set(uniqueStrings([
    requestOrigin,
    siteOrigin,
    ...parseList(env.ALLOWED_ORIGINS)
  ]));
}

export function getRequestId(request) {
  return cleanText(request?.headers?.get('Cf-Ray'), 120)
    || cleanText(request?.headers?.get('X-Request-Id'), 120)
    || crypto.randomUUID();
}

export function buildCorsHeaders(request, env = {}, methods = DEFAULT_ALLOWED_METHODS) {
  const origin = cleanText(request?.headers?.get('Origin'), 500);
  const allowedOrigins = getAllowedOrigins(request, env);
  const headers = {
    'Access-Control-Allow-Methods': uniqueStrings(methods).join(', '),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Operation-Id, X-Workflow-Revision',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    Vary: 'Origin'
  };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export function jsonResponse(request, env, body, status = 200, options = {}) {
  const requestId = options.requestId || getRequestId(request);
  const payload = body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body, requestId: body.requestId || requestId }
    : { data: body, requestId };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...buildCorsHeaders(request, env, options.methods),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-Id': requestId
    }
  });
}

export function errorResponse(request, env, status, code, message, options = {}) {
  return jsonResponse(request, env, {
    ok: false,
    error: {
      code: cleanText(code, 120) || 'INTERNAL_ERROR',
      message: cleanText(message, 1000) || '请求处理失败',
      retryable: Boolean(options.retryable)
    }
  }, status, options);
}

export function optionsResponse(request, env, methods = DEFAULT_ALLOWED_METHODS) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request, env, methods)
  });
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJwtPart(value) {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function normalizeAccessIssuer(value) {
  const rawValue = cleanText(value, 500).replace(/\/$/, '');
  if (!rawValue) return '';
  try {
    const url = new URL(rawValue.includes('://') ? rawValue : `https://${rawValue}`);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

async function getAccessJwks(issuer, fetchImpl = fetch) {
  const cached = accessJwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return [];
    const body = await response.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    if (keys.length) accessJwksCache.set(issuer, { keys, expiresAt: Date.now() + ACCESS_JWKS_CACHE_MS });
    return keys;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function hasExpectedAudience(claim, expectedAudience) {
  const audiences = Array.isArray(claim) ? claim : [claim];
  return audiences.some(audience => constantTimeEqual(audience, expectedAudience));
}

async function getAccessIdentity(request, env = {}, options = {}) {
  const headerEmail = cleanText(request?.headers?.get('Cf-Access-Authenticated-User-Email'), 320).toLowerCase();
  const assertion = cleanText(request?.headers?.get('Cf-Access-Jwt-Assertion'), 16000);
  const allowedEmails = parseList(env.TEAM_ACCESS_EMAILS).map(item => item.toLowerCase());
  const issuer = normalizeAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN);
  const expectedAudience = cleanText(env.CF_ACCESS_AUD, 500);
  if (!assertion || !allowedEmails.length || !issuer || !expectedAudience) return null;

  const parts = assertion.split('.');
  if (parts.length !== 3) return null;
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (!header || !claims || !signature || header.alg !== 'RS256' || !header.kid) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer || !hasExpectedAudience(claims.aud, expectedAudience)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + 30) return null;

  const email = cleanText(claims.email, 320).toLowerCase();
  if (!email || (headerEmail && headerEmail !== email)) return null;
  if (!allowedEmails.includes(email)) return null;

  const jwks = await getAccessJwks(issuer, options.fetchImpl || fetch);
  const jwk = jwks.find(key => key?.kid === header.kid && key?.kty === 'RSA');
  if (!jwk) return null;
  try {
    const verificationKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      verificationKey,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    return verified ? { actor: email, method: 'cloudflare_access' } : null;
  } catch {
    return null;
  }
}

export async function authorizeRequest(request, env = {}, options = {}) {
  const method = cleanText(request?.method, 20).toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const origin = cleanText(request?.headers?.get('Origin'), 500);
    const fetchSite = cleanText(request?.headers?.get('Sec-Fetch-Site'), 40).toLowerCase();
    if ((origin && !getAllowedOrigins(request, env).has(origin)) || fetchSite === 'cross-site') {
      return {
        ok: false,
        actor: '',
        method: '',
        status: 403,
        code: 'ORIGIN_NOT_ALLOWED',
        reason: '不允许从当前页面来源执行写入操作'
      };
    }
  }

  const bearer = getBearerToken(request);
  const adminToken = cleanText(env.ADMIN_API_TOKEN, 2000);
  if (adminToken && bearer && constantTimeEqual(bearer, adminToken)) {
    return { ok: true, actor: 'admin-token', method: 'admin_token' };
  }

  if (options.allowAutomation) {
    const automationSecret = cleanText(env.AUTO_REFRESH_SECRET, 2000);
    if (automationSecret && bearer && constantTimeEqual(bearer, automationSecret)) {
      return { ok: true, actor: options.automationActor || 'scheduled-worker', method: 'automation_secret' };
    }
  }

  const accessIdentity = await getAccessIdentity(request, env, options);
  if (accessIdentity) return { ok: true, ...accessIdentity };

  if (String(env.ALLOW_INSECURE_LOCAL_DEV || '').toLowerCase() === 'true') {
    try {
      const url = new URL(request.url);
      if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
        return { ok: true, actor: 'local-development', method: 'local_dev' };
      }
    } catch {
      // Invalid request URLs remain unauthorized.
    }
  }

  return {
    ok: false,
    actor: '',
    method: '',
    reason: adminToken || env.TEAM_ACCESS_EMAILS || (options.allowAutomation && env.AUTO_REFRESH_SECRET)
      ? '凭证无效或当前账号不在允许列表中'
      : '服务端尚未配置团队认证'
  };
}

export function unauthorizedResponse(request, env, authorization, options = {}) {
  return errorResponse(
    request,
    env,
    authorization?.status || 401,
    authorization?.code || 'UNAUTHORIZED',
    authorization?.reason || '请先完成团队身份验证',
    options
  );
}

export async function readJsonBody(request, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_JSON_BYTES);
  const contentType = cleanText(request?.headers?.get('Content-Type'), 200).toLowerCase();
  if (options.requireJson !== false && !contentType.includes('application/json')) {
    return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type 必须是 application/json' };
  }
  const contentLength = Number.parseInt(request?.headers?.get('Content-Length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE', message: `请求体不能超过 ${maxBytes} 字节` };
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return { ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE', message: `请求体不能超过 ${maxBytes} 字节` };
    }
    if (!text.trim()) {
      return { ok: false, status: 400, code: 'INVALID_JSON', message: '请求体不能为空' };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, code: 'INVALID_JSON', message: '请求体不是有效 JSON' };
  }
}

export async function enforceRateLimit(kv, key, options = {}) {
  if (!kv || !key) return { ok: true, remaining: null };
  const limit = Math.max(1, Number(options.limit) || 10);
  const windowSeconds = Math.max(10, Number(options.windowSeconds) || 60);
  const now = Date.now();
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const storageKey = `rate-limit:${cleanText(key, 180)}:${bucket}`;
  const current = Number.parseInt(await kv.get(storageKey) || '0', 10) || 0;
  if (current >= limit) {
    return { ok: false, remaining: 0, retryAfter: windowSeconds - Math.floor((now / 1000) % windowSeconds) };
  }
  await kv.put(storageKey, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return { ok: true, remaining: Math.max(0, limit - current - 1) };
}

export const API_LIMITS = Object.freeze({
  ai: 512 * 1024,
  command: 256 * 1024,
  published: 2 * 1024 * 1024,
  workflow: 8 * 1024 * 1024
});

import { createHash, randomBytes } from 'node:crypto';
import { readJsonBody } from '../shared/api-security.mjs';
import { commitWorkflowMutation } from '../shared/workflow-coordinator.mjs';
import { buildAppWorkflowView, buildCandidateDetailView, buildFavoriteCommandView } from '../functions/favorites.js';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const windows = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');
export const miniappMemberId = (appId, openid) => digest(`${appId}:${openid}`).slice(0, 24);
const members = env => new Set(String(env.WECHAT_MEMBER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
});
const fail = (status, code, message, extra = {}) => json({ ok: false, error: { code, message, retryable: status >= 500 || status === 429, ...extra } }, status);

function enforceFormalCards(view, source) {
  const entries = view.candidate ? { [view.candidate.kanji]: view.candidate } : view.candidatePool || {};
  for (const [word, entry] of Object.entries(entries)) {
    const raw = source.candidatePool?.[word]?.aiCard;
    if (raw?.cardStatus !== 'ready' || raw?.projection === 'list') {
      entry.aiCard = { cardStatus: ['pending', 'failed', 'stale'].includes(raw?.cardStatus) ? raw.cardStatus : 'none', projection: entry.aiCard?.projection };
    }
  }
  return view;
}

function limited(env, key, maximum, now) {
  let map = windows.get(env);
  if (!map) { map = new Map(); windows.set(env, map); }
  for (const [name, item] of map) if (item.until <= now) map.delete(name);
  if (!map.has(key)) {
    if (map.size >= 2000) return true;
    map.set(key, { count: 0, until: now + 60_000 });
  }
  return ++map.get(key).count > maximum;
}

async function exchangeCode(code, env, fetcher) {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: env.WECHAT_APP_ID, secret: env.WECHAT_APP_SECRET, js_code: code, grant_type: 'authorization_code' });
  // Never log this URL or the upstream payload: both contain credentials.
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('WECHAT_UNAVAILABLE');
  return response.json();
}

export async function handleMiniappRequest(request, env, options = {}) {
  if (env.ENABLE_WECHAT_MINIAPP !== 'true' || !env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET || !env.MINIAPP_SESSIONS) {
    return fail(503, 'MINIAPP_NOT_CONFIGURED', '小程序服务尚未接入，请联系管理员');
  }
  const url = new URL(request.url);
  const route = url.pathname;
  const now = options.now ?? Date.now();
  if (route === '/miniapp/login' && request.method === 'POST') {
    // Nginx must overwrite X-Real-IP; the Node listener stays on loopback.
    const ip = request.headers.get('x-real-ip') || 'local';
    if (limited(env, `login:${ip}`, 12, now)) return fail(429, 'TOO_MANY_REQUESTS', '尝试过于频繁，请一分钟后再试');
    const parsed = await readJsonBody(request, { maxBytes: 2048 });
    if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
    const code = parsed.value?.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) return fail(400, 'INVALID_CODE', '请重新进行微信登录');
    let identity;
    try { identity = await exchangeCode(code, env, options.fetcher || fetch); }
    catch { return fail(502, 'WECHAT_UNAVAILABLE', '微信登录暂时不可用，请稍后重试'); }
    if (identity.errcode || typeof identity.openid !== 'string' || !identity.openid || !identity.session_key) {
      return fail(401, 'WECHAT_CODE_INVALID', '登录凭证已失效，请重新登录');
    }
    const memberId = miniappMemberId(env.WECHAT_APP_ID, identity.openid);
    if (!members(env).has(memberId)) return fail(403, 'MEMBER_NOT_APPROVED', '请将成员编号交给管理员，开通后再登录', { memberId });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_SECONDS * 1000;
    await env.MINIAPP_SESSIONS.put(`session:${digest(token)}`, JSON.stringify({ memberId, expiresAt }), { expirationTtl: SESSION_SECONDS });
    return json({ ok: true, token, memberId, expiresAt });
  }

  const token = (request.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return fail(401, 'SESSION_EXPIRED', '请重新登录');
  const sessionKey = `session:${digest(token)}`;
  const session = await env.MINIAPP_SESSIONS.get(sessionKey, 'json');
  if (!session || session.expiresAt <= now) return fail(401, 'SESSION_EXPIRED', '登录已过期，将为你重新连接');
  if (!members(env).has(session.memberId)) return fail(403, 'MEMBER_REVOKED', '团队访问权限已变更，请联系管理员');
  if (limited(env, `member:${session.memberId}`, 120, now)) return fail(429, 'TOO_MANY_REQUESTS', '操作较快，请稍后重试');
  if (route === '/miniapp/logout' && request.method === 'POST') {
    await env.MINIAPP_SESSIONS.delete(sessionKey);
    return json({ ok: true });
  }
  if (route === '/miniapp/me' && request.method === 'GET') return json({ ok: true, memberId: session.memberId, expiresAt: session.expiresAt });
  if (!env.FAVORITES || !env.WORKFLOW_COORDINATOR) return fail(503, 'STORAGE_UNAVAILABLE', '团队数据暂时不可用');

  if (request.method === 'GET' && ['/miniapp/workflow', '/miniapp/card', '/miniapp/confirmation', '/miniapp/image'].includes(route)) {
    const stored = await env.FAVORITES.get('favorites:global', 'json') || {};
    if (route === '/miniapp/workflow') {
      const scope = url.searchParams.get('scope') || 'today';
      if (!['today', 'favorites', 'published'].includes(scope)) return fail(400, 'INVALID_SCOPE', '不支持的页面');
      return json(enforceFormalCards(buildAppWorkflowView(stored, { scope }), stored));
    }
    const word = url.searchParams.get('word') || '';
    if (!word || word.length > 80) return fail(400, 'INVALID_WORD', '词条无效');
    if (route === '/miniapp/confirmation') {
      // Membership readback without full card serialization.
      return json({ ok: true, words: stored.words || [], statuses: stored.statuses || {}, revision: stored.revision || 0 });
    }
    if (!stored.candidatePool?.[word]) return fail(404, 'CARD_NOT_FOUND', '这个词暂时没有词卡');
    if (route === '/miniapp/card') return json(enforceFormalCards(buildCandidateDetailView(stored, word), stored));
    const card = stored.candidatePool[word].aiCard;
    const key = card?.referenceImage?.key;
    if (card?.cardStatus !== 'ready' || card?.projection === 'list' || card.referenceImage?.status !== 'ready' || !/^codex-daily\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_%.-]+\.(png|jpg|webp)$/.test(key || '')) {
      return fail(404, 'IMAGE_NOT_READY', '参考图尚未准备好');
    }
    const object = await env.REFERENCE_IMAGES_KV?.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!object?.value) return fail(404, 'IMAGE_NOT_FOUND', '参考图暂时不可用');
    const contentType = object.metadata?.contentType;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) return fail(415, 'INVALID_IMAGE', '参考图格式暂不支持');
    return new Response(object.value, { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  if (route === '/miniapp/favorite' && request.method === 'POST') {
    const parsed = await readJsonBody(request, { maxBytes: 2048 });
    if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message);
    const body = parsed.value || {};
    if (typeof body.word !== 'string' || !body.word.trim() || body.word.length > 80 || !['add', 'remove', 'status'].includes(body.action)) {
      return fail(400, 'INVALID_COMMAND', '选题操作无效');
    }
    if (body.action === 'status' && !['none', 'pending'].includes(body.status)) return fail(400, 'INVALID_STATUS', '请在电脑端整理实际发布记录');
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(body.operationId || '')) return fail(400, 'INVALID_OPERATION_ID', '操作编号无效，请刷新后重试');
    const word = body.word.trim();
    const stored = await env.FAVORITES.get('favorites:global', 'json') || {};
    if (!stored.candidatePool?.[word] && !stored.words?.includes(word)) return fail(404, 'WORD_NOT_FOUND', '词条已变更，请刷新');
    if (stored.statuses?.[word] === 'published') return fail(409, 'PUBLISHED_READ_ONLY', '已发布选题请在电脑端管理');
    let mutation;
    try { mutation = await commitWorkflowMutation(env, 'favorites:global', { action: body.action, word, status: body.status }, {
      operationId: `wx-${session.memberId}-${body.operationId}`,
      actor: `wechat:${session.memberId}`,
      action: `favorite.${body.action}`,
      target: word,
      protectPublished: true,
      expectedRevision: null
    }, { strategy: 'favorite-command' }); }
    catch (e) { if (e.code === 'PUBLISHED_READ_ONLY') return fail(409, e.code, e.message); throw e; }
    return json({ ...buildFavoriteCommandView(mutation.workflow, word), mutation: { duplicate: mutation.duplicate } });
  }
  // No admin token proxy, arbitrary forwarding, full saves, AI generation or imports.
  return fail(404, 'NOT_FOUND', '小程序不支持此操作');
}

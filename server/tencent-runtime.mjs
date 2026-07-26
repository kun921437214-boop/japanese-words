import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequest as aiCandidates } from '../functions/ai-candidates.js';
import { onRequest as aiCards } from '../functions/ai-cards.js';
import { onRequest as codexDaily } from '../functions/codex-daily.js';
import { onRequest as codexImage } from '../functions/codex-image.js';
import { onRequest as dailyRefresh } from '../functions/daily-refresh.js';
import { onRequest as favorites } from '../functions/favorites.js';
import { onRequest as healthz } from '../functions/healthz.js';
import { onRequest as publishedImport } from '../functions/published-import.js';
import { onRequest as publishedCover } from '../functions/published-cover.js';
import { onRequest as publishedRefresh } from '../functions/published-refresh.js';
import { onRequest as rankings } from '../functions/rankings.js';
import { onRequest as todaySnapshot } from '../functions/today-snapshot.js';
import scheduledWorker, {
  DAILY_DRAFT_HEALTH_CRON,
  DAILY_SNAPSHOT_HEALTH_CRON
} from '../worker/favorites-worker.js';
import { FileKV } from './file-kv.mjs';
import { LocalWorkflowCoordinator } from './local-coordinator.mjs';
import { onRequest as publishedCoverThumbnail } from './published-cover-thumbnail.mjs';

function publishedCoverRoute(context) {
  const url = new URL(context.request.url);
  return url.searchParams.get('variant') === 'thumb'
    ? publishedCoverThumbnail(context)
    : publishedCover(context);
}

const ROUTES = new Map([
  ['/ai-candidates', aiCandidates],
  ['/ai-cards', aiCards],
  ['/codex-daily', codexDaily],
  ['/codex-image', codexImage],
  ['/daily-refresh', dailyRefresh],
  ['/favorites', favorites],
  ['/healthz', healthz],
  ['/published-cover', publishedCoverRoute],
  ['/published-import', publishedImport],
  ['/published-refresh', publishedRefresh],
  ['/rankings', rankings],
  ['/today-snapshot', todaySnapshot]
]);

const SCHEDULES = [
  '30 6 * * *',
  '0 16 * * *',
  DAILY_DRAFT_HEALTH_CRON,
  DAILY_SNAPSHOT_HEALTH_CRON,
  '5,25,45 * * * *',
  '10,20,30,40,50 16 * * *',
  '0 17 * * *'
];

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function matchesCronField(field, value) {
  if (field === '*') return true;
  return field.split(',').some(part => Number.parseInt(part, 10) === value);
}

export function matchesSchedule(cron, date = new Date()) {
  const [minute, hour, day, month, weekday] = String(cron || '').trim().split(/\s+/);
  if (![minute, hour, day, month, weekday].every(Boolean)) return false;
  return matchesCronField(minute, date.getUTCMinutes())
    && matchesCronField(hour, date.getUTCHours())
    && matchesCronField(day, date.getUTCDate())
    && matchesCronField(month, date.getUTCMonth() + 1)
    && matchesCronField(weekday, date.getUTCDay());
}

function buildRuntimeEnv(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory || process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words');
  const favoritesKv = options.favoritesKv || new FileKV(path.join(dataDirectory, 'workflow-kv'));
  const imagesKv = options.imagesKv || new FileKV(path.join(dataDirectory, 'reference-images-kv'));
  return {
    FAVORITES: favoritesKv,
    REFERENCE_IMAGES_KV: imagesKv,
    WORKFLOW_COORDINATOR: options.coordinator || new LocalWorkflowCoordinator(favoritesKv),
    ALLOW_PUBLIC_APP: process.env.ALLOW_PUBLIC_APP || 'true',
    SITE_URL: process.env.SITE_URL || 'http://127.0.0.1:8788',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || '',
    AUTO_REFRESH_SECRET: process.env.AUTO_REFRESH_SECRET || '',
    OPS_ALERT_WEBHOOK_URL: process.env.OPS_ALERT_WEBHOOK_URL || '',
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || '',
    CODEX_AUTOMATION_SECRET: process.env.CODEX_AUTOMATION_SECRET || '',
    TEAM_ACCESS_EMAILS: process.env.TEAM_ACCESS_EMAILS || '',
    CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
    CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || ''
  };
}

async function readIncomingBody(request, maxBytes = 10 * 1024 * 1024) {
  if (['GET', 'HEAD'].includes(request.method || 'GET')) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function buildRequestUrl(request) {
  const forwardedProto = parseList(request.headers['x-forwarded-proto'])[0];
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '127.0.0.1');
  return `${protocol}://${host}${request.url || '/'}`;
}

async function toWebRequest(request) {
  const body = await readIncomingBody(request);
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  });
  return new Request(buildRequestUrl(request), {
    method: request.method,
    headers,
    ...(body?.length ? { body } : {})
  });
}

async function writeWebResponse(response, outgoing, method = 'GET') {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  if (method === 'HEAD' || response.body === null) {
    outgoing.end();
    return;
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function trackBackgroundTasks(tasks, options = {}) {
  if (!tasks.length) return;
  const settled = Promise.allSettled(tasks).then(results => {
    results.forEach(result => {
      if (result.status === 'rejected') {
        console.error(JSON.stringify({
          event: 'background_task_failure',
          error: String(result.reason?.message || result.reason || 'Unknown background task error')
        }));
      }
    });
  });
  if (typeof options.waitUntil === 'function') options.waitUntil(settled);
  else void settled;
}

export async function dispatchPagesFunction(handler, request, env, options = {}) {
  const backgroundTasks = [];
  const waitUntil = promise => {
    backgroundTasks.push(Promise.resolve(promise));
  };
  const handlerContext = { request, env, waitUntil };
  const response = await middleware({
    ...handlerContext,
    next: () => handler(handlerContext)
  });
  trackBackgroundTasks(backgroundTasks, options);
  return response;
}

export async function handleWebRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const handler = ROUTES.get(url.pathname);
  if (!handler) {
    return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } }, { status: 404 });
  }
  return dispatchPagesFunction(handler, request, env, options);
}

async function runScheduledCron(cron, env) {
  const pending = [];
  const context = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
  await scheduledWorker.scheduled({ cron }, env, context);
  const results = await Promise.allSettled(pending);
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

function startScheduler(env, options = {}) {
  const intervalMs = Number(options.intervalMs) || 30_000;
  let lastMinuteKey = '';
  const runOnce = async (runKey, cron) => {
    if (await env.FAVORITES.get(runKey)) return;
    await env.FAVORITES.put(runKey, 'started', { expirationTtl: 10 * 60 });
    try {
      await runScheduledCron(cron, env);
      await env.FAVORITES.put(runKey, 'success', { expirationTtl: 3 * 24 * 60 * 60 });
      console.log(JSON.stringify({ event: 'scheduled_success', cron, runKey }));
    } catch (error) {
      await env.FAVORITES.delete(runKey);
      console.error(JSON.stringify({ event: 'scheduled_failure', cron, runKey, error: String(error?.message || error) }));
    }
  };
  const tick = async () => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === lastMinuteKey) return;
    lastMinuteKey = minuteKey;
    const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const businessDate = shanghai.toISOString().slice(0, 10);
    const businessMinute = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
    if (env.AUTO_REFRESH_SECRET) {
      await runOnce(`scheduler-critical:daily:${businessDate}`, '0 16 * * *');
    }
    if (businessMinute >= 10) {
      await runOnce(`scheduler-critical:snapshot-health:${businessDate}`, DAILY_SNAPSHOT_HEALTH_CRON);
    }
    if (businessMinute >= 14 * 60 + 30) {
      await runOnce(`scheduler-critical:published:${businessDate}`, '30 6 * * *');
    }
    if (businessMinute >= 17 * 60 + 15) {
      await runOnce(`scheduler-critical:draft-health:${businessDate}`, DAILY_DRAFT_HEALTH_CRON);
    }
    if (env.AUTO_REFRESH_SECRET && businessMinute >= 60) {
      await runOnce(`scheduler-critical:ai-cards-1:${businessDate}`, '0 17 * * *');
      await runOnce(`scheduler-critical:ai-cards-2:${businessDate}`, '0 17 * * *');
    }
    const catchUpSchedules = new Set([
      '0 16 * * *',
      '30 6 * * *',
      DAILY_DRAFT_HEALTH_CRON,
      DAILY_SNAPSHOT_HEALTH_CRON
    ]);
    for (const cron of SCHEDULES.filter(item => !catchUpSchedules.has(item) && matchesSchedule(item, now))) {
      await runOnce(`scheduler-run:${cron}:${minuteKey}`, cron);
    }
  };
  const timer = globalThis.setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => globalThis.clearInterval(timer);
}

export function createTencentRuntime(options = {}) {
  const env = options.env || buildRuntimeEnv(options);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toWebRequest(incoming);
      const response = await handleWebRequest(request, env);
      await writeWebResponse(response, outgoing, incoming.method);
    } catch (error) {
      const status = Number(error?.status) || 500;
      outgoing.statusCode = status;
      outgoing.setHeader('Content-Type', 'application/json; charset=utf-8');
      outgoing.end(JSON.stringify({
        ok: false,
        error: {
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
          message: status === 413 ? '请求体过大' : '服务暂时不可用，请稍后重试',
          retryable: status >= 500
        }
      }));
      console.error(JSON.stringify({ event: 'runtime_error', error: String(error?.message || error) }));
    }
  });
  const stopScheduler = options.scheduler === false ? () => {} : startScheduler(env, options.schedulerOptions);
  server.on('close', stopScheduler);
  return { server, env, stopScheduler };
}

export function startTencentRuntime(options = {}) {
  const port = Number(options.port || process.env.PORT || 8788);
  const host = String(options.host || process.env.HOST || '127.0.0.1');
  const scheduler = options.scheduler ?? String(process.env.DISABLE_SCHEDULER || '').toLowerCase() !== 'true';
  const runtime = createTencentRuntime({ ...options, scheduler });
  runtime.server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'runtime_started', host, port }));
  });
  return runtime;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startTencentRuntime();

export { ROUTES, SCHEDULES, buildRuntimeEnv, runScheduledCron };

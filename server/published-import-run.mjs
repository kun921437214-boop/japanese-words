import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePublishedImportRow } from '../shared/published-import.mjs';
import { dateKey } from '../shared/rankings.mjs';
import { sendOperationsNotification } from '../shared/operations-alert.mjs';
import { FileKV } from './file-kv.mjs';

const METRICS = ['impressions', 'views', 'coverClickRate', 'likes', 'comments', 'favorites', 'follows', 'shares', 'avgWatchSeconds', 'danmaku'];
const fail = code => { throw new Error(code); };

export function validateOfficialPayload(payload, now = new Date()) {
  if (payload?.source !== 'xiaohongshu_creator_export' || !/\.xlsx$/i.test(payload?.sourceFileName || '')) fail('OFFICIAL_EXPORT_REQUIRED');
  const captured = new Date(payload.capturedAt);
  if (!Number.isFinite(captured.getTime()) || dateKey(captured) !== dateKey(now) || captured > now) fail('FRESH_EXPORT_REQUIRED');
  if (!['official_export', 'file_modified_time'].includes(payload.capturedAtSource)) fail('EXPORT_CAPTURE_SOURCE_REQUIRED');
  if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 1000) fail('EXPORT_ROWS_INVALID');
  const identities = new Set();
  for (const row of payload.rows) {
    const rawPublished = normalizePublishedImportRow(row).publishedAt;
    const published = new Date(rawPublished + (/([zZ]|[+-]\d\d:\d\d)$/.test(rawPublished) ? '' : '+08:00'));
    if (!String(row.title || '').trim() || !Number.isFinite(published.getTime()) || published > now) fail('EXPORT_IDENTITY_INVALID');
    const identity = `${row.title.trim()}|${published.toISOString()}`;
    if (identities.has(identity)) fail('EXPORT_IDENTITY_AMBIGUOUS');
    identities.add(identity);
    for (const metric of METRICS) {
      const value = row[metric];
      if (value === null || value === undefined || value === '' || !/^\d+(?:\.\d+)?(?:%|秒)?$/.test(String(value).trim().replace(/,/g, ''))) fail('EXPORT_METRICS_INCOMPLETE');
    }
  }
}

async function requestJson(fetchImpl, url, init) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: globalThis.AbortSignal?.timeout?.(30000) }); }
  catch { fail('IMPORT_TRANSPORT_FAILED'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) fail(response.status === 409 ? 'REVISION_CONFLICT' : `IMPORT_HTTP_${response.status}`);
  return data;
}

function comparableRecord(record) {
  return {
    id: record.id, title: record.title, word: record.word, publishedAt: record.publishedAt,
    contentLocked: record.contentLocked, description: record.description, coverUrl: record.coverUrl,
    coverStorageKey: record.coverStorageKey, creativeSnapshot: record.creativeSnapshot,
    lastMetricsImportedAt: record.lastMetricsImportedAt, latestMetrics: record.latestMetrics,
    metricSnapshots: record.metricSnapshots, importBatchIds: record.importBatchIds
  };
}

export async function runPublishedImport(payload, options = {}) {
  validateOfficialPayload(payload, options.now || new Date());
  const base = new URL(options.origin || `http://127.0.0.1:${process.env.PORT || 8788}`);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail('LOOPBACK_RUNTIME_REQUIRED');
  const token = options.token || process.env.AUTO_REFRESH_SECRET;
  if (!token) fail('SERVER_IMPORT_AUTH_REQUIRED');
  const fetchImpl = options.fetchImpl || fetch;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const operationId = `official-export-${digest}`;
  const endpoint = new URL('/published-import', base).toString();
  const preview = await requestJson(fetchImpl, endpoint, { method: 'POST', headers, body: JSON.stringify({ ...payload, mode: 'preview' }) });
  if (preview.mode !== 'preview' || !Number.isInteger(preview.revision) || !preview.batch?.id) fail('PREVIEW_INVALID');
  if (preview.summary?.ambiguousCount !== 0 || preview.summary?.missingActiveCount !== 0 || preview.summary?.totalRows !== payload.rows.length) fail('PREVIEW_BLOCKED');
  if (options.confirm !== 'IMPORT_PUBLISHED') return { status: 'preview', digest, revision: preview.revision, summary: preview.summary };
  const committed = await requestJson(fetchImpl, endpoint, {
    method: 'POST', headers: { ...headers, 'X-Operation-Id': operationId, 'X-Workflow-Revision': String(preview.revision) },
    body: JSON.stringify({ ...payload, batchId: preview.batch.id, mode: 'commit' })
  });
  if (committed.mode !== 'commit' || committed.batch?.id !== preview.batch.id || !Number.isInteger(committed.revision) || committed.revision < preview.revision || !Array.isArray(committed.publishedRecords) || committed.publishedRecords.length < payload.rows.length) fail('COMMIT_RESPONSE_INVALID');
  // AUTO_REFRESH_SECRET deliberately cannot read /favorites. Read the actual server
  // store instead of broadening API permissions or copying an admin credential.
  const readWorkflow = options.readWorkflow || (() => new FileKV(path.join(
    process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv'
  )).get('favorites:global', 'json'));
  let actual;
  try { actual = await readWorkflow(); } catch { fail('READBACK_FAILED'); }
  if (!actual) fail('READBACK_INVALID');
  if (!Array.isArray(actual.publishedRecords) || actual.revision < committed.revision) fail('READBACK_INVALID');
  const byId = new Map(actual.publishedRecords.map(record => [record.id, record]));
  for (const record of committed.publishedRecords) {
    if (JSON.stringify(comparableRecord(byId.get(record.id) || {})) !== JSON.stringify(comparableRecord(record))) fail('READBACK_MISMATCH');
  }
  return { status: 'verified', operationId, digest, revision: committed.revision, batchId: committed.batch.id, summary: committed.summary };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args.some((arg, index) => index > 0 && arg !== '--confirm=IMPORT_PUBLISHED')) fail('IMPORT_ARGUMENT_INVALID');
  const file = path.resolve(args[0]);
  // systemd instance accepts an inbox JSON basename; never fetch payloads from a URL.
  if (path.dirname(file) !== '/var/lib/japanese-words/published-import-inbox' || !/^[a-zA-Z0-9_-]+\.json$/.test(path.basename(file))) fail('IMPORT_INBOX_REQUIRED');
  let result;
  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) fail('IMPORT_PAYLOAD_TOO_LARGE');
    const payload = JSON.parse(await readFile(file, 'utf8'));
    result = await runPublishedImport(payload, { confirm: args.includes('--confirm=IMPORT_PUBLISHED') ? 'IMPORT_PUBLISHED' : '' });
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{1,70}$/.test(error?.message || '') ? error.message : 'IMPORT_RUN_FAILED';
    await new FileKV(path.join(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv')).put(
      `operations-health:published:official-import:${dateKey()}`,
      JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), error: code }), { expirationTtl: 35 * 86400 }
    ).catch(() => {});
    const notification = await sendOperationsNotification(process.env, { text: `[japanese-words] 官方数据导入失败：${code}；未确认读回成功，请检查服务器日志。`, event: 'published_import_failed' });
    console.error(JSON.stringify({ event: 'published_import_failed', error: code, notification }));
    process.exitCode = 1;
    return;
  }
  if (result.status === 'verified') {
    await new FileKV(path.join(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv')).put(
      `operations-health:published:official-import:${dateKey()}`,
      JSON.stringify({ status: 'verified', checkedAt: new Date().toISOString(), revision: result.revision, digest: result.digest }), { expirationTtl: 35 * 86400 }
    ).catch(() => fail('IMPORT_HEALTH_WRITE_FAILED'));
  }
  const notification = result.status === 'verified'
    ? await sendOperationsNotification(process.env, { text: `[japanese-words] 官方数据导入并读回通过；批次 ${result.batchId}；revision ${result.revision}`, event: 'published_import_verified' })
    : { sent: false };
  console.log(JSON.stringify({ event: 'published_import_completed', ...result, notification }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[A-Z][A-Z0-9_]{1,70}$/.test(error?.message || '') ? error.message : 'IMPORT_RUN_FAILED';
    console.error(JSON.stringify({ event: 'published_import_failed', error: code }));
    process.exitCode = 1;
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanDateKey } from '../../shared/rankings.mjs';
import {
  codexBytesSha256, codexValueSha256, codexOperationScope, requireCodexOperationId
} from '../../shared/codex-operation.mjs';

const lockHelper = fileURLToPath(new URL('./codex-operation-lock.py', import.meta.url));
export class CodexClientError extends Error {
  constructor(code, status = 0, data = {}) { super(code); this.code = code; this.status = status; this.data = data; }
}
function fail(code) { throw new CodexClientError(code); }
function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(directory), metadata = fs.statSync(canonical);
  if (metadata.uid !== process.getuid() || (metadata.mode & 0o077)) fail('UNSAFE_CLIENT_JOURNAL_DIRECTORY');
  return canonical;
}
function readState(file) {
  let metadata;
  try { metadata = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) fail('UNSAFE_CLIENT_JOURNAL_FILE');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('CLIENT_JOURNAL_CORRUPT'); }
}
async function saveState(file, state) {
  const { journalSha256: _old, ...content } = state;
  const record = { ...content, journalSha256: await codexValueSha256(content) };
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return record;
}
async function verifyState(record, slot) {
  const { journalSha256, ...content } = record;
  if (record.schemaVersion !== 1 || journalSha256 !== await codexValueSha256(content)
      || !['prepared', 'unknown', 'blocked', 'complete'].includes(record.state)) fail('CLIENT_JOURNAL_CORRUPT');
  requireCodexOperationId(record.operationId);
  for (const key of ['origin', 'scope', 'kind', 'target']) {
    if (record[key] !== slot[key]) fail('CLIENT_JOURNAL_IDENTITY_CONFLICT');
  }
}
async function acquire(lock, python) {
  const child = spawn(python, ['-B', lockHelper, lock], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let ended = false;
  const exit = new Promise(resolve => { child.once('exit', code => { ended = true; resolve(code); }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new CodexClientError('CLIENT_LOCK_TIMEOUT')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new CodexClientError('CLIENT_LOCK_HELPER_UNAVAILABLE')); });
    child.once('exit', code => { clearTimeout(timer); reject(new CodexClientError(code === 73 ? 'CLIENT_OPERATION_BUSY' : 'CLIENT_LOCK_FAILED')); });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (!output.includes('\n') && output.length < 32) return;
      clearTimeout(timer);
      if (output.trim() === 'LOCKED') resolve();
      else { child.kill(); reject(new CodexClientError('CLIENT_LOCK_FAILED')); }
    });
    child.stderr.resume();
  });
  return async () => { if (!ended) child.stdin.end(); await exit; };
}

// Digest formulas are shared with the actual backend. No secrets, body content
// or image bytes enter the client journal; transport is supplied by the CLI.
export async function prepareCodexClientInput(urlValue, options, kind) {
  const url = new URL(urlValue);
  if (url.username || url.password || url.hash || url.protocol !== 'https:'
      || url.pathname !== (kind === 'image' ? '/codex-image' : '/codex-daily')) fail('INVALID_CLIENT_OPERATION_URL');
  const targetDateKey = cleanDateKey(url.searchParams.get('date'));
  if (!targetDateKey) fail('CLIENT_OPERATION_DATE_REQUIRED');
  const scope = codexOperationScope(url);
  let payload, inputSha256, target;
  if (kind === 'image') {
    const word = String(url.searchParams.get('word') || '').trim().slice(0, 80);
    const contentType = String(new Headers(options.headers).get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!word || !['image/webp', 'image/jpeg', 'image/png'].includes(contentType)) fail('INVALID_CLIENT_IMAGE_INPUT');
    if (!(options.body instanceof Uint8Array) || !options.body.byteLength) fail('CLIENT_IMAGE_BYTES_REQUIRED');
    const bytes = new Uint8Array(options.body);
    const bytesSha256 = await codexBytesSha256(bytes);
    inputSha256 = await codexValueSha256({ targetDateKey, word, contentType, bytesSha256 });
    payload = bytes; target = `${targetDateKey}:${word}`;
  } else if (kind === 'draft') {
    const input = JSON.parse(options.body);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CLIENT_DRAFT_OBJECT_REQUIRED');
    payload = input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationId')) : input;
    inputSha256 = await codexValueSha256({ targetDateKey, payload }); target = targetDateKey;
  } else fail('INVALID_CLIENT_OPERATION_KIND');
  return { origin: url.origin, scope, kind, target, inputSha256, payload, url };
}
function checkReceipt(operation, record) {
  if (!operation || operation.authoritative !== true || operation.operationId !== record.operationId
      || operation.kind !== record.kind || !['absent', 'pending', 'complete'].includes(operation.status)) {
    fail('CODEX_OPERATION_PROTOCOL_UNAVAILABLE');
  }
  if (operation.status !== 'absent' && (operation.target !== record.target || operation.inputSha256 !== record.inputSha256)) {
    fail('REMOTE_OPERATION_IDENTITY_CONFLICT');
  }
  return operation;
}
async function completeReceipt(operation, record) {
  checkReceipt(operation, record);
  if (operation.status !== 'complete' || operation.resultSha256 !== await codexValueSha256(operation.result)
      || !Number.isInteger(operation.httpStatus)) fail('REMOTE_OPERATION_RESULT_UNVERIFIED');
  return operation;
}

export async function runCodexClientOperation({ url, options, kind, journalDirectory, request,
  operationId = '', newOperation = false, attempts = 3, retryDelayMs = 1500, onRetry,
  python = '/usr/bin/python3' }) {
  if (typeof request !== 'function') fail('AUTHORIZED_CLIENT_TRANSPORT_REQUIRED');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    fail('INVALID_CLIENT_RETRY_BUDGET');
  }
  if (operationId) requireCodexOperationId(operationId);
  if (newOperation && !operationId) fail('NEW_OPERATION_REQUIRES_EXPLICIT_ID');
  const input = await prepareCodexClientInput(url, options, kind);
  const root = safeDirectory(journalDirectory);
  const { payload, url: putUrl, inputSha256, ...slot } = input;
  const key = await codexValueSha256(slot), file = path.join(root, key + '.json');
  const release = await acquire(path.join(root, key + '.lock'), python);
  try {
    let record = readState(file);
    if (record) await verifyState(record, slot);
    const auth = new Headers(options.headers); auth.delete('Content-Type'); auth.delete('X-Operation-Id');
    const query = async state => {
      const lookupUrl = new URL(putUrl.pathname, input.origin);
      lookupUrl.searchParams.set('operationId', state.operationId);
      if (state.scope !== 'global') lookupUrl.searchParams.set('code', state.scope);
      const response = await request(lookupUrl, { method: 'GET', headers: auth, redirect: 'error', cache: 'no-store' });
      return checkReceipt(response.operation, state);
    };
    if (record && (record.inputSha256 !== inputSha256 || (operationId && record.operationId !== operationId))) {
      // Resolve the old identity first, even when incoming content has changed.
      const remote = await query(record);
      if (remote.status === 'complete') {
        await completeReceipt(remote, record);
        record = await saveState(file, { ...record, state: 'complete', receipt: remote });
      }
      if (!newOperation) fail(record.inputSha256 !== inputSha256 ? 'CLIENT_PAYLOAD_CONFLICT' : 'CLIENT_OPERATION_ID_CONFLICT');
      if (remote.status !== 'complete' || remote.currentEffect !== 'complete') fail('PREVIOUS_OPERATION_NOT_RESOLVED');
      if (operationId === record.operationId) fail('OPERATION_ID_CANNOT_BE_REUSED');
      const history = safeDirectory(path.join(root, 'history'));
      const archived = path.join(history, record.operationId + '.json');
      if (fs.existsSync(archived)) {
        if ((await codexValueSha256(readState(archived))) !== await codexValueSha256(record)) fail('CLIENT_HISTORY_CONFLICT');
      } else {
        fs.writeFileSync(archived, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
      }
      record = null;
    }
    if (!record) record = await saveState(file, { schemaVersion: 1, ...slot, inputSha256,
      operationId: operationId || 'codex-' + randomUUID(), state: 'prepared', createdAt: new Date().toISOString() });
    const headers = new Headers(options.headers); headers.set('X-Operation-Id', record.operationId);
    const body = kind === 'draft' ? JSON.stringify({ ...payload, operationId: record.operationId }) : payload;
    const accept = async remote => {
      await completeReceipt(remote, record);
      record = await saveState(file, { ...record, state: 'complete', receipt: remote });
      if (remote.currentEffect !== 'complete') fail('COMPLETED_EFFECT_NOT_CURRENT');
      if (remote.httpStatus >= 400) throw new CodexClientError('CODEX_OPERATION_REJECTED', remote.httpStatus, remote.result);
      return { ...remote.result, operation: remote };
    };
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        let remote = await query(record);
        if (remote.status === 'complete') return await accept(remote);
        if (remote.status === 'absent' && record.state === 'complete') fail('OPERATION_HISTORY_MISSING');
        if (remote.status === 'pending' && remote.currentEffect !== 'absent') fail('REMOTE_OPERATION_STATE_UNRESOLVED');
        // Persist uncertainty before sending. A killed process can only resume
        // by querying the same ID; it cannot invent a fresh identity.
        record = await saveState(file, { ...record, state: 'unknown' });
        try {
          await request(putUrl, { ...options, method: 'PUT', headers, body, redirect: 'error' });
        } catch (error) {
          if (error.status && ![422, 429, 500, 502, 503, 504].includes(error.status)) {
            record = await saveState(file, { ...record, state: 'blocked', lastHttpStatus: error.status,
              lastErrorCode: error.data?.error?.code || 'HTTP_REJECTED' });
            throw error;
          }
          lastError = error;
        }
        remote = await query(record);
        if (remote.status === 'complete') return await accept(remote);
        if (remote.status === 'absent' || (remote.status === 'pending' && remote.currentEffect === 'absent')) {
          throw Object.assign(new Error('REMOTE_OPERATION_STATE_UNRESOLVED'), {
            status: 503, data: { error: { code: 'CODEX_OPERATION_PENDING_RETRY_SAME_ID' } }
          });
        }
        throw new CodexClientError('REMOTE_OPERATION_STATE_UNRESOLVED');
      } catch (error) {
        lastError = error;
        const retryable = !error.status || [429, 500, 502, 503, 504].includes(error.status);
        // Known protocol/identity/history/effect failures never authorize a PUT.
        if (error instanceof CodexClientError || !retryable || attempt === attempts) throw error;
        const delayMilliseconds = Math.min(retryDelayMs * (2 ** (attempt - 1)), 10000);
        onRetry?.({ nextAttempt: attempt + 1, delayMilliseconds, error, operationId: record.operationId });
        await new Promise(resolve => { setTimeout(resolve, delayMilliseconds); });
      }
    }
    throw lastError;
  } finally { await release(); }
}

// Operation records are separate from workflow data and have no expiry. They
// use the existing Tencent coordinator queue and FileKV's atomic replacement.
// Cloudflare's workflow-only coordinator cannot offer this protocol; no direct
// or eventually consistent KV fallback is permitted for opted-in clients.
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class CodexOperationError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function fail(code, status = 503) { throw new CodexOperationError(code, status); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
export async function codexBytesSha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function codexValueSha256(value) {
  return codexBytesSha256(new TextEncoder().encode(JSON.stringify(canonical(value))));
}
export function requireCodexOperationId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_OPERATION_ID', 400);
  return value;
}
export function codexOperationIdFromHeader(request, body = {}) {
  const value = request.headers.get('X-Operation-Id');
  if (value === null) return '';
  const id = requireCodexOperationId(value);
  if (body?.operationId && body.operationId !== id) fail('OPERATION_ID_MISMATCH', 400);
  return id;
}
export function codexOperationScope(url) {
  const code = String(url.searchParams.get('code') || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return code.length >= 8 ? code : 'global';
}
export function codexOperationStorageKey(scope, operationId) {
  if (scope !== 'global' && !/^[a-zA-Z0-9_-]{8,64}$/.test(scope)) fail('INVALID_OPERATION_SCOPE', 400);
  return `codex-operation:${scope}:${requireCodexOperationId(operationId)}`;
}
export function withCodexWrite(env, scope, callback, required = false) {
  if (typeof env.WORKFLOW_COORDINATOR?.withCodexWrite === 'function') {
    return env.WORKFLOW_COORDINATOR.withCodexWrite(`favorites:${scope}`, callback);
  }
  if (required) fail('CODEX_OPERATION_COORDINATOR_REQUIRED');
  return callback();
}
async function saveRecord(env, key, record) {
  const { journalSha256: _previous, ...content } = record;
  const stored = { ...content, journalSha256: await codexValueSha256(content) };
  await env.FAVORITES.put(key, JSON.stringify(stored));
  return stored;
}
async function readRecord(env, key) {
  const raw = await env.FAVORITES.get(key);
  if (raw === null || raw === undefined) return null;
  let record;
  try { record = JSON.parse(raw); } catch { fail('CODEX_OPERATION_RECORD_CORRUPT'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('CODEX_OPERATION_RECORD_CORRUPT');
  const { journalSha256, ...content } = record;
  if (record.schemaVersion !== 1 || !['pending', 'complete'].includes(record.status)
      || !HASH_PATTERN.test(record.inputSha256 || '') || !record.effect || !record.response
      || !Number.isInteger(record.response.status)
      || journalSha256 !== await codexValueSha256(content)
      || record.resultSha256 !== await codexValueSha256(record.response.body)) {
    fail('CODEX_OPERATION_RECORD_CORRUPT');
  }
  return record;
}
function checkIdentity(record, identity, comparePayload = true) {
  for (const key of ['scope', 'operationId', 'kind']) {
    if (record[key] !== identity[key]) fail('OPERATION_ID_CONFLICT', 409);
  }
  if (comparePayload && (record.target !== identity.target || record.inputSha256 !== identity.inputSha256)) {
    fail('OPERATION_ID_CONFLICT', 409);
  }
}
function receipt(record, currentEffect = '') {
  return {
    operationId: record.operationId, kind: record.kind, target: record.target,
    inputSha256: record.inputSha256, status: record.status, authoritative: true,
    createdAt: record.createdAt, completedAt: record.completedAt || '',
    ...(currentEffect ? { currentEffect } : {}),
    ...(record.status === 'complete' ? {
      result: record.response.body, resultSha256: record.resultSha256, httpStatus: record.response.status
    } : {})
  };
}
async function finish(env, key, record) {
  return saveRecord(env, key, { ...record, status: 'complete', completedAt: new Date().toISOString() });
}

export function executeCodexOperation(env, identity, { prepare, inspect, apply }) {
  const key = codexOperationStorageKey(identity.scope, identity.operationId);
  return withCodexWrite(env, identity.scope, async () => {
    let record = await readRecord(env, key);
    if (record) checkIdentity(record, identity);
    if (record?.status === 'complete') return { ...record.response, operation: receipt(record) };
    if (!record) {
      const prepared = await prepare();
      record = await saveRecord(env, key, {
        schemaVersion: 1, ...identity, status: 'pending', createdAt: new Date().toISOString(),
        effect: prepared.effect, response: prepared.response,
        resultSha256: await codexValueSha256(prepared.response.body)
      });
    }
    let effectState = await inspect(record);
    if (effectState === 'conflict') fail('CODEX_OPERATION_EFFECT_CONFLICT', 409);
    if (effectState === 'absent') {
      await apply(record);
      effectState = await inspect(record);
    }
    if (effectState !== 'complete') fail('CODEX_OPERATION_EFFECT_UNVERIFIED');
    record = await finish(env, key, record);
    return { ...record.response, operation: receipt(record) };
  }, true);
}

export function lookupCodexOperation(env, identity, inspect) {
  const key = codexOperationStorageKey(identity.scope, identity.operationId);
  return withCodexWrite(env, identity.scope, async () => {
    let record = await readRecord(env, key);
    if (!record) return { operationId: identity.operationId, kind: identity.kind, status: 'absent', authoritative: true };
    checkIdentity(record, identity, false);
    const currentEffect = await inspect(record);
    if (record.status === 'pending' && currentEffect === 'complete') record = await finish(env, key, record);
    return receipt(record, currentEffect);
  }, true);
}

export function codexOperationFailure(error) {
  return error instanceof CodexOperationError
    ? { status: error.status, code: error.code }
    : { status: 503, code: 'CODEX_OPERATION_UNAVAILABLE' };
}

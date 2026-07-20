import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

function cleanKey(value) {
  return String(value || '').trim().slice(0, 1000);
}

function toStoredValue(value) {
  if (typeof value === 'string') return { encoding: 'utf8', data: value };
  if (value instanceof ArrayBuffer) {
    return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      encoding: 'base64',
      data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
    };
  }
  throw new TypeError('FileKV only accepts strings, ArrayBuffer, or typed arrays');
}

function decodeStoredValue(record, type = 'text') {
  const buffer = record.encoding === 'base64'
    ? Buffer.from(record.data || '', 'base64')
    : Buffer.from(String(record.data || ''), 'utf8');
  if (type === 'arrayBuffer') {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  const text = buffer.toString('utf8');
  if (type === 'json') {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function decodeCursor(value) {
  try {
    const decoded = Number.parseInt(Buffer.from(String(value || ''), 'base64url').toString('utf8'), 10);
    return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export class FileKV {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.writeQueues = new Map();
  }

  fileForKey(keyValue) {
    const key = cleanKey(keyValue);
    if (!key) throw new TypeError('FileKV key cannot be empty');
    return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async readRecord(keyValue) {
    await this.ready;
    const key = cleanKey(keyValue);
    if (!key) return null;
    const file = this.fileForKey(key);
    let record;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (record.key !== key) return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      await unlink(file).catch(() => {});
      return null;
    }
    return record;
  }

  async get(key, type = 'text') {
    const record = await this.readRecord(key);
    return record ? decodeStoredValue(record, type) : null;
  }

  async getWithMetadata(key, options = {}) {
    const record = await this.readRecord(key);
    if (!record) return null;
    return {
      value: decodeStoredValue(record, options.type || 'text'),
      metadata: record.metadata || null
    };
  }

  async put(keyValue, value, options = {}) {
    const key = cleanKey(keyValue);
    if (!key) throw new TypeError('FileKV key cannot be empty');
    return this.withKeyWrite(key, async () => {
      await this.ready;
      const ttlSeconds = Math.max(0, Number(options.expirationTtl) || 0);
      const record = {
        version: 1,
        key,
        ...toStoredValue(value),
        metadata: options.metadata || null,
        writtenAt: new Date().toISOString(),
        expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : ''
      };
      const target = this.fileForKey(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    });
  }

  async delete(keyValue) {
    const key = cleanKey(keyValue);
    if (!key) return;
    return this.withKeyWrite(key, async () => {
      await unlink(this.fileForKey(key)).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    });
  }

  async list(options = {}) {
    await this.ready;
    const prefix = String(options.prefix || '');
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 1000));
    const start = decodeCursor(options.cursor);
    const files = (await readdir(this.directory)).filter(file => file.endsWith('.json')).sort();
    const records = [];
    for (const file of files) {
      try {
        const record = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
        if (!record?.key || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) continue;
        if (record.key.startsWith(prefix)) records.push(record);
      } catch {
        // Ignore incomplete or unrelated files. Atomic writes never expose temp files here.
      }
    }
    records.sort((left, right) => left.key.localeCompare(right.key));
    const page = records.slice(start, start + limit);
    const next = start + page.length;
    return {
      keys: page.map(record => ({ name: record.key, metadata: record.metadata || null })),
      list_complete: next >= records.length,
      cursor: next < records.length ? encodeCursor(next) : ''
    };
  }

  async withKeyWrite(key, operation) {
    const previous = this.writeQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.writeQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key);
    }
  }
}

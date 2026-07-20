import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';
import { FileKV } from './file-kv.mjs';

const dataDirectory = path.resolve(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words');
const backupDirectory = path.resolve(process.env.JAPANESE_WORDS_BACKUP_DIR || '/var/backups/japanese-words');
const kv = new FileKV(path.join(dataDirectory, 'workflow-kv'));
const stored = await kv.get('favorites:global', 'json');
if (!stored) throw new Error('腾讯云 workflow 尚未初始化');
const workflow = cleanStoredWorkflow(stored);
const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
const digest = createHash('sha256').update(serialized).digest('hex');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const target = path.join(backupDirectory, `workflow-${timestamp}-r${workflow.revision}.json`);
await writeFile(target, serialized, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  file: target,
  revision: workflow.revision,
  favorites: workflow.words.length,
  candidates: Object.keys(workflow.candidatePool).length,
  published: workflow.publishedRecords.length,
  sha256: digest
}, null, 2));

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';
import { FileKV } from './file-kv.mjs';

async function listAllKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ cursor });
    keys.push(...page.keys.map(item => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function copyKv(source, target) {
  const keys = await listAllKeys(source);
  for (const key of keys) {
    const stored = await source.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!stored) continue;
    await target.put(key, stored.value, { metadata: stored.metadata || undefined });
  }
  return keys;
}

const dataDirectory = path.resolve(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words');
const backupDirectory = path.resolve(process.env.JAPANESE_WORDS_BACKUP_DIR || '/var/backups/japanese-words');
const workflowKv = new FileKV(path.join(dataDirectory, 'workflow-kv'));
const imageKv = new FileKV(path.join(dataDirectory, 'reference-images-kv'));
const stored = await workflowKv.get('favorites:global', 'json');
if (!stored) throw new Error('腾讯云 workflow 尚未初始化');
const workflow = cleanStoredWorkflow(stored);
const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
const digest = createHash('sha256').update(serialized).digest('hex');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const bundleName = `state-${timestamp}-r${workflow.revision}`;
const targetDirectory = path.join(backupDirectory, bundleName);
const partialDirectory = path.join(backupDirectory, `.${bundleName}.${randomUUID()}.partial`);
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
await mkdir(partialDirectory, { recursive: true, mode: 0o700 });

const backupWorkflowKv = new FileKV(path.join(partialDirectory, 'workflow-kv'));
const backupImageKv = new FileKV(path.join(partialDirectory, 'reference-images-kv'));
const workflowKeys = await copyKv(workflowKv, backupWorkflowKv);
const imageKeys = await copyKv(imageKv, backupImageKv);
const draftKeys = workflowKeys.filter(key => key.startsWith('codex-draft:'));
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  revision: workflow.revision,
  workflowKeyCount: workflowKeys.length,
  codexDraftCount: draftKeys.length,
  codexDraftKeys: draftKeys,
  referenceImageCount: imageKeys.length,
  sha256: digest
};
await writeFile(path.join(partialDirectory, 'workflow.json'), serialized, { mode: 0o600 });
await writeFile(path.join(partialDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await rename(partialDirectory, targetDirectory);

console.log(JSON.stringify({
  ok: true,
  directory: targetDirectory,
  revision: workflow.revision,
  favorites: workflow.words.length,
  candidates: Object.keys(workflow.candidatePool).length,
  published: workflow.publishedRecords.length,
  workflowKeys: workflowKeys.length,
  codexDrafts: draftKeys.length,
  referenceImages: imageKeys.length,
  sha256: digest
}, null, 2));

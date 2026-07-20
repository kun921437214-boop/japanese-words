import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanStoredWorkflow, workflowDateKey } from '../shared/workflow-schema.mjs';
import { FileKV } from './file-kv.mjs';

function parseArgs(argv) {
  return argv.reduce((result, value, index) => {
    if (!value.startsWith('--') && !result.file) result.file = value;
    if (value.startsWith('--data-dir=')) result.dataDirectory = value.slice('--data-dir='.length);
    if (value.startsWith('--images-origin=')) result.imagesOrigin = value.slice('--images-origin='.length);
    if (value === '--copy-images') result.copyImages = true;
    if (value === '--apply') result.apply = true;
    if (value === '--confirm=IMPORT') result.confirmed = true;
    result.index = index;
    return result;
  }, {});
}

function collectReferenceImages(workflow) {
  const byKey = new Map();
  const collect = card => {
    const reference = card?.referenceImage;
    if (reference?.status !== 'ready' || !reference?.url) return;
    let key = String(reference.key || '').trim();
    if (!key) {
      try {
        key = new URL(reference.url, 'https://placeholder.invalid').searchParams.get('key') || '';
      } catch {
        key = '';
      }
    }
    if (key && !byKey.has(key)) byKey.set(key, { key, url: reference.url });
  };
  Object.values(workflow.candidatePool || {}).forEach(entry => {
    collect(entry?.aiCard);
    (entry?.aiCardHistory || []).forEach(collect);
  });
  return [...byKey.values()];
}

async function copyReferenceImages(images, storage, originValue) {
  const origin = new URL(originValue || 'https://jiyimianbao.pages.dev').origin;
  const queue = [...images];
  const copied = [];
  const copyNext = async () => {
    while (queue.length) {
      const image = queue.shift();
      if (await storage.get(image.key, 'arrayBuffer')) {
        copied.push({ key: image.key, state: 'existing' });
        continue;
      }
      const url = new URL(image.url, origin);
      if (url.origin !== origin) throw new Error(`拒绝从未授权来源复制图片：${url.origin}`);
      const response = await fetch(url, { headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' } });
      if (!response.ok) throw new Error(`图片复制失败（HTTP ${response.status}）：${image.key}`);
      const bytes = await response.arrayBuffer();
      const contentType = String(response.headers.get('Content-Type') || 'image/webp').split(';')[0];
      await storage.put(image.key, bytes, {
        metadata: {
          contentType,
          size: bytes.byteLength,
          migratedAt: new Date().toISOString(),
          sourceOrigin: origin
        }
      });
      copied.push({ key: image.key, state: 'copied' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, images.length)) }, copyNext));
  return copied;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  throw new Error('用法：node server/import-cloudflare-backup.mjs <backup.json> [--copy-images --apply --confirm=IMPORT]');
}
const sourceFile = path.resolve(args.file);
const workflow = cleanStoredWorkflow(JSON.parse(await readFile(sourceFile, 'utf8')));
const images = collectReferenceImages(workflow);
const dataDirectory = path.resolve(args.dataDirectory || process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words');
const summary = {
  mode: args.apply ? 'apply' : 'dry-run',
  sourceFile,
  dataDirectory,
  revision: workflow.revision,
  favorites: workflow.words.length,
  candidates: Object.keys(workflow.candidatePool).length,
  published: workflow.publishedRecords.length,
  referenceImages: images.length,
  copyImages: Boolean(args.copyImages)
};
console.log(JSON.stringify(summary, null, 2));

if (!args.apply) {
  console.log('dry-run 完成，没有写入腾讯云运行数据。');
  process.exit(0);
}
if (!args.confirmed) throw new Error('正式导入必须同时提供 --apply --confirm=IMPORT');

const workflowKv = new FileKV(path.join(dataDirectory, 'workflow-kv'));
const imageKv = new FileKV(path.join(dataDirectory, 'reference-images-kv'));
let imageResult = [];
if (args.copyImages) {
  imageResult = await copyReferenceImages(images, imageKv, args.imagesOrigin);
}
await workflowKv.put('favorites:global', JSON.stringify(workflow));
const currentBusinessDate = workflowDateKey(new Date());
const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
const businessMinute = shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
if (workflow.todaySnapshot?.dateKey === currentBusinessDate && workflow.todaySnapshot?.words?.length) {
  await workflowKv.put(`scheduler-critical:daily:${currentBusinessDate}`, 'imported', { expirationTtl: 3 * 24 * 60 * 60 });
}
if (businessMinute >= 14 * 60 + 30) {
  await workflowKv.put(`scheduler-critical:published:${currentBusinessDate}`, 'imported', { expirationTtl: 3 * 24 * 60 * 60 });
}
await mkdir(path.join(dataDirectory, 'imports'), { recursive: true, mode: 0o700 });
const digest = createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
await writeFile(path.join(dataDirectory, 'imports', `cloudflare-r${workflow.revision}.json`), `${JSON.stringify({
  importedAt: new Date().toISOString(),
  sourceFile: path.basename(sourceFile),
  revision: workflow.revision,
  sha256: digest,
  copiedImages: imageResult.filter(item => item.state === 'copied').length,
  existingImages: imageResult.filter(item => item.state === 'existing').length
}, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  revision: workflow.revision,
  sha256: digest,
  copiedImages: imageResult.filter(item => item.state === 'copied').length,
  existingImages: imageResult.filter(item => item.state === 'existing').length
}, null, 2));

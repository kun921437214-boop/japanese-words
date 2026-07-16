import fs from 'node:fs';
import path from 'node:path';
import {
  CODEX_BATCH_IMAGE_MAX_BYTES,
  applyCodexImageManifestResult,
  applyCodexImageUploadResult,
  getCodexImageContentType,
  getPendingCodexImageItems,
  isRetryableCodexImageUploadError
} from '../shared/codex-image-batch.mjs';
import { addDays, cleanDateKey, dateKey } from '../shared/rankings.mjs';
import { validateCodexDailyDraft } from '../shared/codex-daily-draft.mjs';

function loadLocalAutomationEnv() {
  const envFile = path.resolve(process.env.CODEX_DAILY_ENV_FILE || '.env.codex-daily');
  if (!fs.existsSync(envFile)) return;

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(CODEX_SITE_URL|CODEX_AUTOMATION_SECRET)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

loadLocalAutomationEnv();

function parseArgs(argv) {
  const args = { command: argv[0] || 'help' };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) args[rawKey] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[rawKey] = argv[++index];
    else args[rawKey] = true;
  }
  return args;
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function getTargetDate(args) {
  return cleanDateKey(args.date) || addDays(dateKey(), 1);
}

function getSite(args) {
  const site = String(args.site || process.env.CODEX_SITE_URL || '').trim().replace(/\/+$/, '');
  return requireValue(site, '必须显式设置 --site 或 CODEX_SITE_URL');
}

function getToken() {
  return requireValue(String(process.env.CODEX_AUTOMATION_SECRET || '').trim(), '必须设置 CODEX_AUTOMATION_SECRET');
}

function getOutputDirectory(args, targetDateKey) {
  return path.resolve(args.output || `exports/codex-daily/${targetDateKey}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error?.code || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function buildValidationWorkflow(context = {}) {
  const historySnapshots = {};
  for (const snapshot of context?.recentSnapshots || []) {
    if (snapshot?.dateKey) historySnapshots[snapshot.dateKey] = snapshot;
  }
  return {
    words: context?.favorites || [],
    feedback: context?.feedback || {},
    publishedRecords: (context?.publishedWords || []).map((word, index) => ({ id: `context-${index}`, word })),
    historySnapshots
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function getPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number.parseInt(String(value), 10);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} 必须是正整数`);
  return result;
}

function getBatchImageFile(entry, imagesDirectory, manifest) {
  const configuredFile = String(manifest?.[entry.word]?.file || '').trim();
  if (configuredFile) {
    const configuredPath = path.resolve(imagesDirectory, configuredFile);
    if (fs.existsSync(configuredPath)) return configuredPath;
  }

  if (!fs.existsSync(imagesDirectory)) return '';
  const prefix = `${String(entry.order).padStart(2, '0')}-`;
  const matches = fs.readdirSync(imagesDirectory)
    .filter(file => file.startsWith(prefix) && getCodexImageContentType(file))
    .sort((left, right) => {
      const priority = { '.webp': 0, '.jpg': 1, '.jpeg': 2, '.png': 3 };
      return (priority[path.extname(left).toLowerCase()] ?? 9)
        - (priority[path.extname(right).toLowerCase()] ?? 9);
    });
  return matches[0] ? path.join(imagesDirectory, matches[0]) : '';
}

async function requestJsonWithRetry(url, options, {
  attempts,
  baseDelayMilliseconds,
  onRetry
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableCodexImageUploadError(error)) throw error;
      const delayMilliseconds = Math.min(baseDelayMilliseconds * (2 ** (attempt - 1)), 10000);
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMilliseconds, error });
      await sleep(delayMilliseconds);
    }
  }
  throw lastError;
}

const args = parseArgs(process.argv.slice(2));
const targetDateKey = getTargetDate(args);

if (args.command === 'help') {
  print({
    commands: {
      context: '读取目标日期所需上下文并保存到 exports/codex-daily/<date>/context.json',
      status: '只读检查目标日期草稿状态',
      draft: '只读下载目标日期草稿到 exports/codex-daily/<date>/draft.json',
      validate: '本地校验 --draft 文件，不发送网络写请求',
      submit: '校验并提交 --draft，必须额外提供 --confirm-submit',
      'upload-image': '上传 --file 对应的 --word 参考图片，必须额外提供 --confirm-submit',
      'upload-images': '批量上传草稿缺失图片，逐张写回 --draft/--manifest，支持断点续传和瞬时错误重试'
    },
    defaultTargetDate: targetDateKey
  });
  process.exit(0);
}

if (['context', 'status', 'draft'].includes(args.command)) {
  const site = getSite(args);
  const token = getToken();
  const view = args.command === 'context' ? 'context' : args.command === 'draft' ? 'draft' : 'status';
  const url = new URL(`${site}/codex-daily`);
  url.searchParams.set('date', targetDateKey);
  url.searchParams.set('view', view);
  const data = await requestJson(url, { headers: { Authorization: `Bearer ${token}` } });
  if (args.command === 'context') {
    const file = writeJson(path.join(getOutputDirectory(args, targetDateKey), 'context.json'), data.context);
    print({ ok: true, command: 'context', targetDateKey, file, context: data.context });
  } else if (args.command === 'draft') {
    const file = writeJson(path.join(getOutputDirectory(args, targetDateKey), 'draft.json'), data.draft);
    print({ ok: true, command: 'draft', targetDateKey, file, draft: data.draft });
  } else {
    print({ ok: true, command: 'status', targetDateKey, draft: data.draft });
  }
  process.exit(0);
}

if (args.command === 'validate' || args.command === 'submit') {
  const draftFile = requireValue(args.draft, 'validate/submit 必须提供 --draft');
  const draftInput = readJson(draftFile);
  const outputDirectory = getOutputDirectory(args, targetDateKey);
  const contextFile = path.resolve(args.context || path.join(outputDirectory, 'context.json'));
  const context = fs.existsSync(contextFile) ? readJson(contextFile) : {};
  const draft = validateCodexDailyDraft(draftInput, {
    workflow: buildValidationWorkflow(context),
    expectedDateKey: targetDateKey
  });
  const reportFile = writeJson(path.join(outputDirectory, 'validation.json'), draft.validation);
  if (args.command === 'validate') {
    print({ ok: draft.validation.valid, command: 'validate', targetDateKey, reportFile, draft });
    process.exit(draft.validation.valid ? 0 : 1);
  }
  if (!draft.validation.valid) {
    print({ ok: false, command: 'submit', targetDateKey, reportFile, errors: draft.validation.errors });
    process.exit(1);
  }
  if (!args['confirm-submit']) throw new Error('提交草稿必须显式提供 --confirm-submit');
  const site = getSite(args);
  const token = getToken();
  const url = new URL(`${site}/codex-daily`);
  url.searchParams.set('date', targetDateKey);
  const data = await requestJson(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(draftInput)
  });
  print({ ok: true, command: 'submit', targetDateKey, reportFile, draft: data.draft });
  process.exit(0);
}

if (args.command === 'upload-image') {
  if (!args['confirm-submit']) throw new Error('上传参考图片必须显式提供 --confirm-submit');
  const file = path.resolve(requireValue(args.file, 'upload-image 必须提供 --file'));
  const word = requireValue(args.word, 'upload-image 必须提供 --word');
  const extension = path.extname(file).toLowerCase();
  const contentType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extension];
  if (!contentType) throw new Error('参考图片只支持 PNG、JPEG 和 WebP');
  const site = getSite(args);
  const token = getToken();
  const url = new URL(`${site}/codex-image`);
  url.searchParams.set('date', targetDateKey);
  url.searchParams.set('word', word);
  const data = await requestJson(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: fs.readFileSync(file)
  });
  print({ ok: true, command: 'upload-image', targetDateKey, word, ...data });
  process.exit(0);
}

if (args.command === 'upload-images') {
  const outputDirectory = getOutputDirectory(args, targetDateKey);
  const draftFile = path.resolve(args.draft || path.join(outputDirectory, 'draft.json'));
  const imagesDirectory = path.resolve(args['images-dir'] || path.join(outputDirectory, 'images'));
  const manifestFile = path.resolve(args.manifest || path.join(outputDirectory, 'image-uploads.json'));
  const draft = readJson(draftFile);
  if (cleanDateKey(draft?.targetDateKey) !== targetDateKey) {
    throw new Error(`草稿目标日期与 --date 不一致：${draft?.targetDateKey || 'missing'} != ${targetDateKey}`);
  }
  if (!Array.isArray(draft?.items) || !draft.items.length) throw new Error('草稿缺少可上传图片的 items');
  const storedManifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : {};
  const manifest = storedManifest && typeof storedManifest === 'object' && !Array.isArray(storedManifest)
    ? storedManifest
    : {};
  const pending = getPendingCodexImageItems(draft);
  if (!pending.length) {
    print({
      ok: true,
      command: 'upload-images',
      targetDateKey,
      total: Array.isArray(draft?.items) ? draft.items.length : 0,
      pending: 0,
      uploaded: 0,
      skippedReady: Array.isArray(draft?.items) ? draft.items.length : 0,
      message: '草稿图片均已就绪，无需上传'
    });
    process.exit(0);
  }
  if (!args['confirm-submit']) throw new Error('批量上传参考图片必须显式提供 --confirm-submit');

  const uploadPlan = pending.map(entry => ({
    ...entry,
    file: getBatchImageFile(entry, imagesDirectory, manifest)
  }));
  const missingFiles = uploadPlan.filter(entry => !entry.file);
  if (missingFiles.length) {
    print({
      ok: false,
      command: 'upload-images',
      targetDateKey,
      error: 'LOCAL_IMAGE_MISSING',
      missing: missingFiles.map(entry => ({ order: entry.order, word: entry.word }))
    });
    process.exit(1);
  }

  for (const entry of uploadPlan) {
    const stats = fs.statSync(entry.file);
    if (!stats.isFile() || !stats.size || stats.size > CODEX_BATCH_IMAGE_MAX_BYTES) {
      print({
        ok: false,
        command: 'upload-images',
        targetDateKey,
        error: 'LOCAL_IMAGE_INVALID',
        order: entry.order,
        word: entry.word,
        file: entry.file,
        size: stats.size,
        maxBytes: CODEX_BATCH_IMAGE_MAX_BYTES
      });
      process.exit(1);
    }
  }

  const site = getSite(args);
  const token = getToken();
  const attempts = getPositiveInteger(args.attempts, 3, '--attempts');
  const baseDelayMilliseconds = getPositiveInteger(args['retry-delay-ms'], 1500, '--retry-delay-ms');
  const requiredStorage = String(args['require-storage'] || '').trim();
  let uploaded = 0;

  for (const entry of uploadPlan) {
    const contentType = getCodexImageContentType(entry.file);
    const url = new URL(`${site}/codex-image`);
    url.searchParams.set('date', targetDateKey);
    url.searchParams.set('word', entry.word);
    let data;
    try {
      data = await requestJsonWithRetry(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        body: fs.readFileSync(entry.file)
      }, {
        attempts,
        baseDelayMilliseconds,
        onRetry({ nextAttempt, delayMilliseconds, error }) {
          print({
            ok: false,
            command: 'upload-images',
            targetDateKey,
            status: 'retrying',
            order: entry.order,
            word: entry.word,
            nextAttempt,
            delayMilliseconds,
            httpStatus: Number(error?.status) || null,
            errorCode: error?.data?.error?.code || 'NETWORK_ERROR'
          });
        }
      });
    } catch (error) {
      print({
        ok: false,
        command: 'upload-images',
        targetDateKey,
        status: 'stopped',
        uploaded,
        remaining: uploadPlan.length - uploaded,
        order: entry.order,
        word: entry.word,
        httpStatus: Number(error?.status) || null,
        errorCode: error?.data?.error?.code || 'NETWORK_ERROR',
        message: error.message
      });
      process.exit(1);
    }

    const generatedAt = new Date().toISOString();
    const relativeFile = path.relative(imagesDirectory, entry.file) || path.basename(entry.file);
    applyCodexImageUploadResult(draft, entry.word, data, generatedAt);
    applyCodexImageManifestResult(manifest, entry.word, data, {
      file: relativeFile,
      generatedAt
    });
    writeJson(draftFile, draft);
    writeJson(manifestFile, manifest);
    uploaded += 1;
    print({
      ok: true,
      command: 'upload-images',
      targetDateKey,
      status: 'checkpoint',
      order: entry.order,
      word: entry.word,
      uploaded,
      remaining: uploadPlan.length - uploaded,
      storage: data.storage,
      size: data.size
    });

    if (requiredStorage && data.storage !== requiredStorage) {
      print({
        ok: false,
        command: 'upload-images',
        targetDateKey,
        status: 'stopped',
        error: 'UNEXPECTED_IMAGE_STORAGE',
        expectedStorage: requiredStorage,
        actualStorage: data.storage,
        uploaded,
        word: entry.word
      });
      process.exit(1);
    }
  }

  print({
    ok: true,
    command: 'upload-images',
    targetDateKey,
    total: Array.isArray(draft?.items) ? draft.items.length : 0,
    pending: pending.length,
    uploaded,
    skippedReady: (Array.isArray(draft?.items) ? draft.items.length : 0) - pending.length,
    manifestFile,
    draftFile
  });
  process.exit(0);
}

throw new Error(`未知命令：${args.command}`);

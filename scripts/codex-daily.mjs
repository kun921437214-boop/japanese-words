import fs from 'node:fs';
import path from 'node:path';
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
      'upload-image': '上传 --file 对应的 --word 参考图片，必须额外提供 --confirm-submit'
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

throw new Error(`未知命令：${args.command}`);

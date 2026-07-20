import fs from 'node:fs/promises';
import process from 'node:process';
import { applyPublishedImport } from '../shared/published-import.mjs';
import { cleanStoredWorkflow, mergeWorkflow } from '../shared/workflow-schema.mjs';

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    options[key] = value;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function buildWorkflow(currentInput, records) {
  const current = cleanStoredWorkflow(currentInput);
  const mappedWords = records.map(record => record.word).filter(Boolean);
  const words = [...new Set([...current.words, ...mappedWords])];
  const statuses = { ...current.statuses };
  mappedWords.forEach(word => {
    statuses[word] = 'published';
  });
  return mergeWorkflow(current, {
    ...current,
    words,
    statuses,
    publishedRecords: records,
    updated: new Date().toISOString()
  });
}

async function postImport(endpoint, payload, mode, token = '') {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ ...payload, mode })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `导入请求失败（HTTP ${response.status}）`);
    error.code = data?.error?.code || 'IMPORT_REQUEST_FAILED';
    throw error;
  }
  return data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.payload) throw new Error('请使用 --payload 指定提取后的 JSON');
  const payload = await readJson(options.payload);
  if (options.mappings) payload.wordMappings = await readJson(options.mappings);
  const mode = options.mode === 'commit' ? 'commit' : 'preview';

  if (options.endpoint) {
    const tokenName = String(options['token-env'] || 'PUBLISHED_IMPORT_TOKEN');
    const result = await postImport(options.endpoint, payload, mode, process.env[tokenName] || '');
    process.stdout.write(`${JSON.stringify({
      mode: result.mode,
      batch: result.batch?.id,
      summary: result.summary,
      revision: result.revision
    }, null, 2)}\n`);
    return;
  }

  const current = options.workflow ? await readJson(options.workflow) : {};
  const imported = applyPublishedImport(current, payload, {
    now: options.now ? new Date(options.now) : new Date()
  });
  const workflow = buildWorkflow(current, imported.records);
  if (options.output) {
    await fs.writeFile(options.output, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({
    mode,
    batch: imported.batch.id,
    summary: imported.summary,
    output: options.output || ''
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || error}\n`);
  process.exitCode = 1;
});

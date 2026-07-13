import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const sourcePath = join(projectRoot, 'data', 'words-data.json');
const backupPath = join(projectRoot, 'data', 'deleted-words-backup.json');
const reviewPath = join(projectRoot, 'data', 'library-review.json');
const DEFAULT_AUDIT_ENDPOINT = 'https://jiyimianbao.pages.dev/ai-candidates';
const DEFAULT_WORKFLOW_ENDPOINT = 'https://jiyimianbao.pages.dev/favorites';
const PROTECT_REASON = '用户已进入工作流，禁止自动删除';
const AUDIT_ACTIONS = ['approve', 'keep', 'watch', 'review', 'delete', 'protect'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'review'];
const BUCKETS = ['today', 'meme_fast', 'long_term', 'review', 'deleted'];
const PROMPT_VERSION_BY_ACTION = {
  audit_library_for_delete: 'library-audit-v2',
  audit_missing_library_words: 'library-audit-v2'
};

function parseArgs(argv) {
  return argv.reduce((result, arg) => {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--yes' || arg === '--confirm-delete') result.yes = true;
    else if (arg === '--strict' || arg === '--second-pass') result.strict = true;
    else if (arg.startsWith('--batch-size=')) result.batchSize = Number.parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--limit=')) result.limit = Number.parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--max-retries=')) result.maxRetries = Number.parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--delay-ms=')) result.delayMs = Number.parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--audit-endpoint=')) result.auditEndpoint = arg.slice('--audit-endpoint='.length);
    else if (arg.startsWith('--workflow-endpoint=')) result.workflowEndpoint = arg.slice('--workflow-endpoint='.length);
    else if (arg.startsWith('--workflow-file=')) result.workflowFile = arg.slice('--workflow-file='.length);
    else if (arg.startsWith('--export-requests=')) result.exportRequests = arg.slice('--export-requests='.length);
    else if (arg.startsWith('--responses-dir=')) result.responsesDir = arg.slice('--responses-dir='.length);
    else if (arg.startsWith('--sync-code=')) result.syncCode = arg.slice('--sync-code='.length);
    return result;
  }, {
    dryRun: false,
    yes: false,
    strict: false,
    batchSize: 10,
    limit: 0,
    maxRetries: 2,
    delayMs: 800,
    auditEndpoint: process.env.AI_CANDIDATES_ENDPOINT || DEFAULT_AUDIT_ENDPOINT,
    workflowEndpoint: process.env.WORKFLOW_ENDPOINT || DEFAULT_WORKFLOW_ENDPOINT,
    workflowFile: '',
    exportRequests: '',
    responsesDir: '',
    syncCode: process.env.WORKFLOW_SYNC_CODE || ''
  });
}

function clamp(number, min, max) {
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanWord(value) {
  return cleanText(value, 80);
}

function cleanEnum(value, options, fallback) {
  const cleanValue = cleanText(value, 80);
  return options.includes(cleanValue) ? cleanValue : fallback;
}

function getPromptVersion(action) {
  return PROMPT_VERSION_BY_ACTION[action] || 'library-audit-v2';
}

function cleanTraceText(value, maxLength = 8000) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value, maxLength);
  try {
    return cleanText(JSON.stringify(value), maxLength);
  } catch (error) {
    return '';
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function resolveProjectPath(value) {
  if (!value) return '';
  return resolve(projectRoot, value);
}

function addUrlSyncCode(endpoint, syncCode) {
  if (!syncCode) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('code', syncCode);
  return url.toString();
}

function requestJson(endpoint, payload = null) {
  const curlArgs = ['-L', '-sS', '--connect-timeout', '10', '--max-time', '180'];
  if (payload) {
    curlArgs.push(
      '-X',
      'POST',
      endpoint,
      '-H',
      'Accept: application/json',
      '-H',
      'Content-Type: application/json',
      '--data',
      JSON.stringify(payload)
    );
  } else {
    curlArgs.push(endpoint);
  }
  let raw = '';
  try {
    raw = execFileSync('curl', curlArgs, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' }
    });
  } catch (error) {
    const stderr = cleanText(error?.stderr?.toString?.() || error?.message, 500);
    throw new Error(stderr || '请求 DeepSeek 审核接口失败');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`审核接口返回非 JSON 内容：${cleanText(raw, 300)}`);
  }
}

function collectProtectedWords(workflow) {
  const protectedWords = new Set();
  const add = value => {
    const word = cleanWord(value);
    if (word) protectedWords.add(word);
  };

  asArray(workflow.words).forEach(add);
  Object.entries(workflow.statuses || {}).forEach(([word, status]) => {
    if (['pending', 'published'].includes(status)) add(word);
  });
  asArray(workflow.publishedRecords).forEach(record => add(record?.word));
  asArray(workflow.todaySnapshot?.words).forEach(add);
  Object.entries(workflow.candidatePool || {}).forEach(([kanji, entry]) => {
    if (['ready', 'watch'].includes(cleanText(entry?.manualReviewState, 20))) add(kanji);
    if (['manual', 'manual_keep'].includes(entry?.sourceType)) add(kanji);
  });

  return protectedWords;
}

function simplifyWordForAudit(word) {
  return {
    kanji: cleanText(word.kanji, 80),
    reading: cleanText(word.reading, 120),
    meaning: cleanText(word.meaning, 220),
    category: cleanText(word.category, 80),
    popularity: Number.parseInt(word.popularity, 10) || 0,
    source: cleanText(word.source, 80),
    explanation: cleanText(word.explanation, 180),
    example: cleanText(word.example, 180),
    synonyms: asArray(word.synonyms).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 5)
  };
}

function makeBatches(words, batchSize) {
  const batches = [];
  let current = [];
  let currentLength = 2;
  words.forEach(word => {
    const itemLength = JSON.stringify(simplifyWordForAudit(word)).length + 1;
    if (current.length && (current.length >= batchSize || currentLength + itemLength > 11200)) {
      batches.push(current);
      current = [];
      currentLength = 2;
    }
    current.push(word);
    currentLength += itemLength;
  });
  if (current.length) batches.push(current);
  return batches;
}

function cleanAuditItem(rawItem, originalWord, protectedWords, trace = {}) {
  const kanji = cleanWord(rawItem?.kanji || originalWord?.kanji);
  const isProtected = protectedWords.has(kanji);
  let action = isProtected ? 'protect' : cleanText(rawItem?.auditAction || rawItem?.action || rawItem?.libraryReviewStatus, 80);
  if (action === 'approved') action = 'approve';
  action = isProtected ? 'protect' : cleanEnum(action, AUDIT_ACTIONS, 'review');
  if (action === 'keep' || action === 'watch') action = 'approve';
  return {
    kanji,
    action,
    auditAction: action,
    libraryReviewStatus: action === 'approve' ? 'approved' : action === 'delete' ? 'deleted' : action === 'protect' ? 'protected' : 'review',
    xhsFitScore: clamp(Number.parseInt(rawItem?.xhsFitScore, 10) || 0, 0, 100),
    reason: action === 'protect' ? PROTECT_REASON : cleanText(rawItem?.reason, 800),
    riskLevel: cleanEnum(rawItem?.riskLevel, RISK_LEVELS, 'low'),
    confidenceLevel: cleanEnum(rawItem?.confidenceLevel, CONFIDENCE_LEVELS, action === 'review' ? 'review' : 'medium'),
    suggestedBucket: cleanEnum(rawItem?.suggestedBucket || rawItem?.displayBucket, BUCKETS, action === 'delete' ? 'deleted' : 'long_term'),
    replacementSuggestion: cleanText(rawItem?.replacementSuggestion, 500),
    candidateType: cleanText(rawItem?.candidateType, 80),
    displayBucket: cleanText(rawItem?.displayBucket || rawItem?.suggestedBucket, 80),
    evidenceType: cleanText(rawItem?.evidenceType, 80),
    suggestedAction: cleanText(rawItem?.suggestedAction, 80),
    romaji: cleanText(rawItem?.romaji, 120),
    kana: cleanText(rawItem?.kana, 120),
    meaning: cleanText(rawItem?.meaning, 240),
    category: cleanText(rawItem?.category, 80),
    reviewReasonType: cleanText(rawItem?.reviewReasonType, 80),
    reviewReason: cleanText(rawItem?.reviewReason, 500),
    promptVersion: cleanText(rawItem?.promptVersion || trace.promptVersion || getPromptVersion(trace.action), 80),
    inputHash: cleanText(rawItem?.inputHash || trace.inputHash, 120),
    reviewResult: ['accepted', 'rejected', 'edited'].includes(rawItem?.reviewResult || trace.reviewResult) ? (rawItem?.reviewResult || trace.reviewResult) : '',
    rawOutput: cleanTraceText(trace.rawOutput, 8000),
    normalizedOutput: cleanTraceText(trace.normalizedOutput, 8000)
  };
}

function buildAuditPayload(batch, protectedWords, workflow, options = {}) {
  return {
    action: options.strict ? 'audit_library_for_delete' : 'audit_missing_library_words',
    input: JSON.stringify(batch.map(simplifyWordForAudit)),
    items: batch.map(simplifyWordForAudit),
    rules: {
      deleteIfNotFit: true,
      protectFavorites: true,
      strictSecondPass: Boolean(options.strict),
      approvalThreshold: options.strict ? '只有能独立做成小红书日语词卡、好配图、好标题、账号方向强的词才能 approve；只是常见、只是基础、只是教材、只是普通名词，应 delete 或 review。' : ''
    },
    count: batch.length,
    preferences: {
      includeMemes: true,
      includeHighRisk: 'review_only',
      readingFormat: 'romaji_kana'
    },
    context: {
      auditMode: options.strict ? 'strict_second_pass' : 'standard',
      protectedWords: [...protectedWords].slice(0, 300),
      favorites: asArray(workflow.words).slice(0, 200),
      publishedWords: asArray(workflow.publishedRecords).map(record => record?.word).filter(Boolean).slice(0, 200),
      todayWords: asArray(workflow.todaySnapshot?.words).slice(0, 40),
      existingCandidates: Object.keys(workflow.candidatePool || {}).slice(0, 300)
    }
  };
}

function auditBatch(endpoint, batch, protectedWords, workflow, options = {}) {
  const payload = buildAuditPayload(batch, protectedWords, workflow, options);
  const response = requestJson(endpoint, payload);
  return cleanAuditResponse(response, batch, protectedWords);
}

function cleanAuditResponse(response, batch, protectedWords) {
  if (response?.error) {
    const message = response.error?.message || response.error || 'DeepSeek audit failed';
    throw new Error(message);
  }
  const trace = {
    action: response.usage?.action || '',
    promptVersion: response.usage?.promptVersion || '',
    inputHash: response.usage?.inputHash || '',
    reviewResult: response.usage?.reviewResult || '',
    rawOutput: response.usage?.rawOutput || '',
    normalizedOutput: response.usage?.normalizedOutput || ''
  };
  const returnedItems = new Map(asArray(response.items).map(item => [cleanWord(item.kanji), item]));
  return batch.map(word => cleanAuditItem(returnedItems.get(cleanWord(word.kanji)), word, protectedWords, trace));
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function auditBatchWithRecovery(endpoint, batch, protectedWords, workflow, options, label = '') {
  const maxRetries = clamp(options.maxRetries, 0, 5);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return auditBatch(endpoint, batch, protectedWords, workflow, options);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const waitMs = Math.max(500, clamp(options.delayMs, 0, 5000)) * (attempt + 1);
        console.log(`  - ${label || '当前批次'} 第 ${attempt + 1} 次失败：${cleanText(error.message, 160)}，${waitMs}ms 后重试`);
        await sleep(waitMs);
      }
    }
  }

  if (batch.length > 1) {
    const middle = Math.ceil(batch.length / 2);
    console.log(`  - ${label || '当前批次'} 仍失败，自动拆成 ${middle} + ${batch.length - middle} 个继续审核`);
    const first = await auditBatchWithRecovery(endpoint, batch.slice(0, middle), protectedWords, workflow, options, `${label || '批次'}A`);
    await sleep(Math.max(0, clamp(options.delayMs, 0, 5000)));
    const second = await auditBatchWithRecovery(endpoint, batch.slice(middle), protectedWords, workflow, options, `${label || '批次'}B`);
    return [...first, ...second];
  }

  throw lastError || new Error('DeepSeek audit failed');
}

async function confirmDeletion(actualDeleteCount) {
  if (actualDeleteCount <= 0) return true;
  console.log('');
  console.log('本操作会从 data/words-data.json 中真实删除词条，但会写入 data/deleted-words-backup.json 备份。收藏、待发布、已发布词不会删除。是否继续？');
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('输入 DELETE 继续，其他任意输入取消：');
    return answer.trim() === 'DELETE';
  } finally {
    rl.close();
  }
}

function buildBackup(deletedItems, previousBackup, model, now) {
  const previousItems = asArray(previousBackup.items);
  const previousRuns = asArray(previousBackup.runs);
  const backupItems = deletedItems.map(item => ({
    kanji: item.kanji,
    reason: item.reason,
    deletedAt: now,
    original: item.original
  }));
  return {
    deletedAt: now,
    source: 'deepseek_missing_library_audit',
    model,
    deletedCount: previousItems.length + backupItems.length,
    items: [...previousItems, ...backupItems],
    runs: [
      ...previousRuns,
      {
        deletedAt: now,
        model,
        deletedCount: backupItems.length,
        words: backupItems.map(item => item.kanji)
      }
    ]
  };
}

function formatBatchName(index) {
  return `batch-${String(index + 1).padStart(3, '0')}`;
}

function exportAuditRequests(directory, batches, protectedWords, workflow, options) {
  mkdirSync(directory, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    auditEndpoint: options.auditEndpoint,
    strict: Boolean(options.strict),
    batchCount: batches.length,
    batches: []
  };
  const configLines = [
    'connect-timeout = 10',
    'max-time = 240',
    'silent',
    'show-error'
  ];

  batches.forEach((batch, index) => {
    const name = formatBatchName(index);
    const requestPath = join(directory, `${name}.request.json`);
    const responsePath = join(directory, `${name}.response.json`);
    writeJsonFile(requestPath, buildAuditPayload(batch, protectedWords, workflow, options));
    manifest.batches.push({
      name,
      count: batch.length,
      request: relative(projectRoot, requestPath),
      response: relative(projectRoot, responsePath),
      words: batch.map(word => cleanWord(word.kanji)).filter(Boolean)
    });
    if (index > 0) configLines.push('next');
    configLines.push(`url = "${options.auditEndpoint}"`);
    configLines.push('request = "POST"');
    configLines.push('header = "Accept: application/json"');
    configLines.push('header = "Content-Type: application/json"');
    configLines.push(`data-binary = "@${requestPath}"`);
    configLines.push(`output = "${responsePath}"`);
  });

  writeJsonFile(join(directory, 'manifest.json'), manifest);
  writeFileSync(join(directory, 'curl.config'), `${configLines.join('\n')}\n`, 'utf8');
}

function readAuditResponses(directory, batches, protectedWords) {
  const auditItems = [];
  for (const [index, batch] of batches.entries()) {
    const name = formatBatchName(index);
    const responsePath = join(directory, `${name}.response.json`);
    const response = readJsonFile(responsePath, null);
    if (!response) throw new Error(`缺少响应文件：${relative(projectRoot, responsePath)}`);
    auditItems.push(...cleanAuditResponse(response, batch, protectedWords));
  }
  return auditItems;
}

function printSummary(summary) {
  console.log('');
  console.log('历史种子数据 DeepSeek 补审结果');
  console.log(`- 本次扫描总数：${summary.scannedTotal}`);
  console.log(`- 建议删除数量：${summary.suggestedDeleteCount}`);
  console.log(`- 实际删除数量：${summary.actualDeleteCount}`);
  console.log(`- 受保护数量：${summary.protectCount}`);
  console.log(`- 保留数量：${summary.keepCount}`);
  console.log(`- 观察数量：${summary.watchCount}`);
  console.log(`- 复核数量：${summary.reviewCount}`);
  console.log(`- 备份文件路径：${relative(projectRoot, backupPath)}`);
  if (summary.dryRun) console.log('- 当前为 dry-run，没有修改 data/words-data.json。');
  if (summary.actualDeleteCount > 0 && !summary.dryRun) {
    console.log('历史种子数据已清洗，后续补位只会使用 DeepSeek 审核词。');
  }
}

function writeLibraryReview(auditItems, previousReview, now) {
  const sourceItems = previousReview?.items && !Array.isArray(previousReview.items) ? previousReview.items : {};
  const nextItems = { ...sourceItems };
  auditItems.forEach(item => {
    if (!item.kanji) return;
    nextItems[item.kanji] = {
      ...nextItems[item.kanji],
      kanji: item.kanji,
      auditAction: item.action,
      action: item.action,
      libraryReviewStatus: item.libraryReviewStatus,
      xhsFitScore: item.xhsFitScore,
      reason: item.reason,
      riskLevel: item.riskLevel,
      confidenceLevel: item.confidenceLevel,
      suggestedBucket: item.suggestedBucket,
      displayBucket: item.displayBucket || item.suggestedBucket,
      candidateType: item.candidateType,
      evidenceType: item.evidenceType,
      suggestedAction: item.suggestedAction,
      romaji: item.romaji,
      kana: item.kana,
      meaning: item.meaning,
      category: item.category,
      reviewReasonType: item.reviewReasonType,
      reviewReason: item.reviewReason,
      reviewSource: 'deepseek_library_audit',
      promptVersion: item.promptVersion,
      inputHash: item.inputHash,
      reviewResult: item.reviewResult,
      rawOutput: item.rawOutput,
      normalizedOutput: item.normalizedOutput,
      reviewedAt: now
    };
  });
  return {
    updatedAt: now,
    source: 'deepseek_missing_library_audit',
    items: nextItems
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const batchSize = clamp(options.batchSize, 1, 50);
  options.maxRetries = clamp(options.maxRetries, 0, 5);
  options.delayMs = clamp(options.delayMs, 0, 5000);
  const sourceWords = readJsonFile(sourcePath, []);
  if (!Array.isArray(sourceWords)) throw new Error('data/words-data.json 顶层必须是数组');

  const workflowEndpoint = addUrlSyncCode(options.workflowEndpoint, options.syncCode);
  const workflow = options.workflowFile
    ? readJsonFile(resolveProjectPath(options.workflowFile), {})
    : requestJson(workflowEndpoint);
  const protectedWords = collectProtectedWords(workflow || {});
  const candidateWords = sourceWords
    .filter(word => cleanWord(word?.kanji))
    .slice(0, options.limit > 0 ? options.limit : sourceWords.length);
  const protectedAuditItems = candidateWords
    .filter(word => protectedWords.has(cleanWord(word.kanji)))
    .map(word => cleanAuditItem({ action: 'protect' }, word, protectedWords));
  const auditTargets = candidateWords.filter(word => !protectedWords.has(cleanWord(word.kanji)));
  const batches = makeBatches(auditTargets, batchSize);

  const auditItems = [...protectedAuditItems];
  console.log(`开始${options.strict ? '严格二审' : '审核'}历史种子数据：${candidateWords.length} 个词，保护 ${protectedAuditItems.length} 个，提交 DeepSeek ${auditTargets.length} 个。`);
  if (options.exportRequests) {
    const exportDir = resolveProjectPath(options.exportRequests);
    exportAuditRequests(exportDir, batches, protectedWords, workflow || {}, options);
    console.log(`已导出 ${batches.length} 个审核请求到：${relative(projectRoot, exportDir)}`);
    console.log(`可以运行：curl -L --config ${relative(projectRoot, join(exportDir, 'curl.config'))}`);
    return;
  }
  if (options.responsesDir) {
    const responseDir = resolveProjectPath(options.responsesDir);
    auditItems.push(...readAuditResponses(responseDir, batches, protectedWords));
  } else {
    for (const [index, batch] of batches.entries()) {
      console.log(`- 审核批次 ${index + 1}/${batches.length}：${batch.length} 个词`);
      auditItems.push(...await auditBatchWithRecovery(options.auditEndpoint, batch, protectedWords, workflow || {}, options, `批次 ${index + 1}/${batches.length}`));
      if (options.delayMs > 0 && index < batches.length - 1) await sleep(options.delayMs);
    }
  }

  const byKanji = new Map(auditItems.map(item => [item.kanji, item]));
  const deleteItems = candidateWords
    .map(word => ({ audit: byKanji.get(cleanWord(word.kanji)), original: word }))
    .filter(item => item.audit?.action === 'delete' && !protectedWords.has(cleanWord(item.original.kanji)))
    .map(item => ({ ...item.audit, original: item.original }));

  const counts = auditItems.reduce((result, item) => {
    result[`${item.action}Count`] = (result[`${item.action}Count`] || 0) + 1;
    return result;
  }, {});
  const summary = {
    scannedTotal: candidateWords.length,
    suggestedDeleteCount: counts.deleteCount || 0,
    actualDeleteCount: deleteItems.length,
    protectCount: counts.protectCount || 0,
    keepCount: (counts.approveCount || 0) + (counts.keepCount || 0),
    watchCount: counts.watchCount || 0,
    reviewCount: counts.reviewCount || 0,
    dryRun: options.dryRun
  };

  printSummary(summary);
  if (deleteItems.length) {
    console.log('');
    console.log('建议删除清单：');
    deleteItems.forEach((item, index) => {
      console.log(`${String(index + 1).padStart(2, '0')}. ${item.kanji} - ${item.reason || '无原因'}`);
    });
  }

  if (options.dryRun) return;
  if (!options.yes && !(await confirmDeletion(deleteItems.length))) {
    console.log('已取消删除。');
    return;
  }

  const now = new Date().toISOString();
  const model = cleanText(process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', 120);
  writeJsonFile(reviewPath, writeLibraryReview(auditItems, readJsonFile(reviewPath, { items: {} }), now));

  if (deleteItems.length) {
    const previousBackup = readJsonFile(backupPath, {
      deletedAt: '',
      source: 'deepseek_missing_library_audit',
      model,
      deletedCount: 0,
      items: []
    });
    writeJsonFile(backupPath, buildBackup(deleteItems, previousBackup, model, now));
  }

  const deleteSet = new Set(deleteItems.map(item => item.kanji));
  const remainingWords = sourceWords.filter(word => !deleteSet.has(cleanWord(word.kanji)));
  writeJsonFile(sourcePath, remainingWords);

  const buildResult = spawnSync('npm', ['run', 'build:words'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  if (buildResult.status !== 0) {
    throw new Error('npm run build:words 执行失败，请检查词库 JSON。');
  }
}

main().catch(error => {
  console.error(`❌ ${error.message || error}`);
  process.exit(1);
});

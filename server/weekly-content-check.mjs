import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KV_IMAGE_TTL_SECONDS } from '../functions/codex-image.js';
import {
  CODEX_DAILY_WORD_COUNT,
  getCodexDraftStorageKey,
  validateCodexDailyDraft
} from '../shared/codex-daily-draft.mjs';
import {
  getWeeklyContentHealthStorageKey,
  getWeeklyContentWindow
} from '../shared/weekly-content-health.mjs';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';
import { FileKV } from './file-kv.mjs';

const HEALTH_TTL_SECONDS = 35 * 24 * 60 * 60;
const ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

function cleanAlertUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function parseStoredImageKey(referenceImage = {}, targetDateKey = '') {
  const key = String(referenceImage?.key || '').trim();
  if (!key.startsWith(`codex-daily/${targetDateKey}/`)) return '';
  try {
    const url = new URL(String(referenceImage?.url || ''), 'https://bijinihaitan.cn');
    if (url.origin !== 'https://bijinihaitan.cn' || url.pathname !== '/codex-image') return '';
    return url.searchParams.get('key') === key ? key : '';
  } catch {
    return '';
  }
}

export async function hasStoredReferenceImage(imageKv, key, options = {}) {
  if (!imageKv || typeof imageKv.fileForKey !== 'function' || !key) return false;
  try {
    const fileStats = await stat(imageKv.fileForKey(key));
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    return fileStats.isFile()
      && fileStats.size > 0
      && nowMs - fileStats.mtimeMs < KV_IMAGE_TTL_SECONDS * 1000;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function collectDuplicates(values = []) {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

async function sendWeeklyAlert(alertUrl, record, fetchImpl = fetch) {
  if (!alertUrl) return { configured: false, sent: false, error: '', skipped: true };
  try {
    const response = await fetchImpl(alertUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[japanese-words] 下周整周内容${record.status === 'healthy' ? '恢复' : '异常'}：${record.targetWeekStart} 至 ${record.targetWeekEnd}（${record.reasons.join('；') || '70词/70卡/70图均已就绪'}）`,
        event: 'japanese_words_weekly_content_health',
        status: record.status,
        runWeekStart: record.runWeekStart,
        targetWeekStart: record.targetWeekStart,
        targetWeekEnd: record.targetWeekEnd,
        reasons: record.reasons,
        totals: record.totals,
        checkedAt: record.checkedAt
      }),
      signal: globalThis.AbortSignal?.timeout?.(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { configured: true, sent: true, error: '', skipped: false };
  } catch (error) {
    return {
      configured: true,
      sent: false,
      error: String(error?.message || error).slice(0, 500),
      skipped: false
    };
  }
}

function summarizeDayFailure(day) {
  if (day.valid) return [];
  return day.reasons.map(reason => `${day.targetDateKey}:${reason}`);
}

export async function runWeeklyContentCheck(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const dataDirectory = path.resolve(options.dataDirectory || process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words');
  const workflowKv = options.workflowKv || new FileKV(path.join(dataDirectory, 'workflow-kv'));
  const imageKv = options.imageKv || new FileKV(path.join(dataDirectory, 'reference-images-kv'));
  const validateDraft = options.validateDraft || validateCodexDailyDraft;
  const imageExists = options.imageExists || hasStoredReferenceImage;
  const fetchImpl = options.fetchImpl || fetch;
  const alertUrl = cleanAlertUrl(options.alertUrl ?? process.env.OPS_ALERT_WEBHOOK_URL);
  const window = options.window || getWeeklyContentWindow(now);
  const storageKey = getWeeklyContentHealthStorageKey(window.runWeekStart);
  const previous = await workflowKv.get(storageKey, 'json');

  if (
    previous?.status === 'healthy'
    && previous?.runWeekStart === window.runWeekStart
    && previous?.targetWeekStart === window.targetWeekStart
    && previous?.targetWeekEnd === window.targetWeekEnd
    && Array.isArray(previous?.days)
    && previous.days.length === 7
    && previous.days.every(day => day?.valid)
  ) {
    return { ...previous, skipped: true, skipReason: 'already_verified' };
  }

  const workflow = cleanStoredWorkflow(await workflowKv.get('favorites:global', 'json'));
  const days = [];
  const allWords = [];
  const allClusters = [];

  for (const targetDateKey of window.targetDateKeys) {
    const storedDraft = await workflowKv.get(getCodexDraftStorageKey(targetDateKey), 'json');
    if (!storedDraft) {
      days.push({
        targetDateKey,
        status: 'missing',
        valid: false,
        wordCount: 0,
        cardReadyCount: 0,
        imageReadyCount: 0,
        imageStorageReadyCount: 0,
        errorCount: 1,
        warningCount: 0,
        reasons: ['draft_missing']
      });
      continue;
    }

    const draft = validateDraft(storedDraft, { workflow, expectedDateKey: targetDateKey });
    const errors = Array.isArray(draft?.validation?.errors) ? draft.validation.errors : [];
    const warnings = Array.isArray(draft?.validation?.warnings) ? draft.validation.warnings : [];
    const imageKeys = [];
    for (const item of Array.isArray(draft?.items) ? draft.items : []) {
      const key = item?.aiCard?.referenceImage?.status === 'ready'
        ? parseStoredImageKey(item.aiCard.referenceImage, targetDateKey)
        : '';
      if (key && await imageExists(imageKv, key, { nowMs: now.getTime() })) imageKeys.push(key);
    }
    const reasons = [];
    if (draft.targetDateKey !== targetDateKey) reasons.push('draft_date_mismatch');
    if (draft.status !== 'valid') reasons.push('draft_not_valid');
    if (Number(draft.wordCount) !== CODEX_DAILY_WORD_COUNT) reasons.push('word_count_incomplete');
    if (Number(draft.cardReadyCount) !== CODEX_DAILY_WORD_COUNT) reasons.push('cards_incomplete');
    if (Number(draft.imageReadyCount) !== CODEX_DAILY_WORD_COUNT) reasons.push('images_incomplete');
    if (imageKeys.length !== CODEX_DAILY_WORD_COUNT) reasons.push('image_storage_incomplete');
    if (!draft.validation?.valid) reasons.push('validation_failed');
    if (errors.length) reasons.push('validation_errors');
    if (warnings.length) reasons.push('validation_warnings');
    const auditItems = Array.isArray(draft.validation?.recommendationAudit?.items)
      ? draft.validation.recommendationAudit.items
      : [];
    allWords.push(...(Array.isArray(draft.items) ? draft.items.map(item => item.kanji) : []));
    allClusters.push(...auditItems.map(item => item.semanticClusterKey).filter(Boolean));
    days.push({
      targetDateKey,
      status: String(draft.status || 'draft'),
      valid: reasons.length === 0,
      wordCount: Number(draft.wordCount) || 0,
      cardReadyCount: Number(draft.cardReadyCount) || 0,
      imageReadyCount: Number(draft.imageReadyCount) || 0,
      imageStorageReadyCount: imageKeys.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      reasons
    });
  }

  const crossDayDuplicateWords = collectDuplicates(allWords);
  const crossDayDuplicateClusters = collectDuplicates(allClusters);
  const reasons = days.flatMap(summarizeDayFailure);
  if (crossDayDuplicateWords.length) reasons.push('weekly_duplicate_words');
  if (crossDayDuplicateClusters.length) reasons.push('weekly_duplicate_semantic_clusters');
  const status = days.length === 7
    && days.every(day => day.valid)
    && !crossDayDuplicateWords.length
    && !crossDayDuplicateClusters.length
    ? 'healthy'
    : 'unhealthy';
  const checkedAt = now.toISOString();
  const totals = days.reduce((result, day) => ({
    words: result.words + day.wordCount,
    cards: result.cards + day.cardReadyCount,
    images: result.images + day.imageReadyCount,
    storedImages: result.storedImages + day.imageStorageReadyCount,
    errors: result.errors + day.errorCount,
    warnings: result.warnings + day.warningCount
  }), { words: 0, cards: 0, images: 0, storedImages: 0, errors: 0, warnings: 0 });
  const record = {
    kind: 'weekly-content',
    status,
    runWeekStart: window.runWeekStart,
    targetWeekStart: window.targetWeekStart,
    targetWeekEnd: window.targetWeekEnd,
    checkedAt,
    totals,
    reasons: reasons.slice(0, 30),
    crossDayDuplicateWords: crossDayDuplicateWords.slice(0, 20),
    crossDayDuplicateClusters: crossDayDuplicateClusters.slice(0, 20),
    days
  };
  const previousAttemptMs = Date.parse(String(previous?.lastNotificationAttemptAt || ''));
  const notificationDue = status === 'unhealthy'
    && (previous?.status !== 'unhealthy' || !Number.isFinite(previousAttemptMs) || now.getTime() - previousAttemptMs >= ALERT_COOLDOWN_MS);
  const recoveryDue = status === 'healthy' && previous?.status === 'unhealthy';
  let notification = {
    configured: Boolean(alertUrl),
    sent: false,
    error: '',
    skipped: true
  };
  let lastNotificationAttemptAt = String(previous?.lastNotificationAttemptAt || '');
  if (notificationDue || recoveryDue) {
    notification = await sendWeeklyAlert(alertUrl, record, fetchImpl);
    lastNotificationAttemptAt = checkedAt;
  }
  const storedRecord = {
    ...record,
    previousStatus: String(previous?.status || ''),
    lastNotificationAttemptAt,
    notification
  };
  await workflowKv.put(storageKey, JSON.stringify(storedRecord), {
    expirationTtl: HEALTH_TTL_SECONDS
  });
  return storedRecord;
}

async function main() {
  const result = await runWeeklyContentCheck();
  console.log(JSON.stringify({
    event: result.skipped ? 'weekly_content_check_skipped' : 'weekly_content_check_completed',
    status: result.status,
    runWeekStart: result.runWeekStart,
    targetWeekStart: result.targetWeekStart,
    targetWeekEnd: result.targetWeekEnd,
    totals: result.totals,
    reasons: result.reasons,
    skipped: Boolean(result.skipped)
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(JSON.stringify({
      event: 'weekly_content_check_failed',
      error: String(error?.message || error).slice(0, 500)
    }));
    process.exitCode = 1;
  });
}

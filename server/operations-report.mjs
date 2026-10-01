import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileKV } from './file-kv.mjs';
import { dateKey, addDays } from '../shared/rankings.mjs';
import { getWeeklyContentWindow, getWeeklyContentHealthStorageKey } from '../shared/weekly-content-health.mjs';
import { sendOperationsNotification } from '../shared/operations-alert.mjs';

async function latestBackup(directory) {
  const names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^state-.*-r\d+$/.test(entry.name)).map(entry => entry.name).sort().reverse();
  for (const name of names) {
    try { return JSON.parse(await readFile(path.join(directory, name, 'manifest.json'), 'utf8')); } catch { /* Ignore incomplete backups. */ }
  }
  return null;
}

export async function collectOperationsReport(options = {}) {
  const now = options.now || new Date();
  const today = dateKey(now);
  const kv = options.workflowKv || new FileKV(path.join(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv'));
  const window = getWeeklyContentWindow(now);
  const [workflow, weekly, official] = await Promise.all([
    kv.get('favorites:global', 'json'), kv.get(getWeeklyContentHealthStorageKey(window.runWeekStart), 'json'),
    kv.get(`operations-health:published:official-import:${today}`, 'json')
  ]);
  const backup = options.backup !== undefined ? options.backup : await latestBackup(process.env.JAPANESE_WORDS_BACKUP_DIR || '/var/backups/japanese-words').catch(() => null);
  const snapshot = workflow?.todaySnapshot || {};
  const words = Array.isArray(snapshot.words) ? snapshot.words : [];
  const cards = words.filter(word => workflow?.candidatePool?.[word]?.aiCard?.cardStatus === 'ready').length;
  const images = words.filter(word => workflow?.candidatePool?.[word]?.aiCard?.referenceImage?.status === 'ready').length;
  const problems = [];
  if (snapshot.dateKey !== today || words.length !== 10 || cards !== 10 || images !== 10) problems.push('today_content_incomplete');
  const weeklyDue = now >= new Date(`${addDays(window.runWeekStart, 1)}T14:40:00+08:00`);
  const weeklyStatus = ['healthy', 'unhealthy'].includes(weekly?.status) ? weekly.status : weeklyDue ? 'unverified' : 'pending';
  if (['unhealthy', 'unverified'].includes(weeklyStatus)) problems.push('next_week_not_verified');
  const officialDue = now >= new Date(`${today}T13:20:00+08:00`);
  const officialStatus = official?.status === 'verified' ? 'verified' : officialDue ? 'missing_or_failed' : 'pending';
  if (officialStatus === 'missing_or_failed') problems.push('official_export_not_verified_today');
  const backupDue = now >= new Date(`${today}T15:10:00+08:00`);
  const backupToday = Number.isFinite(Date.parse(backup?.createdAt)) && dateKey(new Date(backup.createdAt)) === today;
  if (!backup || (backupDue && !backupToday)) problems.push('backup_not_current');
  return {
    dateKey: today, checkedAt: now.toISOString(), status: problems.length ? 'attention' : 'healthy', problems,
    today: { dateKey: String(snapshot.dateKey || ''), words: words.length, cards, images, source: ['codex_draft', 'deepseek', 'candidatePool'].includes(snapshot.source) ? snapshot.source : 'other' },
    weekly: { status: weeklyStatus, targetWeekStart: window.targetWeekStart, targetWeekEnd: window.targetWeekEnd },
    published: { status: officialStatus, lastVerifiedAt: official?.status === 'verified' ? String(official?.checkedAt || '') : '', error: /^[A-Z][A-Z0-9_]{1,70}$/.test(official?.error || '') ? official.error : '' },
    backup: { createdAt: String(backup?.createdAt || ''), revision: Number(backup?.revision) || 0, current: backupToday },
    revision: Number(workflow?.revision) || 0
  };
}

export async function runOperationsReport(options = {}) {
  const report = await collectOperationsReport(options);
  if (!options.send) return report;
  const kv = options.workflowKv || new FileKV(path.join(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv'));
  const key = `operations-health:report:${report.dateKey}`;
  const digest = createHash('sha256').update(JSON.stringify({ ...report, checkedAt: '' })).digest('hex');
  const previous = await kv.get(key, 'json');
  if (previous?.digest === digest && previous?.notification?.sent) return { ...report, skipped: true };
  const labels = { today_content_incomplete: '当天日期/词卡图片未齐', next_week_not_verified: '下周整周验收未通过', official_export_not_verified_today: '当天官方数据未成功提交并读回', backup_not_current: '当天备份未完成或不可读取' };
  const text = `[japanese-words] ${report.dateKey} 每日汇总：${report.status === 'healthy' ? '通过' : '需处理'}\n今天 ${report.today.words}词/${report.today.cards}卡/${report.today.images}图；来源 ${report.today.source}\n下周 ${report.weekly.targetWeekStart}–${report.weekly.targetWeekEnd}：${report.weekly.status}\n官方数据：${report.published.status} ${report.published.error}\n备份：${report.backup.createdAt || '未知'}；revision ${report.revision}\n${report.problems.map(problem => labels[problem] || problem).join('；') || '各项检查通过'}\n排查：对应 japanese-words systemd 服务日志。`;
  const notification = await sendOperationsNotification(options.env || process.env, { text, event: 'japanese_words_daily_report' }, options);
  await kv.put(key, JSON.stringify({ ...report, digest, notification }), { expirationTtl: 35 * 86400 });
  return { ...report, notification };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--send')) throw new Error('invalid_argument');
  const result = await runOperationsReport({ send: process.argv.includes('--send') });
  console.log(JSON.stringify({ event: 'operations_report', ...result }));
  if (result.notification && !result.notification.sent && !result.skipped) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ event: 'operations_report_failed', error: 'report_runtime_failed' })); process.exitCode = 1; });
}

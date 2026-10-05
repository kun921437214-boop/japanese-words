import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileKV } from './file-kv.mjs';
import { dateKey, addDays } from '../shared/rankings.mjs';
import { getWeeklyContentWindow, getWeeklyContentHealthStorageKey } from '../shared/weekly-content-health.mjs';
import { getCodexDraftStorageKey } from '../shared/codex-daily-draft.mjs';
import { sendOperationsNotification } from '../shared/operations-alert.mjs';

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
}

function recordedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function summarizeTomorrow(draft, health, today, now) {
  const targetDateKey = addDays(today, 1);
  const dueAt = `${today}T17:15:00+08:00`;
  const matchingDraft = draft?.targetDateKey === targetDateKey;
  const items = matchingDraft && Array.isArray(draft.items) ? draft.items : null;
  const counts = items ? {
    words: items.length,
    cards: items.filter(item => item?.aiCard?.cardStatus === 'ready').length,
    images: items.filter(item => item?.aiCard?.referenceImage?.status === 'ready' && item.aiCard.referenceImage.url).length
  } : { words: null, cards: null, images: null };
  const checkedMs = Date.parse(health?.checkedAt || '');
  const updatedMs = Date.parse(draft?.updatedAt || '');
  const currentCheck = Number.isFinite(checkedMs) && checkedMs <= now.getTime()
    && dateKey(new Date(checkedMs)) === today && health?.targetDateKey === targetDateKey
    && (!Number.isFinite(updatedMs) || updatedMs <= checkedMs);
  const matchesCounts = items && counts.words === count(health?.wordCount)
    && counts.cards === count(health?.cardReadyCount) && counts.images === count(health?.imageReadyCount);
  const complete = items && counts.words === 10 && counts.cards === 10 && counts.images === 10;
  let status = 'unverified';
  if (now < new Date(dueAt)) status = 'pending';
  else if (currentCheck && health?.status === 'unhealthy') status = 'failed';
  else if (currentCheck && health?.status === 'healthy' && matchesCounts && complete
    && ['valid', 'published'].includes(draft.status) && draft.validation?.valid === true) status = 'verified';
  return { targetDateKey, ...counts, status, dueAt,
    checkedAt: currentCheck ? String(health.checkedAt) : '', countsKnown: Boolean(items) };
}

function reportPriority(problems = [], pending = false) {
  const failures = ['today_content_incomplete', 'next_week_check_failed', 'official_import_failed', 'tomorrow_check_failed'];
  if (problems.some(problem => failures.includes(problem))) return 'action';
  if (problems.length) return 'verify';
  return pending ? 'waiting' : 'clear';
}

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
  const tomorrowDateKey = addDays(today, 1);
  const [workflow, weekly, official, tomorrowDraft, tomorrowHealth] = await Promise.all([
    kv.get('favorites:global', 'json'), kv.get(getWeeklyContentHealthStorageKey(window.runWeekStart), 'json'),
    kv.get(`operations-health:published:official-import:${today}`, 'json'),
    kv.get(getCodexDraftStorageKey(tomorrowDateKey), 'json'),
    kv.get(`operations-health:daily:tomorrow-draft:${tomorrowDateKey}`, 'json')
  ]);
  const backup = options.backup !== undefined ? options.backup : await latestBackup(process.env.JAPANESE_WORDS_BACKUP_DIR || '/var/backups/japanese-words').catch(() => null);
  const snapshot = workflow?.todaySnapshot || {};
  const words = Array.isArray(snapshot.words) ? snapshot.words : [];
  const cards = words.filter(word => workflow?.candidatePool?.[word]?.aiCard?.cardStatus === 'ready').length;
  const images = words.filter(word => workflow?.candidatePool?.[word]?.aiCard?.referenceImage?.status === 'ready').length;
  const problems = [];
  if (snapshot.dateKey !== today || words.length !== 10 || cards !== 10 || images !== 10) problems.push('today_content_incomplete');
  const weeklyDue = now >= new Date(`${addDays(window.runWeekStart, 1)}T14:40:00+08:00`);
  const matchingWeek = (!weekly?.targetWeekStart || weekly.targetWeekStart === window.targetWeekStart)
    && (!weekly?.targetWeekEnd || weekly.targetWeekEnd === window.targetWeekEnd);
  const weeklyStatus = matchingWeek && ['healthy', 'unhealthy'].includes(weekly?.status) ? weekly.status : weeklyDue ? 'unverified' : 'pending';
  if (weeklyStatus === 'unhealthy') problems.push('next_week_check_failed');
  if (weeklyStatus === 'unverified') problems.push('next_week_not_verified');
  const officialDue = now >= new Date(`${today}T13:20:00+08:00`);
  const officialStatus = official?.status === 'verified' ? 'verified'
    : official?.status === 'failed' ? 'failed' : officialDue ? 'unverified' : 'pending';
  if (officialStatus === 'failed') problems.push('official_import_failed');
  if (officialStatus === 'unverified') problems.push('official_export_not_verified_today');
  const tomorrow = summarizeTomorrow(tomorrowDraft, tomorrowHealth, today, now);
  if (tomorrow.status === 'failed') problems.push('tomorrow_check_failed');
  if (tomorrow.status === 'unverified') problems.push('tomorrow_check_not_confirmed');
  const backupDue = now >= new Date(`${today}T15:10:00+08:00`);
  const backupMs = Date.parse(backup?.createdAt || '');
  const backupToday = Number.isFinite(backupMs) && backupMs <= now.getTime() && dateKey(new Date(backupMs)) === today;
  const backupStatus = backupToday ? 'verified' : backupDue ? 'unverified' : 'pending';
  if (backupStatus === 'unverified') problems.push('backup_not_current');
  const pending = [weeklyStatus, officialStatus, tomorrow.status, backupStatus].includes('pending');
  return {
    dateKey: today, checkedAt: now.toISOString(), status: problems.length ? 'attention' : 'healthy',
    priority: reportPriority(problems, pending), problems,
    today: { dateKey: String(snapshot.dateKey || ''), words: words.length, cards, images, source: ['codex_draft', 'deepseek', 'candidatePool'].includes(snapshot.source) ? snapshot.source : 'other' },
    tomorrow,
    weekly: { status: weeklyStatus, targetWeekStart: window.targetWeekStart, targetWeekEnd: window.targetWeekEnd,
      totals: matchingWeek && weekly?.totals && [weekly.totals.words, weekly.totals.cards, weekly.totals.storedImages].every(value => recordedCount(value) !== null)
        ? { words: count(weekly.totals.words), cards: count(weekly.totals.cards), images: count(weekly.totals.storedImages) } : null,
      days: matchingWeek && Array.isArray(weekly?.days) ? weekly.days.filter(day => window.targetDateKeys.includes(day.targetDateKey)).map(day => ({
        dateKey: day.targetDateKey, valid: day.valid === true, words: recordedCount(day.wordCount), cards: recordedCount(day.cardReadyCount), images: recordedCount(day.imageStorageReadyCount)
      })) : [] },
    published: { status: officialStatus, lastVerifiedAt: official?.status === 'verified' ? String(official?.checkedAt || '') : '', error: /^[A-Z][A-Z0-9_]{1,70}$/.test(official?.error || '') ? official.error : '' },
    backup: { createdAt: String(backup?.createdAt || ''), revision: Number(backup?.revision) || 0, current: backupToday, status: backupStatus },
    revision: Number(workflow?.revision) || 0
  };
}

function chineseDate(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : '日期尚未确认';
}

function beijingTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}年${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`;
}

function materials(counts) {
  return `${count(counts.words)}个词、${count(counts.cards)}张词卡、${count(counts.images)}张配图`;
}

export function formatOperationsReport(report) {
  const priority = report.priority || reportPriority(report.problems);
  const headline = { action: '有内容需要处理', verify: '有结果需要核实', waiting: '按计划等待检查', clear: '已记录的检查通过' }[priority];
  const today = report.today || {};
  const tomorrow = report.tomorrow || { targetDateKey: addDays(report.dateKey, 1), status: 'unverified', countsKnown: false };
  const weekly = report.weekly || {};
  const published = report.published || {};
  const backup = report.backup || {};
  const next = [];
  const lines = [`日语词每日汇总｜${chineseDate(report.dateKey)}`, `今日状态：${headline}`, '',
    `一、今日内容（${chineseDate(report.dateKey)}）`];
  if (today.dateKey === report.dateKey) {
    lines.push(`已保存：${materials(today)}。`);
    if (today.words !== 10 || today.cards !== 10 || today.images !== 10) next.push('补齐今日缺少的词、词卡或配图，再检查内容。');
  } else {
    lines.push(`尚未确认今日内容；当前保存的是${chineseDate(today.dateKey)}的素材（${materials(today)}）。`);
    next.push('先确认今日内容日期，再补齐今日的词、词卡和配图。');
  }
  lines.push('数量按保存记录统计；词卡内容与配图外观的质检需另行确认。', '这里统计的是素材准备情况，不代表已在小红书发布。', '',
    `二、明日内容（${chineseDate(tomorrow.targetDateKey)}）`,
    tomorrow.countsKnown ? `已保存：${materials(tomorrow)}。` : '尚未找到可核对的明日素材，数量尚未确认。');
  if (tomorrow.status === 'pending') lines.push('待检查：尚未到今日北京时间17:15的例行检查时间。');
  else if (tomorrow.status === 'verified') lines.push(`内容检查已通过（北京时间${beijingTime(tomorrow.checkedAt)}）；配图外观质检需另行确认。`);
  else if (tomorrow.status === 'failed') {
    lines.push('检查未通过：已保存的检查结果明确记录了问题。');
    next.push('检查明日草稿的内容与缺项，修正后重新质检。');
  } else {
    lines.push('尚未确认：缺少与当前明日素材一致的有效检查结果。');
    next.push('核实今日17:15的明日内容检查结果；先确认问题，再补缺项或修正草稿。');
  }
  lines.push('', `三、下周准备（${chineseDate(weekly.targetWeekStart)}至${chineseDate(weekly.targetWeekEnd)}）`);
  if (weekly.status === 'healthy') {
    lines.push(weekly.totals ? `已保存：${materials(weekly.totals)}；整周检查已通过。` : '整周已有检查通过记录，具体素材数量未记录。');
    lines.push('整周检查未发现内容缺项；配图外观质检需另行确认。');
  } else if (weekly.status === 'pending') lines.push('待检查：尚未到本周二北京时间14:40的整周检查时间。');
  else if (weekly.status === 'unhealthy') {
    lines.push('整周检查未通过，需要补齐缺项或修正内容。');
    for (const day of weekly.days || []) {
      if (day.valid) continue;
      const missing = [['words', '个词'], ['cards', '张词卡'], ['images', '张可读取配图']]
        .filter(([key]) => day[key] !== null && day[key] < 10).map(([key, unit]) => `${10 - day[key]}${unit}`);
      const detail = [day.words, day.cards, day.images].every(value => value !== null)
        ? '数量已齐，内容或去重检查需修正' : '具体缺项尚未记录，需核对检查结果';
      lines.push(`${chineseDate(day.dateKey)}：${missing.length ? `还缺${missing.join('、')}` : detail}。`);
    }
    next.push('补齐下周缺项，修正内容或重复选题，再做整周检查。');
  } else {
    lines.push('尚未确认：未找到本轮下周整周检查的有效结果。');
    next.push('核实下周整周检查结果，再确认是否需要补内容。');
  }
  lines.push('', '四、待处理与下一步', '小红书官方数据同步：');
  if (published.status === 'verified') lines.push(`已同步，并核对了保存结果${beijingTime(published.lastVerifiedAt) ? `（北京时间${beijingTime(published.lastVerifiedAt)}）` : ''}。`);
  else if (published.status === 'failed') {
    lines.push('本次同步未通过：导入或保存后的核对出现了实测问题。');
    next.unshift('先排查本次官方数据同步问题，修复后重新预览、保存并核对结果。');
  } else if (published.status === 'pending') lines.push('待同步：尚未到今日北京时间13:20的计划同步时间。');
  else {
    lines.push('待核实：未找到今日同步完成的确认记录；这不能证明同步失败，也不影响此前已保存的数据。');
    next.unshift('先核实今日官方数据是否已同步；确认未同步后，再从官方后台导出、预览导入并核对保存结果。');
  }
  const backupStatus = backup.status || (backup.current ? 'verified' : 'unverified');
  if (backupStatus === 'unverified') next.push('核实今日备份是否已完成并可读取。');
  lines.push(...(next.length ? next.map((item, index) => `${index + 1}. ${item}`) : ['暂无已确认的问题；发布素材前仍需核对词卡内容与配图外观。']));
  lines.push('', '五、备份');
  const time = beijingTime(backup.createdAt);
  if (backupStatus === 'verified') lines.push(`今日备份已保存：北京时间${time}。`);
  else if (backupStatus === 'pending') lines.push('待确认：今日备份计划北京时间15:00执行，15:10后核对完成记录。');
  else lines.push('待核实：未找到今日成功保存的备份记录，尚不能确认失败原因。');
  if (backupStatus !== 'verified' && time) lines.push(`最近一次备份：北京时间${time}。`);
  return lines.join('\n');
}

export async function runOperationsReport(options = {}) {
  const report = await collectOperationsReport(options);
  if (!options.send) return report;
  const kv = options.workflowKv || new FileKV(path.join(process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv'));
  const key = `operations-health:report:${report.dateKey}`;
  const digest = createHash('sha256').update(JSON.stringify({ ...report, checkedAt: '' })).digest('hex');
  const previous = await kv.get(key, 'json');
  if (previous?.digest === digest && previous?.notification?.sent) return { ...report, skipped: true };
  const text = formatOperationsReport(report);
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

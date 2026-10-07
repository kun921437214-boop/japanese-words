import { createHash } from 'node:crypto';
import { open, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FileKV } from './file-kv.mjs';

const OWNER = 'japanese-words-production';
export const FOLLOWUP_STATE_KEY = `operations-followup:owner:${OWNER}`;
const TYPE_BY_PROBLEM = Object.freeze({
  today_content_incomplete: 'today-content',
  tomorrow_check_failed: 'tomorrow-content',
  tomorrow_check_not_confirmed: 'tomorrow-verification',
  next_week_not_verified: 'weekly-verification',
  official_import_failed: 'official-import',
  official_export_not_verified_today: 'official-export-verification',
  backup_not_current: 'backup-verification'
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function followupIssueKey(targetDateKey, type) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateKey) || !/^[a-z][a-z-]{2,60}$/.test(type)) throw new Error('INVALID_FOLLOWUP_IDENTITY');
  return `${targetDateKey}:${type}`;
}

export function collectFollowupIssues(report) {
  if (!report || report.status === 'healthy' || !Array.isArray(report.problems) || !report.problems.length) return [];
  const issues = [];
  const add = (date, type, details, urgency = 'routine') => {
    issues.push({ key: followupIssueKey(date, type), targetDateKey: date, type, urgency, details });
  };
  for (const problem of report.problems) {
    if (problem === 'next_week_check_failed') {
      const failed = (report.weekly?.days || []).filter(day => !day.valid);
      if (!failed.length) add(report.weekly.targetWeekStart, 'weekly-content', { status: 'unhealthy', countsUnknown: true });
      for (const day of failed) {
        const missing = Object.fromEntries(['words', 'cards', 'images'].map(key => [key,
          typeof day[key] === 'number' && Number.isFinite(day[key]) ? Math.max(0, 10 - day[key]) : null]));
        add(day.dateKey, 'weekly-content', { missing, reasons: day.reasons || [], countsUnknown: Object.values(missing).includes(null) });
      }
      continue;
    }
    const type = TYPE_BY_PROBLEM[problem];
    if (!type) {
      add(report.dateKey, 'unclassified-issue', { reason: 'unrecognized_report_problem' });
      continue;
    }
    const date = type.startsWith('tomorrow-') ? report.tomorrow.targetDateKey
      : type.startsWith('weekly-') ? report.weekly.targetWeekStart : report.dateKey;
    const details = type === 'today-content' ? { ...report.today }
      : type.startsWith('tomorrow-') ? { ...report.tomorrow, checkedAt: '' }
      : type.startsWith('weekly-') ? { ...report.weekly }
      : type.startsWith('official-') ? { status: report.published?.status, error: report.published?.error || '' }
      : { status: report.backup?.status, createdAt: report.backup?.createdAt || '' };
    add(date, type, details, type === 'today-content' ? 'urgent' : 'routine');
  }
  return [...new Map(issues.map(issue => [issue.key, issue])).values()];
}

function directory(options) {
  // Existing workflow KV backup/restore already copies every namespace. No new data root.
  return path.resolve(options.followupDirectory || options.workflowKv?.directory
    || path.join(options.dataDirectory || process.env.JAPANESE_WORDS_DATA_DIR || '/var/lib/japanese-words', 'workflow-kv'));
}

async function withOwnerLock(options, callback) {
  const root = directory(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'owner.lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { status: 'not_dispatched', reason: 'owner_lock_busy', dispatched: false }; throw error; }
  try {
    await handle.writeFile(JSON.stringify({ owner: OWNER, pid: process.pid, createdAt: new Date().toISOString() }));
    return await callback(root);
  } finally { await handle.close(); await unlink(lock); }
}

async function load(root) {
  const raw = await new FileKV(root).get(FOLLOWUP_STATE_KEY);
  if (raw === null) return { version: 1, owner: OWNER, issues: {}, receipts: [] };
  const state = JSON.parse(raw);
  if (state.version !== 1 || state.owner !== OWNER || !state.issues || !Array.isArray(state.receipts)) throw new Error('FOLLOWUP_STATE_INVALID');
  return state;
}

async function save(root, state) {
  await new FileKV(root).put(FOLLOWUP_STATE_KEY, JSON.stringify(state));
}

const SCOPE = Object.freeze({
  safeActions: ['read_project_state', 'write_isolated_content_drafts', 'review_cards_and_images', 'rerun_read_only_checks'],
  requireExistingApproval: ['save_production_content', 'publish_code', 'deploy_release'],
  humanBoundaries: ['password_or_QR_or_OAuth_login', 'new_credentials_or_persistent_access', 'server_security_changes', 'new_high_risk_approval'],
  forbiddenActions: ['parallel_content_producer', 'private_session_or_unregistered_API', 'paid_AI_API_substitute', 'disable_timers_or_global_alerts', 'unapproved_production_mutation']
});

/** No network/default scheduler. An official, authorized Codex owner queue must supply this boundary.
 * submitToOwner MUST atomically append to the existing owner task or create exactly one task,
 * and persist requestId idempotently even across transport timeout and server restart.
 */
export async function reconcileOperationsFollowup(report, options = {}) {
  const issues = collectFollowupIssues(report);
  if (!issues.length) return { status: 'not_required', reason: 'no_issues', dispatched: false, issueCount: 0 };
  return withOwnerLock(options, async root => {
    const state = await load(root);
    const checkedAt = report.checkedAt;
    for (const issue of issues) {
      const previous = state.issues[issue.key];
      const fingerprint = hash(issue);
      const episode = (previous?.episode || 1) + (previous?.status === 'resolved' ? 1 : 0);
      const unchanged = previous?.fingerprint === fingerprint && previous.status !== 'resolved';
      state.issues[issue.key] = { ...previous, ...issue, fingerprint, episode,
        firstSeenAt: previous?.firstSeenAt || checkedAt, lastSeenAt: checkedAt,
        status: unchanged ? previous.status : 'pending',
        requestId: unchanged ? previous.requestId : hash({ owner: OWNER, key: issue.key, episode, fingerprint }) };
    }
    // Persist findings before trying a dispatcher. Feishu delivery is a separate receipt.
    await save(root, state);
    const pending = Object.values(state.issues).filter(issue => !['accepted', 'resolved'].includes(issue.status));
    if (!pending.length) return { status: 'already_dispatched', dispatched: true, issueCount: issues.length, taskIds: [...new Set(issues.map(issue => state.issues[issue.key].taskId).filter(Boolean))] };
    const scheduler = options.codexScheduler;
    if (!scheduler || scheduler.kind !== 'supported_codex' || scheduler.authorized !== true
      || scheduler.atomicOwnerQueue !== true || scheduler.durableIdempotency !== true || typeof scheduler.submitToOwner !== 'function') {
      const receipt = { status: 'not_dispatched', dispatched: false, reason: 'supported_codex_scheduler_unavailable', checkedAt,
        issueCount: issues.length, pendingIssueCount: pending.length };
      state.receipts.push(receipt); await save(root, state); return receipt;
    }
    const requestId = hash({ owner: OWNER, requests: pending.map(issue => issue.requestId).sort() });
    const request = { owner: OWNER, requestId, project: 'japanese-words', issues: pending.map(issue => ({ ...issue })), scope: SCOPE,
      instruction: '逐项核实日报问题，在已有授权范围内修复；同一owner已有任务时追加，不能启动并发生产。优先完成下周内容。修复后重新读取当前数据验收，提交任务结果与复验回执；登录、凭据、新持续权限和未批准生产动作列为人工边界。' };
    let receipt;
    try {
      const result = await scheduler.submitToOwner(request);
      if (result?.accepted !== true || result.requestId !== requestId || !['created', 'appended'].includes(result.mode)
        || typeof result.taskId !== 'string' || !result.taskId.trim()) throw new Error('DISPATCH_NOT_ACKNOWLEDGED');
      receipt = { status: 'dispatched', dispatched: true, requestId, taskId: result.taskId, mode: result.mode, checkedAt, issueCount: pending.length };
      for (const issue of pending) state.issues[issue.key] = { ...issue, status: 'accepted', taskId: result.taskId, dispatchReceipt: receipt };
    } catch {
      // Ambiguous transport failures keep the SAME request identity for safe retry.
      receipt = { status: 'not_dispatched', dispatched: false, requestId, reason: 'codex_dispatch_not_confirmed', checkedAt, issueCount: pending.length };
    }
    state.receipts.push(receipt); await save(root, state); return receipt;
  });
}

/** Recheck must read the live project; the official scheduler must authenticate the task receipt. */
export async function verifyOperationsFollowupResult(taskReceipt, options = {}) {
  const scheduler = options.codexScheduler;
  if (!scheduler || scheduler.kind !== 'supported_codex' || scheduler.authorized !== true
    || typeof scheduler.verifyTaskReceipt !== 'function' || typeof options.recheck !== 'function') {
    return { status: 'not_verified', reason: 'supported_codex_result_or_recheck_unavailable', resolved: false };
  }
  if (!(await scheduler.verifyTaskReceipt(taskReceipt))) return { status: 'not_verified', reason: 'task_receipt_not_authenticated', resolved: false };
  return withOwnerLock(options, async root => {
    const state = await load(root);
    const accepted = Object.values(state.issues).filter(issue => issue.status === 'accepted' && issue.taskId === taskReceipt.taskId);
    if (!accepted.length) return { status: 'not_verified', reason: 'task_has_no_accepted_issues', resolved: false };
    const report = await options.recheck();
    const checkTime = Date.parse(report?.checkedAt || '');
    const completionTime = Date.parse(taskReceipt.completedAt || '');
    if (!Number.isFinite(checkTime) || !Number.isFinite(completionTime) || checkTime < completionTime || checkTime > Date.now() + 1000
      || !Array.isArray(report?.problems) || !['healthy', 'attention'].includes(report?.status)
      || (report.status === 'healthy' && report.problems.length)) {
      return { status: 'not_verified', reason: 'fresh_post_repair_check_required', resolved: false };
    }
    const remaining = new Set(collectFollowupIssues(report).map(issue => issue.key));
    const resolvedKeys = [];
    const blocked = taskReceipt.outcome !== 'repaired' || (Array.isArray(taskReceipt.humanBlockers) && taskReceipt.humanBlockers.length);
    if (!blocked) {
      for (const issue of accepted) {
        const sameWindow = issue.type.startsWith('weekly-') ? issue.targetDateKey >= report.weekly?.targetWeekStart && issue.targetDateKey <= report.weekly?.targetWeekEnd
          : issue.type.startsWith('tomorrow-') ? issue.targetDateKey === report.tomorrow?.targetDateKey : issue.targetDateKey === report.dateKey;
        if (sameWindow && !remaining.has(issue.key)) {
          state.issues[issue.key] = { ...issue, status: 'resolved', resolvedAt: report.checkedAt, taskResult: taskReceipt };
          resolvedKeys.push(issue.key);
        }
      }
    }
    const receipt = { status: blocked ? 'human_action_required' : resolvedKeys.length === accepted.length ? 'verified' : 'verification_failed',
      taskId: taskReceipt.taskId, checkedAt: report.checkedAt, resolved: resolvedKeys.length === accepted.length && !blocked,
      resolvedKeys, remainingKeys: accepted.map(issue => issue.key).filter(key => !resolvedKeys.includes(key)),
      humanBlockers: (taskReceipt.humanBlockers || []).filter(item => typeof item === 'string').map(item => item.slice(0, 200)) };
    state.receipts.push(receipt); await save(root, state); return receipt;
  });
}

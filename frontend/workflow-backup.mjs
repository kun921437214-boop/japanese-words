export const MAX_WORKFLOW_BACKUP_BYTES = 10 * 1024 * 1024;

function requireWorkflowCleaner(cleanWorkflow) {
  if (typeof cleanWorkflow !== 'function') throw new TypeError('工作流清理器不可用');
  return cleanWorkflow;
}

export function buildWorkflowBackup(workflow = {}, options = {}) {
  return requireWorkflowCleaner(options.cleanWorkflow)(workflow);
}

export function parseWorkflowBackupText(text, options = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('备份根节点必须是 JSON 对象');
  }
  return requireWorkflowCleaner(options.cleanWorkflow)(raw);
}

export function formatWorkflowBackupSummary(workflow = {}) {
  const favoriteCount = Array.isArray(workflow.words) ? workflow.words.length : 0;
  const candidateCount = workflow.candidatePool && typeof workflow.candidatePool === 'object' && !Array.isArray(workflow.candidatePool)
    ? Object.keys(workflow.candidatePool).length
    : 0;
  const publishedCount = Array.isArray(workflow.publishedRecords) ? workflow.publishedRecords.length : 0;
  const todayCount = Array.isArray(workflow.todaySnapshot?.words) ? workflow.todaySnapshot.words.length : 0;
  return `选题 ${favoriteCount} 个、候选 ${candidateCount} 个、发布记录 ${publishedCount} 条、今日推荐 ${todayCount} 个`;
}

export function serializeWorkflowBackup(workflow = {}) {
  return JSON.stringify(workflow, null, 2);
}

export function getWorkflowBackupFilename(dateKey) {
  return `japanese-words-workflow-backup-${String(dateKey || '').trim()}.json`;
}

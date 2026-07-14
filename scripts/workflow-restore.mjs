import fs from 'node:fs';
import path from 'node:path';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';

const args = process.argv.slice(2);
const fileArg = args.find(argument => !argument.startsWith('--'));
const apply = args.includes('--apply');
const confirmed = args.includes('--confirm=RESTORE');
const endpoint = String(process.env.WORKFLOW_ENDPOINT || '').trim();
const token = String(process.env.ADMIN_API_TOKEN || '').trim();

if (!fileArg) throw new Error('用法：npm run restore:workflow -- <backup.json> [--apply --confirm=RESTORE]');
if (!endpoint || !token) throw new Error('必须显式设置 WORKFLOW_ENDPOINT 和 ADMIN_API_TOKEN');

const file = path.resolve(fileArg);
const stats = fs.statSync(file);
if (!stats.isFile() || stats.size > 10 * 1024 * 1024) throw new Error('备份文件不存在或超过 10 MB');
const backup = cleanStoredWorkflow(JSON.parse(fs.readFileSync(file, 'utf8')));

const response = await fetch(endpoint, {
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
});
if (!response.ok) throw new Error(`当前 workflow 读取失败（HTTP ${response.status}）`);
const current = cleanStoredWorkflow(await response.json());
const summary = {
  mode: apply ? 'apply' : 'dry-run',
  currentRevision: current.revision,
  current: {
    favorites: current.words.length,
    candidates: Object.keys(current.candidatePool).length,
    published: current.publishedRecords.length
  },
  backup: {
    favorites: backup.words.length,
    candidates: Object.keys(backup.candidatePool).length,
    published: backup.publishedRecords.length
  }
};
console.log(JSON.stringify(summary, null, 2));

if (!apply) {
  console.log('dry-run 完成，没有写入远程数据。');
  process.exit(0);
}
if (!confirmed) throw new Error('正式恢复必须同时提供 --apply --confirm=RESTORE');

const { revision: _backupRevision, auditLog: _backupAuditLog, ...restorePayload } = backup;
const operationId = `restore-${crypto.randomUUID()}`;
const restoreResponse = await fetch(endpoint, {
  method: 'PUT',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Operation-Id': operationId,
    'X-Workflow-Revision': String(current.revision)
  },
  body: JSON.stringify(restorePayload)
});
const result = await restoreResponse.json().catch(() => ({}));
if (!restoreResponse.ok) {
  const message = result?.error?.message || `HTTP ${restoreResponse.status}`;
  throw new Error(`恢复失败：${message}`);
}
console.log(JSON.stringify({ ok: true, operationId, revision: result.revision }, null, 2));

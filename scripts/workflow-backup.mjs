import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanStoredWorkflow } from '../shared/workflow-schema.mjs';

const endpoint = String(process.env.WORKFLOW_ENDPOINT || '').trim();
const token = String(process.env.ADMIN_API_TOKEN || '').trim();
const publicRead = process.argv.includes('--public-read');
if (!endpoint || (!token && !publicRead)) {
  throw new Error('必须显式设置 WORKFLOW_ENDPOINT 和 ADMIN_API_TOKEN；公开只读环境可改用 --public-read');
}

const outputDirectory = path.resolve(process.env.WORKFLOW_BACKUP_DIR || 'exports/workflow-backups');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
try {
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal: controller.signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`备份读取失败（HTTP ${response.status}）`);
  const workflow = cleanStoredWorkflow(JSON.parse(text));
  const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
  const digest = createHash('sha256').update(serialized).digest('hex');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(outputDirectory, `workflow-${timestamp}-r${workflow.revision}.json`);
  fs.writeFileSync(target, serialized, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    file: target,
    revision: workflow.revision,
    favoriteCount: workflow.words.length,
    candidateCount: Object.keys(workflow.candidatePool).length,
    sha256: digest
  }, null, 2));
} finally {
  clearTimeout(timeout);
}

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function runWrangler(args) {
  const root = process.cwd();
  const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(wranglerBin)) {
    console.error('Pinned Wrangler is missing. Run npm ci before deployment.');
    return 1;
  }

  const logPath = join(root, '.wrangler', 'logs');
  mkdirSync(logPath, { recursive: true });
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: logPath }
  });
  return typeof result.status === 'number' ? result.status : 1;
}

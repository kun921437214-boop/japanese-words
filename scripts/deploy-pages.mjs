import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WRANGLER_ARGS = ['pages', 'deploy', 'dist', '--project-name', 'jiyimianbao', '--branch', 'main'];

function run(command, args) {
  const logPath = join(process.cwd(), '.wrangler', 'logs');
  mkdirSync(logPath, { recursive: true });
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: logPath
    }
  });
  return typeof result.status === 'number' ? result.status : 1;
}

const wranglerBin = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!existsSync(wranglerBin)) {
  console.error('Pinned Wrangler is missing. Run npm ci before deployment.');
  process.exit(1);
}
process.exit(run(process.execPath, [wranglerBin, ...WRANGLER_ARGS]));

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WRANGLER_ARGS = ['deploy', '--config', 'wrangler.worker.toml'];

function compareVersions(a, b) {
  const left = String(a).split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function findCachedWranglerV3() {
  const npxCacheDir = join(homedir(), '.npm', '_npx');
  if (!existsSync(npxCacheDir)) return null;
  const candidates = [];
  for (const cacheName of readdirSync(npxCacheDir)) {
    const packagePath = join(npxCacheDir, cacheName, 'node_modules', 'wrangler', 'package.json');
    if (!existsSync(packagePath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (!String(pkg.version || '').startsWith('3.')) continue;
      const binPath = join(npxCacheDir, cacheName, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
      if (existsSync(binPath)) candidates.push({ version: pkg.version, binPath });
    } catch (error) {
      // Ignore broken cache entries and continue looking.
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] || null;
}

function run(command, args) {
  const logPath = join(process.cwd(), '.wrangler', 'logs');
  const dnsFallbackPath = join(process.cwd(), 'scripts', 'node-dns-fallback.cjs');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${dnsFallbackPath}`].filter(Boolean).join(' ');
  mkdirSync(logPath, { recursive: true });
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      WRANGLER_LOG_PATH: logPath
    }
  });
  return typeof result.status === 'number' ? result.status : 1;
}

const cachedWrangler = findCachedWranglerV3();

if (cachedWrangler) {
  console.log(`Using cached wrangler ${cachedWrangler.version}`);
  process.exit(run(process.execPath, [cachedWrangler.binPath, ...WRANGLER_ARGS]));
}

console.log('Cached wrangler v3 not found. Falling back to npx with the project npm registry.');
process.exit(run('npx', ['-y', 'wrangler@3', ...WRANGLER_ARGS]));

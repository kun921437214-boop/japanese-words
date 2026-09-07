import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { FileKV } from '../server/file-kv.mjs';
import { LocalWorkflowCoordinator } from '../server/local-coordinator.mjs';
import { dispatchPagesFunction, handleWebRequest, matchesSchedule } from '../server/tencent-runtime.mjs';

const execFileAsync = promisify(execFile);

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-tencent-'));
  const workflow = new FileKV(path.join(root, 'workflow'));
  const images = new FileKV(path.join(root, 'images'));
  return {
    FAVORITES: workflow,
    REFERENCE_IMAGES_KV: images,
    WORKFLOW_COORDINATOR: new LocalWorkflowCoordinator(workflow),
    ALLOW_PUBLIC_APP: 'true',
    SITE_URL: 'https://bijinihaitan.cn',
    ALLOWED_ORIGINS: 'https://bijinihaitan.cn'
  };
}

test('FileKV preserves JSON, binary metadata, listing, and TTL behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-kv-'));
  const kv = new FileKV(root);
  await kv.put('favorites:global', JSON.stringify({ words: ['モヤる'] }));
  assert.deepEqual(await kv.get('favorites:global', 'json'), { words: ['モヤる'] });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await kv.put('codex-daily/example.webp', bytes, { metadata: { contentType: 'image/webp' } });
  const image = await kv.getWithMetadata('codex-daily/example.webp', { type: 'arrayBuffer' });
  assert.deepEqual([...new Uint8Array(image.value)], [...bytes]);
  assert.equal(image.metadata.contentType, 'image/webp');
  assert.deepEqual((await kv.list({ prefix: 'favorites:' })).keys.map(item => item.name), ['favorites:global']);
  await kv.put('temporary', 'value', { expirationTtl: 0.001 });
  await new Promise(resolve => {
    setTimeout(resolve, 10);
  });
  assert.equal(await kv.get('temporary'), null);
});

test('local coordinator serializes concurrent favorite commands', async () => {
  const env = await makeEnv();
  const add = word => handleWebRequest(new Request('https://bijinihaitan.cn/favorites', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://bijinihaitan.cn',
      'Sec-Fetch-Site': 'same-origin',
      'X-Operation-Id': `test-${encodeURIComponent(word)}`
    },
    body: JSON.stringify({ action: 'add', word })
  }), env);
  const responses = await Promise.all([add('モヤる'), add('気まずい')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  await Promise.all(responses.map(response => response.arrayBuffer()));
  const stored = await env.FAVORITES.get('favorites:global', 'json');
  assert.deepEqual(new Set(stored.words), new Set(['モヤる', '気まずい']));
  assert.equal(stored.revision, 2);
});

test('Tencent runtime dispatches existing API handlers', async () => {
  const env = await makeEnv();
  const health = await handleWebRequest(new Request('https://bijinihaitan.cn/healthz'), env);
  const body = await health.json();
  assert.equal(health.status, 200);
  assert.equal(body.storageConfigured, true);
  assert.equal(body.workflowCoordinatorConfigured, true);
  assert.equal(body.dailyOperations.todaySnapshot.status, 'unknown');
  assert.equal(body.dailyOperations.tomorrowDraft.status, 'unknown');
  const missing = await handleWebRequest(new Request('https://bijinihaitan.cn/unknown'), env);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();

  const coverKey = `published-covers/v1/${'a'.repeat(32)}`;
  await env.REFERENCE_IMAGES_KV.put(coverKey, new Uint8Array([1, 2, 3]), {
    metadata: { contentType: 'image/webp' }
  });
  const cover = await handleWebRequest(new Request(`https://bijinihaitan.cn/published-cover?key=${coverKey}`), env);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('Content-Type'), 'image/webp');
  assert.equal((await cover.arrayBuffer()).byteLength, 3);

  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 120, b: 140 } }
  }).png().toBuffer();
  await env.REFERENCE_IMAGES_KV.put(coverKey, png, { metadata: { contentType: 'image/png' } });
  const thumbnail = await handleWebRequest(new Request(`https://bijinihaitan.cn/published-cover?key=${coverKey}&variant=thumb`), env);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('Content-Type'), 'image/webp');
  assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);
  const thumbnailKey = `published-cover-thumbs/v1/${'a'.repeat(32)}.webp`;
  assert.ok((await env.REFERENCE_IMAGES_KV.getWithMetadata(thumbnailKey, { type: 'arrayBuffer' })).value.byteLength > 0);
});

test('Tencent runtime exposes waitUntil so long Pages jobs return before background completion', async () => {
  const env = await makeEnv();
  let releaseBackground;
  const background = new Promise(resolve => {
    releaseBackground = resolve;
  });
  let trackedBackground;
  const response = await dispatchPagesFunction(({ waitUntil }) => {
    waitUntil(background);
    return Response.json({ ok: true, queued: true });
  }, new Request('https://bijinihaitan.cn/healthz'), env, {
    waitUntil(promise) {
      trackedBackground = promise;
    }
  });
  assert.deepEqual(await response.json(), { ok: true, queued: true });
  assert.ok(trackedBackground instanceof Promise);
  let settled = false;
  void trackedBackground.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseBackground();
  await trackedBackground;
  assert.equal(settled, true);
});

test('Tencent scheduler matches the existing UTC cron definitions', () => {
  assert.equal(matchesSchedule('30 6 * * *', new Date('2026-07-20T06:30:00Z')), true);
  assert.equal(matchesSchedule('30 6 * * *', new Date('2026-07-20T06:29:00Z')), false);
  assert.equal(matchesSchedule('5,25,45 * * * *', new Date('2026-07-20T09:25:00Z')), true);
  assert.equal(matchesSchedule('10,20,30,40,50 16 * * *', new Date('2026-07-20T16:40:00Z')), true);
  assert.equal(matchesSchedule('15 9 * * *', new Date('2026-07-20T09:15:00Z')), true);
  assert.equal(matchesSchedule('10 16 * * *', new Date('2026-07-20T16:10:00Z')), true);
});

test('Tencent installer changes into the resolved repository before relative installs', async () => {
  const installer = await readFile(new URL('../server/install-runtime.sh', import.meta.url), 'utf8');
  const changeDirectoryAt = installer.indexOf('cd "${repo_root}"');
  assert.ok(changeDirectoryAt > 0);
  assert.ok(changeDirectoryAt < installer.indexOf('install -m 0600 server/tencent.env.example'));
  assert.ok(changeDirectoryAt < installer.indexOf('npm ci'));
  assert.match(installer, /\/var\/lib\/letsencrypt\/\.well-known\/acme-challenge/);
});

test('Tencent Node 22 upgrade is pinned, explicit, backed up, and reversible', async () => {
  const upgrader = await readFile(new URL('../server/upgrade-node-runtime.sh', import.meta.url), 'utf8');
  const runtimeOverride = await readFile(new URL('../server/systemd/japanese-words-node22.conf', import.meta.url), 'utf8');
  const backupOverride = await readFile(new URL('../server/systemd/japanese-words-backup-node22.conf', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const nodeVersion = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim();
  assert.equal(nodeVersion, '22.23.1');
  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.match(upgrader, /--confirm=UPGRADE_NODE_22/);
  assert.match(upgrader, /Runtime validation requires --expected-commit=<full Git hash>/);
  assert.match(upgrader, /--expected-commit=<full Git hash>/);
  assert.match(upgrader, /flock -n 9/);
  assert.match(upgrader, /node_version="22\.23\.1"/);
  assert.match(upgrader, /node_release="node-v\$\{node_version\}-linux-x64"/);
  assert.match(upgrader, /9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578/);
  assert.match(upgrader, /sha256sum/);
  assert.match(upgrader, /git -C "\$\{app_dir\}" worktree add --detach/);
  assert.match(upgrader, /npm run lint/);
  assert.match(upgrader, /npm run typecheck/);
  assert.match(upgrader, /npm test/);
  assert.match(upgrader, /import\('\.\/server\/tencent-runtime\.mjs'\)/);
  assert.match(upgrader, /node server\/tencent-backup\.mjs/);
  assert.match(upgrader, /Production health check failed under Node/);
  assert.match(upgrader, /automatic runtime rollback did not restore local health/);
  assert.match(upgrader, /rollback/);
  assert.match(runtimeOverride, /ExecStart=\/opt\/japanese-words\/runtime\/node-current\/bin\/node server\/tencent-runtime\.mjs/);
  assert.match(backupOverride, /ExecStart=\/opt\/japanese-words\/runtime\/node-current\/bin\/node server\/tencent-backup\.mjs/);
});

test('Tencent Production deploy is explicit, guarded, backed up, and self-checking', async () => {
  const deployer = await readFile(new URL('../server/deploy-production.sh', import.meta.url), 'utf8');
  assert.match(deployer, /--confirm=DEPLOY/);
  assert.match(deployer, /git status --porcelain/);
  assert.match(deployer, /git ls-remote --exit-code origin/);
  assert.match(deployer, /http\.version=HTTP\/1\.1/);
  assert.match(deployer, /fetch --no-tags --prune origin/);
  assert.match(deployer, /git bundle verify/);
  assert.match(deployer, /git bundle list-heads/);
  assert.match(deployer, /official GitHub release bundle/);
  assert.match(deployer, /--expected-commit=<full Git hash>/);
  assert.match(deployer, /--allow-dependency-lock-sha256 requires --expected-commit=<full Git hash>/);
  assert.match(deployer, /Allowed dependency lock SHA-256 must be a full lowercase 64-character hash/);
  assert.match(deployer, /Fetched target does not match --expected-commit/);
  assert.match(deployer, /git merge-base --is-ancestor/);
  assert.match(deployer, /git diff --quiet .*package-lock\.json/);
  assert.match(deployer, /git show "\$\{target_commit\}:package-lock\.json"/);
  assert.match(deployer, /sha256sum/);
  assert.match(deployer, /Target package-lock\.json does not match --allow-dependency-lock-sha256/);
  assert.match(deployer, /Reviewed dependency lock change approved/);
  assert.match(deployer, /JAPANESE_WORDS_NODE_BIN_DIR/);
  assert.match(deployer, /export PATH="\$\{node_runtime_bin\}:\$\{PATH\}"/);
  assert.match(deployer, /git worktree add --detach/);
  assert.match(deployer, /npm run lint/);
  assert.match(deployer, /npm run typecheck/);
  assert.match(deployer, /npm test/);
  assert.match(deployer, /node server\/tencent-backup\.mjs/);
  assert.match(deployer, /git merge --ff-only/);
  assert.match(deployer, /systemctl restart japanese-words\.service/);
  assert.match(deployer, /https:\/\/bijinihaitan\.cn\/healthz/);
  assert.match(deployer, /git -C "\$\{app_dir\}" reset --hard "\$\{current_commit\}"/);
});

test('Tencent staging exposes public files from a private mktemp directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-staging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, 'release');
  const staged = await mkdtemp(path.join(root, 'staged-'));
  await mkdir(path.join(release, 'dist'), { recursive: true });
  await writeFile(path.join(release, 'dist', 'app.js'), 'reviewed app\n', { mode: 0o644 });
  assert.equal((await stat(staged)).mode & 0o777, 0o700);
  const deployer = await readFile(new URL('../server/deploy-production.sh', import.meta.url), 'utf8');
  const stage = deployer.slice(deployer.indexOf('cp -a '), deployer.indexOf('echo "Creating a complete workflow'));
  await execFileAsync('bash', ['-c', 'set -eu\nrelease_dir=$1\nstaged_dist=$2\n' + stage, 'staging', release, staged]);
  assert.equal((await stat(staged)).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(staged, 'app.js'), 'utf8'), 'reviewed app\n');
});

test('Tencent release acceptance checks real health JSON and the served artifact', async t => {
  const deployer = await readFile(new URL('../server/deploy-production.sh', import.meta.url), 'utf8');
  const checks = deployer.slice(deployer.indexOf('healthy=false\n'), deployer.indexOf('\ninstall -d -m 0700'));
  const healthy = JSON.stringify({ ok: true, storageConfigured: true, workflowCoordinatorConfigured: true, imageStorageConfigured: true });
  const cases = [
    { name: 'healthy release needs two consecutive passes', body: healthy, asset: 'reviewed app', readable: '1', accepts: true },
    { name: 'redirect HTML cannot report success', body: '<html>301 Moved Permanently</html>', asset: 'reviewed app', readable: '1' },
    { name: 'unhealthy JSON triggers rollback', body: '{"ok":false}', asset: 'reviewed app', readable: '1' },
    { name: 'inaccessible static files trigger rollback', body: healthy, asset: 'reviewed app', readable: '0' },
    { name: 'old served JavaScript triggers rollback', body: healthy, asset: 'old app', readable: '1' }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-acceptance-'));
      try {
        await mkdir(path.join(root, 'dist'));
        await writeFile(path.join(root, 'dist', 'app.js'), 'reviewed app');
        await writeFile(path.join(root, 'served.js'), fixture.asset);
        const harness = [
          'set -euo pipefail', 'app_dir=$1', 'release_dir=$1',
          'systemctl() { return 0; }', 'sleep() { :; }', 'rollback() { printf "ROLLED_BACK\\n"; }',
          'curl() {',
          '  local output="" url=""',
          '  while [[ $# -gt 0 ]]; do',
          '    case "$1" in --output) output="$2"; shift ;; https://*) url="$1" ;; esac',
          '    shift',
          '  done',
          '  case "$url" in',
          '    */healthz) printf "health\\n" >> "$app_dir/checks"; printf "%s" "$JW_HEALTH_BODY" ;;',
          '    */app.js) printf "app\\n" >> "$app_dir/checks"; [[ "$JW_ASSET_READABLE" = 1 ]] || return 22; cp "$app_dir/served.js" "$output" ;;',
          '    *) return 22 ;;',
          '  esac',
          '}',
          checks,
          'printf "ACCEPTED\\n"'
        ].join('\n');
        let result;
        try {
          result = await execFileAsync('bash', ['-c', harness, 'release-check', root], {
            env: { ...process.env, JW_HEALTH_BODY: fixture.body, JW_ASSET_READABLE: fixture.readable }
          });
        } catch (error) {
          result = error;
        }
        assert.equal(result.code || 0, fixture.accepts ? 0 : 1);
        assert.match(result.stdout, fixture.accepts ? /ACCEPTED/ : /ROLLED_BACK/);
        if (fixture.accepts) assert.equal(await readFile(path.join(root, 'checks'), 'utf8'), 'health\napp\nhealth\napp\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('GitHub publishes a credential-free fallback bundle for Tencent Production', async () => {
  const workflow = await readFile(new URL('../.github/workflows/tencent-deploy-bundle.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /permissions:\n  contents: write/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git bundle create japanese-words-production\.bundle HEAD/);
  assert.match(workflow, /git bundle verify japanese-words-production\.bundle/);
  assert.match(workflow, /gh release upload tencent-deploy-channel/);
  assert.match(workflow, /--clobber/);
});

test('Tencent fallback bundle imports the exact reviewed HEAD into a remote-tracking ref', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-deploy-bundle-'));
  const repository = path.join(root, 'source');
  const bundle = path.join(root, 'production.bundle');
  const bareRepository = path.join(root, 'receiver.git');
  await mkdir(repository);
  await execFileAsync('git', ['init'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.name', 'Tencent deploy test'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'deploy-test@example.invalid'], { cwd: repository });
  await writeFile(path.join(repository, 'release.txt'), 'reviewed release\n');
  await execFileAsync('git', ['add', 'release.txt'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'reviewed release'], { cwd: repository });
  const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const expectedHead = headOutput.trim();
  await execFileAsync('git', ['bundle', 'create', bundle, 'HEAD'], { cwd: repository });
  await execFileAsync('git', ['bundle', 'verify', bundle], { cwd: repository });
  await execFileAsync('git', ['init', '--bare', bareRepository]);
  await execFileAsync('git', [
    '--git-dir', bareRepository,
    'fetch', '--no-tags', bundle,
    'HEAD:refs/remotes/origin/production'
  ]);
  const { stdout: importedOutput } = await execFileAsync('git', [
    '--git-dir', bareRepository,
    'rev-parse', 'refs/remotes/origin/production'
  ]);
  assert.equal(importedOutput.trim(), expectedHead);
});

test('production import restores the runtime data owner after a root import', async () => {
  const importer = await readFile(new URL('../server/import-cloudflare-backup.mjs', import.meta.url), 'utf8');
  assert.match(importer, /JAPANESE_WORDS_DATA_OWNER/);
  assert.match(importer, /dataDirectory === path\.resolve\('\/var\/lib\/japanese-words'\)/);
  assert.match(importer, /if \(dataOwner\) await setTreeOwner\(dataDirectory, dataOwner\)/);
});

test('Nginx keeps the ACME challenge reachable before and after HTTPS cutover', async () => {
  const httpConfig = await readFile(new URL('../server/nginx/japanese-words-http.conf', import.meta.url), 'utf8');
  const httpsConfig = await readFile(new URL('../server/nginx/japanese-words-https.conf', import.meta.url), 'utf8');
  for (const config of [httpConfig, httpsConfig]) {
    assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//);
    assert.match(config, /root \/var\/lib\/letsencrypt/);
  }
});

test('Nginx serves browser modules with a JavaScript MIME type', async () => {
  const httpConfig = await readFile(new URL('../server/nginx/japanese-words-http.conf', import.meta.url), 'utf8');
  const httpsConfig = await readFile(new URL('../server/nginx/japanese-words-https.conf', import.meta.url), 'utf8');
  for (const config of [httpConfig, httpsConfig]) {
    assert.match(config, /location ~\* \\.mjs\$/);
    assert.match(config, /default_type application\/javascript/);
  }
});

test('Nginx compresses text responses and revalidates unhashed browser code', async () => {
  const httpConfig = await readFile(new URL('../server/nginx/japanese-words-http.conf', import.meta.url), 'utf8');
  const httpsConfig = await readFile(new URL('../server/nginx/japanese-words-https.conf', import.meta.url), 'utf8');
  for (const config of [httpConfig, httpsConfig]) {
    assert.match(config, /gzip on;/);
    assert.match(config, /gzip_types[^;]*application\/json/);
    assert.match(config, /location ~\* \\\.\(\?:css\|js\)\$/);
    assert.match(config, /add_header Cache-Control "no-cache" always;/);
    assert.match(config, /location = \/published-cover/);
    assert.match(config, /proxy_buffering on;/);
    assert.match(config, /open_file_cache max=1000/);
  }
});

test('Tencent backup bundles workflow keys, Codex drafts, images, and restores them locally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'japanese-words-backup-'));
  const dataDirectory = path.join(root, 'data');
  const backupDirectory = path.join(root, 'backups');
  const restoreDirectory = path.join(root, 'restore');
  const workflowKv = new FileKV(path.join(dataDirectory, 'workflow-kv'));
  const imageKv = new FileKV(path.join(dataDirectory, 'reference-images-kv'));
  await workflowKv.put('favorites:global', JSON.stringify({
    words: ['胸をなで下ろす'],
    revision: 7,
    candidatePool: {},
    publishedRecords: []
  }));
  await workflowKv.put('codex-draft:global:2026-07-21', JSON.stringify({
    targetDateKey: '2026-07-21',
    status: 'valid',
    wordCount: 10
  }));
  await imageKv.put('codex-daily/2026-07-21/example.webp', new Uint8Array([4, 3, 2, 1]), {
    metadata: { contentType: 'image/webp' }
  });

  await execFileAsync(process.execPath, [fileURLToPath(new URL('../server/tencent-backup.mjs', import.meta.url))], {
    env: {
      ...process.env,
      JAPANESE_WORDS_DATA_DIR: dataDirectory,
      JAPANESE_WORDS_BACKUP_DIR: backupDirectory
    }
  });
  const bundleName = (await readdir(backupDirectory)).find(name => name.startsWith('state-'));
  assert.ok(bundleName);
  const bundleDirectory = path.join(backupDirectory, bundleName);
  const manifest = JSON.parse(await readFile(path.join(bundleDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.codexDraftCount, 1);
  assert.equal(manifest.referenceImageCount, 1);

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../server/import-cloudflare-backup.mjs', import.meta.url)),
    bundleDirectory,
    `--data-dir=${restoreDirectory}`,
    '--apply',
    '--confirm=IMPORT'
  ]);
  const restoredWorkflowKv = new FileKV(path.join(restoreDirectory, 'workflow-kv'));
  const restoredImageKv = new FileKV(path.join(restoreDirectory, 'reference-images-kv'));
  assert.equal((await restoredWorkflowKv.get('favorites:global', 'json')).revision, 7);
  assert.equal((await restoredWorkflowKv.get('codex-draft:global:2026-07-21', 'json')).status, 'valid');
  const restoredImage = await restoredImageKv.getWithMetadata('codex-daily/2026-07-21/example.webp', { type: 'arrayBuffer' });
  assert.deepEqual([...new Uint8Array(restoredImage.value)], [4, 3, 2, 1]);
  assert.equal(restoredImage.metadata.contentType, 'image/webp');
});

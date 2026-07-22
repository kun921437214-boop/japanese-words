import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'words-data.js', 'sync-config.js', '_headers'];
const directories = ['assets'];
const moduleDirectories = ['frontend'];
const sharedModules = [
  'daily-config.mjs',
  'workflow-schema.mjs',
  'published-import.mjs',
  'published-refresh.mjs',
  'xiaohongshu-url.mjs'
];
const publicAssetExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
for (const directory of directories) {
  const sourceRoot = path.join(root, directory);
  fs.cpSync(sourceRoot, path.join(output, directory), {
    recursive: true,
    filter(source) {
      const stats = fs.lstatSync(source);
      if (stats.isSymbolicLink()) return false;
      return stats.isDirectory() || publicAssetExtensions.has(path.extname(source).toLowerCase());
    }
  });
}
for (const directory of moduleDirectories) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
}
fs.mkdirSync(path.join(output, 'shared'), { recursive: true });
for (const moduleName of sharedModules) {
  fs.copyFileSync(
    path.join(root, 'shared', moduleName),
    path.join(output, 'shared', moduleName)
  );
}
fs.mkdirSync(path.join(output, 'data'), { recursive: true });
fs.copyFileSync(path.join(root, 'data', 'library-review.json'), path.join(output, 'data', 'library-review.json'));

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(absolutePath);
    return /\.(?:m?js)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function assertLocalModuleImportsExist(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const targetPath = path.resolve(path.dirname(filePath), match[1]);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Missing deployment module: ${path.relative(output, targetPath)} (imported by ${path.relative(output, filePath)})`);
    }
  }
}

for (const filePath of listJavaScriptFiles(output)) assertLocalModuleImportsExist(filePath);

const forbidden = ['.env', '.git', 'docs', 'scripts', 'worker', 'account-intelligence', 'deleted-words-backup.json'];
for (const item of forbidden) {
  if (fs.existsSync(path.join(output, item))) throw new Error(`Forbidden deployment artifact: ${item}`);
}

console.log(`static build completed: ${output}`);

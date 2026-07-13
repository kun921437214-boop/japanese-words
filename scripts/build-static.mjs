import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'words-data.js', 'sync-config.js', '_headers'];
const directories = ['assets'];
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
fs.mkdirSync(path.join(output, 'data'), { recursive: true });
fs.copyFileSync(path.join(root, 'data', 'library-review.json'), path.join(output, 'data', 'library-review.json'));

const forbidden = ['.env', '.git', 'docs', 'scripts', 'worker', 'shared', 'account-intelligence', 'deleted-words-backup.json'];
for (const item of forbidden) {
  if (fs.existsSync(path.join(output, item))) throw new Error(`Forbidden deployment artifact: ${item}`);
}

console.log(`static build completed: ${output}`);

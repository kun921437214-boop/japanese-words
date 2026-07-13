import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['functions', 'shared', 'worker', 'scripts'];
const extensions = ['.js', '.mjs', '.cjs'];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(target);
    return extensions.includes(path.extname(entry.name)) ? [target] : [];
  });
}

function resolveImport(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [base, ...extensions.map(extension => `${base}${extension}`)];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

const files = roots.flatMap(directory => walk(path.join(root, directory)));
const graph = new Map(files.map(file => [file, []]));
const importPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)['"]([^'"]+)['"]/g;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const dependency = resolveImport(file, match[1]);
    if (dependency && graph.has(dependency)) graph.get(file).push(dependency);
  }
}

const visiting = new Set();
const visited = new Set();

function visit(file, stack = []) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file].map(item => path.relative(root, item));
    throw new Error(`Circular dependency: ${cycle.join(' -> ')}`);
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) || []) visit(dependency, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);
console.log(`cycle check passed (${files.length} modules)`);

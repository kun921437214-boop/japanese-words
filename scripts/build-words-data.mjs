import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'data', 'words-data.json');
const frontendTargetPath = path.join(projectRoot, 'words-data.js');
const sharedTargetPath = path.join(projectRoot, 'shared', 'words-data.mjs');
const DEFAULT_DATE = new Date().toISOString().slice(0, 10);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function normalizeWord(word, index) {
  const item = word && typeof word === 'object' && !Array.isArray(word) ? { ...word } : null;
  if (!item) fail(`第 ${index + 1} 条词不是对象`);

  const kanji = String(item.kanji || '').trim();
  const reading = String(item.reading || '').trim();
  const meaning = String(item.meaning || '').trim();
  const category = String(item.category || '').trim();
  const example = String(item.example || '').trim();
  const popularity = Number(item.popularity);

  if (!kanji) fail(`第 ${index + 1} 条词缺少 kanji`);
  if (!reading) fail(`词「${kanji}」缺少 reading`);
  if (!meaning) fail(`词「${kanji}」缺少 meaning`);
  if (!category) fail(`词「${kanji}」缺少 category`);
  if (!Number.isFinite(popularity)) fail(`词「${kanji}」的 popularity 不是数字`);
  if (!Array.isArray(item.synonyms)) fail(`词「${kanji}」的 synonyms 必须是数组`);
  if (!example) fail(`词「${kanji}」缺少 example`);

  return {
    ...item,
    kanji,
    reading,
    meaning,
    category,
    popularity,
    source: String(item.source || '').trim(),
    cover: String(item.cover || '').trim(),
    explanation: String(item.explanation || '').trim(),
    synonyms: item.synonyms.map(value => String(value ?? '').trim()),
    example,
    status: String(item.status || 'approved').trim() || 'approved',
    createdAt: String(item.createdAt || DEFAULT_DATE).trim() || DEFAULT_DATE,
    updatedAt: String(item.updatedAt || DEFAULT_DATE).trim() || DEFAULT_DATE,
    sourceType: (() => {
      const sourceType = String(item.sourceType || '').trim();
      if (sourceType === 'manual') return 'manual_keep';
      if (sourceType === 'deepseek_generated' || sourceType === 'manual_keep') return sourceType;
      return 'deepseek_reviewed';
    })(),
    verified: typeof item.verified === 'boolean' ? item.verified : false
  };
}

function validateUniqueKanji(words) {
  const seen = new Map();
  for (const [index, word] of words.entries()) {
    if (seen.has(word.kanji)) {
      fail(`发现重复 kanji：「${word.kanji}」出现在第 ${seen.get(word.kanji) + 1} 条和第 ${index + 1} 条`);
    }
    seen.set(word.kanji, index);
  }
}

function buildFrontendContent(words) {
  const payload = JSON.stringify(words, null, 2);
  return `// AUTO-GENERATED FILE. DO NOT EDIT.\n// Source: data/words-data.json (historical seed data only; candidatePool is the unified candidate store; aiCard is the only formal word-card source)\nvar ALL_WORDS = ${payload};\nif (typeof window !== 'undefined') {\n  window.ALL_WORDS = ALL_WORDS;\n}\n`;
}

function buildSharedContent(words) {
  const payload = JSON.stringify(words, null, 2);
  return `// AUTO-GENERATED FILE. DO NOT EDIT.\n// Source: data/words-data.json (historical seed data only; candidatePool is the unified candidate store; aiCard is the only formal word-card source)\nexport const ALL_WORDS = ${payload};\n`;
}

async function main() {
  const raw = await fs.readFile(sourcePath, 'utf8').catch(() => fail(`找不到词库源文件：${sourcePath}`));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`data/words-data.json 不是合法 JSON：${error.message}`);
  }
  if (!Array.isArray(parsed)) fail('data/words-data.json 顶层必须是数组');

  const normalizedWords = parsed.map(normalizeWord);
  validateUniqueKanji(normalizedWords);

  await fs.writeFile(frontendTargetPath, buildFrontendContent(normalizedWords), 'utf8');
  await fs.writeFile(sharedTargetPath, buildSharedContent(normalizedWords), 'utf8');

  console.log(`✅ 词库构建完成：${normalizedWords.length} 个词`);
  console.log(`- 前端文件：${path.relative(projectRoot, frontendTargetPath)}`);
  console.log(`- 后端文件：${path.relative(projectRoot, sharedTargetPath)}`);
}

await main();

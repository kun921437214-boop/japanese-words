const PUBLISHED_BODY_READING_PATTERN = /^[（(].+[）)](?:\s*[⓪①②③④⑤⑥⑦⑧⑨0-9]+)?$/u;
const PUBLISHED_BODY_META_PATTERN = /^(?:[=＝]|全称(?:是|为)|[➡👉💡🥯🥖💅])/u;
const PUBLISHED_BODY_CONTINUATION_PATTERN = /[；;、，,:：]$/u;

function cleanPublishedBodyLine(value = '') {
  return String(value || '').replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractPublishedMeaningFromDescription(record = {}) {
  if (!record?.contentLocked || record?.contentCategory === 'non_word') return '';
  const word = String(record?.word || '').trim();
  if (!word) return '';
  const lines = String(record?.description || '')
    .split(/[\r\n\u2028\u2029]+/u)
    .map(cleanPublishedBodyLine)
    .filter(Boolean);
  const wordLineIndex = lines.findIndex(line => line.replace(/^[🍞\s]+/u, '').startsWith(word));
  if (wordLineIndex < 0) return '';

  function nextMeaningLine(startIndex) {
    for (let index = startIndex; index < Math.min(lines.length, wordLineIndex + 10); index += 1) {
      const line = lines[index];
      if (!line || line.startsWith('⬇')) continue;
      if (line.startsWith('🍞') || line.startsWith('#')) return null;
      if (PUBLISHED_BODY_READING_PATTERN.test(line) || PUBLISHED_BODY_META_PATTERN.test(line)) continue;
      if (!/[\u3400-\u9fff]/u.test(line)) continue;
      return { index, line: line.slice(0, 240) };
    }
    return null;
  }

  const first = nextMeaningLine(wordLineIndex + 1);
  if (!first) return '';
  const meaningLines = [first.line];
  let current = first;
  while (PUBLISHED_BODY_CONTINUATION_PATTERN.test(current.line) && meaningLines.length < 3) {
    const next = nextMeaningLine(current.index + 1);
    if (!next) break;
    meaningLines.push(next.line);
    current = next;
  }
  return meaningLines.join(' ').slice(0, 240);
}

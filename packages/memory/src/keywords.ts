const ASCII_STOPWORDS = new Set(['the', 'a', 'to', 'and', 'in', 'of', 'for', 'must', 'all', 'use']);
// Applied only when every character in a CJK token is in this small function-word set.
const CHINESE_STOPWORD_CHARS = new Set('的了和与及是在都要用把被一律必须所有这个我们本项目仓库房间时前后');
const TOKEN = /[A-Za-z0-9_.\-/:]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Extract lightweight, deterministic keywords from Chinese prose and embedded identifiers. */
export function memoryKeywords(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const result = new Set<string>();

  for (const match of normalized.matchAll(TOKEN)) {
    const token = match[0];
    if (/^[a-z0-9_.\-/:]+$/u.test(token)) {
      if (!/[a-z0-9]/u.test(token)) continue;
      if (!ASCII_STOPWORDS.has(token)) result.add(token);
      // Keep delimiter-bounded identifier pieces too (for example YYYY, MM, DD
      // and GBK from GBK/GB18030) while preserving the complete code token.
      for (const piece of token.split(/[-/ :]+/u)) {
        if (piece && !ASCII_STOPWORDS.has(piece)) result.add(piece);
      }
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) {
      if (!isChineseStopwordToken(chars)) result.add(token);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
      const bigram = chars[i]! + chars[i + 1]!;
      if (!isChineseStopwordToken([...bigram])) result.add(bigram);
    }
  }
  return result;
}

function isChineseStopwordToken(chars: string[]): boolean {
  return chars.every(char => CHINESE_STOPWORD_CHARS.has(char));
}

export function keywordSimilarity(a: Set<string>, b: Set<string>): number {
  const minSize = Math.min(a.size, b.size);
  const intersection = [...a].reduce((count, token) => count + (b.has(token) ? 1 : 0), 0);
  const union = a.size + b.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  if (minSize < 3) return jaccard;
  const containment = intersection / minSize;
  return Math.max(jaccard, containment);
}

export function isLikelyDuplicate(a: Set<string>, b: Set<string>, threshold: number): boolean {
  return keywordSimilarity(a, b) >= threshold;
}

// Measured pairs top out at 0.333 for unrelated examples; 0.30 keeps close
// misses available to a verifier while the 0.50 duplicate cutoff stays precise.
export const BORDERLINE_THRESHOLD = 0.3;
export const DUPLICATE_THRESHOLD = 0.5;
export const DEFAULT_DUPLICATE_THRESHOLD = DUPLICATE_THRESHOLD;

export type DuplicateClassification = 'duplicate' | 'borderline' | 'not_duplicate';

export function classifyDuplicate(a: Set<string>, b: Set<string>): DuplicateClassification {
  const score = keywordSimilarity(a, b);
  if (score >= DUPLICATE_THRESHOLD) return 'duplicate';
  if (score >= BORDERLINE_THRESHOLD) return 'borderline';
  return 'not_duplicate';
}

import { describe, expect, it } from 'vitest';
import { keywordSimilarity, memoryKeywords } from './keywords.js';

const pairs = [
  ['这个仓库中的所有 shell 脚本都必须在第二行写 set -euo pipefail。', '每个仓库脚本的第二行都必须是 set -euo pipefail。', true],
  // Known limit: lexical overlap is too low (0.235) without semantic/embedding calls.
  ['本环境没有 file 命令，且 data.csv 是 GBK 编码；匹配 UTF-8 中文字面串前先用 iconv -f GBK -t UTF-8 转码。', '房间工作区的 data.csv 是 GBK/GB18030 编码，统计中文前要按此解码。', false],
  ['日期统一写成 YYYY-MM-DD 格式。', '房间交付物和脚本里的日期都用 YYYY-MM-DD。', true],
  ['脚本报错输出到 stderr，退出码用 2。', '脚本第二行必须是 set -euo pipefail。', false],
  ['本地 Redis 直连用 6379，8079 是代理。', '本地 Postgres 用 5432 端口。', false],
  ['接口时间字段统一用 ISO 8601。', '日期统一写成 YYYY-MM-DD 格式。', false],
  ['data.csv 是 GBK 编码。', 'data.csv 的第一列是城市名。', false],
] as const;

describe('memoryKeywords', () => {
  it('keeps code identifiers and creates overlapping CJK bigrams', () => {
    const keywords = memoryKeywords('set -euo pipefail iconv gbk 6379 stderr utf-8 日期格式');
    for (const token of ['set', '-euo', 'pipefail', 'iconv', 'gbk', '6379', 'stderr', 'utf-8', '日期', '期格']) {
      expect(keywords.has(token), token).toBe(true);
    }
  });

  it('normalizes compatibility forms and removes stopwords', () => {
    const keywords = memoryKeywords('ＡＢＣ 的了和 与及 是 在 都 要 用 把 被 一律 必须 所有 这个 我们 the a to and in of for must all use');
    expect(keywords.has('abc')).toBe(true);
    expect(memoryKeywords('--- ::: ...').size).toBe(0);
    for (const token of ['的了', '和与', 'the', 'a', 'to', 'and', 'in', 'of', 'for', 'must', 'all', 'use']) {
      expect(keywords.has(token), token).toBe(false);
    }
  });

  it('returns a symmetric keyword ranking score without a duplicate threshold', () => {
    const left = memoryKeywords(pairs[1]![0]);
    const right = memoryKeywords(pairs[1]![1]);
    const score = keywordSimilarity(left, right);
    expect(score).toBeCloseTo(0.235, 2);
    expect(keywordSimilarity(right, left)).toBe(score);
    expect(keywordSimilarity(left, left)).toBe(1);
  });
});

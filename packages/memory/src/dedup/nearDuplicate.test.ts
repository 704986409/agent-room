import { describe, expect, it } from 'vitest';
import { rankNearDuplicateCandidates } from './nearDuplicate.js';

function candidate(id: string, title: string, content: string, embedding?: number[] | null) {
  return { id, kind: 'memory' as const, title, content, embedding };
}

describe('rankNearDuplicateCandidates', () => {
  it('orders by cosine and applies the candidate cap', () => {
    const candidates = Array.from({ length: 25 }, (_, index) => {
      const similarity = 1 - index / 100;
      return candidate(
        `c${String(index).padStart(2, '0')}`,
        `candidate ${index}`,
        '中文记忆内容',
        [similarity, Math.sqrt(1 - similarity * similarity)],
      );
    });

    const ranked = rankNearDuplicateCandidates(candidates, '新的中文记忆', [1, 0], 20);
    expect(ranked.ranking).toBe('cosine');
    expect(ranked.candidates).toHaveLength(20);
    expect(ranked.candidates.map(item => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `c${String(index).padStart(2, '0')}`),
    );
  });

  it('uses keyword order when the query embedding is unavailable', () => {
    const ranked = rankNearDuplicateCandidates([
      candidate('b', '完全不同', '其他事实'),
      candidate('a', '接口重试规则', '接口失败后最多重试两次。'),
    ], '接口重试规则 接口失败后最多重试两次。', null, 20);

    expect(ranked.ranking).toBe('keyword');
    expect(ranked.candidates[0]?.id).toBe('a');
    expect(ranked.candidates[0]?.score).toBeGreaterThan(ranked.candidates[1]?.score ?? 0);
  });

  it('uses keyword order when fewer than half of candidates have usable embeddings', () => {
    const ranked = rankNearDuplicateCandidates([
      candidate('semantic-low', '无关语义', '猫咪每天晒太阳。', [0, 1]),
      candidate('keyword-high', '接口超时规则', '接口请求超时后返回错误。'),
      candidate('missing-b', '无关内容', '仓库的灯光需要关闭。', null),
      candidate('missing-c', '另一个主题', '文档由值班同学维护。'),
    ], '接口超时规则 接口请求超时后返回错误。', [1, 0], 20);

    expect(ranked.ranking).toBe('keyword');
    expect(ranked.candidates[0]?.id).toBe('keyword-high');
  });

  it('uses cosine when exactly half the candidates have usable embeddings', () => {
    const ranked = rankNearDuplicateCandidates([
      candidate('semantic', '没有关键词交集', '猫咪每天晒太阳。', [1, 0]),
      candidate('keyword', '接口重试规则', '接口失败后重试两次。'),
    ], '接口重试规则 接口失败后重试两次。', [1, 0], 20);

    expect(ranked.ranking).toBe('cosine');
    expect(ranked.candidates.map(item => item.id)).toEqual(['semantic']);
  });
});

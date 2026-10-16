import { afterEach, describe, expect, it, vi } from 'vitest';
import { mostlyChinese, resolveJevReviewer, type JevReviewInput } from './jevReviewer.js';
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

const input: JevReviewInput = {
  action: 'create',
  title: '部署规范',
  content: '发布前必须运行类型检查。',
  existingMemories: [{ title: '代码检查', content: '改动后运行类型检查。' }],
};

function mockScores(scores: Record<string, number>) {
  return vi.fn<FetchArgs, Promise<Response>>(async () => new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(scores).map(([id, noul]) => [id, { type: 'noul', noul }])),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

const passing = { is_chinese: 0.9, durable: 0.9, concise: 0.9, already_known: 0.1 };

describe('Jev reviewer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is disabled without a key or when MEMORY_JEV_REVIEW is off', () => {
    vi.stubEnv('JEV_API_KEY', '');
    expect(resolveJevReviewer()).toBeUndefined();
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubEnv('MEMORY_JEV_REVIEW', 'false');
    expect(resolveJevReviewer()).toBeUndefined();
  });

  it('approves a Chinese, durable, concise memory not already known', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    const fetchMock = mockScores(passing);
    vi.stubGlobal('fetch', fetchMock);
    const reviewer = resolveJevReviewer()!;
    expect(await reviewer.review(input)).toEqual({ decision: 'approve' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      state: { action: 'create', title: input.title, content: input.content, existing_memories: input.existingMemories },
      questions: {
        is_chinese: { type: 'noul' }, durable: { type: 'noul' }, concise: { type: 'noul' },
        already_known: { type: 'noul' },
      },
    });
  });

  it.each([
    [{ ...passing, is_chinese: 0.49 }, '格式不合规'],
    [{ ...passing, durable: 0.59 }, '无关记忆'],
    [{ ...passing, concise: 0.49 }, '格式不合规'],
    [{ ...passing, already_known: 0.6 }, '重复记忆'],
  ])('rejects with the first failing reason', async (scores, reason) => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubGlobal('fetch', mockScores(scores));
    expect(await resolveJevReviewer()!.review(input)).toEqual({ decision: 'reject', reason });
  });

  it('skips delete proposals without a Jev request', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    const fetchMock = mockScores(passing);
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveJevReviewer()!.review({ ...input, action: 'delete' })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mostly non-Chinese text locally without calling Jev', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reviewer = resolveJevReviewer()!;
    expect(await reviewer.review({ action: 'create', title: 'Lint', content: 'Always run the linter before pushing.', existingMemories: [] }))
      .toEqual({ decision: 'reject', reason: '格式不合规' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('keeps Chinese text with embedded identifiers', () => {
    expect(mostlyChinese('本地 Redis 直连用 6379，8079 是代理。')).toBe(true);
  });
});

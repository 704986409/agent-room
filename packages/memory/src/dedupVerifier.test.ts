import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxJevCandidatesFrom, resolveDuplicateVerifier } from './dedupVerifier.js';
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

const candidate = { title: '新记忆', content: 'data.csv 第一列是城市名。' };
const existing = { id: 'memory-1', kind: 'memory' as const, title: '编码', content: 'data.csv 是 GBK 编码。' };

function mockJev(answers: Record<string, number>) {
  return vi.fn<FetchArgs, Promise<Response>>(async () => new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: 'noul', noul }])),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

describe('resolveDuplicateVerifier', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is disabled when the API key is absent', () => {
    vi.stubEnv('JEV_API_KEY', '');
    expect(resolveDuplicateVerifier()).toBeUndefined();
  });

  it('shares the candidate cap and honors the legacy alias', () => {
    expect(maxJevCandidatesFrom({})).toBe(20);
    expect(maxJevCandidatesFrom({
      MEMORY_DEDUP_CANDIDATE_CAP: '12', MEMORY_DEDUP_JEV_MAX_CANDIDATES: '3',
    })).toBe(12);
    expect(maxJevCandidatesFrom({ MEMORY_DEDUP_JEV_MAX_CANDIDATES: '3' })).toBe(3);
  });

  it.each(['0', 'false', 'off'])('is disabled when MEMORY_DEDUP_VERIFIER is %s', value => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubEnv('MEMORY_DEDUP_VERIFIER', value);
    expect(resolveDuplicateVerifier()).toBeUndefined();
  });

  it('uses the JEV endpoint and default threshold when enabled by a key', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubEnv('JEV_API_URL', 'https://jev.test/v1/systemone');
    const fetchMock = mockJev({ c0: 0.54 });
    vi.stubGlobal('fetch', fetchMock);
    const verifier = resolveDuplicateVerifier();
    expect(verifier).toBeDefined();
    expect(await verifier!.verifyMany({ candidate, existings: [{ ...existing, score: 0.235 }] })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://jev.test/v1/systemone');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'jev-1.13.0',
      state: '房间共享记忆去重检查。每个问题比较两条中文记忆。',
      questions: {
        c0: {
          type: 'noul',
          instructions: {
            new_memory: { content: candidate.content },
            existing_memory: { content: existing.content },
            question: '`new_memory` 与 `existing_memory` 表达的是否是同一条规则或事实（即重复，记下 `new_memory` 不会带来新信息）？',
          },
          criteria: { true: '同一条规则/事实，只是措辞不同', false: '不同的规则或事实，或包含实质性的新信息' },
        },
      },
    });
  });

  it('honors the configured decision threshold and legacy endpoint override', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubEnv('MEMORY_DEDUP_JEV_THRESHOLD', '0.8');
    vi.stubEnv('MEMORY_DEDUP_JEV_MAX_CANDIDATES', '2');
    vi.stubEnv('MEMORY_DEDUP_VERIFIER_URL', 'https://legacy-jev.test');
    const fetchMock = mockJev({ c0: 0.72, c1: 0.95, c2: 1 });
    vi.stubGlobal('fetch', fetchMock);
    const verifier = resolveDuplicateVerifier();
    const existings = [0, 1, 2].map(index => ({
      ...existing, id: `memory-${index}`, title: `现有记忆${index}`, score: 0.3 - index / 100,
    }));
    expect(await verifier!.verifyMany({ candidate, existings })).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://legacy-jev.test');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body.questions)).toEqual(['c0', 'c1']);
    expect(body.questions.c0.instructions.existing_memory).toEqual({ content: existing.content });
    expect(body.questions.c1.instructions.new_memory).toEqual({ content: candidate.content });
    expect(JSON.stringify(body.questions)).not.toContain('现有记忆');
  });

  it('defaults the duplicate threshold to 0.55', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    vi.stubGlobal('fetch', mockJev({ c0: 0.56 }));
    const verifier = resolveDuplicateVerifier();
    expect(await verifier!.verifyMany({ candidate, existings: [{ ...existing, score: 0.5 }] })).toBe(0);
  });

  it('judgeMany asks duplicate and conflict questions per candidate in one request', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    const fetchMock = mockJev({ c0: 0.1, x0: 0.2, c1: 0.3, x1: 0.91 });
    vi.stubGlobal('fetch', fetchMock);
    const existings = [0, 1].map(index => ({ ...existing, id: `memory-${index}`, score: 0.5 }));
    expect(await resolveDuplicateVerifier()!.judgeMany!({ candidate, existings }))
      .toEqual({ duplicate: null, conflict: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body.questions)).toEqual(['c0', 'x0', 'c1', 'x1']);
    expect(body.questions.x0.instructions.question).toContain('改值');
  });

  it('judgeMany prefers a duplicate over a conflict and honors the conflict threshold', async () => {
    vi.stubEnv('JEV_API_KEY', 'test-key');
    const existings = [0, 1].map(index => ({ ...existing, id: `memory-${index}`, score: 0.5 }));
    vi.stubGlobal('fetch', mockJev({ c0: 0.8, x0: 0.1, c1: 0.1, x1: 0.95 }));
    expect(await resolveDuplicateVerifier()!.judgeMany!({ candidate, existings }))
      .toEqual({ duplicate: 0, conflict: null });

    vi.stubEnv('MEMORY_CONFLICT_JEV_THRESHOLD', '0.96');
    vi.stubGlobal('fetch', mockJev({ c0: 0.1, x0: 0.1, c1: 0.1, x1: 0.95 }));
    expect(await resolveDuplicateVerifier()!.judgeMany!({ candidate, existings }))
      .toEqual({ duplicate: null, conflict: null });
  });
});


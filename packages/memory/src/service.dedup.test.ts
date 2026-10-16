import { describe, expect, it, vi } from 'vitest';
import type { MemoryRepository } from './repository.js';
import { MemoryService } from './service.js';
import type { DuplicateVerifier } from './dedupVerifier.js';
import { classifyDuplicate, keywordSimilarity, memoryKeywords } from './keywords.js';
import type { MemoryContent } from './types.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const caller = { roomInstanceId: roomId, identityType: 'room_member' as const, principalId: 'member-a' };
const existing = {
  id: 'proposal-existing',
  kind: 'proposal' as const,
  title: 'data.csv',
  content: 'data.csv 是 GBK 编码。',
};
const candidate: MemoryContent = {
  title: 'data.csv',
  preview: '数据说明',
  content: 'data.csv 的第一列是城市名。',
  searchText: 'data csv 城市名',
};

function makeService(verifier?: DuplicateVerifier | null, maxCandidates = 5, candidates = [existing]) {
  const repository = {
    getRequestResult: vi.fn(async () => null),
    listEntries: vi.fn(async () => []),
    findRoomCreateDuplicateCandidates: vi.fn(async () => candidates),
    createRoomProposal: vi.fn(async (_scope, _input, _proposer, _requestId, duplicateResult) =>
      duplicateResult ?? { status: 'pending_review' as const, id: 'proposal-new' }),
  } as unknown as MemoryRepository;
  return new MemoryService(repository, { duplicateVerifier: verifier, duplicateVerifierMaxCandidates: maxCandidates });
}

describe('MemoryService borderline duplicate verification', () => {
  it('uses a positive verifier result as a pending proposal duplicate', async () => {
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => 0);
    const service = makeService({ verifyMany });
    expect(await service.createEntry(caller, 'room', candidate, 'verify-true'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: existing.id, duplicateOf: existing.id });
    expect(verifyMany).toHaveBeenCalledOnce();
    expect(verifyMany.mock.calls[0]?.[0].existings).toEqual([expect.objectContaining({ id: existing.id })]);
  });

  it('fails open for false, errors, and an absent verifier', async () => {
    const falseService = makeService({ verifyMany: vi.fn(async () => null) });
    expect(await falseService.createEntry(caller, 'room', candidate, 'verify-false'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const errorService = makeService({ verifyMany: vi.fn(async () => { throw new Error('failure'); }) });
      expect(await errorService.createEntry(caller, 'room', candidate, 'verify-error'))
        .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }

    const absentService = makeService(null);
    expect(await absentService.createEntry(caller, 'room', candidate, 'verify-absent'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
  });

  it('sends only the highest-scoring capped candidates in one verifier call', async () => {
    const candidates = [
      { ...existing, id: 'low', content: `${existing.content} unrelatedone unrelatedtwo unrelatedthree unrelatedfour` },
      { ...existing, id: 'high' },
      { ...existing, id: 'middle', content: `${existing.content} redis` },
    ];
    const candidateKeywords = memoryKeywords(`${candidate.title} ${candidate.content}`);
    const scores = candidates.map(item => keywordSimilarity(candidateKeywords, memoryKeywords(`${item.title} ${item.content}`)));
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(scores[0]!);
    expect(scores[1]).toBeLessThan(0.5);
    expect(scores[2]).toBeGreaterThanOrEqual(0.15);
    expect(scores[0]).toBeLessThan(0.15);
    expect(candidates.map(item => classifyDuplicate(candidateKeywords, memoryKeywords(`${item.title} ${item.content}`), { verifier: true })))
      .toEqual(['not_duplicate', 'borderline', 'borderline']);
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => null);
    const service = makeService({ verifyMany }, 2, candidates);
    await service.createEntry(caller, 'room', candidate, 'verify-cap');
    expect(verifyMany).toHaveBeenCalledOnce();
    expect(verifyMany.mock.calls[0]?.[0].existings.map(item => item.id)).toEqual(['high', 'middle']);
  });
});

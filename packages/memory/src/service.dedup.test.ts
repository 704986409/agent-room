import { describe, expect, it, vi } from 'vitest';
import type { MemoryRepository } from './repository.js';
import { MemoryService } from './service.js';
import type { DuplicateVerifier } from './dedupVerifier.js';
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

function makeService(verifier?: DuplicateVerifier | null) {
  const repository = {
    getRequestResult: vi.fn(async () => null),
    listEntries: vi.fn(async () => []),
    findRoomCreateDuplicateCandidates: vi.fn(async () => [existing]),
    createRoomProposal: vi.fn(async (_scope, _input, _proposer, _requestId, duplicateResult) =>
      duplicateResult ?? { status: 'pending_review' as const, id: 'proposal-new' }),
  } as unknown as MemoryRepository;
  return new MemoryService(repository, { duplicateVerifier: verifier });
}

describe('MemoryService borderline duplicate verification', () => {
  it('uses a positive verifier result as a pending proposal duplicate', async () => {
    const verify = vi.fn(async () => true);
    const service = makeService({ verify });
    expect(await service.createEntry(caller, 'room', candidate, 'verify-true'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: existing.id, duplicateOf: existing.id });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('fails open for false, errors, and an absent verifier', async () => {
    const falseService = makeService({ verify: vi.fn(async () => false) });
    expect(await falseService.createEntry(caller, 'room', candidate, 'verify-false'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const errorService = makeService({ verify: vi.fn(async () => { throw new Error('failure'); }) });
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
});

import { describe, expect, it, vi } from 'vitest';
import type { MemoryRepository } from './repository.js';
import { MemoryService } from './service.js';
import type { DuplicateVerifier } from './dedupVerifier.js';
import type { NearDuplicateCandidate } from './dedup/nearDuplicate.js';
import type { Embedder } from './embedding/embedder.js';
import { keywordSimilarity, memoryKeywords } from './keywords.js';
import type { MemoryContent, MemoryEntry } from './types.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const caller = { roomInstanceId: roomId, identityType: 'room_member' as const, principalId: 'member-a' };
const candidate: MemoryContent = {
  title: '订单服务超时调整',
  preview: '订单服务超时调整',
  content: '订单服务的超时时间统一设为 30 秒。',
  searchText: '订单服务 超时时间 30 秒',
};
const similarCandidate = {
  id: 'entry-similar',
  kind: 'memory' as const,
  title: '订单服务超时规则',
  content: '订单服务的超时时间统一设为 60 秒。',
  embedding: null,
};

function makeService(input: {
  verifier?: DuplicateVerifier | null;
  embedder?: Embedder | null;
  candidates?: NearDuplicateCandidate[];
  entries?: MemoryEntry[];
  entry?: MemoryEntry;
} = {}) {
  const repository = {
    getRequestResult: vi.fn(async () => null),
    readEntry: vi.fn(async () => input.entry ?? null),
    listEntries: vi.fn(async () => input.entries ?? []),
    findRoomCreateDuplicateCandidates: vi.fn(async () => input.candidates ?? [similarCandidate]),
    createRoomProposal: vi.fn(async (_scope, _input, _proposer, _requestId, duplicateResult) =>
      duplicateResult ?? { status: 'pending_review' as const, id: 'proposal-new' }),
  } as unknown as MemoryRepository;
  return {
    repository,
    service: new MemoryService(repository, {
      duplicateVerifier: input.verifier ?? null,
      embedder: input.embedder ?? null,
      embeddingModel: 'test-model',
    }),
  };
}

describe('MemoryService semantic duplicate decisions', () => {
  it('keeps exact normalized matches on the early path without verifier or embedder calls', async () => {
    const exact: MemoryEntry = {
      id: 'entry-exact',
      room_instance_id: roomId,
      persona_id: null,
      scope: 'room',
      title: candidate.title,
      preview: candidate.preview,
      content: 'A different body.',
      search_text: candidate.searchText,
      version: 1,
      updated_at: new Date(),
      created_at: new Date(),
      source_message_id: null,
      deleted_at: null,
    };
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => 0);
    const embed = vi.fn(async () => [[1, 0]]);
    const { service, repository } = makeService({
      verifier: { verifyMany },
      embedder: { embed },
      entries: [exact],
    });

    expect(await service.createEntry(caller, 'room', candidate, 'exact-match')).toEqual({
      status: 'duplicate_candidates',
      candidates: [{ id: exact.id, title: exact.title, preview: exact.preview }],
      guidance: 'update_existing_or_clarify',
    });
    expect(verifyMany).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(repository.findRoomCreateDuplicateCandidates).not.toHaveBeenCalled();
  });

  it('sends a high-keyword non-exact pair to Jev instead of auto-skipping it', async () => {
    expect(keywordSimilarity(
      memoryKeywords(`${candidate.title} ${candidate.content}`),
      memoryKeywords(`${similarCandidate.title} ${similarCandidate.content}`),
    )).toBeGreaterThanOrEqual(0.5);
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => null);
    const embed = vi.fn(async () => null);
    const { service } = makeService({ verifier: { verifyMany }, embedder: { embed } });

    expect(await service.createEntry(caller, 'room', candidate, 'high-keyword')).toEqual({
      code: 'PENDING_REVIEW', proposalId: 'proposal-new',
    });
    expect(verifyMany).toHaveBeenCalledOnce();
    expect(verifyMany.mock.calls[0]?.[0].existings[0]?.id).toBe(similarCandidate.id);
    expect(embed).toHaveBeenCalledWith([`${candidate.title} ${candidate.content}`]);
  });

  it('uses the pending proposal exact-text path without Jev or embedding', async () => {
    const exactPending = {
      id: 'proposal-exact', kind: 'proposal' as const,
      title: `  ${candidate.title.toUpperCase()}  `,
      content: candidate.content,
      embedding: null,
    };
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => 0);
    const embed = vi.fn(async () => [[1, 0]]);
    const { service } = makeService({
      verifier: { verifyMany },
      embedder: { embed },
      candidates: [exactPending],
    });

    expect(await service.createEntry(caller, 'room', candidate, 'pending-exact')).toEqual({
      code: 'PENDING_REVIEW', proposalId: exactPending.id, duplicateOf: exactPending.id,
    });
    expect(verifyMany).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('does not treat a same-title memory with different content as an exact duplicate', async () => {
    const sameTitle = { id: 'entry-same-title', kind: 'memory' as const, title: candidate.title, content: 'data.csv 的第一列是城市名。', embedding: null };
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => null);
    const { service } = makeService({ verifier: { verifyMany }, candidates: [sameTitle] });
    expect(await service.createEntry(caller, 'room', candidate, 'same-title')).toEqual({
      code: 'PENDING_REVIEW', proposalId: 'proposal-new',
    });
    expect(verifyMany).toHaveBeenCalledOnce();
  });

  it('treats Jev null and Jev errors as not duplicate', async () => {
    const nullVerifier = vi.fn(async () => null);
    const nullResult = makeService({ verifier: { verifyMany: nullVerifier } });
    expect(await nullResult.service.createEntry(caller, 'room', candidate, 'jev-null'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });

    const throwingVerifier = vi.fn(async () => { throw new Error('simulated Jev failure'); });
    const errorResult = makeService({ verifier: { verifyMany: throwingVerifier } });
    expect(await errorResult.service.createEntry(caller, 'room', candidate, 'jev-error'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
  });

  it('uses a positive Jev result for a semantic candidate with no keyword overlap', async () => {
    const query = {
      title: '工单服务链路要求',
      preview: '工单服务链路要求',
      content: '所有工单必须记录完整的请求调用链。',
      searchText: '工单 请求 调用链',
    };
    const semanticCandidate = {
      id: 'entry-semantic', kind: 'memory' as const,
      title: '猫咪的日常习惯', content: '猫咪每天喜欢在窗边晒太阳。',
      embedding: [1, 0],
    };
    expect(keywordSimilarity(
      memoryKeywords(`${query.title} ${query.content}`),
      memoryKeywords(`${semanticCandidate.title} ${semanticCandidate.content}`),
    )).toBe(0);
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => 0);
    const embed = vi.fn(async () => [[1, 0]]);
    const { service } = makeService({
      verifier: { verifyMany },
      embedder: { embed },
      candidates: [semanticCandidate],
    });

    expect(await service.createEntry(caller, 'room', query, 'semantic-only')).toEqual({
      code: 'DUPLICATE', duplicateOf: semanticCandidate.id, duplicateKind: 'memory',
    });
    expect(verifyMany.mock.calls[0]?.[0].existings.map(item => item.id)).toEqual([semanticCandidate.id]);
  });

  it('does no embedding work when no verifier is configured', async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    const { service, repository } = makeService({ embedder: { embed } });

    expect(await service.createEntry(caller, 'room', candidate, 'no-verifier'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
    expect(embed).not.toHaveBeenCalled();
    expect(repository.findRoomCreateDuplicateCandidates).not.toHaveBeenCalled();
  });

  it('embeds updated Room content and passes the vector to the proposal repository', async () => {
    const current: MemoryEntry = {
      id: '22222222-2222-4222-8222-222222222222',
      room_instance_id: roomId,
      persona_id: null,
      scope: 'room',
      title: 'Existing update title',
      preview: 'Current preview',
      content: 'Current content',
      search_text: 'current',
      version: 1,
      updated_at: new Date(),
      created_at: new Date(),
      source_message_id: null,
      deleted_at: null,
    };
    const embed = vi.fn(async (_texts: string[]) => [[0.5, 0.5]]);
    const { service, repository } = makeService({
      verifier: { verifyMany: vi.fn(async () => null) },
      embedder: { embed },
      entry: current,
    });

    expect(await service.updateEntry(caller, 'room', current.id, { content: 'Updated content' }, 'update-vector'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
    expect(embed).toHaveBeenCalledWith(['Existing update title Updated content']);
    const createProposal = repository.createRoomProposal as unknown as ReturnType<typeof vi.fn>;
    expect(createProposal.mock.calls[0]?.[5]).toEqual({ vector: [0.5, 0.5], model: 'test-model' });
  });
});

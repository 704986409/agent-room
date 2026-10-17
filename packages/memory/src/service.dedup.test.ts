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
  it('ignores titles: a same-title approved memory with different content goes to the normal path and is written', async () => {
    const sameTitle: MemoryEntry = {
      id: 'entry-same-title-approved',
      room_instance_id: roomId,
      persona_id: null,
      scope: 'room',
      title: candidate.title,
      preview: candidate.preview,
      content: '订单服务的日志级别线上用 warn。',
      search_text: candidate.searchText,
      version: 1,
      updated_at: new Date(),
      created_at: new Date(),
      source_message_id: null,
      deleted_at: null,
    };
    const verifyMany = vi.fn(async () => null);
    const judgeMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) =>
      ({ duplicate: null, conflict: null }));
    const embed = vi.fn(async () => [[1, 0]]);
    const { service, repository } = makeService({
      verifier: { verifyMany, judgeMany },
      embedder: { embed },
      entries: [sameTitle],
      candidates: [{ id: sameTitle.id, kind: 'memory', title: sameTitle.title, content: sameTitle.content, embedding: [1, 0] }],
    });

    expect(await service.createEntry(caller, 'room', candidate, 'same-title-approved'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
    expect(judgeMany).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith([candidate.content]);
    expect(repository.createRoomProposal).toHaveBeenCalledOnce();
  });

  it('sends a high-keyword non-exact pair to Jev instead of auto-skipping it', async () => {
    expect(keywordSimilarity(
      memoryKeywords(candidate.content),
      memoryKeywords(similarCandidate.content),
    )).toBeGreaterThanOrEqual(0.5);
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => null);
    const embed = vi.fn(async () => null);
    const { service } = makeService({ verifier: { verifyMany }, embedder: { embed } });

    expect(await service.createEntry(caller, 'room', candidate, 'high-keyword')).toEqual({
      code: 'PENDING_REVIEW', proposalId: 'proposal-new',
    });
    expect(verifyMany).toHaveBeenCalledOnce();
    expect(verifyMany.mock.calls[0]?.[0].existings[0]?.id).toBe(similarCandidate.id);
    expect(embed).toHaveBeenCalledWith([candidate.content]);
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

  it('returns the same silent DUPLICATE shape for an exact normalized content match, without Jev or embedding', async () => {
    const existingEntry: MemoryEntry = {
      id: 'entry-exact-content',
      room_instance_id: roomId,
      persona_id: null,
      scope: 'room',
      title: '另一个标题',
      preview: candidate.preview,
      content: '  订单服务的超时时间统一设为 30 秒。 ',
      search_text: candidate.searchText,
      version: 1,
      updated_at: new Date(),
      created_at: new Date(),
      source_message_id: null,
      deleted_at: null,
    };
    const verifyMany = vi.fn(async () => 0);
    const judgeMany = vi.fn(async () => ({ duplicate: 0, conflict: null }));
    const embed = vi.fn(async () => [[1, 0]]);
    const { service, repository } = makeService({
      verifier: { verifyMany, judgeMany }, embedder: { embed }, entries: [existingEntry],
    });

    expect(await service.createEntry(caller, 'room', candidate, 'exact-content')).toEqual({
      code: 'DUPLICATE',
      duplicateOf: existingEntry.id,
      duplicateKind: 'memory',
      existing: { id: existingEntry.id, title: existingEntry.title, content: existingEntry.content },
    });
    expect(verifyMany).not.toHaveBeenCalled();
    expect(judgeMany).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(repository.createRoomProposal).not.toHaveBeenCalled();
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
      existing: { id: semanticCandidate.id, title: semanticCandidate.title, content: semanticCandidate.content },
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
    expect(embed).toHaveBeenCalledWith(['Updated content']);
    const createProposal = repository.createRoomProposal as unknown as ReturnType<typeof vi.fn>;
    expect(createProposal.mock.calls[0]?.[5]).toEqual({ vector: [0.5, 0.5], model: 'test-model' });
  });

  describe('conflicting value (same object, changed value)', () => {
    const sixty: MemoryContent = {
      title: '订单服务超时时间',
      preview: '订单服务超时 60 秒',
      content: '订单服务的超时时间统一为 60 秒。',
      searchText: '订单服务 超时时间 60 秒',
    };
    const thirty = {
      id: 'entry-thirty', kind: 'memory' as const,
      title: '订单服务超时', content: '订单服务的超时时间统一设为 30 秒。', embedding: null,
    };

    it('returns update guidance for the conflicting entry and writes nothing', async () => {
      const verifyMany = vi.fn(async () => null);
      const judgeMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) =>
        ({ duplicate: null, conflict: 0 }));
      const { service, repository } = makeService({ verifier: { verifyMany, judgeMany }, candidates: [thirty] });

      const result = await service.createEntry(caller, 'room', sixty, 'conflict-60');
      expect(result).toMatchObject({
        code: 'CONFLICTS_WITH_EXISTING',
        conflictWith: { id: 'entry-thirty', kind: 'memory', content: '订单服务的超时时间统一设为 30 秒。' },
        guidance: 'memory_update_existing',
      });
      expect((result as { message: string }).message).toContain('memory_update');
      expect(repository.createRoomProposal).not.toHaveBeenCalled();
      expect(judgeMany).toHaveBeenCalledOnce();
      expect(verifyMany).not.toHaveBeenCalled();
    });

    it('asks to wait when the conflict is a pending proposal', async () => {
      const judgeMany = vi.fn(async () => ({ duplicate: null, conflict: 0 }));
      const { service } = makeService({
        verifier: { verifyMany: vi.fn(async () => null), judgeMany },
        candidates: [{ ...thirty, id: 'proposal-thirty', kind: 'proposal' }],
      });
      expect(await service.createEntry(caller, 'room', sixty, 'conflict-pending')).toMatchObject({
        code: 'CONFLICTS_WITH_EXISTING',
        conflictWith: { id: 'proposal-thirty', kind: 'proposal' },
        guidance: 'wait_for_pending_review',
      });
    });

    it('still skips a true duplicate silently', async () => {
      const judgeMany = vi.fn(async () => ({ duplicate: 0, conflict: null }));
      const { service } = makeService({
        verifier: { verifyMany: vi.fn(async () => null), judgeMany },
        candidates: [{ ...thirty, content: '订单服务超时时间为 60 秒。' }],
      });
      expect(await service.createEntry(caller, 'room', sixty, 'dup-60')).toEqual({
        code: 'DUPLICATE', duplicateOf: 'entry-thirty', duplicateKind: 'memory',
        existing: { id: 'entry-thirty', title: '订单服务超时', content: '订单服务超时时间为 60 秒。' },
      });
    });

    it('lets an unrelated write proceed to review', async () => {
      const judgeMany = vi.fn(async () => ({ duplicate: null, conflict: null }));
      const { service, repository } = makeService({
        verifier: { verifyMany: vi.fn(async () => null), judgeMany },
        candidates: [thirty],
      });
      const unrelated = { ...sixty, title: '本地 Postgres 端口', content: '本地 Postgres 连接用 5432 端口。', searchText: 'Postgres 5432' };
      expect(await service.createEntry(caller, 'room', unrelated, 'unrelated'))
        .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
      expect(repository.createRoomProposal).toHaveBeenCalledOnce();
    });

    it('fails open to a normal write when the judge errors', async () => {
      const judgeMany = vi.fn(async () => { throw new Error('jev down'); });
      const { service } = makeService({
        verifier: { verifyMany: vi.fn(async () => null), judgeMany },
        candidates: [thirty],
      });
      expect(await service.createEntry(caller, 'room', sixty, 'judge-down'))
        .toEqual({ code: 'PENDING_REVIEW', proposalId: 'proposal-new' });
    });
  });

  it('ignores stored vectors embedded under a different tag (e.g. old title+content vectors)', async () => {
    const stale = { id: 'entry-stale', kind: 'memory' as const, title: 'x', content: '猫咪每天喜欢在窗边晒太阳。', embedding: [1, 0], embeddingModel: 'old-model' };
    const fresh = { id: 'entry-fresh', kind: 'memory' as const, title: 'y', content: '订单服务的超时时间统一设为 60 秒。', embedding: [0, 1], embeddingModel: 'test-model' };
    const verifyMany = vi.fn(async (_input: Parameters<DuplicateVerifier['verifyMany']>[0]) => null);
    const { service } = makeService({
      verifier: { verifyMany }, embedder: { embed: vi.fn(async () => [[1, 0]]) }, candidates: [stale, fresh],
    });
    await service.createEntry(caller, 'room', candidate, 'stale-tag');
    // Only one of two candidates has a usable vector (>= half), so cosine ranking keeps just the fresh one.
    expect(verifyMany.mock.calls[0]?.[0].existings.map(item => item.id)).toEqual(['entry-fresh']);
  });
});


import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryReviewService, ReviewerPolicy } from './review-service.js';
import type { MemoryRepository } from './repository.js';
import type { MemoryProposal } from './types.js';

const roomId = randomUUID();
const proposalId = randomUUID();

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: proposalId,
    room_instance_id: roomId,
    action: 'create',
    target_memory_id: null,
    target_version: null,
    target_updated_at: null,
    payload: { title: '规则', preview: '简介', content: '长期规则', searchText: '规则' },
    proposer_persona_id: 'writer',
    proposer_identity_type: 'persona',
    proposer_identity_id: 'writer',
    status: 'pending',
    reviewer_identity_type: null,
    reviewer_identity_id: null,
    review_reason: null,
    request_id: 'write-request',
    created_at: new Date(0),
    reviewed_at: null,
    ...overrides,
  };
}

function serviceFor(record: MemoryProposal) {
  const repository = {
    getRoomProposal: vi.fn(async () => record),
    reviewRoomProposal: vi.fn(async (_room, id, reviewer, decision, _requestId, reviewReason) => {
      record.status = decision === 'approve' ? 'approved' : 'rejected';
      record.reviewer_identity_type = reviewer.type;
      record.reviewer_identity_id = reviewer.id;
      record.review_reason = reviewReason ?? null;
      return { status: record.status, id, ...(decision === 'approve' ? { version: 1, superseded: [] } : {}) };
    }),
  } as unknown as MemoryRepository;
  const directory = {
    findReviewerByRole: vi.fn(async () => { throw new Error('system reviews bypass policy'); }),
    isAvailable: vi.fn(async () => false),
    resolveRoomOwner: vi.fn(async () => null),
  };
  return { service: new MemoryReviewService(repository, new ReviewerPolicy(directory)), repository, directory };
}

describe('MemoryReviewService.reviewAsSystem', () => {
  it('reviews with Jev identity, stores NULL for approval, and bypasses ReviewerPolicy', async () => {
    const { service, repository, directory } = serviceFor(proposal());
    const result = await service.reviewAsSystem(roomId, proposalId, 'approve', 'ignored', 'jev-review-1');

    expect(result).toMatchObject({ status: 'approved', proposalId, version: 1 });
    expect(result).not.toHaveProperty('reason');
    expect(repository.reviewRoomProposal).toHaveBeenCalledWith(
      roomId, proposalId, { type: 'system', id: 'jev' }, 'approve', 'jev-review-1', undefined,
    );
    expect(directory.findReviewerByRole).not.toHaveBeenCalled();
  });

  it('stores and returns a required Jev rejection code', async () => {
    const { service, repository } = serviceFor(proposal());
    const result = await service.reviewAsSystem(roomId, proposalId, 'reject', '重复记忆', 'jev-reject-1');
    expect(result).toMatchObject({ status: 'rejected', proposalId, reason: '重复记忆' });
    expect(repository.reviewRoomProposal).toHaveBeenCalledWith(
      roomId, proposalId, { type: 'system', id: 'jev' }, 'reject', 'jev-reject-1', '重复记忆',
    );
  });

  it('returns INVALID_INPUT when an agent rejection lacks a valid code and ignores approval reasons', async () => {
    const record = proposal();
    const { service, repository } = serviceFor(record);
    const reviewer = { type: 'room_owner' as const, id: roomId };
    const context = { roomInstanceId: roomId, identity: reviewer, verified: true };
    await expect(service.review(context, proposalId, 'reject', 'reject-missing'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.review(context, proposalId, 'reject', 'reject-invalid', '其他'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(repository.reviewRoomProposal).not.toHaveBeenCalled();
  });

  it('preserves first-review-wins and superseded proposal behavior', async () => {
    const humanReviewed = proposal({
      status: 'approved', reviewer_identity_type: 'room_owner', reviewer_identity_id: roomId,
    });
    const humanService = serviceFor(humanReviewed).service;
    await expect(humanService.reviewAsSystem(roomId, proposalId, 'approve', undefined, 'jev-review-2'))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    const supersededService = serviceFor(proposal({ status: 'superseded' })).service;
    await expect(supersededService.reviewAsSystem(roomId, proposalId, 'approve', undefined, 'jev-review-3'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  applyMemoryMigrations,
  MemoryReviewService,
  PostgresMemoryRepository,
  ReviewerPolicy,
  type MemoryContent,
  type MemoryIdentity,
  type TrustedMemoryReviewer,
} from '../src/index.js';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MEMORY_TEST_DATABASE_URL is required; PostgreSQL review tests do not skip.');

function content(overrides: Partial<MemoryContent> = {}): MemoryContent {
  return {
    title: 'Shared fact',
    preview: 'Short review summary',
    content: 'Shared memory body',
    searchText: 'shared fact',
    ...overrides,
  };
}

function persona(id: string): MemoryIdentity {
  return { type: 'persona', id, personaId: id };
}

function owner(roomInstanceId: string): MemoryIdentity {
  return { type: 'room_owner', id: roomInstanceId };
}

function reviewerContext(roomInstanceId: string, identity: MemoryIdentity | null, verified = true): TrustedMemoryReviewer {
  return { roomInstanceId, identity, verified };
}

describe('P5 shared Memory review with PostgreSQL 17', () => {
  let admin: Pool;
  let scopedPool: Pool;
  let repository: PostgresMemoryRepository;
  let schemaName: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    const versionNumber = Number(version.rows[0]?.server_version_num);
    if (versionNumber < 170000 || versionNumber >= 180000) {
      throw new Error(`MEMORY_TEST_DATABASE_URL must point to PostgreSQL 17.x; found ${String(version.rows[0]?.server_version_num)}.`);
    }
    schemaName = `memory_review_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName},public` });
    await applyMemoryMigrations(scopedPool);
    repository = await PostgresMemoryRepository.fromPool(scopedPool);
  }, 30_000);

  afterAll(async () => {
    await repository?.close();
    await scopedPool?.end();
    if (schemaName) await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  function serviceFor(roomInstanceId: string, configuredReviewer: MemoryIdentity | null, available = true) {
    const availability = vi.fn(async () => available);
    const directory = {
      findReviewerByRole: vi.fn(async () => configuredReviewer),
      isAvailable: availability,
      resolveRoomOwner: vi.fn(async () => owner(roomInstanceId)),
    };
    return {
      service: new MemoryReviewService(repository, new ReviewerPolicy(directory, 'project-analyst')),
      directory,
      availability,
    };
  }

  async function proposeCreate(roomInstanceId: string, proposer: MemoryIdentity, value = content()) {
    return repository.createRoomProposal(
      { roomInstanceId, scope: 'room' },
      { action: 'create', content: value },
      proposer,
      `review-proposal-${randomUUID()}`,
    );
  }

  async function approveDirectly(roomInstanceId: string, proposalId: string, reviewer: MemoryIdentity) {
    return repository.reviewRoomProposal(
      roomInstanceId,
      proposalId,
      reviewer,
      'approve',
      `review-direct-${randomUUID()}`,
    );
  }

  it('lists pending proposals and approves through the configured trusted reviewer', async () => {
    const roomId = randomUUID();
    const reviewer = persona(`project-analyst-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const { service } = serviceFor(roomId, reviewer);

    const pending = await service.listPending(reviewerContext(roomId, reviewer));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: proposal.id,
      action: 'create',
      payload: { title: 'Shared fact', preview: 'Short review summary', content: 'Shared memory body' },
    });
    expect(pending[0]).not.toHaveProperty('proposerIdentityId');

    const notification = await service.mentionReviewer(roomId, proposal.id);
    expect(notification).toEqual({ kind: 'mention', roomInstanceId: roomId, proposalId: proposal.id, recipient: reviewer });

    const result = await service.review(
      reviewerContext(roomId, reviewer), proposal.id, 'approve', `review-approve-${randomUUID()}`,
    );
    expect(result).toMatchObject({ status: 'approved', proposalId: proposal.id, version: 1 });
    expect(await repository.listEntries({ roomInstanceId: roomId, scope: 'room' })).toHaveLength(1);
    expect(await repository.listPendingRoomProposals(roomId)).toEqual([]);
  });

  it('rejects a proposal without changing the existing shared memory', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const existing = await proposeCreate(roomId, owner(roomId), content({ title: 'Current fact' }));
    await approveDirectly(roomId, existing.id, analyst);
    const current = (await repository.listEntries({ roomInstanceId: roomId, scope: 'room' }))[0]!;
    const update = await repository.createRoomProposal(
      { roomInstanceId: roomId, scope: 'room' },
      { action: 'update', targetMemoryId: current.id, update: { content: 'Proposed replacement' } },
      persona(`proposer-${randomUUID()}`),
      `review-update-${randomUUID()}`,
    );
    const { service } = serviceFor(roomId, analyst);

    const result = await service.review(
      reviewerContext(roomId, analyst), update.id, 'reject', `review-reject-${randomUUID()}`,
    );
    expect(result.status).toBe('rejected');
    expect((await repository.readEntry({ roomInstanceId: roomId, scope: 'room' }, current.id))?.content)
      .toBe('Shared memory body');
    expect((await repository.readEntry({ roomInstanceId: roomId, scope: 'room' }, current.id))?.version).toBe(1);
  });

  it('rejects self-review and callers who are not the selected reviewer', async () => {
    const roomId = randomUUID();
    const proposer = persona(`self-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, proposer);
    const { service } = serviceFor(roomId, proposer);
    await expect(service.review(
      reviewerContext(roomId, proposer), proposal.id, 'approve', `self-review-${randomUUID()}`,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const selected = persona(`selected-${randomUUID()}`);
    const other = persona(`other-${randomUUID()}`);
    const otherProposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const otherService = serviceFor(roomId, selected).service;
    await expect(otherService.review(
      reviewerContext(roomId, other), otherProposal.id, 'approve', `wrong-reviewer-${randomUUID()}`,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('falls back to the room owner when the configured reviewer is unavailable', async () => {
    const roomId = randomUUID();
    const configured = persona(`configured-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const { service, availability } = serviceFor(roomId, configured, false);
    const result = await service.review(
      reviewerContext(roomId, owner(roomId)), proposal.id, 'approve', `owner-fallback-${randomUUID()}`,
    );
    expect(availability).toHaveBeenCalledWith(roomId, configured);
    expect(result.status).toBe('approved');
  });

  it('returns the prior result on duplicate approval without applying the proposal twice', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const { service } = serviceFor(roomId, analyst);
    const requestId = `approval-${randomUUID()}`;
    const first = await service.review(
      reviewerContext(roomId, analyst), proposal.id, 'approve', requestId,
    );
    const replay = await service.review(
      reviewerContext(roomId, analyst), proposal.id, 'approve', requestId,
    );
    expect(replay).toEqual(first);
    const repeatedDecision = await service.review(
      reviewerContext(roomId, analyst), proposal.id, 'approve', `repeat-${randomUUID()}`,
    );
    expect(repeatedDecision).toMatchObject({ status: 'approved', proposalId: proposal.id });
    expect(await repository.listEntries({ roomInstanceId: roomId, scope: 'room' })).toHaveLength(1);
  });

  it('returns CONFLICT when a proposal target changed after its version snapshot', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const base = await proposeCreate(roomId, owner(roomId), content({ title: 'Version one' }));
    await approveDirectly(roomId, base.id, analyst);
    const entry = (await repository.listEntries({ roomInstanceId: roomId, scope: 'room' }))[0]!;
    const first = await repository.createRoomProposal(
      { roomInstanceId: roomId, scope: 'room' },
      { action: 'update', targetMemoryId: entry.id, update: { content: 'First proposed change' } },
      persona(`proposer-a-${randomUUID()}`),
      `stale-a-${randomUUID()}`,
    );
    const newer = await repository.createRoomProposal(
      { roomInstanceId: roomId, scope: 'room' },
      { action: 'update', targetMemoryId: entry.id, update: { content: 'Newer accepted change' } },
      persona(`proposer-b-${randomUUID()}`),
      `stale-b-${randomUUID()}`,
    );
    const { service } = serviceFor(roomId, analyst);
    await service.review(
      reviewerContext(roomId, analyst), newer.id, 'approve', `newer-approval-${randomUUID()}`,
    );
    await expect(service.review(
      reviewerContext(roomId, analyst), first.id, 'approve', `stale-approval-${randomUUID()}`,
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.readEntry({ roomInstanceId: roomId, scope: 'room' }, entry.id))?.content)
      .toBe('Newer accepted change');
  });

  it('requires verifiable reviewer identity before showing or changing proposals', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const { service } = serviceFor(roomId, analyst);
    const unverified = reviewerContext(roomId, null, false);
    await expect(service.listPending(unverified)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    await expect(service.review(unverified, proposal.id, 'approve', `unverified-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    expect((await repository.getRoomProposal(roomId, proposal.id))?.status).toBe('pending');
  });
});

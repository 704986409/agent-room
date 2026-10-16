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

  async function createEntry(roomInstanceId: string, reviewer: MemoryIdentity) {
    const proposal = await proposeCreate(roomInstanceId, owner(roomInstanceId));
    await approveDirectly(roomInstanceId, proposal.id, reviewer);
    return (await repository.listEntries({ roomInstanceId, scope: 'room' }))[0]!;
  }

  async function proposeUpdate(roomInstanceId: string, targetMemoryId: string, proposer: MemoryIdentity, suffix: string) {
    return repository.createRoomProposal(
      { roomInstanceId, scope: 'room' },
      { action: 'update', targetMemoryId, update: { content: `Replacement ${suffix}` } },
      proposer,
      `review-update-${suffix}-${randomUUID()}`,
    );
  }

  async function proposeDelete(roomInstanceId: string, targetMemoryId: string, proposer: MemoryIdentity, suffix: string) {
    return repository.createRoomProposal(
      { roomInstanceId, scope: 'room' },
      { action: 'delete', targetMemoryId },
      proposer,
      `review-delete-${suffix}-${randomUUID()}`,
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

  function multiServiceFor(roomInstanceId: string, seats: { identity: MemoryIdentity; online: boolean }[]) {
    const directory = {
      findReviewerByRole: vi.fn(async () => seats.find(seat => seat.online)?.identity ?? null),
      isAvailable: vi.fn(async (_room: string, identity: MemoryIdentity) =>
        seats.some(seat => seat.online && seat.identity.id === identity.id)),
      resolveRoomOwner: vi.fn(async () => owner(roomInstanceId)),
      listReviewersByRole: vi.fn(async () => seats),
    };
    return new MemoryReviewService(repository, new ReviewerPolicy(directory, 'project-analyst'));
  }

  it('lets any online reviewer review, notifies all of them, and the first review wins', async () => {
    const roomId = randomUUID();
    const first = persona(`analyst-a-${randomUUID()}`);
    const second = persona(`analyst-b-${randomUUID()}`);
    const stale = persona(`analyst-stale-${randomUUID()}`);
    const proposer = persona(`proposer-${randomUUID()}`);
    const service = multiServiceFor(roomId, [
      { identity: first, online: true }, { identity: stale, online: false }, { identity: second, online: true },
    ]);
    const proposal = await proposeCreate(roomId, proposer);
    const mention = await service.mentionReviewers(roomId, proposal.id);
    expect(mention.mode).toBe('reviewers');
    expect(mention.reviewCode).toBeUndefined();
    expect(mention.notifications.map(n => n.recipient.id).sort()).toEqual([first.id, second.id].sort());
    // Second (not first-match) reviewer may review; stale seat gets REVIEWER_UNAVAILABLE.
    await expect(service.review(reviewerContext(roomId, stale), proposal.id, 'approve', `s-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'REVIEWER_UNAVAILABLE' });
    await expect(service.review(reviewerContext(roomId, owner(roomId)), proposal.id, 'approve', `o-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.review(reviewerContext(roomId, proposer), proposal.id, 'approve', `p-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const winner = await service.review(reviewerContext(roomId, second), proposal.id, 'approve', `w-${randomUUID()}`);
    expect(winner.status).toBe('approved');
    await expect(service.review(reviewerContext(roomId, first), proposal.id, 'approve', `l-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.review(reviewerContext(roomId, first), proposal.id, 'reject', `l2-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.listEntries({ roomInstanceId: roomId, scope: 'room' })).toHaveLength(1);
  });

  it('serializes concurrent reviews by different reviewers: exactly one wins, the other gets CONFLICT', async () => {
    const roomId = randomUUID();
    const a = persona(`race-a-${randomUUID()}`);
    const b = persona(`race-b-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const results = await Promise.allSettled([
      repository.reviewRoomProposal(roomId, proposal.id, a, 'approve', `ra-${randomUUID()}`),
      repository.reviewRoomProposal(roomId, proposal.id, b, 'approve', `rb-${randomUUID()}`),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await repository.listEntries({ roomInstanceId: roomId, scope: 'room' })).toHaveLength(1);
  });

  it('falls back to the owner only when every reviewer is offline, with REVIEWER_UNAVAILABLE', async () => {
    const roomId = randomUUID();
    const a = persona(`off-a-${randomUUID()}`);
    const b = persona(`off-b-${randomUUID()}`);
    const service = multiServiceFor(roomId, [{ identity: a, online: false }, { identity: b, online: false }]);
    const proposal = await proposeCreate(roomId, persona(`proposer-${randomUUID()}`));
    const mention = await service.mentionReviewers(roomId, proposal.id);
    expect(mention).toMatchObject({ mode: 'owner_fallback', reviewCode: 'REVIEWER_UNAVAILABLE' });
    expect(mention.notifications.map(n => n.recipient)).toEqual([owner(roomId)]);
    await expect(service.review(reviewerContext(roomId, a), proposal.id, 'approve', `a-${randomUUID()}`))
      .rejects.toMatchObject({ code: 'REVIEWER_UNAVAILABLE' });
    expect((await service.review(reviewerContext(roomId, owner(roomId)), proposal.id, 'approve', `own-${randomUUID()}`)).status)
      .toBe('approved');
    // Owner is never chosen as reviewer of its own proposal.
    const ownProposal = await proposeCreate(roomId, owner(roomId));
    await expect(service.mentionReviewers(roomId, ownProposal.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
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

  it('supersedes older pending updates atomically and leaves other targets pending', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const firstEntry = await createEntry(roomId, analyst);
    const otherEntryProposal = await proposeCreate(roomId, owner(roomId), content({ title: 'Another fact' }));
    await approveDirectly(roomId, otherEntryProposal.id, analyst);
    const secondEntry = (await repository.listEntries({ roomInstanceId: roomId, scope: 'room' }))
      .find(entry => entry.id !== firstEntry.id)!;
    const losing = await proposeUpdate(roomId, firstEntry.id, persona(`loser-${randomUUID()}`), randomUUID());
    const winning = await proposeUpdate(roomId, firstEntry.id, persona(`winner-${randomUUID()}`), randomUUID());
    const unrelated = await proposeUpdate(roomId, secondEntry.id, persona(`other-${randomUUID()}`), randomUUID());
    const { service } = serviceFor(roomId, analyst);

    const approved = await service.review(
      reviewerContext(roomId, analyst), winning.id, 'approve', `supersede-${randomUUID()}`,
    );
    expect(approved).toMatchObject({ status: 'approved', superseded: [losing.id] });
    expect((await repository.getRoomProposal(roomId, losing.id))?.status).toBe('superseded');
    expect((await repository.getRoomProposal(roomId, unrelated.id))?.status).toBe('pending');
    expect((await service.listPending(reviewerContext(roomId, analyst))).map(item => item.id))
      .toEqual([unrelated.id]);
    await expect(service.review(
      reviewerContext(roomId, analyst), losing.id, 'approve', `stale-${randomUUID()}`,
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    const supersededRow = await repository.getRoomProposal(roomId, losing.id);
    expect(supersededRow).toMatchObject({
      reviewer_identity_type: analyst.type,
      reviewer_identity_id: analyst.id,
      status: 'superseded',
    });
    expect(supersededRow?.reviewed_at).toBeInstanceOf(Date);
  });

  it('supersedes a pending delete when an update is approved', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const entry = await createEntry(roomId, analyst);
    const deletion = await proposeDelete(roomId, entry.id, persona(`deleter-${randomUUID()}`), randomUUID());
    const update = await proposeUpdate(roomId, entry.id, persona(`updater-${randomUUID()}`), randomUUID());
    const { service } = serviceFor(roomId, analyst);
    const result = await service.review(
      reviewerContext(roomId, analyst), update.id, 'approve', `approve-update-${randomUUID()}`,
    );
    expect(result.superseded).toEqual([deletion.id]);
    expect((await repository.getRoomProposal(roomId, deletion.id))?.status).toBe('superseded');
  });

  it('supersedes every pending update or delete when a delete is approved', async () => {
    const roomId = randomUUID();
    const analyst = persona(`analyst-${randomUUID()}`);
    const entry = await createEntry(roomId, analyst);
    const update = await proposeUpdate(roomId, entry.id, persona(`updater-${randomUUID()}`), randomUUID());
    const winner = await proposeDelete(roomId, entry.id, persona(`winner-${randomUUID()}`), randomUUID());
    const { service } = serviceFor(roomId, analyst);
    const result = await service.review(
      reviewerContext(roomId, analyst), winner.id, 'approve', `approve-delete-${randomUUID()}`,
    );
    expect(result.superseded).toEqual([update.id]);
    expect((await repository.getRoomProposal(roomId, update.id))?.status).toBe('superseded');
    expect(await repository.readEntry({ roomInstanceId: roomId, scope: 'room' }, entry.id)).toBeNull();
  });

  it('routes a reviewer proposer to the host when no other online reviewer remains', async () => {
    const roomId = randomUUID();
    const soleReviewer = persona(`sole-reviewer-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, soleReviewer);
    const service = multiServiceFor(roomId, [{ identity: soleReviewer, online: true }]);
    const mention = await service.mentionReviewers(roomId, proposal.id);
    expect(mention).toMatchObject({ mode: 'owner_fallback', reviewCode: 'REVIEWER_UNAVAILABLE' });
    expect(mention.notifications.map(item => item.recipient)).toEqual([owner(roomId)]);
    await expect(service.review(
      reviewerContext(roomId, soleReviewer), proposal.id, 'approve', `self-${randomUUID()}`,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const listed = await service.listPending(reviewerContext(roomId, owner(roomId)));
    expect(listed.map(item => item.id)).toContain(proposal.id);
    expect((await service.review(
      reviewerContext(roomId, owner(roomId)), proposal.id, 'approve', `host-${randomUUID()}`,
    )).status).toBe('approved');
  });

  it('routes to a second online reviewer when the proposer is also a reviewer seat', async () => {
    const roomId = randomUUID();
    const proposer = persona(`reviewer-proposer-${randomUUID()}`);
    const secondReviewer = persona(`reviewer-second-${randomUUID()}`);
    const proposal = await proposeCreate(roomId, proposer);
    const service = multiServiceFor(roomId, [
      { identity: proposer, online: true }, { identity: secondReviewer, online: true },
    ]);
    const mention = await service.mentionReviewers(roomId, proposal.id);
    expect(mention.notifications.map(item => item.recipient)).toEqual([secondReviewer]);
    await expect(service.listPending(reviewerContext(roomId, proposer)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await service.listPending(reviewerContext(roomId, secondReviewer))).map(item => item.id)).toContain(proposal.id);
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

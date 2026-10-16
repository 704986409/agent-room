import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { applyMemoryMigrations, PostgresMemoryRepository } from '../src/postgres.js';
import {
  MemoryService,
  type MemoryServiceMutationResult,
  type TrustedMemoryCaller,
} from '../src/service.js';
import { MemoryConflictError, MemoryForbiddenError, type MemoryContent } from '../src/types.js';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('MEMORY_TEST_DATABASE_URL is required; PostgreSQL integration tests do not skip.');
}

function content(overrides: Partial<MemoryContent> = {}): MemoryContent {
  return {
    title: 'Memory title',
    preview: 'Short preview',
    content: 'Full memory content',
    searchText: 'Memory title keywords aliases',
    ...overrides,
  };
}

function personaIdentity(personaId: string) {
  return { type: 'persona' as const, id: personaId, personaId };
}

function roomOwnerIdentity(id = `owner-${randomUUID()}`) {
  return { type: 'room_owner' as const, id };
}

function roomMemberIdentity(id = `member-${randomUUID()}`) {
  return { type: 'room_member' as const, id };
}

function trustedCaller(
  roomInstanceId: string,
  personaId: string,
  identityType: TrustedMemoryCaller['identityType'] = 'persona',
): TrustedMemoryCaller {
  return identityType === 'persona'
    ? { roomInstanceId, personaId, identityType }
    : { roomInstanceId, principalId: personaId, identityType };
}

function resultId(result: MemoryServiceMutationResult): string {
  if ('id' in result) return result.id;
  if ('proposalId' in result) return result.proposalId;
  throw new Error('Expected a mutation result with an ID.');
}

describe('Agent Memory PostgreSQL 17 integration', () => {
  let admin: Pool;
  let scopedPool: Pool;
  let repository: PostgresMemoryRepository;
  let schemaName: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    const versionNumber = Number(version.rows[0]?.server_version_num);
    if (versionNumber < 170000 || versionNumber >= 180000) {
      throw new Error(`MEMORY_TEST_DATABASE_URL must point to PostgreSQL 17.x; found server_version_num=${String(version.rows[0]?.server_version_num)}.`);
    }
    const extension = await admin.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
    );
    if (!extension.rows[0]?.installed) {
      throw new Error('PostgreSQL test database must have pg_trgm preinstalled by an administrator.');
    }

    schemaName = `memory_test_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    await applyMemoryMigrations(scopedPool);
    await applyMemoryMigrations(scopedPool);
    repository = await PostgresMemoryRepository.fromPool(scopedPool);
  }, 30_000);

  afterAll(async () => {
    await repository?.close();
    await scopedPool?.end();
    if (schemaName) await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  it('creates the schema, applies migrations repeatedly, and has no Room table foreign key', async () => {
    const versions = await scopedPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_memory_schema_migrations WHERE version IN (1, 2, 3)',
    );
    expect(versions.rows[0]?.count).toBe('3');

    const foreignKeys = await scopedPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relnamespace = current_schema()::regnamespace
        AND t.relname LIKE 'agent_memory_%' AND c.contype = 'f'
    `);
    expect(foreignKeys.rows[0]?.count).toBe('0');

    const extension = await scopedPool.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
    );
    expect(extension.rows[0]?.installed).toBe(true);
  });

  it('enforces scope checks and title/preview character limits in PostgreSQL', async () => {
    const roomInstanceId = randomUUID();
    await expect(scopedPool.query(
      `INSERT INTO agent_memory_entries
        (id, room_instance_id, persona_id, scope, title, preview, content, search_text)
       VALUES ($1, $2, 'persona-a', 'room', 'x', 'y', 'z', 'z')`,
      [randomUUID(), roomInstanceId],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(scopedPool.query(
      `INSERT INTO agent_memory_entries
        (id, room_instance_id, persona_id, scope, title, preview, content, search_text)
       VALUES ($1, $2, NULL, 'room', $3, 'y', 'z', 'z')`,
      [randomUUID(), roomInstanceId, 'x'.repeat(201)],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(scopedPool.query(
      `INSERT INTO agent_memory_entries
        (id, room_instance_id, persona_id, scope, title, preview, content, search_text)
       VALUES ($1, $2, NULL, 'room', 'x', $3, 'z', 'z')`,
      [randomUUID(), roomInstanceId, 'x'.repeat(301)],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('supports scoped persona CRUD, soft deletion, and request replay', async () => {
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const scope = { roomInstanceId, scope: 'persona' as const, personaId };
    const actor = personaIdentity(personaId);

    const created = await repository.createPersonaEntry(scope, content(), actor, 'persona-create-1');
    expect(created.status).toBe('created');
    const replayedCreate = await repository.createPersonaEntry(
      scope, content({ title: 'Changed retry payload' }), actor, 'persona-create-1',
    );
    expect(replayedCreate).toEqual(created);
    expect((await repository.readEntry(scope, created.id))?.title).toBe('Memory title');

    const anotherPersona = { ...scope, personaId: `persona-${randomUUID()}` };
    expect(await repository.readEntry(anotherPersona, created.id)).toBeNull();
    expect(await repository.readEntry({ roomInstanceId: randomUUID(), scope: 'persona', personaId }, created.id)).toBeNull();

    const updated = await repository.updatePersonaEntry(
      scope, created.id, { content: 'Updated body', title: 'Updated title' }, actor, 'persona-update-1',
    );
    expect(updated).toMatchObject({ status: 'updated', id: created.id, version: 2 });
    const replayedUpdate = await repository.updatePersonaEntry(
      scope, created.id, { content: 'A different retry must not reapply' }, actor, 'persona-update-1',
    );
    expect(replayedUpdate).toEqual(updated);
    expect((await repository.readEntry(scope, created.id))?.content).toBe('Updated body');

    const deleted = await repository.deletePersonaEntry(scope, created.id, actor, 'persona-delete-1');
    expect(deleted).toMatchObject({ status: 'deleted', id: created.id, version: 3 });
    expect(await repository.deletePersonaEntry(scope, created.id, actor, 'persona-delete-1')).toEqual(deleted);
    expect(await repository.readEntry(scope, created.id)).toBeNull();
    expect(await repository.listEntries(scope)).toEqual([]);
  });

  it('enforces cross-Persona and cross-Room read/list isolation through the service', async () => {
    const service = new MemoryService(repository);
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const otherPersonaId = `persona-${randomUUID()}`;
    const owner = trustedCaller(roomInstanceId, personaId);
    const entry = await service.createEntry(owner, 'persona', content(), 'service-isolation-create');
    expect(entry).toMatchObject({ status: 'created' });
    const entryId = resultId(entry);

    await expect(service.readEntry(trustedCaller(roomInstanceId, otherPersonaId), 'persona', entryId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.listEntries(trustedCaller(roomInstanceId, otherPersonaId), 'persona')).toEqual([]);
    await expect(service.readEntry(trustedCaller(roomInstanceId, `member-${randomUUID()}`, 'room_member'), 'persona', entryId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.listEntries(trustedCaller(roomInstanceId, `member-${randomUUID()}`, 'room_member'), 'persona'))
      .toEqual([]);
    await expect(service.readEntry(trustedCaller(randomUUID(), personaId), 'persona', entryId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.listEntries(trustedCaller(randomUUID(), personaId), 'persona')).toEqual([]);

    const shared = await service.createEntry(owner, 'room', content({ title: 'Shared service fact' }), 'service-room-create');
    expect(shared).toMatchObject({ code: 'PENDING_REVIEW' });
    const proposalId = resultId(shared);
    expect(await service.listEntries(owner, 'room')).toEqual([]);
    await repository.reviewRoomProposal(
      roomInstanceId,
      proposalId,
      roomOwnerIdentity(),
      'approve',
      'service-room-review',
    );
    expect(await service.listEntries(owner, 'room')).toHaveLength(1);
    expect(await service.listEntries(trustedCaller(randomUUID(), personaId), 'room')).toEqual([]);
    const roomScope = { roomInstanceId, scope: 'room' as const };
    const roomEntry = (await repository.listEntries(roomScope))[0]!;
    expect(await service.createEntry(
      owner,
      'room',
      content({ title: 'Shared service fact' }),
      'service-room-duplicate',
    )).toMatchObject({ status: 'duplicate_candidates', candidates: [{ id: roomEntry.id }] });
    await expect(service.readEntry(trustedCaller(randomUUID(), personaId), 'room', roomEntry.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const updateProposal = await service.updateEntry(
      owner,
      'room',
      roomEntry.id,
      { content: 'An explicitly proposed room update.' },
      'service-room-update',
    );
    expect(updateProposal).toMatchObject({ code: 'PENDING_REVIEW' });
    expect((await repository.readEntry(roomScope, roomEntry.id))?.content).toBe('Full memory content');
    await repository.reviewRoomProposal(
      roomInstanceId,
      resultId(updateProposal),
      roomOwnerIdentity(),
      'approve',
      'service-room-update-review',
    );
    expect((await repository.readEntry(roomScope, roomEntry.id))?.content)
      .toBe('An explicitly proposed room update.');

    const deleteProposal = await service.deleteEntry(owner, 'room', roomEntry.id, 'service-room-delete');
    expect(deleteProposal).toMatchObject({ code: 'PENDING_REVIEW' });
    expect(await repository.readEntry(roomScope, roomEntry.id)).not.toBeNull();
    await repository.reviewRoomProposal(
      roomInstanceId,
      resultId(deleteProposal),
      roomOwnerIdentity(),
      'approve',
      'service-room-delete-review',
    );
    expect(await service.listEntries(owner, 'room')).toEqual([]);
  });

  it('returns exact duplicate candidates, requires explicit updates, and preserves distinct facts', async () => {
    const service = new MemoryService(repository);
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const caller = trustedCaller(roomInstanceId, personaId);
    const firstContent = content({
      title: 'Fallback rollout schedule',
      preview: 'Friday rollout',
      content: 'The fallback rollout happens Friday after the risk review.',
      sourceMessageId: 'message-42',
    });
    const created = await service.createEntry(caller, 'persona', firstContent, 'dedup-create');
    expect(created).toMatchObject({ status: 'created' });
    const createdId = resultId(created);
    const createReplay = await service.createEntry(
      caller,
      'persona',
      content({ title: 'A retry with a changed payload' }),
      'dedup-create',
    );
    expect(createReplay).toEqual(created);
    expect((await repository.readEntry(
      { roomInstanceId, scope: 'persona', personaId }, createdId,
    ))?.source_message_id).toBe('message-42');

    const [concurrentCreateA, concurrentCreateB] = await Promise.all([
      service.createEntry(caller, 'persona', content({ title: 'Concurrent idempotent entry' }), 'dedup-concurrent'),
      service.createEntry(caller, 'persona', content({ title: 'Concurrent idempotent entry' }), 'dedup-concurrent'),
    ]);
    expect(concurrentCreateA).toEqual(concurrentCreateB);
    expect(concurrentCreateA).toMatchObject({ status: 'created' });

    const sameTitleDifferentFact = await service.createEntry(
      caller,
      'persona',
      content({ title: 'Fallback rollout schedule', content: 'The fallback rollout happens Monday after the risk review.' }),
      'dedup-same-title',
    );
    expect(sameTitleDifferentFact).toMatchObject({
      status: 'duplicate_candidates',
      candidates: [{ id: createdId }],
      guidance: 'update_existing_or_clarify',
    });
    expect((await service.readEntry(caller, 'persona', createdId)).content)
      .toBe('The fallback rollout happens Friday after the risk review.');

    const sameNormalizedContent = await service.createEntry(
      caller,
      'persona',
      content({ title: 'A differently cased title', content: '  THE FALLBACK ROLLOUT HAPPENS FRIDAY AFTER THE RISK REVIEW.  ' }),
      'dedup-normalized-content',
    );
    expect(sameNormalizedContent).toMatchObject({ status: 'duplicate_candidates', candidates: [{ id: createdId }] });

    const updated = await service.updateEntry(
      caller,
      'persona',
      createdId,
      { content: 'The fallback rollout happens Wednesday after the risk review.', preview: 'Wednesday rollout' },
      'dedup-explicit-update',
    );
    expect(updated).toMatchObject({ status: 'updated', id: createdId, version: 2 });
    const updatedId = resultId(updated);
    const replayedUpdate = await service.updateEntry(
      caller,
      'persona',
      createdId,
      { content: 'A retry must not replace the Wednesday fact.' },
      'dedup-explicit-update',
    );
    expect(replayedUpdate).toEqual(updated);
    expect((await service.readEntry(caller, 'persona', updatedId)).content)
      .toBe('The fallback rollout happens Wednesday after the risk review.');

    const differentFact = await service.createEntry(
      caller,
      'persona',
      content({
        title: 'Fallback rollout date',
        preview: 'Tuesday rollout',
        content: 'The fallback rollout happens Tuesday after the risk review.',
      }),
      'dedup-distinct-fact',
    );
    expect(differentFact).toMatchObject({ status: 'created' });
    expect(await service.listEntries(caller, 'persona')).toHaveLength(3);
    expect((await service.readEntry(caller, 'persona', createdId)).content)
      .toBe('The fallback rollout happens Wednesday after the risk review.');
  });

  it('maps an unavailable PostgreSQL connection to STORAGE_ERROR without a fake mutation result', async () => {
    const unavailablePool = new Pool({
      host: '127.0.0.1',
      port: 1,
      user: 'memory-test',
      database: 'memory-test',
      connectionTimeoutMillis: 100,
      max: 1,
    });
    const unavailableRepository = await PostgresMemoryRepository.fromPool(unavailablePool, false);
    const service = new MemoryService(unavailableRepository);
    try {
      await expect(service.createEntry(
        trustedCaller(randomUUID(), `persona-${randomUUID()}`),
        'persona',
        content(),
        'database-down-create',
      )).rejects.toMatchObject({
        code: 'STORAGE_ERROR',
        message: 'Memory storage is temporarily unavailable.',
      });
    } finally {
      await unavailableRepository.close();
      await unavailablePool.end();
    }
  });

  it('maps invalid input and Persona-scope authorization failures to stable safe codes', async () => {
    const service = new MemoryService(repository);
    const roomInstanceId = randomUUID();
    await expect(service.createEntry(
      trustedCaller(roomInstanceId, `persona-${randomUUID()}`, 'room_member'),
      'persona',
      content(),
      'forbidden-private-write',
    )).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Memory access is not allowed.' });

    await expect(service.createEntry(
      trustedCaller(roomInstanceId, `persona-${randomUUID()}`),
      'persona',
      content({ title: 'x'.repeat(201) }),
      'invalid-title',
    )).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid memory request.' });
  });

  it('isolates Room entries by room_instance_id and creates without a Room row', async () => {
    const roomInstanceId = randomUUID();
    const scope = { roomInstanceId, scope: 'room' as const };
    const proposer = roomOwnerIdentity();
    const created = await repository.createRoomProposal(
      scope, { action: 'create', content: content({ title: 'Room-only memory' }) }, proposer, 'room-create-1',
    );
    expect(created.status).toBe('pending_review');
    expect(await repository.createRoomProposal(
      scope, { action: 'create', content: content({ title: 'Retry differs' }) }, proposer, 'room-create-1',
    )).toEqual(created);

    const proposal = await repository.getRoomProposal(roomInstanceId, created.id);
    expect(proposal?.status).toBe('pending');
    const reviewer = roomMemberIdentity();
    await repository.reviewRoomProposal(roomInstanceId, created.id, reviewer, 'approve', 'room-approve-1');
    const entries = await repository.listEntries(scope);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('Room-only memory');

    expect(await repository.listEntries({ roomInstanceId: randomUUID(), scope: 'room' })).toEqual([]);
    expect(await repository.readEntry({ roomInstanceId: randomUUID(), scope: 'room' }, entries[0]!.id)).toBeNull();
  });

  it('applies approval and proposal state atomically; retries never duplicate an entry', async () => {
    const roomInstanceId = randomUUID();
    const scope = { roomInstanceId, scope: 'room' as const };
    const proposal = await repository.createRoomProposal(
      scope, { action: 'create', content: content({ title: 'Exactly once' }) }, roomOwnerIdentity(), 'proposal-once',
    );
    const reviewer = roomMemberIdentity();
    const [first, concurrentRetry] = await Promise.all([
      repository.reviewRoomProposal(roomInstanceId, proposal.id, reviewer, 'approve', 'review-once-a'),
      repository.reviewRoomProposal(roomInstanceId, proposal.id, reviewer, 'approve', 'review-once-b'),
    ]);
    expect(first.status).toBe('approved');
    expect(concurrentRetry.status).toBe('approved');
    expect(await repository.reviewRoomProposal(roomInstanceId, proposal.id, reviewer, 'approve', 'review-once-a'))
      .toEqual(first);
    expect(await repository.listEntries(scope)).toHaveLength(1);
    expect((await repository.getRoomProposal(roomInstanceId, proposal.id))?.status).toBe('approved');
  });

  it('collapses identical pending Room proposals across requestIds, race-safely, keeping requestId replay', async () => {
    const service = new MemoryService(repository);
    const roomInstanceId = randomUUID();
    const callerA = trustedCaller(roomInstanceId, `member-a-${randomUUID()}`, 'room_member');
    const callerB = trustedCaller(roomInstanceId, `member-b-${randomUUID()}`, 'room_member');
    const shared = content({ title: 'Shared port decision', content: 'API runs on port 3000.' });

    const first = await service.createEntry(callerA, 'room', shared, 'pdup-create-1');
    expect(first).toMatchObject({ code: 'PENDING_REVIEW' });
    expect(first).not.toHaveProperty('duplicateOf');
    const firstId = resultId(first);
    // Same normalized content (case/whitespace/NFKC differences), new requestId, other caller.
    const again = await service.createEntry(callerB, 'room', content({
      title: '  shared   PORT decision ', content: 'api runs on port 3000.',
    }), 'pdup-create-2');
    expect(again).toEqual({ code: 'PENDING_REVIEW', proposalId: firstId, duplicateOf: firstId });
    // requestId idempotency unchanged: replays return their own stored receipt.
    expect(await service.createEntry(callerA, 'room', content({ title: 'changed' }), 'pdup-create-1')).toEqual(first);
    expect(await service.createEntry(callerB, 'room', content({ title: 'changed' }), 'pdup-create-2')).toEqual(again);
    // Different content is still a separate proposal.
    const distinct = await service.createEntry(callerA, 'room', content({ title: 'Other', content: 'Other fact' }), 'pdup-create-3');
    expect(resultId(distinct)).not.toBe(firstId);

    // Concurrent identical submissions yield exactly one pending proposal.
    const racers = await Promise.all(Array.from({ length: 6 }, (_, index) => service.createEntry(
      index % 2 ? callerA : callerB, 'room', content({ title: 'Race title', content: 'Race body' }), `pdup-race-${index}`,
    )));
    expect(new Set(racers.map(resultId)).size).toBe(1);
    const pending = await repository.listPendingRoomProposals(roomInstanceId, { limit: 50 });
    expect(pending.filter(p => p.action === 'create' && (p.payload as MemoryContent).title === 'Race title')).toHaveLength(1);
    expect(pending.filter(p => p.action === 'create' && (p.payload as MemoryContent).title === 'Shared port decision')).toHaveLength(1);

    // Update and delete: same target + action + normalized payload collapse; others do not.
    const owner = roomOwnerIdentity();
    await repository.reviewRoomProposal(roomInstanceId, firstId, owner, 'approve', 'pdup-approve-1');
    const entryId = (await repository.listEntries({ roomInstanceId, scope: 'room' }))
      .find(entry => entry.title === 'Shared port decision')!.id;
    const up1 = await service.updateEntry(callerA, 'room', entryId, { content: 'API runs on port 3001.' }, 'pdup-up-1');
    const up2 = await service.updateEntry(callerB, 'room', entryId, { content: ' api RUNS on port 3001. ' }, 'pdup-up-2');
    expect(up2).toEqual({ code: 'PENDING_REVIEW', proposalId: resultId(up1), duplicateOf: resultId(up1) });
    const up3 = await service.updateEntry(callerB, 'room', entryId, { content: 'API runs on port 3002.' }, 'pdup-up-3');
    expect(resultId(up3)).not.toBe(resultId(up1));
    const del1 = await service.deleteEntry(callerA, 'room', entryId, 'pdup-del-1');
    const del2 = await service.deleteEntry(callerB, 'room', entryId, 'pdup-del-2');
    expect(del2).toEqual({ code: 'PENDING_REVIEW', proposalId: resultId(del1), duplicateOf: resultId(del1) });
    expect(resultId(del1)).not.toBe(resultId(up1));

    // Once reviewed, the same content may be proposed again as a fresh proposal.
    await repository.reviewRoomProposal(roomInstanceId, resultId(del1), owner, 'reject', 'pdup-reject-del');
    const del3 = await service.deleteEntry(callerA, 'room', entryId, 'pdup-del-3');
    expect(del3).not.toHaveProperty('duplicateOf');
    expect(resultId(del3)).not.toBe(resultId(del1));
  });

  it('detects bounded room create near-duplicates against pending and approved records only', async () => {
    const service = new MemoryService(repository);
    const roomInstanceId = randomUUID();
    const roomScope = { roomInstanceId, scope: 'room' as const };
    const caller = trustedCaller(roomInstanceId, `member-${randomUUID()}`, 'room_member');
    const shellA = '这个仓库中的所有 shell 脚本都必须在第二行写 set -euo pipefail。';
    const shellB = '每个仓库脚本的第二行都必须是 set -euo pipefail。';
    const pending = await service.createEntry(caller, 'room', content({ title: 'Shell guideline A', content: shellA }), 'near-pending-a');
    const pendingId = resultId(pending);
    expect(await service.createEntry(caller, 'room', content({ title: 'Shell guideline B', content: shellB }), 'near-pending-b'))
      .toEqual({ code: 'PENDING_REVIEW', proposalId: pendingId, duplicateOf: pendingId });
    expect(await repository.listPendingRoomProposals(roomInstanceId, { limit: 100 })).toHaveLength(1);

    const approvedProposal = await service.createEntry(caller, 'room', content({
      title: 'Date convention A', content: '日期统一写成 YYYY-MM-DD 格式。',
    }), 'near-approved-a');
    const approvedId = resultId(approvedProposal);
    await repository.reviewRoomProposal(roomInstanceId, approvedId, roomOwnerIdentity(), 'approve', 'near-approved-review');
    const approvedEntry = (await repository.listEntries(roomScope, { limit: 100 }))
      .find(entry => entry.title === 'Date convention A')!;
    expect(await service.createEntry(caller, 'room', content({
      title: 'Date convention B', content: '房间交付物和脚本里的日期都用 YYYY-MM-DD。',
    }), 'near-approved-b')).toEqual({ code: 'DUPLICATE', duplicateOf: approvedEntry.id, duplicateKind: 'memory' });

    const distinct = await service.createEntry(caller, 'room', content({
      title: 'Output diagnostics', content: '脚本报错输出到 stderr，退出码用 2。',
    }), 'near-distinct');
    expect(distinct).toMatchObject({ code: 'PENDING_REVIEW' });
    expect(resultId(distinct)).not.toBe(pendingId);

    const personaCaller = trustedCaller(roomInstanceId, `persona-${randomUUID()}`);
    const persona = await service.createEntry(personaCaller, 'persona', content({ title: 'Persona shell', content: shellB }), 'near-persona');
    expect(persona).toMatchObject({ status: 'created' });
  });

  it('rejects self-review and detects stale version snapshots without overwriting newer facts', async () => {
    const roomInstanceId = randomUUID();
    const scope = { roomInstanceId, scope: 'room' as const };
    const proposer = roomOwnerIdentity();
    const created = await repository.createRoomProposal(
      scope, { action: 'create', content: content({ title: 'Original fact' }) }, proposer, 'snapshot-create',
    );
    const reviewer = roomMemberIdentity();
    await expect(repository.reviewRoomProposal(roomInstanceId, created.id, proposer, 'approve', 'self-review'))
      .rejects.toBeInstanceOf(MemoryForbiddenError);
    await repository.reviewRoomProposal(roomInstanceId, created.id, reviewer, 'approve', 'snapshot-approve-create');
    const [entry] = await repository.listEntries(scope);

    const older = await repository.createRoomProposal(
      scope,
      { action: 'update', targetMemoryId: entry!.id, update: { content: 'Older proposed edit' } },
      proposer,
      'snapshot-older',
    );
    const newer = await repository.createRoomProposal(
      scope,
      { action: 'update', targetMemoryId: entry!.id, update: { content: 'Newer accepted fact' } },
      proposer,
      'snapshot-newer',
    );
    await repository.reviewRoomProposal(roomInstanceId, newer.id, reviewer, 'approve', 'snapshot-approve-newer');
    await expect(repository.reviewRoomProposal(roomInstanceId, older.id, reviewer, 'approve', 'snapshot-approve-older'))
      .rejects.toBeInstanceOf(MemoryConflictError);
    expect((await repository.readEntry(scope, entry!.id))?.content).toBe('Newer accepted fact');
    expect((await repository.getRoomProposal(roomInstanceId, older.id))?.status).toBe('superseded');
  });

  it('detects an updated_at-only change against the proposal snapshot', async () => {
    const roomInstanceId = randomUUID();
    const scope = { roomInstanceId, scope: 'room' as const };
    const proposer = roomOwnerIdentity();
    const created = await repository.createRoomProposal(
      scope, { action: 'create', content: content({ title: 'Timestamp snapshot' }) }, proposer, 'timestamp-create',
    );
    const reviewer = roomMemberIdentity();
    await repository.reviewRoomProposal(roomInstanceId, created.id, reviewer, 'approve', 'timestamp-create-review');
    const [entry] = await repository.listEntries(scope);
    const stale = await repository.createRoomProposal(
      scope,
      { action: 'update', targetMemoryId: entry!.id, update: { content: 'Stale proposal' } },
      proposer,
      'timestamp-stale',
    );
    await scopedPool.query(
      `UPDATE agent_memory_entries SET updated_at = updated_at + interval '1 second'
       WHERE room_instance_id = $1 AND id = $2`,
      [roomInstanceId, entry!.id],
    );

    await expect(repository.reviewRoomProposal(roomInstanceId, stale.id, reviewer, 'approve', 'timestamp-stale-review'))
      .rejects.toBeInstanceOf(MemoryConflictError);
    expect((await repository.readEntry(scope, entry!.id))?.content).toBe('Full memory content');
    expect((await repository.getRoomProposal(roomInstanceId, stale.id))?.status).toBe('pending');
  });

  it('rolls back entry application, approval state, and idempotency receipt on constraint failure', async () => {
    const roomInstanceId = randomUUID();
    const scope = { roomInstanceId, scope: 'room' as const };
    const proposal = await repository.createRoomProposal(
      scope,
      { action: 'create', content: content({ title: 'x'.repeat(201) }) },
      roomOwnerIdentity(),
      'rollback-proposal',
    );
    const reviewer = roomMemberIdentity();
    await expect(repository.reviewRoomProposal(roomInstanceId, proposal.id, reviewer, 'approve', 'rollback-approve'))
      .rejects.toMatchObject({ code: '23514' });
    expect((await repository.getRoomProposal(roomInstanceId, proposal.id))?.status).toBe('pending');
    expect(await repository.listEntries(scope)).toEqual([]);
    const receipt = await scopedPool.query(
      `SELECT 1 FROM agent_memory_requests
       WHERE room_instance_id = $1 AND actor_identity_type = $2
         AND actor_identity_id = $3 AND request_id = $4`,
      [roomInstanceId, reviewer.type, reviewer.id, 'rollback-approve'],
    );
    expect(receipt.rowCount).toBe(0);
  });
});

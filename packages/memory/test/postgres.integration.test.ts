import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { applyMemoryMigrations, PostgresMemoryRepository } from '../src/postgres.js';
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
      'SELECT count(*)::text AS count FROM agent_memory_schema_migrations WHERE version = 1',
    );
    expect(versions.rows[0]?.count).toBe('1');

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
    expect((await repository.getRoomProposal(roomInstanceId, older.id))?.status).toBe('pending');
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

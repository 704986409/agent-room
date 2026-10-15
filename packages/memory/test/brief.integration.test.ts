import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  applyMemoryMigrations,
  MemoryBriefService,
  MemoryService,
  PostgresMemoryRepository,
  RedisMemoryBriefSessionStore,
  RedisUrlCommandClient,
  type MemoryContent,
  type TrustedMemoryCaller,
} from '../src/index.js';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MEMORY_TEST_DATABASE_URL is required; PostgreSQL Brief tests do not skip.');
const redisUrl = process.env.MEMORY_TEST_REDIS_URL?.trim();
if (!redisUrl) throw new Error('MEMORY_TEST_REDIS_URL is required; Redis Brief tests do not skip.');

function content(overrides: Partial<MemoryContent> = {}): MemoryContent {
  return {
    title: 'Memory title',
    preview: 'Stored description',
    content: 'Full memory body that should not be copied into the brief.',
    searchText: 'topic-alpha project-context',
    ...overrides,
  };
}

function caller(roomInstanceId: string, personaId: string): TrustedMemoryCaller {
  return { roomInstanceId, personaId, identityType: 'persona' };
}

describe('P4 Memory Brief with PostgreSQL 17 and Redis', () => {
  let admin: Pool;
  let scopedPool: Pool;
  let repository: PostgresMemoryRepository;
  let service: MemoryService;
  let briefs: MemoryBriefService;
  let schemaName: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    const versionNumber = Number(version.rows[0]?.server_version_num);
    if (versionNumber < 170000 || versionNumber >= 180000) {
      throw new Error(`MEMORY_TEST_DATABASE_URL must point to PostgreSQL 17.x; found ${String(version.rows[0]?.server_version_num)}.`);
    }
    schemaName = `memory_brief_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName},public` });
    await applyMemoryMigrations(scopedPool);
    repository = await PostgresMemoryRepository.fromPool(scopedPool);
    service = new MemoryService(repository);
    const redis = new RedisUrlCommandClient(redisUrl!);
    const sessions = new RedisMemoryBriefSessionStore(redis, {
      namespace: `memory-brief-test-${process.pid}-${Date.now().toString(36)}`,
      ttlSeconds: 600,
    });
    briefs = new MemoryBriefService(service, sessions, { authorize: async () => true }, {
      readRoomTopic: async () => 'Verified Room background',
    });
  }, 30_000);

  afterAll(async () => {
    await repository?.close();
    await scopedPool?.end();
    if (schemaName) await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  async function createPersona(
    roomInstanceId: string,
    personaId: string,
    value: MemoryContent,
    requestId: string,
  ): Promise<string> {
    const result = await repository.createPersonaEntry(
      { roomInstanceId, scope: 'persona', personaId },
      value,
      { type: 'persona', id: personaId, personaId },
      requestId,
    );
    return result.id;
  }

  async function createShared(roomInstanceId: string, value: MemoryContent): Promise<string> {
    const proposal = await repository.createRoomProposal(
      { roomInstanceId, scope: 'room' },
      { action: 'create', content: value },
      { type: 'room_owner', id: `owner-${randomUUID()}` },
      `brief-room-create-${randomUUID()}`,
    );
    await repository.reviewRoomProposal(
      roomInstanceId,
      proposal.id,
      { type: 'room_member', id: `reviewer-${randomUUID()}` },
      'approve',
      `brief-room-review-${randomUUID()}`,
    );
    const rows = await repository.listEntries({ roomInstanceId, scope: 'room' });
    return rows[0]!.id;
  }

  it('includes Room-shared and only current Persona-private memories', async () => {
    const roomId = randomUUID();
    const personaA = `persona-a-${randomUUID()}`;
    const personaB = `persona-b-${randomUUID()}`;
    const sharedId = await createShared(roomId, content({ title: 'Shared project decision' }));
    const privateAId = await createPersona(roomId, personaA, content({ title: 'A private direction' }), `brief-a-${randomUUID()}`);
    await createPersona(roomId, personaB, content({ title: 'B confidential direction' }), `brief-b-${randomUUID()}`);

    const result = await briefs.loadOnce(caller(roomId, personaA), 'seat-session-a');
    expect(result.loaded).toBe(true);
    if (!result.loaded) return;
    expect(result.brief).toContain(sharedId);
    expect(result.brief).toContain(privateAId);
    expect(result.brief).toContain('Shared project decision');
    expect(result.brief).toContain('A private direction');
    expect(result.brief).not.toContain('B confidential direction');
    expect(result.brief).not.toContain('Full memory body');
    expect(result.brief).toContain('Important topics');
    expect(result.brief).toContain('Recent changes');
    expect(result.estimated).toBe(true);
  });

  it('returns a Brief once per session, then serves a new-session snapshot after updates', async () => {
    const roomId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const entryId = await createPersona(roomId, personaId, content({ title: 'Before update' }), `brief-once-${randomUUID()}`);
    const seatSessionOne = `seat-session-${randomUUID()}`;

    const first = await briefs.loadOnce(caller(roomId, personaId), seatSessionOne);
    expect(first.loaded).toBe(true);
    const repeated = await briefs.loadOnce(caller(roomId, personaId), seatSessionOne);
    expect(repeated).toEqual({ loaded: false, brief: null, estimated: true, estimatedTokens: 0, memoryIds: [] });

    await repository.updatePersonaEntry(
      { roomInstanceId: roomId, scope: 'persona', personaId },
      entryId,
      { title: 'After update', preview: 'New saved description' },
      { type: 'persona', id: personaId, personaId },
      `brief-update-${randomUUID()}`,
    );
    expect((await briefs.loadOnce(caller(roomId, personaId), seatSessionOne)).loaded).toBe(false);
    const reconnected = await briefs.loadOnce(caller(roomId, personaId), `seat-session-${randomUUID()}`);
    expect(reconnected.loaded).toBe(true);
    if (reconnected.loaded) {
      expect(reconnected.brief).toContain('After update');
      expect(reconnected.brief).not.toContain('Before update');
    }
  });

  it('trims a large structured Brief to its conservative character estimate', async () => {
    const roomId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    for (let index = 0; index < 18; index += 1) {
      await createPersona(roomId, personaId, content({
        title: `Memory ${index} ${'标题'.repeat(80)}`,
        preview: `Preview ${index} ${'详细描述'.repeat(60)}`,
      }), `brief-budget-${index}-${randomUUID()}`);
    }
    const result = await briefs.loadOnce(caller(roomId, personaId), `seat-session-${randomUUID()}`);
    expect(result.loaded).toBe(true);
    if (!result.loaded) return;
    expect(result.brief.length).toBeLessThanOrEqual(1_800);
    expect(result.estimatedTokens).toBe(result.brief.length);
    expect(result.memoryIds.length).toBeGreaterThan(0);
    expect(result.brief).toContain('Recent changes');
  });

  it('refuses unauthorized callers before claiming the session marker', async () => {
    const roomId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    let authorized = false;
    const sessions = new RedisMemoryBriefSessionStore(new RedisUrlCommandClient(redisUrl!), {
      namespace: `memory-brief-deny-${process.pid}-${Date.now().toString(36)}`,
      ttlSeconds: 600,
    });
    const guarded = new MemoryBriefService(service, sessions, { authorize: async () => authorized });
    const sessionKey = `seat-session-${randomUUID()}`;
    await expect(guarded.loadOnce(caller(roomId, personaId), sessionKey))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    authorized = true;
    expect((await guarded.loadOnce(caller(roomId, personaId), sessionKey)).loaded).toBe(true);
  });

  it('maps a database failure to STORAGE_ERROR without recording a one-time load', async () => {
    const roomId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    await scopedPool.query('DROP TABLE agent_memory_entries CASCADE');
    const sessionKey = `seat-session-${randomUUID()}`;
    await expect(briefs.loadOnce(caller(roomId, personaId), sessionKey))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await scopedPool.query('DELETE FROM agent_memory_schema_migrations WHERE version = 1');
    await applyMemoryMigrations(scopedPool);
    const result = await briefs.loadOnce(caller(roomId, personaId), sessionKey);
    expect(result.loaded).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  applyMemoryMigrations,
  MemorySearchService,
  PostgresMemoryRepository,
  RedisSearchSessionStore,
  RedisUrlCommandClient,
  SearchSessionRateLimitError,
  type MemoryContent,
  type TrustedMemoryCaller,
} from '../src/index.js';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MEMORY_TEST_DATABASE_URL is required; PostgreSQL search tests do not skip.');
const redisUrl = process.env.MEMORY_TEST_REDIS_URL?.trim();
if (!redisUrl) throw new Error('MEMORY_TEST_REDIS_URL is required; Redis session tests do not skip.');

function content(overrides: Partial<MemoryContent> = {}): MemoryContent {
  return {
    title: 'Search title',
    preview: 'Search preview',
    content: 'Search body',
    searchText: 'Search title keywords',
    ...overrides,
  };
}

function caller(roomInstanceId: string, personaId: string, identityType: TrustedMemoryCaller['identityType'] = 'persona') {
  return identityType === 'persona'
    ? { roomInstanceId, personaId, identityType } satisfies TrustedMemoryCaller
    : { roomInstanceId, principalId: personaId, identityType } satisfies TrustedMemoryCaller;
}

describe('Agent Memory P3 search with PostgreSQL 17 and Redis', () => {
  let admin: Pool;
  let scopedPool: Pool;
  let repository: PostgresMemoryRepository;
  let service: MemorySearchService;
  let schemaName: string;
  let store: RedisSearchSessionStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    const versionNumber = Number(version.rows[0]?.server_version_num);
    if (versionNumber < 170000 || versionNumber >= 180000) {
      throw new Error(`MEMORY_TEST_DATABASE_URL must point to PostgreSQL 17.x; found ${String(version.rows[0]?.server_version_num)}.`);
    }
    const extension = await admin.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
    );
    if (!extension.rows[0]?.installed) throw new Error('The PostgreSQL test database must have pg_trgm installed.');
    schemaName = `memory_search_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName},public` });
    await applyMemoryMigrations(scopedPool);
    repository = await PostgresMemoryRepository.fromPool(scopedPool);
    const redis = new RedisUrlCommandClient(redisUrl!);
    store = new RedisSearchSessionStore(redis, {
      namespace: `memory-search-test-${process.pid}-${Date.now().toString(36)}`,
      ttlSeconds: 600,
    });
    service = new MemorySearchService(repository, store);
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
    requestId = `search-create-${randomUUID()}`,
  ): Promise<string> {
    const result = await repository.createPersonaEntry(
      { roomInstanceId, scope: 'persona', personaId },
      value,
      { type: 'persona', id: personaId, personaId },
      requestId,
    );
    return result.id;
  }

  async function createRoomEntry(roomInstanceId: string, value: MemoryContent): Promise<string> {
    const proposer = `owner-${randomUUID()}`;
    const reviewer = `member-${randomUUID()}`;
    const proposal = await repository.createRoomProposal(
      { roomInstanceId, scope: 'room' },
      { action: 'create', content: value },
      { type: 'room_owner', id: proposer },
      `room-search-proposal-${randomUUID()}`,
    );
    await repository.reviewRoomProposal(
      roomInstanceId,
      proposal.id,
      { type: 'room_member', id: reviewer },
      'approve',
      `room-search-review-${randomUUID()}`,
    );
    return (await repository.listEntries({ roomInstanceId, scope: 'room' }))[0]!.id;
  }

  it('uses OR recall, metadata tier and keyword hit weighting, returns only five minimal DTOs, and excludes deleted rows', async () => {
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      ids.push(await createPersona(roomInstanceId, personaId, content({
        title: `alpha candidate ${index}`,
        preview: `preview ${index}`,
        content: `PRIVATE-BODY-${index}`,
        searchText: index === 7 ? 'alpha beta' : 'alpha only',
        sourceMessageId: `source-${index}`,
      })));
    }
    await scopedPool.query(
      `UPDATE agent_memory_entries SET updated_at = CASE id
        WHEN $1 THEN timestamptz '2020-01-01 00:00:00+00'
        WHEN $2 THEN timestamptz '2025-01-01 00:00:00+00'
        WHEN $3::uuid THEN timestamptz '2030-01-01 00:00:00+00'
        ELSE timestamptz '2022-01-01 00:00:00+00' END
       WHERE id = ANY($4::uuid[])`,
      [ids[7], ids[0], ids[20], ids],
    );
    await repository.deletePersonaEntry(
      { roomInstanceId, scope: 'persona', personaId },
      ids[20]!,
      { type: 'persona', id: personaId, personaId },
      'search-soft-delete',
    );

    const response = await service.search(caller(roomInstanceId, personaId), {
      keywords: ['alpha', 'beta'], requestId: 'search-or-ranked',
    });
    expect(response.found).toBe(true);
    if (!response.found) return;
    expect(response.results).toHaveLength(5);
    expect(response.results[0]?.id).toBe(ids[7]); // two metadata keywords beat newer one-keyword matches
    expect(response.results.map(row => row.id)).not.toContain(ids[20]);
    for (const row of response.results) {
      expect(Object.keys(row).sort()).toEqual(['id', 'preview', 'title']);
      expect(JSON.stringify(row)).not.toMatch(/PRIVATE-BODY|updated_at|source_message_id|content/);
    }
    expect(response.results[0]).toEqual({ id: ids[7], title: 'alpha candidate 7', preview: 'preview 7' });
  });

  it('sorts all authorized metadata matches before newer body-only matches, then uses updated_at and ID', async () => {
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const oldMetadata = await createPersona(roomInstanceId, personaId, content({
      title: 'relevant metadata', preview: 'metadata preview', content: 'unrelated body', searchText: 'unrelated',
    }));
    const bodyOnly = await createPersona(roomInstanceId, personaId, content({
      title: 'body record', preview: 'body preview', content: 'contains relevant', searchText: 'unrelated',
    }));
    const newerMetadata = await createPersona(roomInstanceId, personaId, content({
      title: 'another relevant title', preview: 'new preview', content: 'unrelated', searchText: 'unrelated',
    }));
    const tiedMetadata = await createPersona(roomInstanceId, personaId, content({
      title: 'tied relevant title', preview: 'tied preview', content: 'unrelated', searchText: 'unrelated',
    }));
    await scopedPool.query(
      `UPDATE agent_memory_entries SET updated_at = CASE id
        WHEN $1 THEN timestamptz '2020-01-01 00:00:00+00'
        WHEN $2 THEN timestamptz '2026-01-01 00:00:00+00'
        ELSE timestamptz '2025-01-01 00:00:00+00' END
       WHERE id = ANY($3::uuid[])`,
      [oldMetadata, bodyOnly, [oldMetadata, bodyOnly, newerMetadata, tiedMetadata]],
    );
    const response = await service.search(caller(roomInstanceId, personaId), {
      keywords: ['relevant'], requestId: 'search-tier-order',
    });
    expect(response.found).toBe(true);
    if (!response.found) return;
    const tiedIds = [newerMetadata, tiedMetadata].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    expect(response.results.map(row => row.id)).toEqual([...tiedIds, oldMetadata, bodyOnly]);
  });

  it('matches Chinese short words and English class, path, and underscore tokens within the trusted scope', async () => {
    const roomInstanceId = randomUUID();
    const cjkPersona = `persona-${randomUUID()}`;
    await createPersona(roomInstanceId, cjkPersona, content({
      title: 'IK约束', preview: '短词结果', content: 'IK joints', searchText: '约束 IK',
    }));
    const cjk = await service.search(caller(roomInstanceId, cjkPersona), {
      keywords: ['约'], requestId: 'short-cjk-search',
    });
    expect(cjk.found).toBe(true);

    const classPersona = `persona-${randomUUID()}`;
    const classId = await createPersona(roomInstanceId, classPersona, content({
      title: 'FABRIK_solver', preview: 'Class result', content: 'solver details',
      searchText: 'engine/animation/FABRIK_solver path_with_underscores',
    }));
    const classPath = await service.search(caller(roomInstanceId, classPersona), {
      keywords: ['FABRIK_solver', 'path_with_underscores'], requestId: 'class-path-search',
    });
    expect(classPath.found).toBe(true);
    if (classPath.found) expect(classPath.results[0]?.id).toBe(classId);
  });

  it('validates keyword count, length, and empty words', async () => {
    const searcher = caller(randomUUID(), `persona-${randomUUID()}`);
    await expect(service.search(searcher, { keywords: [], requestId: 'invalid-none' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.search(searcher, { keywords: ['ok', '  '], requestId: 'invalid-empty' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.search(searcher, {
      keywords: Array.from({ length: 9 }, (_, index) => `term-${index}`), requestId: 'invalid-count',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.search(searcher, { keywords: ['x'.repeat(65)], requestId: 'invalid-long' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('limits a no-hit intent to two searches, replays the same request, and rejects a third request', async () => {
    const searcher = caller(randomUUID(), `persona-${randomUUID()}`);
    const first = await service.search(searcher, { keywords: ['absent'], requestId: 'round-one' });
    expect(first).toMatchObject({ found: false, code: 'NOT_FOUND', retryAllowed: true });
    if (first.found) return;

    expect(await service.search(searcher, {
      keywords: ['changed payload is ignored for an idempotent retry'],
      requestId: 'round-one',
      searchSessionId: first.searchSessionId,
    })).toEqual(first);
    const second = await service.search(searcher, {
      keywords: ['still absent'], requestId: 'round-two', searchSessionId: first.searchSessionId,
    });
    expect(second).toMatchObject({ found: false, code: 'NOT_FOUND', retryAllowed: false });
    await expect(service.search(searcher, {
      keywords: ['third attempt'], requestId: 'round-three', searchSessionId: first.searchSessionId,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('defines forged, expired, and foreign sessions as NOT_FOUND and rate limits new sessions', async () => {
    const firstCaller = caller(randomUUID(), `persona-${randomUUID()}`);
    const otherCaller = caller(firstCaller.roomInstanceId, `persona-${randomUUID()}`);
    await expect(service.search(firstCaller, {
      keywords: ['x'], requestId: 'forged-session', searchSessionId: randomUUID(),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const firstBinding = {
      roomInstanceId: firstCaller.roomInstanceId,
      personaId: firstCaller.personaId,
      identityType: firstCaller.identityType,
    };
    const foreignSession = await store.create(firstBinding);
    await expect(service.search(otherCaller, {
      keywords: ['x'], requestId: 'foreign-session', searchSessionId: foreignSession,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const expiredStore = new RedisSearchSessionStore(new RedisUrlCommandClient(redisUrl!), {
      namespace: `memory-search-expiry-${process.pid}-${Date.now().toString(36)}`,
      ttlSeconds: 1,
    });
    const expiredService = new MemorySearchService(repository, expiredStore);
    const expiredResponse = await expiredService.search(firstCaller, {
      keywords: ['not-present'], requestId: 'expired-session-request',
    });
    expect(expiredResponse).toMatchObject({ found: false, retryAllowed: true });
    if (expiredResponse.found) return;
    await new Promise(resolve => setTimeout(resolve, 1100));
    await expect(expiredService.search(firstCaller, {
      keywords: ['not-present'], requestId: 'expired-session-request',
      searchSessionId: expiredResponse.searchSessionId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const rateCaller = caller(randomUUID(), `persona-${randomUUID()}`);
    const rateBinding = {
      roomInstanceId: rateCaller.roomInstanceId,
      personaId: rateCaller.personaId,
      identityType: rateCaller.identityType,
    };
    const rateStore = new RedisSearchSessionStore(new RedisUrlCommandClient(redisUrl!), {
      namespace: `memory-search-rate-${process.pid}-${Date.now().toString(36)}`,
    });
    for (let index = 0; index < 10; index += 1) await rateStore.create(rateBinding);
    await expect(rateStore.create(rateBinding)).rejects.toBeInstanceOf(SearchSessionRateLimitError);
  }, 10_000);

  it('replays a request without a session ID and preserves the original receipt', async () => {
    const searcher = caller(randomUUID(), `persona-${randomUUID()}`);
    const first = await service.search(searcher, { keywords: ['never-there'], requestId: 'implicit-session-replay' });
    expect(first).toMatchObject({ found: false, retryAllowed: true });
    expect(await service.search(searcher, {
      keywords: ['different terms'], requestId: 'implicit-session-replay',
    })).toEqual(first);
  });

  it('reads long content in bounded cursor pages without gaps and hides unauthorized or deleted records', async () => {
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const original = `${'行🙂abc'.repeat(1200)} tail`;
    const id = await createPersona(roomInstanceId, personaId, content({ content: original }));
    const pages: string[] = [];
    let cursor: string | undefined;
    let page = await service.read(caller(roomInstanceId, personaId), { id, limit: 333 });
    while (true) {
      expect([...page.content].length).toBeLessThanOrEqual(333);
      pages.push(page.content);
      if (!page.hasMore) break;
      expect(page.nextCursor).toBeTruthy();
      cursor = page.nextCursor ?? undefined;
      page = await service.read(caller(roomInstanceId, personaId), { id, limit: 333, cursor });
    }
    expect(pages.join('')).toBe(original);
    await expect(service.read(caller(roomInstanceId, `persona-${randomUUID()}`), { id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await repository.deletePersonaEntry(
      { roomInstanceId, scope: 'persona', personaId }, id,
      { type: 'persona', id: personaId, personaId }, 'read-delete',
    );
    await expect(service.read(caller(roomInstanceId, personaId), { id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.read(caller(roomInstanceId, personaId), { id, limit: 4001 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('searches only current Room and Persona scopes and returns NOT_FOUND for another Room', async () => {
    const roomInstanceId = randomUUID();
    const personaId = `persona-${randomUUID()}`;
    const otherPersonaId = `persona-${randomUUID()}`;
    const privateId = await createPersona(roomInstanceId, personaId, content({
      title: 'private needle', preview: 'private', searchText: 'needle',
    }));
    const otherPrivateId = await createPersona(roomInstanceId, otherPersonaId, content({
      title: 'other needle', preview: 'other', searchText: 'needle',
    }));
    const sharedId = await createRoomEntry(roomInstanceId, content({
      title: 'shared needle', preview: 'shared', searchText: 'needle',
    }));
    const own = await service.search(caller(roomInstanceId, personaId), {
      keywords: ['needle'], requestId: 'scope-own-search',
    });
    expect(own.found).toBe(true);
    if (own.found) {
      expect(own.results.map(row => row.id)).toContain(privateId);
      expect(own.results.map(row => row.id)).toContain(sharedId);
    }
    expect(own.found && own.results.map(row => row.id)).not.toContain(otherPrivateId);

    const roomMember = await service.search(caller(roomInstanceId, `seat-${randomUUID()}`, 'room_member'), {
      keywords: ['needle'], requestId: 'scope-room-member-search',
    });
    expect(roomMember.found).toBe(true);
    if (roomMember.found) {
      expect(roomMember.results.map(row => row.id)).toContain(sharedId);
      expect(roomMember.results.map(row => row.id)).not.toContain(privateId);
    }

    const otherRoom = await service.search(caller(randomUUID(), personaId), {
      keywords: ['needle'], requestId: 'scope-other-room-search',
    });
    expect(otherRoom).toMatchObject({ found: false, code: 'NOT_FOUND' });
    await expect(service.read(caller(roomInstanceId, `persona-${randomUUID()}`), { id: privateId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.read(caller(randomUUID(), personaId), { id: sharedId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps PostgreSQL outages to STORAGE_ERROR and never fabricates NOT_FOUND', async () => {
    const unavailablePool = new Pool({
      host: '127.0.0.1', port: 1, user: 'memory-test', database: 'memory-test',
      connectionTimeoutMillis: 100, max: 1,
    });
    const unavailableRepository = await PostgresMemoryRepository.fromPool(unavailablePool, false);
    const unavailableService = new MemorySearchService(unavailableRepository, store);
    try {
      await expect(unavailableService.search(caller(randomUUID(), `persona-${randomUUID()}`), {
        keywords: ['anything'], requestId: 'search-database-down',
      })).rejects.toMatchObject({ code: 'STORAGE_ERROR', message: 'Memory storage is temporarily unavailable.' });
    } finally {
      await unavailableRepository.close();
      await unavailablePool.end();
    }
  });
});

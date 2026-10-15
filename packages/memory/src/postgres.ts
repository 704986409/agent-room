import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { MemoryRepository } from './repository.js';
import {
  MemoryConflictError,
  MemoryForbiddenError,
  MemorySchemaError,
  type ListMemoryOptions,
  type MemoryContent,
  type MemoryContentSegment,
  type MemoryEntry,
  type MemoryIdentity,
  type MemoryMutationResult,
  type MemoryProposal,
  type MemoryProposalInput,
  type MemoryReviewDecision,
  type MemorySearchCandidate,
  type MemoryScope,
  type MemoryUpdate,
} from './types.js';

const REQUIRED_SCHEMA_VERSION = 2;
const MIGRATION_LOCK_ID = '7319581420361';
const ENTRY_RETURNING = `id, room_instance_id, persona_id, scope, title, preview, content,
  search_text, version, updated_at, created_at, source_message_id, deleted_at`;

export function buildMemorySearchSql(includeShortKeywordPath: boolean): string {
  const shortMetadataHits = includeShortKeywordPath ? `
    UNION ALL
    SELECT k.keyword, e.id, e.title, e.preview, e.updated_at
    FROM short_keywords k
    CROSS JOIN LATERAL (
      SELECT e.id, e.title, e.preview, e.updated_at
      FROM agent_memory_entries e
      WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
        AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
          OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
        AND (strpos(lower(e.title), k.keyword) > 0
          OR strpos(lower(e.search_text), k.keyword) > 0)
    ) e` : '';
  const shortBodyHits = includeShortKeywordPath ? `
    UNION ALL
    SELECT k.keyword, e.id, e.title, e.preview, e.updated_at
    FROM short_keywords k
    CROSS JOIN LATERAL (
      SELECT e.id, e.title, e.preview, e.updated_at
      FROM agent_memory_entries e
      WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
        AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
          OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
        AND strpos(lower(e.content), k.keyword) > 0
        AND NOT EXISTS (SELECT 1 FROM metadata_matches m WHERE m.id = e.id)
    ) e` : '';

  return `
    WITH long_keywords AS MATERIALIZED (
      SELECT DISTINCT lower(word) AS keyword, pattern
      FROM unnest($4::text[], $5::text[]) AS requested(word, pattern)
    ),
    short_keywords AS MATERIALIZED (
      SELECT DISTINCT lower(word) AS keyword
      FROM unnest($6::text[]) AS requested(word)
    ),
    metadata_hit_rows AS MATERIALIZED (
      SELECT k.keyword, e.id, e.title, e.preview, e.updated_at
      FROM long_keywords k
      CROSS JOIN LATERAL (
        SELECT e.id, e.title, e.preview, e.updated_at
        FROM agent_memory_entries e
        WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
          AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
            OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
          AND lower(e.title) LIKE k.pattern
        UNION ALL
        SELECT e.id, e.title, e.preview, e.updated_at
        FROM agent_memory_entries e
        WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
          AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
            OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
          AND lower(e.search_text) LIKE k.pattern
        UNION ALL
        SELECT e.id, e.title, e.preview, e.updated_at
        FROM agent_memory_entries e
        WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
          AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
            OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
          AND lower(e.search_text) % k.keyword
      ) e
      ${shortMetadataHits}
    ),
    metadata_matches AS MATERIALIZED (
      SELECT id, title, preview, updated_at, COUNT(DISTINCT keyword)::int AS matched_keywords
      FROM metadata_hit_rows
      GROUP BY id, title, preview, updated_at
    ),
    body_hit_rows AS MATERIALIZED (
      SELECT k.keyword, e.id, e.title, e.preview, e.updated_at
      FROM long_keywords k
      CROSS JOIN LATERAL (
        SELECT e.id, e.title, e.preview, e.updated_at
        FROM agent_memory_entries e
        WHERE e.room_instance_id = $1 AND e.deleted_at IS NULL
          AND (($2::boolean AND e.scope = 'room' AND e.persona_id IS NULL)
            OR ($3::text IS NOT NULL AND e.scope = 'persona' AND e.persona_id = $3))
          AND lower(e.content) LIKE k.pattern
          AND NOT EXISTS (SELECT 1 FROM metadata_matches m WHERE m.id = e.id)
      ) e
      ${shortBodyHits}
    ),
    body_matches AS MATERIALIZED (
      SELECT id, title, preview, updated_at, COUNT(DISTINCT keyword)::int AS matched_keywords
      FROM body_hit_rows
      GROUP BY id, title, preview, updated_at
    ),
    ranked AS (
      SELECT id, title, preview, updated_at, 0 AS match_tier, matched_keywords
      FROM metadata_matches
      UNION ALL
      SELECT id, title, preview, updated_at, 1 AS match_tier, matched_keywords
      FROM body_matches
    )
    SELECT id, title, preview
    FROM ranked
    ORDER BY match_tier ASC, matched_keywords DESC, updated_at DESC, id ASC
    LIMIT 5
  `;
}

/** Long-keyword query shape used by the standalone benchmark. */
export const MEMORY_SEARCH_SQL = buildMemorySearchSql(false);

type EntryRow = Omit<MemoryEntry, 'version'> & { version: string | number };
type ProposalRow = Omit<MemoryProposal, 'target_version'> & { target_version: string | number | null };
type RequestRow = { result_json: MemoryMutationResult };
type MigrationFile = { version: number; sql: string };

function entryFromRow(row: EntryRow): MemoryEntry {
  return { ...row, version: Number(row.version) };
}

function proposalFromRow(row: ProposalRow): MemoryProposal {
  return {
    ...row,
    target_version: row.target_version === null ? null : Number(row.target_version),
  };
}

function assertRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) {
    throw new TypeError('request_id must contain 1 to 128 characters.');
  }
}

function assertIdentity(identity: MemoryIdentity): void {
  if (!['persona', 'room_member', 'room_owner'].includes(identity.type)) {
    throw new TypeError('Invalid memory actor identity type.');
  }
  if (!identity.id.trim()) throw new TypeError('Memory actor identity is required.');
  if (identity.type === 'persona' && identity.personaId !== identity.id) {
    throw new MemoryForbiddenError('Persona actor identity must match its scoped persona_id.');
  }
  if (identity.type !== 'persona' && identity.personaId !== undefined) {
    throw new MemoryForbiddenError('Non-Persona identities cannot carry a persona_id.');
  }
}

function assertScope(scope: MemoryScope): void {
  if (!scope.roomInstanceId.trim()) throw new TypeError('room_instance_id is required.');
  if (scope.scope === 'persona') {
    if (!scope.personaId.trim()) throw new TypeError('persona_id is required for Persona scope.');
    return;
  }
  if (scope.scope !== 'room') throw new TypeError('Invalid memory scope.');
}

function assertPersonaScope(scope: Extract<MemoryScope, { scope: 'persona' }>, actor: MemoryIdentity): void {
  assertScope(scope);
  assertIdentity(actor);
  if (actor.type !== 'persona' || actor.id !== scope.personaId || actor.personaId !== scope.personaId) {
    throw new MemoryForbiddenError('Persona writes require the matching trusted Persona identity.');
  }
}

function assertProposerIdentity(proposer: MemoryIdentity): void {
  assertIdentity(proposer);
  if (proposer.type === 'persona' && !proposer.personaId) {
    throw new MemoryForbiddenError('Persona proposals require a verified Persona identity.');
  }
}

function assertValidPage(options: ListMemoryOptions): { limit: number; offset: number } {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Memory list limit must be an integer from 1 to 100.');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new TypeError('Memory list offset must be a non-negative integer.');
  }
  return { limit, offset };
}

function assertSearchScopes(scopes: readonly MemoryScope[]): {
  roomInstanceId: string;
  includeRoom: boolean;
  personaId: string | null;
} {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 2) {
    throw new TypeError('Memory search requires one or two authorized scopes.');
  }
  scopes.forEach(assertScope);
  const roomInstanceId = scopes[0]!.roomInstanceId;
  if (scopes.some(scope => scope.roomInstanceId !== roomInstanceId)) {
    throw new MemoryForbiddenError('Memory search scopes must belong to the same Room instance.');
  }
  const roomScopes = scopes.filter(scope => scope.scope === 'room');
  const personaScopes = scopes.filter(scope => scope.scope === 'persona');
  if (roomScopes.length > 1 || personaScopes.length > 1) {
    throw new TypeError('Duplicate memory search scope.');
  }
  return {
    roomInstanceId,
    includeRoom: roomScopes.length === 1,
    personaId: personaScopes[0]?.scope === 'persona' ? personaScopes[0].personaId : null,
  };
}

function assertSearchKeywords(keywords: readonly string[]): string[] {
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 8) {
    throw new TypeError('Memory search requires 1 to 8 keywords.');
  }
  const normalized = keywords.map(keyword => {
    if (typeof keyword !== 'string') throw new TypeError('Memory search keywords must be strings.');
    const value = keyword.normalize('NFKC').trim().toLowerCase();
    if (!value || [...value].length > 64) throw new TypeError('Memory search keyword length is invalid.');
    return value;
  });
  return [...new Set(normalized)];
}

function contentFields(content: MemoryContent) {
  return [content.title, content.preview, content.content, content.searchText, content.sourceMessageId ?? null] as const;
}

function patchFields(current: MemoryEntry, patch: MemoryUpdate) {
  if (Object.keys(patch).length === 0) throw new TypeError('Memory update must change at least one field.');
  return [
    patch.title ?? current.title,
    patch.preview ?? current.preview,
    patch.content ?? current.content,
    patch.searchText ?? current.search_text,
    patch.sourceMessageId === undefined ? current.source_message_id : patch.sourceMessageId,
  ] as const;
}

async function migrationFiles(): Promise<MigrationFile[]> {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const versions = new Set<number>();
  for (const name of names) {
    const match = /^(\d+)_.*\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid memory migration filename: ${name}`);
    const version = Number(match[1]);
    if (versions.has(version)) throw new Error(`Duplicate memory migration version ${version}.`);
    versions.add(version);
    files.push({ version, sql: await readFile(new URL(name, directory), 'utf8') });
  }
  return files;
}

async function assertPostgres17(client: PoolClient): Promise<void> {
  const result = await client.query<{ server_version_num: string }>('SHOW server_version_num');
  const version = Number(result.rows[0]?.server_version_num);
  if (!Number.isInteger(version) || version < 170000 || version >= 180000) {
    throw new Error(`Agent Memory migrations require PostgreSQL 17.x; found server_version_num=${String(result.rows[0]?.server_version_num)}.`);
  }
}

/** Apply numbered SQL files atomically and safely when multiple deploys race. */
export async function applyMemoryMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await assertPostgres17(client);
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID}::bigint)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_memory_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    for (const migration of await migrationFiles()) {
      const applied = await client.query<{ version: number }>(
        'SELECT version FROM agent_memory_schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (applied.rowCount) continue;
      try {
        await client.query(migration.sql);
        const extension = await client.query<{ installed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
        );
        if (!extension.rows[0]?.installed) {
          throw new Error('pg_trgm is not installed in this database. Ask a database administrator to install it, then retry.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/pg_trgm|extension/i.test(message)) {
          throw new Error(
            `Memory migration requires pg_trgm to be installed. CREATE EXTENSION IF NOT EXISTS succeeds when preinstalled; if absent, an administrator must install it before migration. Cause: ${message}`,
            { cause: error },
          );
        }
        throw error;
      }
      await client.query(
        'INSERT INTO agent_memory_schema_migrations (version) VALUES ($1)',
        [migration.version],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface RequestContext {
  roomInstanceId: string;
  actor: MemoryIdentity;
  requestId: string;
}

export class PostgresMemoryRepository implements MemoryRepository {
  private closed = false;

  private constructor(private readonly pool: Pool, private readonly ownsPool: boolean) {}

  static async connect(config: PoolConfig): Promise<PostgresMemoryRepository> {
    const pool = new Pool(config);
    const repository = new PostgresMemoryRepository(pool, true);
    try {
      await repository.verifySchema();
      return repository;
    } catch (error) {
      await repository.close();
      throw error;
    }
  }

  static async fromPool(pool: Pool, verify = true): Promise<PostgresMemoryRepository> {
    const repository = new PostgresMemoryRepository(pool, false);
    if (verify) await repository.verifySchema();
    return repository;
  }

  private async verifySchema(): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await assertPostgres17(client);
      } finally {
        client.release();
      }
      const result = await this.pool.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0)::int AS version FROM agent_memory_schema_migrations',
      );
      const version = Number(result.rows[0]?.version ?? 0);
      if (version < REQUIRED_SCHEMA_VERSION) {
        throw new MemorySchemaError(`Memory schema is behind: expected ${REQUIRED_SCHEMA_VERSION}, found ${version}.`);
      }
    } catch (error) {
      if (error instanceof MemorySchemaError) throw error;
      throw new MemorySchemaError(`Memory schema is not migrated; run the explicit migration command (${String(error)}).`, { cause: error });
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Memory repository is closed.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRequestResult(
    roomInstanceId: string,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult | null> {
    assertIdentity(actor);
    assertRequestId(requestId);
    if (!roomInstanceId.trim()) throw new TypeError('room_instance_id is required.');
    const result = await this.pool.query<RequestRow>(
      `SELECT result_json FROM agent_memory_requests
       WHERE room_instance_id = $1 AND actor_identity_type = $2
         AND actor_identity_id = $3 AND request_id = $4`,
      [roomInstanceId, actor.type, actor.id, requestId],
    );
    return result.rows[0]?.result_json ?? null;
  }

  private async withRequest<T extends MemoryMutationResult>(context: RequestContext, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    assertIdentity(context.actor);
    assertRequestId(context.requestId);
    return this.transaction(async client => {
      const reserved = await client.query(
        `INSERT INTO agent_memory_requests
          (room_instance_id, actor_identity_type, actor_identity_id, request_id,
           result_kind, result_id, result_json)
         VALUES ($1, $2, $3, $4, 'processing', NULL, '{}'::jsonb)
         ON CONFLICT (room_instance_id, actor_identity_type, actor_identity_id, request_id) DO NOTHING
         RETURNING request_id`,
        [context.roomInstanceId, context.actor.type, context.actor.id, context.requestId],
      );
      if (!reserved.rowCount) {
        const existing = await client.query<RequestRow>(
          `SELECT result_json FROM agent_memory_requests
           WHERE room_instance_id = $1 AND actor_identity_type = $2
             AND actor_identity_id = $3 AND request_id = $4
           FOR UPDATE`,
          [context.roomInstanceId, context.actor.type, context.actor.id, context.requestId],
        );
        if (!existing.rows[0]) throw new Error('Idempotency record disappeared after a conflicting insert.');
        return existing.rows[0].result_json as T;
      }

      const result = await operation(client);
      await client.query(
        `UPDATE agent_memory_requests
         SET result_kind = $5, result_id = $6, result_json = $7::jsonb
         WHERE room_instance_id = $1 AND actor_identity_type = $2
           AND actor_identity_id = $3 AND request_id = $4`,
        [context.roomInstanceId, context.actor.type, context.actor.id, context.requestId,
          result.status, result.id || null, JSON.stringify(result)],
      );
      return result;
    });
  }

  async createPersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    content: MemoryContent,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult> {
    assertPersonaScope(scope, actor);
    return this.withRequest({ roomInstanceId: scope.roomInstanceId, actor, requestId }, async client => {
      const id = randomUUID();
      const [title, preview, body, searchText, sourceMessageId] = contentFields(content);
      const result = await client.query(
        `INSERT INTO agent_memory_entries
          (id, room_instance_id, persona_id, scope, title, preview, content, search_text, source_message_id)
         VALUES ($1, $2, $3, 'persona', $4, $5, $6, $7, $8)
         RETURNING version`,
        [id, scope.roomInstanceId, scope.personaId, title, preview, body, searchText, sourceMessageId],
      );
      return { status: 'created', id, version: Number(result.rows[0]?.version ?? 1) };
    });
  }

  async readEntry(scope: MemoryScope, id: string): Promise<MemoryEntry | null> {
    assertScope(scope);
    if (scope.scope === 'persona') {
      const result = await this.pool.query<EntryRow>(
        `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
         WHERE room_instance_id = $1 AND scope = 'persona' AND persona_id = $2
           AND id = $3 AND deleted_at IS NULL`,
        [scope.roomInstanceId, scope.personaId, id],
      );
      return result.rows[0] ? entryFromRow(result.rows[0]) : null;
    }
    const result = await this.pool.query<EntryRow>(
      `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
       WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
         AND id = $2 AND deleted_at IS NULL`,
      [scope.roomInstanceId, id],
    );
    return result.rows[0] ? entryFromRow(result.rows[0]) : null;
  }

  async readContentSegment(
    scopes: readonly MemoryScope[],
    id: string,
    offset: number,
    limit: number,
  ): Promise<MemoryContentSegment | null> {
    const scope = assertSearchScopes(scopes);
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('Memory ID is required.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Memory offset is invalid.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 4000) {
      throw new TypeError('Memory read limit must be from 1 to 4000 characters.');
    }
    const result = await this.pool.query<MemoryContentSegment>(
      `SELECT id, substring(content FROM $5::int FOR $6::int) AS content
       FROM agent_memory_entries
       WHERE room_instance_id = $1 AND deleted_at IS NULL
         AND (($2::boolean AND scope = 'room' AND persona_id IS NULL)
           OR ($3::text IS NOT NULL AND scope = 'persona' AND persona_id = $3))
         AND id = $4`,
      [scope.roomInstanceId, scope.includeRoom, scope.personaId, id, offset + 1, limit + 1],
    );
    return result.rows[0] ?? null;
  }

  async searchEntries(
    scopes: readonly MemoryScope[],
    keywords: readonly string[],
  ): Promise<MemorySearchCandidate[]> {
    const scope = assertSearchScopes(scopes);
    const queryWords = assertSearchKeywords(keywords);
    const longKeywords = queryWords.filter(word => [...word].length >= 3);
    const shortKeywords = queryWords.filter(word => [...word].length < 3);
    const patterns = longKeywords.map(word => `%${word.replace(/[\\%_]/g, '\\$&')}%`);
    const result = await this.pool.query<MemorySearchCandidate>(
      buildMemorySearchSql(shortKeywords.length > 0),
      [scope.roomInstanceId, scope.includeRoom, scope.personaId, longKeywords, patterns, shortKeywords],
    );
    return result.rows;
  }

  async listEntries(scope: MemoryScope, options: ListMemoryOptions = {}): Promise<MemoryEntry[]> {
    assertScope(scope);
    const { limit, offset } = assertValidPage(options);
    const result = scope.scope === 'persona'
      ? await this.pool.query<EntryRow>(
        `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
         WHERE room_instance_id = $1 AND scope = 'persona' AND persona_id = $2
           AND deleted_at IS NULL
         ORDER BY updated_at DESC, id ASC LIMIT $3 OFFSET $4`,
        [scope.roomInstanceId, scope.personaId, limit, offset],
      )
      : await this.pool.query<EntryRow>(
        `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
         WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
           AND deleted_at IS NULL
         ORDER BY updated_at DESC, id ASC LIMIT $2 OFFSET $3`,
        [scope.roomInstanceId, limit, offset],
      );
    return result.rows.map(entryFromRow);
  }

  async updatePersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    id: string,
    patch: MemoryUpdate,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult> {
    assertPersonaScope(scope, actor);
    return this.withRequest({ roomInstanceId: scope.roomInstanceId, actor, requestId }, async client => {
      const selected = await client.query<EntryRow>(
        `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
         WHERE room_instance_id = $1 AND scope = 'persona' AND persona_id = $2
           AND id = $3 AND deleted_at IS NULL FOR UPDATE`,
        [scope.roomInstanceId, scope.personaId, id],
      );
      if (!selected.rows[0]) return { status: 'not_found', id };
      const current = entryFromRow(selected.rows[0]);
      const [title, preview, body, searchText, sourceMessageId] = patchFields(current, patch);
      const updated = await client.query<{ version: string | number }>(
        `UPDATE agent_memory_entries SET title = $4, preview = $5, content = $6,
           search_text = $7, source_message_id = $8, version = version + 1,
           updated_at = clock_timestamp()
         WHERE room_instance_id = $1 AND scope = 'persona' AND persona_id = $2
           AND id = $3 AND deleted_at IS NULL
         RETURNING version`,
        [scope.roomInstanceId, scope.personaId, id, title, preview, body, searchText, sourceMessageId],
      );
      return { status: 'updated', id, version: Number(updated.rows[0]?.version) };
    });
  }

  async deletePersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    id: string,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult> {
    assertPersonaScope(scope, actor);
    return this.withRequest({ roomInstanceId: scope.roomInstanceId, actor, requestId }, async client => {
      const deleted = await client.query<{ version: string | number }>(
        `UPDATE agent_memory_entries SET deleted_at = clock_timestamp(),
           updated_at = clock_timestamp(), version = version + 1
         WHERE room_instance_id = $1 AND scope = 'persona' AND persona_id = $2
           AND id = $3 AND deleted_at IS NULL
         RETURNING version`,
        [scope.roomInstanceId, scope.personaId, id],
      );
      return deleted.rows[0]
        ? { status: 'deleted', id, version: Number(deleted.rows[0].version) }
        : { status: 'not_found', id };
    });
  }

  async createRoomProposal(
    scope: Extract<MemoryScope, { scope: 'room' }>,
    input: MemoryProposalInput,
    proposer: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult> {
    assertScope(scope);
    assertProposerIdentity(proposer);
    if (input.action === 'update' && Object.keys(input.update).length === 0) {
      throw new TypeError('Memory proposal update must change at least one field.');
    }
    return this.withRequest({ roomInstanceId: scope.roomInstanceId, actor: proposer, requestId }, async client => {
      const proposalId = randomUUID();
      let targetMemoryId: string | null = null;
      let targetVersion: number | null = null;
      let targetUpdatedAt: string | null = null;
      let payload: MemoryContent | MemoryUpdate | Record<string, never>;

      if (input.action === 'create') {
        payload = input.content;
      } else {
        targetMemoryId = input.targetMemoryId;
        const target = await client.query<{
          id: string;
          version: string | number;
          updated_at_snapshot: string;
        }>(
          `SELECT id, version, updated_at::text AS updated_at_snapshot FROM agent_memory_entries
           WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
             AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [scope.roomInstanceId, targetMemoryId],
        );
        if (!target.rows[0]) return { status: 'not_found', id: targetMemoryId };
        targetVersion = Number(target.rows[0].version);
        // Preserve PostgreSQL's full timestamp precision; JS Date truncates to milliseconds.
        targetUpdatedAt = target.rows[0].updated_at_snapshot;
        payload = input.action === 'update' ? input.update : {};
      }

      await client.query(
        `INSERT INTO agent_memory_proposals
          (id, room_instance_id, action, target_memory_id, target_version, target_updated_at,
           payload, proposer_persona_id, proposer_identity_type, proposer_identity_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
        [proposalId, scope.roomInstanceId, input.action, targetMemoryId, targetVersion,
          targetUpdatedAt, JSON.stringify(payload), proposer.personaId ?? null,
          proposer.type, proposer.id, requestId],
      );
      return { status: 'pending_review', id: proposalId };
    });
  }

  async getRoomProposal(roomInstanceId: string, proposalId: string): Promise<MemoryProposal | null> {
    const result = await this.pool.query<ProposalRow>(
      `SELECT id, room_instance_id, action, target_memory_id, target_version,
         target_updated_at, payload, proposer_persona_id, proposer_identity_type,
         proposer_identity_id, status, reviewer_identity_type, reviewer_identity_id,
         request_id, created_at, reviewed_at
       FROM agent_memory_proposals
       WHERE room_instance_id = $1 AND id = $2`,
      [roomInstanceId, proposalId],
    );
    return result.rows[0] ? proposalFromRow(result.rows[0]) : null;
  }

  async listPendingRoomProposals(roomInstanceId: string, options: ListMemoryOptions = {}): Promise<MemoryProposal[]> {
    if (!roomInstanceId.trim()) throw new TypeError('room_instance_id is required.');
    const { limit, offset } = assertValidPage(options);
    const result = await this.pool.query<ProposalRow>(
      `SELECT id, room_instance_id, action, target_memory_id, target_version,
         target_updated_at, payload, proposer_persona_id, proposer_identity_type,
         proposer_identity_id, status, reviewer_identity_type, reviewer_identity_id,
         request_id, created_at, reviewed_at
       FROM agent_memory_proposals
       WHERE room_instance_id = $1 AND status = 'pending'
       ORDER BY created_at DESC, id ASC
       LIMIT $2 OFFSET $3`,
      [roomInstanceId, limit, offset],
    );
    return result.rows.map(proposalFromRow);
  }

  async reviewRoomProposal(
    roomInstanceId: string,
    proposalId: string,
    reviewer: MemoryIdentity,
    decision: MemoryReviewDecision,
    requestId: string,
  ): Promise<MemoryMutationResult> {
    assertIdentity(reviewer);
    return this.withRequest({ roomInstanceId, actor: reviewer, requestId }, async client => {
      const selected = await client.query<ProposalRow>(
        `SELECT id, room_instance_id, action, target_memory_id, target_version,
           target_updated_at, payload, proposer_persona_id, proposer_identity_type,
           proposer_identity_id, status, reviewer_identity_type, reviewer_identity_id,
           request_id, created_at, reviewed_at
         FROM agent_memory_proposals
         WHERE room_instance_id = $1 AND id = $2 FOR UPDATE`,
        [roomInstanceId, proposalId],
      );
      if (!selected.rows[0]) return { status: 'not_found', id: proposalId };
      const proposal = proposalFromRow(selected.rows[0]);
      const targetStatus = decision === 'approve' ? 'approved' : 'rejected';
      if (proposal.proposer_identity_type === reviewer.type && proposal.proposer_identity_id === reviewer.id) {
        throw new MemoryForbiddenError('A proposer cannot review their own memory proposal.');
      }
      if (proposal.status !== 'pending') {
        if (proposal.status === targetStatus) return { status: proposal.status, id: proposal.id };
        throw new MemoryConflictError(`Proposal ${proposal.id} is already ${proposal.status}.`);
      }

      let appliedVersion: number | undefined;
      if (decision === 'approve') {
        appliedVersion = await this.applyProposal(client, proposal);
      }
      await client.query(
        `UPDATE agent_memory_proposals
         SET status = $3, reviewer_identity_type = $4, reviewer_identity_id = $5,
             reviewed_at = clock_timestamp()
         WHERE room_instance_id = $1 AND id = $2 AND status = 'pending'`,
        [roomInstanceId, proposal.id, targetStatus, reviewer.type, reviewer.id],
      );
      return {
        status: targetStatus,
        id: proposal.id,
        ...(appliedVersion === undefined ? {} : { version: appliedVersion }),
      };
    });
  }

  private async applyProposal(client: PoolClient, proposal: MemoryProposal): Promise<number | undefined> {
    if (proposal.action === 'create') {
      const content = proposal.payload as MemoryContent;
      const id = randomUUID();
      const [title, preview, body, searchText, sourceMessageId] = contentFields(content);
      await client.query(
        `INSERT INTO agent_memory_entries
          (id, room_instance_id, persona_id, scope, title, preview, content, search_text, source_message_id)
         VALUES ($1, $2, NULL, 'room', $3, $4, $5, $6, $7)`,
        [id, proposal.room_instance_id, title, preview, body, searchText, sourceMessageId],
      );
      return 1;
    }

    const target = await client.query<EntryRow>(
      `SELECT ${ENTRY_RETURNING} FROM agent_memory_entries
       WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
         AND id = $2 AND deleted_at IS NULL AND version = $3
         AND updated_at = (
           SELECT target_updated_at FROM agent_memory_proposals
           WHERE room_instance_id = $1 AND id = $4
         )
       FOR UPDATE`,
      [proposal.room_instance_id, proposal.target_memory_id, proposal.target_version, proposal.id],
    );
    if (!target.rows[0]) throw new MemoryConflictError('Proposal target is no longer active; submit a new proposal.');
    const current = entryFromRow(target.rows[0]);

    if (proposal.action === 'delete') {
      const deleted = await client.query<{ version: string | number }>(
        `UPDATE agent_memory_entries SET deleted_at = clock_timestamp(),
           updated_at = clock_timestamp(), version = version + 1
         WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
           AND id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING version`,
        [proposal.room_instance_id, current.id, current.version],
      );
      if (!deleted.rows[0]) throw new MemoryConflictError('Proposal target changed while applying; submit a new proposal.');
      return Number(deleted.rows[0].version);
    }

    const [title, preview, body, searchText, sourceMessageId] = patchFields(
      current,
      proposal.payload as MemoryUpdate,
    );
    const updated = await client.query<{ version: string | number }>(
      `UPDATE agent_memory_entries SET title = $3, preview = $4, content = $5,
         search_text = $6, source_message_id = $7, version = version + 1,
         updated_at = clock_timestamp()
       WHERE room_instance_id = $1 AND scope = 'room' AND persona_id IS NULL
         AND id = $2 AND version = $8 AND deleted_at IS NULL
       RETURNING version`,
      [proposal.room_instance_id, current.id, title, preview, body, searchText,
        sourceMessageId, current.version],
    );
    if (!updated.rows[0]) throw new MemoryConflictError('Proposal target changed while applying; submit a new proposal.');
    return Number(updated.rows[0].version);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }
}

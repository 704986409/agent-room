import { Pool, type QueryResult } from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEmbedder, embeddingModelFrom, type Embedder } from './embedding/embedder.js';

const DEFAULT_BATCH_SIZE = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BackfillRow = {
  id: string;
  room_instance_id: string;
  title: string;
  content: string;
};

export interface BackfillEmbeddingOptions {
  pool: Pick<Pool, 'query'>;
  embedder: Embedder;
  model?: string;
  roomId?: string;
  batchSize?: number;
  now?: () => number;
}

export interface BackfillEmbeddingResult {
  entriesUpdated: number;
  proposalsUpdated: number;
  skipped: number;
  elapsedMs: number;
}

function vectorsAreValid(value: unknown, count: number): value is number[][] {
  return Array.isArray(value) && value.length === count && value.every(vector =>
    Array.isArray(vector) && vector.length > 0
      && vector.every(number => typeof number === 'number' && Number.isFinite(number)));
}

async function backfillTable(
  input: BackfillEmbeddingOptions & { table: 'entries' | 'proposals'; model: string; batchSize: number },
): Promise<{ updated: number; skipped: number }> {
  let cursor: string | null = null;
  let updated = 0;
  let skipped = 0;

  while (true) {
    const rows: QueryResult<BackfillRow> = input.table === 'entries'
      ? await input.pool.query<BackfillRow>(
        `SELECT id, room_instance_id, title, content
         FROM agent_memory_entries
         WHERE scope = 'room' AND persona_id IS NULL AND deleted_at IS NULL
           AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
           AND ($2::uuid IS NULL OR room_instance_id = $2)
           AND ($3::uuid IS NULL OR id > $3::uuid)
         ORDER BY id LIMIT $4`,
        [input.model, input.roomId ?? null, cursor, input.batchSize],
      )
      : await input.pool.query<BackfillRow>(
        `SELECT id, room_instance_id, payload->>'title' AS title, payload->>'content' AS content
         FROM agent_memory_proposals
         WHERE action = 'create' AND status = 'pending'
           AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
           AND ($2::uuid IS NULL OR room_instance_id = $2)
           AND ($3::uuid IS NULL OR id > $3::uuid)
         ORDER BY id LIMIT $4`,
        [input.model, input.roomId ?? null, cursor, input.batchSize],
      );
    if (rows.rows.length === 0) break;
    cursor = rows.rows[rows.rows.length - 1]!.id;

    let vectors: number[][] | null = null;
    try {
      vectors = await input.embedder.embed(rows.rows.map(row => `${row.title} ${row.content}`));
    } catch {
      vectors = null;
    }
    if (!vectorsAreValid(vectors, rows.rows.length)) {
      skipped += rows.rows.length;
      continue;
    }

    for (const [index, row] of rows.rows.entries()) {
      const vector = vectors[index]!;
      const result = input.table === 'entries'
        ? await input.pool.query(
          `UPDATE agent_memory_entries
           SET embedding = $2::real[], embedding_model = $3
           WHERE id = $1 AND room_instance_id = $4 AND scope = 'room' AND persona_id IS NULL
             AND deleted_at IS NULL AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $3)
             AND title = $5 AND content = $6`,
          [row.id, vector, input.model, row.room_instance_id, row.title, row.content],
        )
        : await input.pool.query(
          `UPDATE agent_memory_proposals
           SET embedding = $2::real[], embedding_model = $3
           WHERE id = $1 AND room_instance_id = $4 AND action = 'create' AND status = 'pending'
             AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $3)
             AND payload->>'title' = $5 AND payload->>'content' = $6`,
          [row.id, vector, input.model, row.room_instance_id, row.title, row.content],
        );
      if (result.rowCount) updated += 1;
      else skipped += 1;
    }
  }

  return { updated, skipped };
}

/** Populate Room entry and pending create-proposal vectors, safely resuming by id. */
export async function backfillEmbeddings(options: BackfillEmbeddingOptions): Promise<BackfillEmbeddingResult> {
  if (options.roomId && !UUID_PATTERN.test(options.roomId)) throw new TypeError('--room must be a UUID.');
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be positive.');
  const started = (options.now ?? Date.now)();
  const model = options.model ?? embeddingModelFrom();
  const shared = { ...options, model, batchSize };
  const entries = await backfillTable({ ...shared, table: 'entries' });
  const proposals = await backfillTable({ ...shared, table: 'proposals' });
  return {
    entriesUpdated: entries.updated,
    proposalsUpdated: proposals.updated,
    skipped: entries.skipped + proposals.skipped,
    elapsedMs: Math.max(0, (options.now ?? Date.now)() - started),
  };
}

function roomArgument(args: string[]): string | undefined {
  const index = args.indexOf('--room');
  if (index < 0) return undefined;
  const roomId = args[index + 1];
  if (!roomId) throw new TypeError('--room requires a UUID.');
  return roomId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const databaseUrl = process.env.MEMORY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL (or MEMORY_DATABASE_URL) is required for embedding backfill.');
  const pool = new Pool({ connectionString: databaseUrl });
  const embedder = createEmbedder();
  try {
    const result = await backfillEmbeddings({ pool, embedder, roomId: roomArgument(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await embedder.close();
    await pool.end();
  }
}

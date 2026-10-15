import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { applyMemoryMigrations, MEMORY_SEARCH_SQL } from '../dist/postgres.js';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('MEMORY_TEST_DATABASE_URL is required; use a dedicated PostgreSQL 17 benchmark database.');
}

const counts = [1_000, 10_000, 100_000];
const sampleRuns = Number(process.env.MEMORY_BENCHMARK_RUNS ?? 25);
if (!Number.isInteger(sampleRuns) || sampleRuns < 5 || sampleRuns > 100) {
  throw new Error('MEMORY_BENCHMARK_RUNS must be between 5 and 100.');
}

function summarizeNode(node) {
  return {
    node: node['Node Type'],
    ...(node['Relation Name'] ? { relation: node['Relation Name'] } : {}),
    ...(node['Index Name'] ? { index: node['Index Name'] } : {}),
    ...(node['Join Type'] ? { join: node['Join Type'] } : {}),
    actualRows: node['Actual Rows'],
    loops: node['Actual Loops'],
    actualTimeMs: [node['Actual Startup Time'], node['Actual Total Time']],
    ...(node['Rows Removed by Filter'] === undefined ? {} : { rowsRemovedByFilter: node['Rows Removed by Filter'] }),
    buffers: {
      hit: node['Shared Hit Blocks'] ?? 0,
      read: node['Shared Read Blocks'] ?? 0,
      dirtied: node['Shared Dirtied Blocks'] ?? 0,
      written: node['Shared Written Blocks'] ?? 0,
    },
    ...(node['Index Cond'] ? { indexCond: node['Index Cond'] } : {}),
    ...(node['Filter'] ? { filter: node['Filter'] } : {}),
    children: (node.Plans ?? []).map(summarizeNode),
  };
}

const admin = new Pool({ connectionString: databaseUrl });
let scoped;
let schemaName;
try {
  const version = await admin.query('SHOW server_version_num');
  const versionNumber = Number(version.rows[0]?.server_version_num);
  if (versionNumber < 170000 || versionNumber >= 180000) {
    throw new Error(`Benchmark requires PostgreSQL 17.x; found ${String(version.rows[0]?.server_version_num)}.`);
  }
  const extension = await admin.query(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
  );
  if (!extension.rows[0]?.installed) throw new Error('Benchmark database must have pg_trgm installed.');

  schemaName = `memory_benchmark_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  scoped = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName},public` });
  await applyMemoryMigrations(scoped);
  const roomInstanceId = randomUUID();
  const personaId = `benchmark-${randomUUID()}`;

  for (const count of counts) {
    await scoped.query('TRUNCATE agent_memory_entries');
    await scoped.query(`
      INSERT INTO agent_memory_entries
        (id, room_instance_id, persona_id, scope, title, preview, content, search_text)
      SELECT gen_random_uuid(), $1, $2, 'persona',
        CASE WHEN n % 997 = 0 THEN 'needle metadata ' ELSE 'sample record ' END || n,
        'preview ' || n,
        CASE WHEN n % 991 = 0 THEN 'needle body fact ' ELSE 'ordinary body fact ' END || n,
        CASE WHEN n % 499 = 0 THEN 'needle alias class path_with_underscore ' ELSE 'ordinary index text ' END || n
      FROM generate_series(1, $3::int) AS series(n)
    `, [roomInstanceId, personaId, count]);
    await scoped.query('ANALYZE agent_memory_entries');

    const params = [roomInstanceId, false, personaId, ['needle'], ['%needle%']];
    await scoped.query(MEMORY_SEARCH_SQL, params); // warm up the query path
    const latencies = [];
    for (let run = 0; run < sampleRuns; run += 1) {
      const started = performance.now();
      await scoped.query(MEMORY_SEARCH_SQL, params);
      latencies.push(performance.now() - started);
    }
    latencies.sort((left, right) => left - right);
    const explain = await scoped.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${MEMORY_SEARCH_SQL}`, params);
    const plan = explain.rows[0]['QUERY PLAN'][0];
    const result = {
      sampleRows: count,
      resultCount: (await scoped.query(MEMORY_SEARCH_SQL, params)).rowCount,
      latencyMs: {
        samples: sampleRuns,
        median: Number(latencies[Math.floor(latencies.length / 2)].toFixed(3)),
        p95: Number(latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(3)),
      },
      explainAnalyzeBuffers: {
        planningTimeMs: plan['Planning Time'],
        executionTimeMs: plan['Execution Time'],
        root: summarizeNode(plan.Plan),
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} finally {
  await scoped?.end();
  if (schemaName) await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin.end();
}

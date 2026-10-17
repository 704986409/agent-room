# Deployment and Operations

## Runtime configuration

Set these values in the API server environment only:

- `MEMORY_ENABLED=true` enables the MCP Memory tools. If it is unset/false, memory tools are absent from `listTools`.
- `MEMORY_DATABASE_URL` or `DATABASE_URL` points to PostgreSQL 17.x. The migration runner reads `DATABASE_URL`.
- Redis session commands use `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or the existing `VITE_UPSTASH_REDIS_REST_*` compatibility variables). `MEMORY_REDIS_URL=redis://...` is available for a private Redis endpoint.
- `MEMORY_REVIEWER_ROLE` optionally names the reviewer role; the default is `project-analyst`.

Do not put database URLs, Redis tokens, seat keys, host keys, or test connection strings in Git, logs, API responses, or docs. Keep PostgreSQL reachable only on a private network or loopback. Use TLS verification for remote services.

The memory API opens a PostgreSQL pool with a per-pool maximum of four connections and a three-second connection timeout. Capacity planning must account for concurrent serverless invocations, not only this per-invocation limit. The memory feature does not change the existing Room Redis TTL.

## Migration

Back up the target database and confirm it is PostgreSQL 17.x with `pg_trgm` installed before deployment. The memory runtime role needs privileges to create the Agent Memory tables and indexes. If `pg_trgm` is already installed, `CREATE EXTENSION IF NOT EXISTS pg_trgm` succeeds without requiring the app role to own the extension. If it is absent and the runtime role cannot install extensions, the migration fails explicitly; have a database administrator install it and rerun.

Run:

```sh
npm run build -w packages/memory
npm run migrate:postgres -w @agent-room/memory
```

`DATABASE_URL` is required by the migration runner. The runner applies numbered migrations under a PostgreSQL advisory transaction lock. Schema version 2 adds the P7 trigram and Room/scope indexes to the original version 1 tables. Schema version 3 adds a nullable `dedup_key` column and a partial unique index so identical pending Room proposals (same action, target, and normalized content) collapse into one; rows created earlier keep `dedup_key` NULL. Migration 004 updates pending proposal states, migration 005 adds trusted system reviewer identity and rejection-reason storage, and migration 006 adds nullable embeddings to Room entries and proposals. Re-running the migration command is safe. No Room table is migrated or recreated.

Schema version 5 adds trusted system reviewer identity support and nullable `review_reason` storage constrained to the three rejection codes. Approvals store NULL. Migration `005_system_reviewer.sql` is applied automatically by the numbered migration runner.

### TypeSafe Jev

When `JEV_API_KEY` is configured, TypeSafe Jev verifies semantically ranked room-memory duplicate candidates and reviews new or updated shared-memory proposals only when no agent holds the configured reviewer role. The reviewer skips delete proposals. Jev errors fall back to the existing owner review flow.

- `JEV_API_KEY`: bearer credential for `https://api.typesafe.ai/v1/systemone`.
- `JEV_MODEL`: model name; defaults to `jev-1.13.0`.
- `JEV_API_URL`: full Jev request endpoint override.
- `JEV_TIMEOUT_MS`: request timeout in milliseconds; defaults to `5000`.
- `MEMORY_DEDUP_VERIFIER`: duplicate verification is on when a key exists; set to `0`, `false`, or `off` to disable it.
- `MEMORY_DEDUP_JEV_THRESHOLD`: duplicate probability cutoff from `0` to `1`; defaults to `0.55`.
- `MEMORY_CONFLICT_JEV_THRESHOLD`: changed-value conflict probability cutoff from `0` to `1`; defaults to `0.7`.
- `MEMORY_DEDUP_CANDIDATE_CAP`: maximum candidates sent together in one request; defaults to `20`.
- `MEMORY_DEDUP_JEV_MAX_CANDIDATES`: legacy alias for `MEMORY_DEDUP_CANDIDATE_CAP`.
- `MEMORY_DEDUP_VERIFIER_URL`: legacy duplicate-verifier endpoint override, retained as a Jev base URL override.
- `MEMORY_JEV_REVIEW`: proposal review is on when a key exists; set to `0`, `false`, or `off` to disable it.

### 语义去重候选

Normalized exact content matches (same title alone is not enough) use the existing exact-match and pending-proposal deduplication paths, before embedding or Jev. For other Room writes, when the Jev duplicate verifier is enabled, the service embeds `${title} ${content}` with `Xenova/bge-small-zh-v1.5` and sends the top candidates to one `verifyMany` call. The default cap is 20 and the default Jev duplicate threshold is 0.55. The same request also asks, per candidate, whether the new memory is the same object and rule with a changed value; above the conflict threshold (default 0.7, and only when no candidate is a duplicate) nothing is written, no room message is sent, and `memory_write` returns `code: CONFLICTS_WITH_EXISTING` with the conflicting entry (`conflictWith`) and guidance to `memory_update` it (or to wait when the conflict is a pending proposal). There is no keyword-only duplicate cutoff. If embeddings are unavailable, or fewer than half of the Room candidates have compatible vectors, candidates are ranked by keyword similarity instead. A Jev error, timeout, or rate limit allows the write to continue to normal owner review.

Configure embeddings in the API server environment:

- `MEMORY_EMBEDDING`: set to `0`, `false`, or `off` to disable. Embeddings are enabled only when the Jev duplicate verifier is enabled.
- `MEMORY_EMBEDDING_MODEL`: model id or local model path; defaults to `Xenova/bge-small-zh-v1.5`.
- `MEMORY_EMBEDDING_CACHE_DIR`: model cache location; defaults to `~/.cache/agent-room/models`.
- `MEMORY_EMBEDDING_ALLOW_DOWNLOAD`: set to `false` to prohibit remote model downloads; defaults to allowing downloads.
- `MEMORY_EMBEDDING_TIMEOUT_MS`: per-call wait limit; defaults to `3000`. A first call can time out while loading; model loading continues in the background.
- `MEMORY_DEDUP_CANDIDATE_CAP`: candidate limit for both ranking and Jev; defaults to `20`.
- `MEMORY_DEDUP_JEV_THRESHOLD`: duplicate probability threshold; defaults to `0.55`.
- `MEMORY_CONFLICT_JEV_THRESHOLD`: conflict probability threshold; defaults to `0.7`.

The fp32 model download is about 90 MB and uses about 250 MB RSS after loading. Single-thread inference is roughly 3 ms per sentence on the deployment target. Model files stay outside Git. After configuring the persistent cache volume, deploy in this order:

```sh
npm run build -w @agent-room/memory
npm run migrate:postgres -w @agent-room/memory
npm run model:download -w @agent-room/memory
npm run backfill:embeddings -w @agent-room/memory
```

The backfill can be limited with `--room <uuid>` and is safe to rerun. It reads `MEMORY_DATABASE_URL` when set, otherwise `DATABASE_URL`, matching the migration runner's database configuration. To fetch the model on first use instead, leave downloads enabled and ensure the cache path is on persistent storage. The worker resolves `./embedWorker.js` from `import.meta.url` inside `packages/memory/dist/embedding`; the VPS bundle externalizes the memory package, and the runtime image copies that package's `dist` files and production `node_modules`, including `onnxruntime-node`. The Debian bookworm-slim runtime uses glibc, as required by `onnxruntime-node`.

For a clean database when the runtime role cannot install the extension, the administrator runs:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Then run the migration command with the normal runtime role.

## Rollback

The normal rollback is application-only:

1. Set `MEMORY_ENABLED=false` or remove it to hide memory tools.
2. Deploy the previous application version.
3. Keep `agent_memory_*` tables, rows, migrations, and indexes in place.

There is no destructive down migration. Do not drop memory tables as part of a code rollback. Migrations 002, 003, and 006 add indexes or nullable columns; retaining them is safe for the previous application version. Index removal is a separate database change that requires review and a verified backup.

## Backup and restore

Take a custom-format backup before migration/deployment:

```sh
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" \
  --file=agent-memory-before.dump --table='agent_memory_*'
```

Restore into a separate PostgreSQL 17 validation database first:

```sh
pg_restore --no-owner --dbname="$MEMORY_RESTORE_URL" agent-memory-before.dump
```

Check schema version, extension state, index definitions, row counts for entries/proposals/briefs/request receipts, and representative scoped reads before using the restore. Record the source and target PostgreSQL versions. Never test a restore by writing into production.

## Verification

PostgreSQL and Redis integration tests require the dedicated PostgreSQL 17 database and Redis endpoint:

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
MEMORY_TEST_REDIS_URL='redis://127.0.0.1:6379' \
npm test -w packages/memory
```

The suite fails if either variable is absent; it does not skip integration tests. Search plan and latency runs use:

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
npm run benchmark:search -w packages/memory
```

The benchmark creates and removes a private schema and emits real `EXPLAIN (ANALYZE, BUFFERS)` plans and measured latency samples. Do not use production data or a production database for these commands.

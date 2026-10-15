# Agent Memory PostgreSQL package

This package owns the Memory V1 PostgreSQL schema, repository, business service, search service, and short-lived search-session storage. It stores only Memory tables; it does not migrate, recreate, or reference `agent_room_rooms`. Room access must be validated by the calling adapter against the current Room and trusted member context. MCP integration remains a later phase.

## Business service (P2)

`MemoryService` is the business boundary above `MemoryRepository`. Every operation receives a server-injected `TrustedMemoryCaller` containing `roomInstanceId`, `personaId`, and `identityType`; request payloads do not supply caller IDs, Room IDs, Persona IDs, names, or roles. The `MemoryCallerContextResolver` seam is reserved for the P6 adapter to validate a seatKey against server-stored seat bindings. The service does not treat a display name or role string as identity.

- Persona read/list/write operations use the caller's Persona scope; only `identityType: 'persona'` can access that private scope. An out-of-scope read returns the same `NOT_FOUND` error as an unknown ID, and a list returns no rows.
- Room reads/lists are limited to the caller's current `roomInstanceId`. Room create/update/delete operations create a Proposal and return `PENDING_REVIEW`; they never write shared entries directly.
- Create and update check active entries in the exact scope for an NFKC, case-normalized title or content match. A match returns up to five `{id,title,preview}` candidates and asks the caller to explicitly update one or clarify the fact. The service never merges or overwrites a fact based on similarity. A different title and normalized content remains a separate fact.
- `sourceMessageId` is an optional, minimal provenance field. It is stored on the entry but is not used as identity or authorization.
- `MemoryCorePrinciplesReader` is a read-only adapter seam for developer-owned file/configuration. The service has no API to create, update, or delete core principles.
- Errors use stable codes (`NOT_FOUND`, `INVALID_INPUT`, `FORBIDDEN`, `PENDING_REVIEW`, `REVIEW_REQUIRED`, `CONFLICT`, `STORAGE_ERROR`). Driver and SQL details are replaced with a generic storage error.

The trusted caller currently requires a Persona ID, including when `identityType` is a server-verified Room member/owner. A host path without a seat Persona must receive a separately trusted principal mapping in a later phase; the service will not synthesize one from a name or role.

## Search and bounded reads (P3)

`MemorySearchService` receives the same server-injected trusted caller plus an injectable `MemorySearchSessionStore`. Persona callers search current Room-shared and their own Persona-private records; non-Persona callers search only Room-shared records. The PostgreSQL repository applies these scopes and `deleted_at IS NULL` before ranking or limiting.

- Search accepts 1–8 non-empty keywords, at most 64 Unicode characters per term and 256 characters total after NFKC normalization. Recall is OR; metadata (title/search keywords) matches rank before body-only matches, hit keyword count ranks within each tier, then `updated_at DESC` and `id ASC` stabilize the result. Short Chinese words and English class/path/underscore tokens use bounded substring matching; terms of at least three characters also use a `pg_trgm` similarity check on search text.
- Search returns at most five DTOs with exactly `{id,title,preview}`. It never returns body, source, or timestamps.
- Each user intent has at most two searches. The first no-hit response allows one retry, the second does not, and a third distinct request fails with `CONFLICT`. Replaying the same `requestId` returns the saved response without using another round. Sessions are bound to the trusted Room/Persona/caller type, expire after 10 minutes, and allow at most 10 new sessions per caller per minute. Forged, expired, and other-caller session IDs return `NOT_FOUND`.
- `RedisSearchSessionStore` stores state only in Redis. `MemorySearchSessionStore` and `RedisCommandClient` are injectable; `RedisUrlCommandClient` supports `redis://` connections, while hosts may adapt their existing Redis client. Redis failures map to `STORAGE_ERROR`.
- `MemorySearchService.read` rechecks Room and Persona scopes on every page and returns at most 4,000 Unicode characters (2,000 by default). Its opaque cursor is tied to the requested memory ID; deleted or out-of-scope entries return `NOT_FOUND`.

Run the search integration coverage with both local services configured:

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
MEMORY_TEST_REDIS_URL='redis://127.0.0.1:6379' \
npm test -w packages/memory
```

Both variables are required; the test suite fails rather than skipping if either is missing. Search plan and latency measurements are recorded in [`BENCHMARK.md`](./BENCHMARK.md). Reproduce them against the dedicated PostgreSQL 17 test database with:

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' \
npm run benchmark:search -w packages/memory
```

## Requirements

- PostgreSQL 17.x.
- Node.js runtime with the repository's pinned `pg@8.16.3` dependency.
- `pg_trgm` installed in the target database. If the application role has permission, the migration's `CREATE EXTENSION IF NOT EXISTS pg_trgm` installs it. If the extension is already installed, the statement succeeds for an unprivileged application role. If it is missing and the application role cannot create extensions, the migration fails with an actionable error; a database administrator must install it, then rerun the migration.
- `DATABASE_URL` is configured only in the server/runtime environment. Never commit it or include it in logs.

## Apply or verify migrations

Build the package, then run its explicit numbered migration runner:

```sh
npm run build -w packages/memory
npm run migrate:postgres -w packages/memory
```

The runner requires `DATABASE_URL`, verifies PostgreSQL 17.x, serializes concurrent migration runs with a PostgreSQL advisory transaction lock, and applies all pending migrations and their version rows in one transaction. It does not migrate the existing Room schema. Re-running the command is safe.

For a new database where the runtime role cannot create extensions, have an administrator connect to the target database and run:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Then run the package migration with the runtime role. This migration is non-destructive and adds only `agent_memory_*` objects. Production rollout requires an approved backup first.

## Backup and restore

Create a custom-format backup of the Memory schema before migration or deployment:

```sh
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file=agent-memory-before.dump --table='agent_memory_*'
```

Restore into a separate, empty PostgreSQL 17 validation database first (do not point a validation restore at production):

```sh
pg_restore --no-owner --dbname="$MEMORY_RESTORE_URL" agent-memory-before.dump
```

Validate the restored schema version, table/index definitions, row counts for `agent_memory_entries`, `agent_memory_proposals`, `agent_memory_briefs`, and `agent_memory_requests`, and representative row reads. Record the source/target PostgreSQL versions and validation results before relying on a production restore.

There is deliberately no destructive down migration. To roll back application code, disable the Memory feature entry point and deploy the previous application version while preserving Memory tables and rows. Dropping the tables is a separate, explicitly approved data-destruction operation and is not part of normal rollback.

## Integration tests

The PostgreSQL integration suite requires a dedicated PostgreSQL 17 test database and `MEMORY_TEST_DATABASE_URL`:

```sh
MEMORY_TEST_DATABASE_URL='postgresql://…/agent_room_memtest' npm test -w packages/memory
```

The test suite fails during collection when the variable is absent, verifies server version 17.x and preinstalled `pg_trgm`, creates a private temporary schema, applies and repeats migrations there, and drops that schema at completion. It never skips the database tests. Do not use a production database for this command.

# Agent Memory PostgreSQL package

This package owns the Memory V1 PostgreSQL schema and repository. It stores only Memory tables; it does not migrate, recreate, or reference `agent_room_rooms`. Room access must be validated by the calling service against the current Room and trusted member context before it supplies a `room_instance_id` or Persona scope. The MCP integration remains outside this P1 package.

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

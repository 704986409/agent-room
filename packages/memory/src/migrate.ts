import { Pool } from 'pg';
import { applyMemoryMigrations } from './postgres.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString?.trim()) {
  throw new Error('DATABASE_URL is required for the explicit Agent Memory migration command.');
}

const pool = new Pool({ connectionString });
try {
  await applyMemoryMigrations(pool);
  process.stdout.write('Agent Memory PostgreSQL schema migrated to version 3.\n');
} finally {
  await pool.end();
}

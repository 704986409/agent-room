import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTGRES_SCHEMA_SQL } from '../src/schema.js';

describe('migration custody', () => {
  it('keeps the shipped migration byte-equivalent to the schema applied by the adapter', () => {
    const path = fileURLToPath(new URL('../migrations/001_durable_room_record.sql', import.meta.url));
    // Git may check out the migration with CRLF on Windows while the source
    // template uses LF. Compare the SQL after canonicalizing only line endings
    // so platform checkout settings do not create a false mismatch.
    const canonicalizeLineEndings = (sql: string) => sql.replace(/\r\n?/g, '\n').trim();
    expect(canonicalizeLineEndings(readFileSync(path, 'utf8')))
      .toBe(canonicalizeLineEndings(POSTGRES_SCHEMA_SQL));
  });
});

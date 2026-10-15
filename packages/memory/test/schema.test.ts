import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Agent Memory migration source', () => {
  it('defines the approved isolated schema, limits, snapshots, and idempotency constraints', () => {
    const path = fileURLToPath(new URL('../migrations/001_agent_memory.sql', import.meta.url));
    const sql = readFileSync(path, 'utf8');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(sql).toContain('char_length(title) <= 200');
    expect(sql).toContain('char_length(preview) <= 300');
    expect(sql).toContain('room_instance_id uuid NOT NULL');
    expect(sql).toContain('target_version bigint NULL');
    expect(sql).toContain('target_updated_at timestamptz NULL');
    expect(sql).toContain('proposer_identity_type');
    expect(sql).toContain('PRIMARY KEY (room_instance_id, actor_identity_type, actor_identity_id, request_id)');
    expect(sql).not.toMatch(/REFERENCES\s+agent_room_rooms/i);
  });
});

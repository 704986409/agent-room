import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMemorySearchSql, MEMORY_SEARCH_SQL } from '../src/postgres.js';

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

    const searchIndexes = readFileSync(
      fileURLToPath(new URL('../migrations/002_search_candidate_indexes.sql', import.meta.url)),
      'utf8',
    );
    expect(searchIndexes).toContain('idx_memory_title_lower_trgm_active');
    expect(searchIndexes).toContain('idx_memory_search_lower_trgm_active');
    expect(searchIndexes).toContain('idx_memory_content_lower_trgm_active');
    expect(searchIndexes).toContain('idx_memory_scope_first_active');
    const dedup = readFileSync(
      fileURLToPath(new URL('../migrations/003_pending_proposal_dedup.sql', import.meta.url)),
      'utf8',
    );
    expect(dedup).toContain('ADD COLUMN IF NOT EXISTS dedup_key');
    expect(dedup).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_proposals_pending_dedup[\s\S]*WHERE status = 'pending' AND dedup_key IS NOT NULL/);

    const reviewer = readFileSync(
      fileURLToPath(new URL('../migrations/005_system_reviewer.sql', import.meta.url)),
      'utf8',
    );
    expect(reviewer).toContain("'system'");
    expect(reviewer).toContain('ADD COLUMN IF NOT EXISTS review_reason text NULL');
    expect(reviewer).toContain("review_reason IN ('无关记忆', '重复记忆', '格式不合规')");
  });

  it('uses scoped indexable predicates for long search terms and keeps short-term fallback', () => {
    expect(MEMORY_SEARCH_SQL).toContain('CROSS JOIN LATERAL');
    expect(MEMORY_SEARCH_SQL).toContain('lower(e.title) LIKE k.pattern');
    expect(MEMORY_SEARCH_SQL).toContain('lower(e.search_text) LIKE k.pattern');
    expect(MEMORY_SEARCH_SQL).toContain('lower(e.search_text) % k.keyword');
    expect(MEMORY_SEARCH_SQL).toContain('lower(e.content) LIKE k.pattern');
    expect(MEMORY_SEARCH_SQL).not.toContain('strpos(');
    expect(MEMORY_SEARCH_SQL).toContain('e.room_instance_id = $1 AND e.deleted_at IS NULL');
    expect(MEMORY_SEARCH_SQL).toContain('ORDER BY match_tier ASC, matched_keywords DESC, updated_at DESC, id ASC');
    expect(MEMORY_SEARCH_SQL).toMatch(/LIMIT\s+5\s*$/);

    const shortKeywordSql = buildMemorySearchSql(true);
    expect(shortKeywordSql).toContain('strpos(lower(e.title), k.keyword) > 0');
    expect(shortKeywordSql).toContain('strpos(lower(e.search_text), k.keyword) > 0');
    expect(shortKeywordSql).toContain('strpos(lower(e.content), k.keyword) > 0');
  });
});

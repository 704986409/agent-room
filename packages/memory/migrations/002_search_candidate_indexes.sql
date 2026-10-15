-- Trigram indexes make literal substring predicates indexable for 3+ character
-- terms. One- and two-character terms retain scoped substring matching in SQL.
CREATE INDEX IF NOT EXISTS idx_memory_title_lower_trgm_active
  ON agent_memory_entries USING GIN (lower(title) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_search_lower_trgm_active
  ON agent_memory_entries USING GIN (lower(search_text) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_content_lower_trgm_active
  ON agent_memory_entries USING GIN (lower(content) gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Search predicates always pin the Room first, then scope/Persona, while
-- excluding soft-deleted rows. The trigram GIN indexes can be bitmap-combined
-- with this B-tree for authorized candidate retrieval.
CREATE INDEX IF NOT EXISTS idx_memory_scope_first_active
  ON agent_memory_entries(room_instance_id, scope, persona_id, updated_at DESC)
  WHERE deleted_at IS NULL;

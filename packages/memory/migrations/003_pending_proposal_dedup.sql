-- Collapse identical pending Room proposals. dedup_key is a server-computed
-- SHA-256 over (action, target, normalized payload). Rows created before this
-- migration keep dedup_key NULL so the partial unique index builds even if
-- older duplicate pending rows exist.
ALTER TABLE agent_memory_proposals ADD COLUMN IF NOT EXISTS dedup_key text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_proposals_pending_dedup
  ON agent_memory_proposals(room_instance_id, dedup_key)
  WHERE status = 'pending' AND dedup_key IS NOT NULL;

ALTER TABLE agent_memory_entries
  ADD COLUMN IF NOT EXISTS embedding real[] NULL,
  ADD COLUMN IF NOT EXISTS embedding_model text NULL;

ALTER TABLE agent_memory_proposals
  ADD COLUMN IF NOT EXISTS embedding real[] NULL,
  ADD COLUMN IF NOT EXISTS embedding_model text NULL;

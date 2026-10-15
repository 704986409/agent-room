CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS agent_memory_entries (
  id uuid PRIMARY KEY,
  room_instance_id uuid NOT NULL,
  persona_id text NULL,
  scope text NOT NULL CHECK (scope IN ('persona', 'room')),
  title text NOT NULL CHECK (char_length(title) <= 200),
  preview text NOT NULL CHECK (char_length(preview) <= 300),
  content text NOT NULL,
  search_text text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_message_id text NULL,
  deleted_at timestamptz NULL,
  CHECK (
    (scope = 'persona' AND persona_id IS NOT NULL) OR
    (scope = 'room' AND persona_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS agent_memory_proposals (
  id uuid PRIMARY KEY,
  room_instance_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  target_memory_id uuid NULL,
  target_version bigint NULL,
  target_updated_at timestamptz NULL,
  payload jsonb NOT NULL,
  proposer_persona_id text NULL,
  proposer_identity_type text NOT NULL
    CHECK (proposer_identity_type IN ('persona', 'room_member', 'room_owner')),
  proposer_identity_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_identity_type text NULL
    CHECK (reviewer_identity_type IS NULL OR reviewer_identity_type IN ('persona', 'room_member', 'room_owner')),
  reviewer_identity_id text NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz NULL,
  CHECK (
    (action = 'create' AND target_memory_id IS NULL AND target_version IS NULL AND target_updated_at IS NULL)
    OR
    (action IN ('update', 'delete') AND target_memory_id IS NOT NULL
      AND target_version IS NOT NULL AND target_updated_at IS NOT NULL)
  ),
  CHECK (
    (proposer_identity_type = 'persona' AND proposer_persona_id IS NOT NULL
      AND proposer_identity_id = proposer_persona_id)
    OR
    (proposer_identity_type IN ('room_member', 'room_owner') AND proposer_persona_id IS NULL)
  ),
  CHECK ((reviewer_identity_type IS NULL) = (reviewer_identity_id IS NULL)),
  UNIQUE (room_instance_id, proposer_identity_type, proposer_identity_id, request_id)
);

CREATE TABLE IF NOT EXISTS agent_memory_briefs (
  room_instance_id uuid NOT NULL,
  persona_id text NOT NULL,
  brief text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_instance_id, persona_id)
);

-- Durable replay receipts cover all mutation types, including repeated updates/deletes.
-- result_json contains only the minimal mutation response, never memory content.
CREATE TABLE IF NOT EXISTS agent_memory_requests (
  room_instance_id uuid NOT NULL,
  actor_identity_type text NOT NULL
    CHECK (actor_identity_type IN ('persona', 'room_member', 'room_owner')),
  actor_identity_id text NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  result_kind text NOT NULL,
  result_id uuid NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_instance_id, actor_identity_type, actor_identity_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_persona_recent
  ON agent_memory_entries(room_instance_id, persona_id, updated_at DESC)
  WHERE scope = 'persona' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_room_recent
  ON agent_memory_entries(room_instance_id, updated_at DESC)
  WHERE scope = 'room' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_search_trgm
  ON agent_memory_entries USING GIN(search_text gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_proposal_pending
  ON agent_memory_proposals(room_instance_id, created_at DESC)
  WHERE status = 'pending';

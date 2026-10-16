-- Jev is a trusted server-side reviewer. Receipt rows use the same identity so
-- repeated system decisions retain the repository's normal idempotency model.
ALTER TABLE agent_memory_proposals
  DROP CONSTRAINT IF EXISTS agent_memory_proposals_reviewer_identity_type_check;
ALTER TABLE agent_memory_proposals
  ADD CONSTRAINT agent_memory_proposals_reviewer_identity_type_check
  CHECK (reviewer_identity_type IS NULL OR reviewer_identity_type IN ('persona', 'room_member', 'room_owner', 'system'));

ALTER TABLE agent_memory_requests
  DROP CONSTRAINT IF EXISTS agent_memory_requests_actor_identity_type_check;
ALTER TABLE agent_memory_requests
  ADD CONSTRAINT agent_memory_requests_actor_identity_type_check
  CHECK (actor_identity_type IN ('persona', 'room_member', 'room_owner', 'system'));

ALTER TABLE agent_memory_proposals
  ADD COLUMN IF NOT EXISTS review_reason text NULL;
ALTER TABLE agent_memory_proposals
  DROP CONSTRAINT IF EXISTS agent_memory_proposals_review_reason_check;
ALTER TABLE agent_memory_proposals
  ADD CONSTRAINT agent_memory_proposals_review_reason_check
  CHECK (review_reason IS NULL OR review_reason IN ('无关记忆', '重复记忆', '格式不合规'));

ALTER TABLE agent_memory_proposals
  DROP CONSTRAINT agent_memory_proposals_status_check;

-- The reviewer who approved the winning change is recorded as reviewer of each superseded proposal.
ALTER TABLE agent_memory_proposals
  ADD CONSTRAINT agent_memory_proposals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'));

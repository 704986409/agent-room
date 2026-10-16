export type MemoryScope =
  | { readonly roomInstanceId: string; readonly scope: 'persona'; readonly personaId: string }
  | { readonly roomInstanceId: string; readonly scope: 'room' };

export type MemoryIdentityType = 'persona' | 'room_member' | 'room_owner';

export interface MemoryIdentity {
  readonly type: MemoryIdentityType;
  readonly id: string;
  /** Set only for Persona actors; human identities must not invent a Persona ID. */
  readonly personaId?: string;
}

export interface MemoryEntry {
  id: string;
  room_instance_id: string;
  persona_id: string | null;
  scope: 'persona' | 'room';
  title: string;
  preview: string;
  content: string;
  search_text: string;
  version: number;
  updated_at: Date;
  created_at: Date;
  source_message_id: string | null;
  deleted_at: Date | null;
}

/** Search repository rows intentionally omit body, source, and timestamps. */
export interface MemorySearchCandidate {
  id: string;
  title: string;
  preview: string;
}

/** A bounded database substring, including one lookahead character. */
export interface MemoryContentSegment {
  id: string;
  content: string;
}

export type MemoryProposalAction = 'create' | 'update' | 'delete';
export type MemoryProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type MemoryReviewDecision = 'approve' | 'reject';

export interface MemoryContent {
  title: string;
  preview: string;
  content: string;
  searchText: string;
  sourceMessageId?: string | null;
}

export interface MemoryUpdate {
  title?: string;
  preview?: string;
  content?: string;
  searchText?: string;
  sourceMessageId?: string | null;
}

export interface CreateMemoryProposal {
  action: 'create';
  content: MemoryContent;
}

export interface UpdateMemoryProposal {
  action: 'update';
  targetMemoryId: string;
  update: MemoryUpdate;
}

export interface DeleteMemoryProposal {
  action: 'delete';
  targetMemoryId: string;
}

export type MemoryProposalInput =
  | CreateMemoryProposal
  | UpdateMemoryProposal
  | DeleteMemoryProposal;

export interface MemoryProposal {
  id: string;
  room_instance_id: string;
  action: MemoryProposalAction;
  target_memory_id: string | null;
  target_version: number | null;
  target_updated_at: Date | null;
  payload: MemoryContent | MemoryUpdate | Record<string, never>;
  proposer_persona_id: string | null;
  proposer_identity_type: MemoryIdentityType;
  proposer_identity_id: string;
  status: MemoryProposalStatus;
  reviewer_identity_type: MemoryIdentityType | null;
  reviewer_identity_id: string | null;
  request_id: string;
  created_at: Date;
  reviewed_at: Date | null;
}

export type MutationStatus =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'not_found'
  | 'pending_review'
  | 'approved'
  | 'rejected';

/** Stable, minimal receipt replayed for an identical request_id. */
export interface MemoryMutationResult {
  status: MutationStatus;
  id: string;
  version?: number;
  /** pending_review only: the existing identical pending proposal that was returned. */
  duplicateOf?: string;
  /** Proposal IDs made obsolete by an approved update or delete. */
  superseded?: string[];
}

export interface ListMemoryOptions {
  limit?: number;
  offset?: number;
}

export class MemorySchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MemorySchemaError';
  }
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

export class MemoryForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryForbiddenError';
  }
}

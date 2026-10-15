import type {
  ListMemoryOptions,
  MemoryContent,
  MemoryEntry,
  MemoryIdentity,
  MemoryMutationResult,
  MemoryProposal,
  MemoryProposalInput,
  MemoryReviewDecision,
  MemoryScope,
  MemoryUpdate,
} from './types.js';

/** PostgreSQL persistence contract. Every read/write carries a trusted scope. */
export interface MemoryRepository {
  getRequestResult(
    roomInstanceId: string,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult | null>;

  createPersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    content: MemoryContent,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult>;

  readEntry(scope: MemoryScope, id: string): Promise<MemoryEntry | null>;
  listEntries(scope: MemoryScope, options?: ListMemoryOptions): Promise<MemoryEntry[]>;

  updatePersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    id: string,
    patch: MemoryUpdate,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult>;

  deletePersonaEntry(
    scope: Extract<MemoryScope, { scope: 'persona' }>,
    id: string,
    actor: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult>;

  createRoomProposal(
    scope: Extract<MemoryScope, { scope: 'room' }>,
    input: MemoryProposalInput,
    proposer: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult>;

  getRoomProposal(roomInstanceId: string, proposalId: string): Promise<MemoryProposal | null>;

  reviewRoomProposal(
    roomInstanceId: string,
    proposalId: string,
    reviewer: MemoryIdentity,
    decision: MemoryReviewDecision,
    requestId: string,
  ): Promise<MemoryMutationResult>;

  close(): Promise<void>;
}

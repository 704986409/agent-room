import type {
  ListMemoryOptions,
  MemoryContent,
  MemoryContentSegment,
  MemoryEntry,
  MemoryIdentity,
  MemoryEmbedding,
  MemoryMutationResult,
  MemoryProposal,
  MemoryProposalInput,
  MemoryReviewDecision,
  MemorySearchCandidate,
  MemoryScope,
  MemoryUpdate,
} from './types.js';
import type { MemoryReviewRejectionReason } from './review-reasons.js';

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
  readContentSegment(
    scopes: readonly MemoryScope[],
    id: string,
    offset: number,
    limit: number,
  ): Promise<MemoryContentSegment | null>;
  listEntries(scope: MemoryScope, options?: ListMemoryOptions): Promise<MemoryEntry[]>;
  searchEntries(
    scopes: readonly MemoryScope[],
    keywords: readonly string[],
  ): Promise<MemorySearchCandidate[]>;

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
    duplicateResult?: MemoryMutationResult,
    embedding?: MemoryEmbedding,
  ): Promise<MemoryMutationResult>;

  findRoomCreateDuplicateCandidates(
    scope: Extract<MemoryScope, { scope: 'room' }>,
  ): Promise<Array<{
    id: string;
    kind: 'memory' | 'proposal';
    title: string;
    content: string;
    embedding: number[] | null;
    embeddingModel?: string | null;
  }>>;

  getRoomProposal(roomInstanceId: string, proposalId: string): Promise<MemoryProposal | null>;
  getRoomProposals(roomInstanceId: string, proposalIds: readonly string[]): Promise<MemoryProposal[]>;
  listPendingRoomProposals(roomInstanceId: string, options?: ListMemoryOptions): Promise<MemoryProposal[]>;

  reviewRoomProposal(
    roomInstanceId: string,
    proposalId: string,
    reviewer: MemoryIdentity,
    decision: MemoryReviewDecision,
    requestId: string,
    reviewReason?: MemoryReviewRejectionReason,
  ): Promise<MemoryMutationResult>;

  close(): Promise<void>;
}

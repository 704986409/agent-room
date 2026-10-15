export { PostgresMemoryRepository, applyMemoryMigrations } from './postgres.js';
export { MemoryService, MemoryServiceError } from './service.js';
export type { MemoryRepository } from './repository.js';
export type {
  DuplicateCandidatesResult,
  MemoryCallerContextResolver,
  MemoryCorePrinciplesReader,
  MemoryEntrySummary,
  MemoryScopeKind,
  MemoryServiceErrorCode,
  MemoryServiceMutationResult,
  MutationCompletedResult,
  PendingReviewResult,
  TrustedMemoryCaller,
} from './service.js';
export {
  MemoryConflictError,
  MemoryForbiddenError,
  MemorySchemaError,
} from './types.js';
export type {
  CreateMemoryProposal,
  DeleteMemoryProposal,
  ListMemoryOptions,
  MemoryContent,
  MemoryEntry,
  MemoryIdentity,
  MemoryIdentityType,
  MemoryMutationResult,
  MemoryProposal,
  MemoryProposalAction,
  MemoryProposalInput,
  MemoryProposalStatus,
  MemoryReviewDecision,
  MemoryScope,
  MemoryUpdate,
  MutationStatus,
  UpdateMemoryProposal,
} from './types.js';

import type { MemoryRepository } from './repository.js';
import { normalizeForDuplicate } from './normalize.js';
import { maxJevCandidatesFrom, resolveDuplicateVerifier, type DuplicateVerifier } from './dedupVerifier.js';
import { findNearDuplicate, embedRoomContent, type MemoryConflict } from './dedup/nearDuplicate.js';
import { embeddingModelFrom, resolveEmbedder, type Embedder } from './embedding/embedder.js';
import {
  MemoryConflictError,
  MemoryForbiddenError,
  type ListMemoryOptions,
  type MemoryContent,
  type MemoryEmbedding,
  type MemoryEntry,
  type MemoryIdentity,
  type MemoryProposerIdentityType,
  type MemoryMutationResult,
  type MemoryProposalInput,
  type MemoryScope,
  type MemoryUpdate,
} from './types.js';

export type MemoryScopeKind = 'persona' | 'room';
export type MemoryServiceErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'PENDING_REVIEW'
  | 'REVIEW_REQUIRED'
  | 'REVIEWER_UNAVAILABLE'
  | 'CONFLICT'
  | 'STORAGE_ERROR';

/** Trusted context injected by the server after resolving the caller's seat. */
export interface TrustedMemoryCaller {
  readonly roomInstanceId: string;
  readonly identityType: MemoryProposerIdentityType;
  readonly personaId?: string;
  /** Stable server-assigned identity for room_member / room_owner callers. */
  readonly principalId?: string;
}

/** P6 adapter seam: verify an opaque seatKey and return server-stored seat context. */
export interface MemoryCallerContextResolver {
  resolveSeatKey(seatKey: string): Promise<TrustedMemoryCaller | null>;
}

/** Read-only adapter reserved for loading developer-owned core principles. */
export interface MemoryCorePrinciplesReader {
  read(): Promise<readonly string[]>;
}

export interface MemoryEntrySummary {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
}

/** Server-authorized structured fields used to render the short join Brief. */
export interface MemoryBriefSourceEntry {
  readonly id: string;
  readonly scope: 'room' | 'persona';
  readonly title: string;
  readonly preview: string;
  readonly searchText: string;
  readonly updatedAt: Date;
}

export interface DuplicateCandidatesResult {
  readonly status: 'duplicate_candidates';
  readonly candidates: readonly MemoryEntrySummary[];
  readonly guidance: 'update_existing_or_clarify';
}

/**
 * A Room create that would contradict an existing approved memory or pending proposal
 * (same object and rule, changed value). Nothing is written and no room message is sent;
 * the agent should memory_update the returned entry instead.
 */
export interface ConflictsWithExistingResult {
  readonly code: 'CONFLICTS_WITH_EXISTING';
  readonly conflictWith: {
    readonly id: string;
    readonly kind: 'memory' | 'proposal';
    readonly title: string;
    readonly content: string;
  };
  readonly guidance: 'memory_update_existing' | 'wait_for_pending_review';
  readonly message: string;
}

export interface MutationCompletedResult {
  readonly status: 'created' | 'updated' | 'deleted';
  readonly id: string;
  readonly version?: number;
}

export interface PendingReviewResult {
  readonly code: 'PENDING_REVIEW';
  readonly proposalId: string;
  /** Set when an identical pending proposal already existed and was returned instead. */
  readonly duplicateOf?: string;
}

export interface DuplicateMemoryResult {
  readonly code: 'DUPLICATE';
  readonly duplicateOf: string;
  readonly duplicateKind: 'memory';
  /** The existing equivalent memory. Present on fresh results; omitted on idempotent replays. */
  readonly existing?: { readonly id: string; readonly title: string; readonly content: string };
}

export type MemoryServiceMutationResult =
  | DuplicateCandidatesResult
  | MutationCompletedResult
  | DuplicateMemoryResult
  | PendingReviewResult
  | ConflictsWithExistingResult;

const ERROR_MESSAGES: Record<MemoryServiceErrorCode, string> = {
  NOT_FOUND: 'Memory not found.',
  INVALID_INPUT: 'Invalid memory request.',
  FORBIDDEN: 'Memory access is not allowed.',
  PENDING_REVIEW: 'This memory change requires review.',
  REVIEW_REQUIRED: 'A verified reviewer is required.',
  REVIEWER_UNAVAILABLE: 'This reviewer seat is offline; refresh presence with room_listen, then retry.',
  CONFLICT: 'Memory operation conflicts with the current state.',
  STORAGE_ERROR: 'Memory storage is temporarily unavailable.',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const MAX_DUPLICATE_CANDIDATES = 5;

export interface MemoryServiceOptions {
  /** null explicitly disables verification; omitted resolves from the environment. */
  duplicateVerifier?: DuplicateVerifier | null;
  /** Overrides the candidate cap for deterministic adapter tests and live evaluation. */
  duplicateVerifierMaxCandidates?: number;
  /** null explicitly disables embeddings; omitted resolves from the environment. */
  embedder?: Embedder | null;
  /** Overrides MEMORY_EMBEDDING_MODEL for injected embedders. */
  embeddingModel?: string;
}

export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MemoryServiceError';
  }
}

function isIdentityType(value: unknown): value is MemoryProposerIdentityType {
  return value === 'persona' || value === 'room_member' || value === 'room_owner';
}

function validateCaller(caller: TrustedMemoryCaller): TrustedMemoryCaller {
  const validPersona = typeof caller?.personaId === 'string' && Boolean(caller.personaId.trim());
  const validPrincipal = typeof caller?.principalId === 'string' && Boolean(caller.principalId.trim());
  if (!caller || typeof caller !== 'object'
    || typeof caller.roomInstanceId !== 'string'
    || !UUID_PATTERN.test(caller.roomInstanceId)
    || !isIdentityType(caller.identityType)
    || (caller.identityType === 'persona'
      ? !validPersona
      : !validPrincipal || caller.personaId !== undefined)) {
    throw new MemoryForbiddenError('A trusted Room seat context is required.');
  }
  // Copy only server-derived fields. Agent-controlled name, role, or IDs are never read.
  return {
    roomInstanceId: caller.roomInstanceId,
    identityType: caller.identityType,
    ...(caller.identityType === 'persona' ? { personaId: caller.personaId } : { principalId: caller.principalId }),
  };
}

function identityFor(caller: TrustedMemoryCaller): MemoryIdentity {
  if (caller.identityType === 'persona') {
    return { type: 'persona', id: caller.personaId!, personaId: caller.personaId! };
  }
  return { type: caller.identityType, id: caller.principalId! };
}

function scopeFor(caller: TrustedMemoryCaller, kind: MemoryScopeKind): MemoryScope {
  if (kind === 'persona') {
    if (caller.identityType !== 'persona') {
      throw new MemoryForbiddenError('Persona memory requires the matching Persona seat.');
    }
    return { roomInstanceId: caller.roomInstanceId, scope: 'persona', personaId: caller.personaId! };
  }
  if (kind === 'room') return { roomInstanceId: caller.roomInstanceId, scope: 'room' };
  throw new TypeError('Invalid memory scope.');
}

function readScopeFor(caller: TrustedMemoryCaller, kind: MemoryScopeKind): MemoryScope | null {
  if (kind === 'persona' && caller.identityType !== 'persona') return null;
  return scopeFor(caller, kind);
}

function validateRequestId(requestId: string): string {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
    throw new TypeError('request_id must contain 1 to 128 characters.');
  }
  return requestId;
}

function validateEntryId(id: string): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new TypeError('memory_id must be a UUID.');
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  if (maxLength !== undefined && [...value].length > maxLength) {
    throw new TypeError(`${field} exceeds its maximum length.`);
  }
  return value;
}

function validateOptionalSource(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('source_message_id must be a string or null.');
  return value;
}

function validateContent(value: MemoryContent): MemoryContent {
  if (!isRecord(value)) throw new TypeError('Memory content is required.');
  const title = requiredText(value.title, 'title', 200);
  const preview = value.preview;
  const body = requiredText(value.content, 'content');
  const searchText = value.searchText;
  if (typeof preview !== 'string' || [...preview].length > 300) {
    throw new TypeError('preview must be a string of at most 300 characters.');
  }
  if (typeof searchText !== 'string') throw new TypeError('searchText must be a string.');
  return {
    title,
    preview,
    content: body,
    searchText,
    sourceMessageId: validateOptionalSource(value.sourceMessageId),
  };
}

function validateUpdate(value: MemoryUpdate): MemoryUpdate {
  if (!isRecord(value)) throw new TypeError('Memory update is required.');
  const allowed = new Set(['title', 'preview', 'content', 'searchText', 'sourceMessageId']);
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !allowed.has(key))) {
    throw new TypeError('Memory update must contain supported fields.');
  }
  const update: MemoryUpdate = {};
  if ('title' in value) update.title = requiredText(value.title, 'title', 200);
  if ('preview' in value) {
    if (typeof value.preview !== 'string' || [...value.preview].length > 300) {
      throw new TypeError('preview must be a string of at most 300 characters.');
    }
    update.preview = value.preview;
  }
  if ('content' in value) update.content = requiredText(value.content, 'content');
  if ('searchText' in value) {
    if (typeof value.searchText !== 'string') throw new TypeError('searchText must be a string.');
    update.searchText = value.searchText;
  }
  if ('sourceMessageId' in value) update.sourceMessageId = validateOptionalSource(value.sourceMessageId);
  return update;
}

function mergeUpdate(entry: MemoryEntry, update: MemoryUpdate): MemoryContent {
  return {
    title: update.title ?? entry.title,
    preview: update.preview ?? entry.preview,
    content: update.content ?? entry.content,
    searchText: update.searchText ?? entry.search_text,
    sourceMessageId: update.sourceMessageId === undefined ? entry.source_message_id : update.sourceMessageId,
  };
}



function isExactDuplicate(entry: MemoryEntry, candidate: MemoryContent): boolean {
  return normalizeForDuplicate(entry.title) === normalizeForDuplicate(candidate.title)
    || normalizeForDuplicate(entry.content) === normalizeForDuplicate(candidate.content);
}

function duplicateMemoryResult(entry: { id: string; title: string; content: string }): DuplicateMemoryResult {
  return {
    code: 'DUPLICATE',
    duplicateOf: entry.id,
    duplicateKind: 'memory',
    existing: { id: entry.id, title: entry.title, content: entry.content },
  };
}

function conflictResult(conflict: MemoryConflict): ConflictsWithExistingResult {
  const isMemory = conflict.kind === 'memory';
  return {
    code: 'CONFLICTS_WITH_EXISTING',
    conflictWith: { id: conflict.id, kind: conflict.kind, title: conflict.title, content: conflict.content },
    guidance: isMemory ? 'memory_update_existing' : 'wait_for_pending_review',
    message: isMemory
      ? `房间已有同一规则的记忆但值不同：「${conflict.content}」。没有新写记忆；请用 memory_update 更新这条（id ${conflict.id}），不要在房间里发消息。`
      : `已有同一规则但值不同的待审提议：「${conflict.content}」。没有新写记忆；等它审核后再用 memory_update 更新，不要在房间里发消息。`,
  };
}

function toServiceMutation(result: MemoryMutationResult): MemoryServiceMutationResult {
  if (result.status === 'not_found') throw new MemoryServiceError('NOT_FOUND');
  if (result.status === 'pending_review') {
    return { code: 'PENDING_REVIEW', proposalId: result.id, ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}) };
  }
  if (result.status === 'duplicate' && result.duplicateOf) {
    return { code: 'DUPLICATE', duplicateOf: result.duplicateOf, duplicateKind: 'memory' };
  }
  if (result.status === 'created' || result.status === 'updated' || result.status === 'deleted') {
    return { status: result.status, id: result.id, ...(result.version === undefined ? {} : { version: result.version }) };
  }
  throw new MemoryServiceError('CONFLICT');
}

/**
 * Business boundary for Memory writes and reads. The caller must be injected by a
 * server-side seat resolver; MCP payload fields are never used to construct it.
 */
export class MemoryService {
  private readonly duplicateVerifier: DuplicateVerifier | undefined;
  private readonly duplicateVerifierMaxCandidates: number;
  private readonly embedder: Embedder | undefined;
  private readonly embeddingModel: string;

  constructor(private readonly repository: MemoryRepository, options: MemoryServiceOptions = {}) {
    this.duplicateVerifier = options.duplicateVerifier === null
      ? undefined
      : options.duplicateVerifier ?? resolveDuplicateVerifier();
    this.embedder = options.embedder === null ? undefined : options.embedder ?? resolveEmbedder();
    this.embeddingModel = options.embeddingModel ?? embeddingModelFrom();
    this.duplicateVerifierMaxCandidates = Number.isSafeInteger(options.duplicateVerifierMaxCandidates)
      && options.duplicateVerifierMaxCandidates! > 0
      ? options.duplicateVerifierMaxCandidates!
      : maxJevCandidatesFrom();
  }

  async readEntry(caller: TrustedMemoryCaller, kind: MemoryScopeKind, id: string): Promise<MemoryEntry> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scope = readScopeFor(trusted, kind);
      if (!scope) throw new MemoryServiceError('NOT_FOUND');
      const entryId = validateEntryId(id);
      const entry = await this.repository.readEntry(scope, entryId);
      if (!entry) throw new MemoryServiceError('NOT_FOUND');
      return entry;
    });
  }

  async listEntries(
    caller: TrustedMemoryCaller,
    kind: MemoryScopeKind,
    options: ListMemoryOptions = {},
  ): Promise<MemoryEntrySummary[]> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scope = readScopeFor(trusted, kind);
      if (!scope) return [];
      const entries = await this.repository.listEntries(scope, options);
      return entries.map(({ id, title, preview }) => ({ id, title, preview }));
    });
  }

  /**
   * Return only the caller's Room-shared and own Persona entries for Brief
   * generation. Other Persona scopes are never queried by this method.
   */
  async listBriefSourceEntries(caller: TrustedMemoryCaller): Promise<MemoryBriefSourceEntry[]> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scopes: MemoryScope[] = [{ roomInstanceId: trusted.roomInstanceId, scope: 'room' }];
      if (trusted.identityType === 'persona') {
        scopes.push({ roomInstanceId: trusted.roomInstanceId, scope: 'persona', personaId: trusted.personaId! });
      }
      const pages = await Promise.all(scopes.map(scope =>
        this.repository.listEntries(scope, { limit: 100, offset: 0 }),
      ));
      return pages.flatMap((entries, index) => entries.map(entry => ({
        id: entry.id,
        scope: scopes[index]!.scope,
        title: entry.title,
        preview: entry.preview,
        searchText: entry.search_text,
        updatedAt: entry.updated_at,
      })));
    });
  }

  async createEntry(
    caller: TrustedMemoryCaller,
    kind: MemoryScopeKind,
    value: MemoryContent,
    requestId: string,
  ): Promise<MemoryServiceMutationResult> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scope = scopeFor(trusted, kind);
      const content = validateContent(value);
      const idempotencyKey = validateRequestId(requestId);
      const identity = identityFor(trusted);
      const replay = await this.requestReplay(trusted, identity, idempotencyKey);
      if (replay) return toServiceMutation(replay);

      const candidates = await this.findDuplicateCandidates(scope, content);
      if (candidates.length) {
        const concurrentReplay = await this.requestReplay(trusted, identity, idempotencyKey);
        if (concurrentReplay) return toServiceMutation(concurrentReplay);
        return this.exactOrCandidatesResult(candidates, content);
      }

      let nearDuplicateResult: MemoryMutationResult | undefined;
      let nearDuplicateEntry: { id: string; title: string; content: string } | undefined;
      let embedding: MemoryEmbedding | undefined;
      if (scope.scope === 'room' && this.duplicateVerifier) {
        const nearDuplicate = await findNearDuplicate({
          repository: this.repository,
          scope,
          content,
          verifier: this.duplicateVerifier,
          embedder: this.embedder,
          embeddingModel: this.embeddingModel,
          cap: this.duplicateVerifierMaxCandidates,
        });
        nearDuplicateResult = nearDuplicate.duplicateResult;
        nearDuplicateEntry = nearDuplicate.duplicateEntry;
        embedding = nearDuplicate.embedding;
        if (nearDuplicate.conflict) {
          const concurrentReplay = await this.requestReplay(trusted, identity, idempotencyKey);
          if (concurrentReplay) return toServiceMutation(concurrentReplay);
          return conflictResult(nearDuplicate.conflict);
        }
      }

      const result = scope.scope === 'persona'
        ? await this.repository.createPersonaEntry(scope, content, identity, idempotencyKey)
        : await this.repository.createRoomProposal(
          scope,
          { action: 'create', content },
          identity,
          idempotencyKey,
          nearDuplicateResult,
          embedding,
        );
      const mutation = toServiceMutation(result);
      if ('code' in mutation && mutation.code === 'DUPLICATE' && nearDuplicateEntry?.id === mutation.duplicateOf) {
        return duplicateMemoryResult(nearDuplicateEntry);
      }
      return mutation;
    });
  }

  async updateEntry(
    caller: TrustedMemoryCaller,
    kind: MemoryScopeKind,
    id: string,
    value: MemoryUpdate,
    requestId: string,
  ): Promise<MemoryServiceMutationResult> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scope = scopeFor(trusted, kind);
      const entryId = validateEntryId(id);
      const update = validateUpdate(value);
      const idempotencyKey = validateRequestId(requestId);
      const identity = identityFor(trusted);
      const replay = await this.requestReplay(trusted, identity, idempotencyKey);
      if (replay) return toServiceMutation(replay);

      const current = await this.repository.readEntry(scope, entryId);
      if (!current) throw new MemoryServiceError('NOT_FOUND');
      const candidateContent = mergeUpdate(current, update);
      const candidates = await this.findDuplicateCandidates(scope, candidateContent, entryId);
      if (candidates.length) {
        const concurrentReplay = await this.requestReplay(trusted, identity, idempotencyKey);
        if (concurrentReplay) return toServiceMutation(concurrentReplay);
        return this.exactOrCandidatesResult(candidates, candidateContent);
      }

      const embedding = scope.scope === 'room' && this.duplicateVerifier
        ? await embedRoomContent(candidateContent, this.embedder, this.embeddingModel)
        : undefined;
      const result = scope.scope === 'persona'
        ? await this.repository.updatePersonaEntry(scope, entryId, update, identity, idempotencyKey)
        : await this.repository.createRoomProposal(
          scope,
          { action: 'update', targetMemoryId: entryId, update } satisfies MemoryProposalInput,
          identity,
          idempotencyKey,
          undefined,
          embedding,
        );
      return toServiceMutation(result);
    });
  }

  async deleteEntry(
    caller: TrustedMemoryCaller,
    kind: MemoryScopeKind,
    id: string,
    requestId: string,
  ): Promise<MemoryServiceMutationResult> {
    return this.execute(async () => {
      const trusted = validateCaller(caller);
      const scope = scopeFor(trusted, kind);
      const entryId = validateEntryId(id);
      const idempotencyKey = validateRequestId(requestId);
      const identity = identityFor(trusted);
      const replay = await this.requestReplay(trusted, identity, idempotencyKey);
      if (replay) return toServiceMutation(replay);

      const result = scope.scope === 'persona'
        ? await this.repository.deletePersonaEntry(scope, entryId, identity, idempotencyKey)
        : await this.repository.createRoomProposal(
          scope,
          { action: 'delete', targetMemoryId: entryId },
          identity,
          idempotencyKey,
        );
      return toServiceMutation(result);
    });
  }

  private async requestReplay(
    caller: TrustedMemoryCaller,
    identity: MemoryIdentity,
    requestId: string,
  ): Promise<MemoryMutationResult | null> {
    return this.repository.getRequestResult(caller.roomInstanceId, identity, requestId);
  }

  private async findDuplicateCandidates(
    scope: MemoryScope,
    content: MemoryContent,
    excludedId?: string,
  ): Promise<MemoryEntry[]> {
    const matches: MemoryEntry[] = [];
    let offset = 0;
    while (true) {
      const page = await this.repository.listEntries(scope, { limit: PAGE_SIZE, offset });
      for (const entry of page) {
        if (entry.id !== excludedId && isExactDuplicate(entry, content)) {
          matches.push(entry);
          if (matches.length === MAX_DUPLICATE_CANDIDATES) break;
        }
      }
      if (matches.length === MAX_DUPLICATE_CANDIDATES || page.length < PAGE_SIZE) break;
      offset += page.length;
    }
    return matches.slice(0, MAX_DUPLICATE_CANDIDATES);
  }

  /**
   * Same normalized content -> the silent DUPLICATE shape used by the Jev path (no Jev call).
   * Same title with different content is not a duplicate; it keeps the legacy
   * duplicate_candidates guidance so the agent can update or clarify.
   */
  private exactOrCandidatesResult(
    matches: MemoryEntry[],
    content: MemoryContent,
  ): DuplicateMemoryResult | DuplicateCandidatesResult {
    const exact = matches.find(entry =>
      normalizeForDuplicate(entry.content) === normalizeForDuplicate(content.content));
    if (exact) return duplicateMemoryResult(exact);
    return {
      status: 'duplicate_candidates',
      candidates: matches.map(({ id, title, preview }) => ({ id, title, preview })),
      guidance: 'update_existing_or_clarify',
    };
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      if (error instanceof MemoryForbiddenError) throw new MemoryServiceError('FORBIDDEN');
      if (error instanceof MemoryConflictError) throw new MemoryServiceError('CONFLICT');
      if (error instanceof TypeError) throw new MemoryServiceError('INVALID_INPUT');
      // Never return driver messages, SQL, connection details, or schema names to callers.
      throw new MemoryServiceError('STORAGE_ERROR');
    }
  }
}

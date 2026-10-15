import type { MemoryRepository } from './repository.js';
import {
  MemoryConflictError,
  MemoryForbiddenError,
  type ListMemoryOptions,
  type MemoryContent,
  type MemoryEntry,
  type MemoryIdentity,
  type MemoryIdentityType,
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
  | 'CONFLICT'
  | 'STORAGE_ERROR';

/** Trusted context injected by the server after resolving the caller's seat. */
export interface TrustedMemoryCaller {
  readonly roomInstanceId: string;
  readonly personaId: string;
  readonly identityType: MemoryIdentityType;
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

export interface DuplicateCandidatesResult {
  readonly status: 'duplicate_candidates';
  readonly candidates: readonly MemoryEntrySummary[];
  readonly guidance: 'update_existing_or_clarify';
}

export interface MutationCompletedResult {
  readonly status: 'created' | 'updated' | 'deleted';
  readonly id: string;
  readonly version?: number;
}

export interface PendingReviewResult {
  readonly code: 'PENDING_REVIEW';
  readonly proposalId: string;
}

export type MemoryServiceMutationResult =
  | DuplicateCandidatesResult
  | MutationCompletedResult
  | PendingReviewResult;

const ERROR_MESSAGES: Record<MemoryServiceErrorCode, string> = {
  NOT_FOUND: 'Memory not found.',
  INVALID_INPUT: 'Invalid memory request.',
  FORBIDDEN: 'Memory access is not allowed.',
  PENDING_REVIEW: 'This memory change requires review.',
  REVIEW_REQUIRED: 'A verified reviewer is required.',
  CONFLICT: 'Memory operation conflicts with the current state.',
  STORAGE_ERROR: 'Memory storage is temporarily unavailable.',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const MAX_DUPLICATE_CANDIDATES = 5;

export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MemoryServiceError';
  }
}

function isIdentityType(value: unknown): value is MemoryIdentityType {
  return value === 'persona' || value === 'room_member' || value === 'room_owner';
}

function validateCaller(caller: TrustedMemoryCaller): TrustedMemoryCaller {
  if (!caller || typeof caller !== 'object'
    || typeof caller.roomInstanceId !== 'string'
    || !UUID_PATTERN.test(caller.roomInstanceId)
    || typeof caller.personaId !== 'string'
    || !caller.personaId.trim()
    || !isIdentityType(caller.identityType)) {
    throw new MemoryForbiddenError('A trusted Room seat context is required.');
  }
  // Copy only server-derived fields. Agent-controlled name, role, or IDs are never read.
  return {
    roomInstanceId: caller.roomInstanceId,
    personaId: caller.personaId,
    identityType: caller.identityType,
  };
}

function identityFor(caller: TrustedMemoryCaller): MemoryIdentity {
  if (caller.identityType === 'persona') {
    return { type: 'persona', id: caller.personaId, personaId: caller.personaId };
  }
  // The identity type is server-derived; the associated seat Persona is its stable caller key.
  return { type: caller.identityType, id: caller.personaId };
}

function scopeFor(caller: TrustedMemoryCaller, kind: MemoryScopeKind): MemoryScope {
  if (kind === 'persona') {
    if (caller.identityType !== 'persona') {
      throw new MemoryForbiddenError('Persona memory requires the matching Persona seat.');
    }
    return { roomInstanceId: caller.roomInstanceId, scope: 'persona', personaId: caller.personaId };
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

function normalizeForDuplicate(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isExactDuplicate(entry: MemoryEntry, candidate: MemoryContent): boolean {
  return normalizeForDuplicate(entry.title) === normalizeForDuplicate(candidate.title)
    || normalizeForDuplicate(entry.content) === normalizeForDuplicate(candidate.content);
}

function toServiceMutation(result: MemoryMutationResult): MemoryServiceMutationResult {
  if (result.status === 'not_found') throw new MemoryServiceError('NOT_FOUND');
  if (result.status === 'pending_review') return { code: 'PENDING_REVIEW', proposalId: result.id };
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
  constructor(private readonly repository: MemoryRepository) {}

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
        return this.duplicateResult(candidates);
      }

      const result = scope.scope === 'persona'
        ? await this.repository.createPersonaEntry(scope, content, identity, idempotencyKey)
        : await this.repository.createRoomProposal(
          scope,
          { action: 'create', content },
          identity,
          idempotencyKey,
        );
      return toServiceMutation(result);
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
        return this.duplicateResult(candidates);
      }

      const result = scope.scope === 'persona'
        ? await this.repository.updatePersonaEntry(scope, entryId, update, identity, idempotencyKey)
        : await this.repository.createRoomProposal(
          scope,
          { action: 'update', targetMemoryId: entryId, update } satisfies MemoryProposalInput,
          identity,
          idempotencyKey,
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
  ): Promise<MemoryEntrySummary[]> {
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
    return matches.slice(0, MAX_DUPLICATE_CANDIDATES)
      .map(({ id, title, preview }) => ({ id, title, preview }));
  }

  private duplicateResult(candidates: MemoryEntrySummary[]): DuplicateCandidatesResult {
    return { status: 'duplicate_candidates', candidates, guidance: 'update_existing_or_clarify' };
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

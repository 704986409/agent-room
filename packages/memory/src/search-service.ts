import { MemoryForbiddenError, type MemoryScope } from './types.js';
import type { MemoryRepository } from './repository.js';
import { MemoryServiceError, type TrustedMemoryCaller } from './service.js';
import {
  SearchSessionRateLimitError,
  type MemorySearchBinding,
  type MemorySearchResponse,
  type MemorySearchSessionStore,
} from './search-session-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_LENGTH = 64;
const MAX_TOTAL_KEYWORD_LENGTH = 256;
export const MEMORY_READ_MAX_CHARS = 4000;
const DEFAULT_READ_CHARS = 2000;

class InvalidSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchInputError';
  }
}

function invalidInput(message: string): never {
  throw new InvalidSearchInputError(message);
}

export interface MemorySearchInput {
  readonly keywords: readonly string[];
  readonly requestId: string;
  readonly searchSessionId?: string;
}

export interface MemoryReadInput {
  readonly id: string;
  readonly cursor?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface MemoryReadPage {
  readonly id: string;
  readonly content: string;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trustedCaller(value: TrustedMemoryCaller): TrustedMemoryCaller {
  if (!isRecord(value)
    || typeof value.roomInstanceId !== 'string'
    || !UUID_PATTERN.test(value.roomInstanceId)
    || typeof value.personaId !== 'string'
    || !value.personaId.trim()
    || !['persona', 'room_member', 'room_owner'].includes(String(value.identityType))) {
    throw new MemoryForbiddenError('A trusted Room seat context is required.');
  }
  return {
    roomInstanceId: value.roomInstanceId,
    personaId: value.personaId,
    identityType: value.identityType as TrustedMemoryCaller['identityType'],
  };
}

function bindingFor(caller: TrustedMemoryCaller): MemorySearchBinding {
  return {
    roomInstanceId: caller.roomInstanceId,
    personaId: caller.personaId,
    identityType: caller.identityType,
  };
}

function scopesFor(caller: TrustedMemoryCaller): MemoryScope[] {
  const scopes: MemoryScope[] = [{ roomInstanceId: caller.roomInstanceId, scope: 'room' }];
  if (caller.identityType === 'persona') {
    scopes.push({ roomInstanceId: caller.roomInstanceId, scope: 'persona', personaId: caller.personaId });
  }
  return scopes;
}

function validateKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYWORDS) {
    invalidInput('keywords must contain 1 to 8 terms.');
  }
  const normalized = value.map((keyword: unknown) => {
    if (typeof keyword !== 'string') invalidInput('keywords must contain text.');
    const term = keyword.normalize('NFKC').trim().toLowerCase();
    if (!term) invalidInput('keywords cannot contain empty terms.');
    if ([...term].length > MAX_KEYWORD_LENGTH) invalidInput('keyword is too long.');
    return term;
  });
  const unique = [...new Set(normalized)];
  if (unique.reduce((length, term) => length + [...term].length, 0) > MAX_TOTAL_KEYWORD_LENGTH) {
    invalidInput('combined keyword length is too long.');
  }
  return unique;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 128) {
    invalidInput('request_id must contain 1 to 128 characters.');
  }
  return value;
}

function validateSearchSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalidInput('searchSessionId must be an opaque session ID.');
  }
  return value;
}

function validateReadId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidInput('id must be a memory UUID.');
  return value;
}

function validateOffset(value: unknown): number {
  const offset = value ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_646) {
    invalidInput('offset must be a supported non-negative integer.');
  }
  return offset;
}

function validateReadLimit(value: unknown): number {
  const limit = value ?? DEFAULT_READ_CHARS;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MEMORY_READ_MAX_CHARS) {
    invalidInput(`limit must be from 1 to ${MEMORY_READ_MAX_CHARS} characters.`);
  }
  return limit;
}

function encodeCursor(id: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, id, offset }), 'utf8').toString('base64url');
}

function offsetFromCursor(value: string, expectedId: string): number {
  if (typeof value !== 'string' || !value || value.length > 512) invalidInput('cursor is invalid.');
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalidInput('cursor is invalid.');
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(parsed) || parsed.v !== 1 || parsed.id !== expectedId
      || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) {
      invalidInput('cursor is invalid.');
    }
    return validateOffset(parsed.offset as number);
  } catch {
    invalidInput('cursor is invalid.');
  }
}

function resultFromCommit(status: string, response?: MemorySearchResponse): MemorySearchResponse {
  if (status === 'recorded' || status === 'replay') {
    if (!response) throw new Error('Search response was not saved.');
    return response;
  }
  if (status === 'not_found') throw new MemoryServiceError('NOT_FOUND');
  if (status === 'exhausted') throw new MemoryServiceError('CONFLICT');
  throw new Error('Unknown search session state.');
}

/** Search and bounded reads over only the trusted caller's Room and Persona scopes. */
export class MemorySearchService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly sessions: MemorySearchSessionStore,
  ) {}

  async search(caller: TrustedMemoryCaller, input: MemorySearchInput): Promise<MemorySearchResponse> {
    return this.execute(async () => {
      const trusted = trustedCaller(caller);
      const keywords = validateKeywords(input?.keywords);
      const requestId = validateRequestId(input?.requestId);
      const providedSessionId = validateSearchSessionId(input?.searchSessionId);
      const binding = bindingFor(trusted);

      let searchSessionId = providedSessionId;
      if (searchSessionId) {
        const inspection = await this.sessions.inspect(binding, searchSessionId, requestId);
        if (inspection.status === 'replay') return inspection.response;
        if (inspection.status === 'not_found') throw new MemoryServiceError('NOT_FOUND');
        if (inspection.status === 'exhausted') throw new MemoryServiceError('CONFLICT');
      } else {
        const requestReplay = await this.sessions.getRequestReplay(binding, requestId);
        if (requestReplay) return requestReplay;
        searchSessionId = await this.sessions.create(binding);
      }

      // Exact substring matching is intentional for 1–2 character Chinese terms and
      // English class/path/underscore tokens; all comparisons stay inside trusted scopes.
      const matches = await this.repository.searchEntries(scopesFor(trusted), keywords);
      const candidates = matches.map(({ id, title, preview }) => ({
        id,
        title: [...title].slice(0, 200).join(''),
        preview: [...preview].slice(0, 300).join(''),
      }));
      const commit = await this.sessions.record(
        binding,
        searchSessionId!,
        requestId,
        candidates.length ? { found: true, results: candidates } : { found: false },
      );
      return resultFromCommit(commit.status, 'response' in commit ? commit.response : undefined);
    });
  }

  async read(caller: TrustedMemoryCaller, input: MemoryReadInput): Promise<MemoryReadPage> {
    return this.execute(async () => {
      const trusted = trustedCaller(caller);
      const id = validateReadId(input?.id);
      if (input.cursor !== undefined && input.offset !== undefined) {
        invalidInput('Provide either cursor or offset, not both.');
      }
      const offset = input.cursor === undefined
        ? validateOffset(input.offset)
        : offsetFromCursor(input.cursor, id);
      const limit = validateReadLimit(input.limit);
      const row = await this.repository.readContentSegment(scopesFor(trusted), id, offset, limit);
      if (!row) throw new MemoryServiceError('NOT_FOUND');
      const codePoints = [...row.content];
      const hasMore = codePoints.length > limit;
      const content = hasMore ? codePoints.slice(0, limit).join('') : row.content;
      const nextOffset = offset + limit;
      return {
        id: row.id,
        content,
        nextCursor: hasMore ? encodeCursor(id, nextOffset) : null,
        hasMore,
      };
    });
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      if (error instanceof MemoryForbiddenError) throw new MemoryServiceError('FORBIDDEN');
      if (error instanceof SearchSessionRateLimitError) throw new MemoryServiceError('CONFLICT');
      if (error instanceof InvalidSearchInputError) throw new MemoryServiceError('INVALID_INPUT');
      throw new MemoryServiceError('STORAGE_ERROR');
    }
  }
}

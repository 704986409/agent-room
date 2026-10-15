import { createHash, randomUUID } from 'node:crypto';
import type { MemorySearchCandidate, MemoryIdentityType } from './types.js';

export interface MemorySearchBinding {
  readonly roomInstanceId: string;
  readonly identityType: MemoryIdentityType;
  readonly personaId?: string;
  readonly principalId?: string;
}

export type MemorySearchResponse =
  | { readonly found: true; readonly results: readonly MemorySearchCandidate[] }
  | {
    readonly found: false;
    readonly code: 'NOT_FOUND';
    readonly retryAllowed: boolean;
    readonly searchSessionId: string;
  };

export type MemorySearchOutcome =
  | { readonly found: true; readonly results: readonly MemorySearchCandidate[] }
  | { readonly found: false };

export type SearchSessionInspection =
  | { readonly status: 'ready' }
  | { readonly status: 'replay'; readonly response: MemorySearchResponse }
  | { readonly status: 'not_found' }
  | { readonly status: 'exhausted' };

export type SearchSessionCommit =
  | { readonly status: 'recorded' | 'replay'; readonly response: MemorySearchResponse }
  | { readonly status: 'not_found' }
  | { readonly status: 'exhausted' };

/** Search intent state is short-lived and deliberately separate from PostgreSQL. */
export interface MemorySearchSessionStore {
  create(binding: MemorySearchBinding): Promise<string>;
  getRequestReplay(binding: MemorySearchBinding, requestId: string): Promise<MemorySearchResponse | null>;
  inspect(
    binding: MemorySearchBinding,
    searchSessionId: string,
    requestId: string,
  ): Promise<SearchSessionInspection>;
  record(
    binding: MemorySearchBinding,
    searchSessionId: string,
    requestId: string,
    outcome: MemorySearchOutcome,
  ): Promise<SearchSessionCommit>;
}

/** Minimal command surface that can be backed by node-redis, Upstash, or another client. */
export interface RedisCommandClient {
  sendCommand(command: readonly string[]): Promise<unknown>;
}

export class SearchSessionRateLimitError extends Error {
  constructor() {
    super('Search session creation limit reached.');
    this.name = 'SearchSessionRateLimitError';
  }
}

const CREATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if count > 10 then return 'limited' end
local result = redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX')
if result then return ARGV[3] end
return 'collision'
`;

const INSPECT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local state = cjson.decode(raw)
if state.binding ~= ARGV[1] then return 'not_found' end
local receipt = state.receipts[ARGV[2]]
if receipt then return cjson.encode({ status = 'replay', response = receipt }) end
if state.rounds >= 2 or state.completed then return 'exhausted' end
return 'ready'
`;

const RECORD_SCRIPT = `
local request_receipt = redis.call('GET', KEYS[2])
if request_receipt then
  return cjson.encode({ status = 'replay', response = cjson.decode(request_receipt) })
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local state = cjson.decode(raw)
if state.binding ~= ARGV[1] then return 'not_found' end
local receipt_id = ARGV[2]
local old_receipt = state.receipts[receipt_id]
if old_receipt then return cjson.encode({ status = 'replay', response = old_receipt }) end
if state.rounds >= 2 or state.completed then return 'exhausted' end
local outcome = cjson.decode(ARGV[3])
state.rounds = state.rounds + 1
local response
if outcome.found then
  response = { found = true, results = outcome.results }
  state.completed = true
else
  response = {
    found = false,
    code = 'NOT_FOUND',
    retryAllowed = state.rounds < 2,
    searchSessionId = ARGV[4]
  }
end
state.receipts[receipt_id] = response
redis.call('SET', KEYS[1], cjson.encode(state), 'EX', ARGV[5])
redis.call('SET', KEYS[2], cjson.encode(response), 'EX', ARGV[5])
return cjson.encode({ status = 'recorded', response = response })
`;

function parseResponse(value: unknown): MemorySearchResponse {
  if (typeof value !== 'string') throw new Error('Invalid search-session response from Redis.');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid search-session response from Redis.');
  }
  const response = parsed as Record<string, unknown>;
  if (response.found === true && Array.isArray(response.results)) {
    const results = response.results.map((candidate: unknown) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('Invalid search candidate in Redis receipt.');
      }
      const row = candidate as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.preview !== 'string') {
        throw new Error('Invalid search candidate in Redis receipt.');
      }
      return { id: row.id, title: row.title, preview: row.preview };
    });
    if (results.length < 1 || results.length > 5) throw new Error('Invalid result count in Redis receipt.');
    return { found: true, results };
  }
  if (response.found === false && response.code === 'NOT_FOUND'
    && typeof response.retryAllowed === 'boolean' && typeof response.searchSessionId === 'string') {
    return {
      found: false,
      code: 'NOT_FOUND',
      retryAllowed: response.retryAllowed,
      searchSessionId: response.searchSessionId,
    };
  }
  throw new Error('Invalid search-session response from Redis.');
}

function parseScriptResult(value: unknown): SearchSessionInspection | SearchSessionCommit {
  if (value === 'ready') return { status: 'ready' };
  if (value === 'not_found') return { status: 'not_found' };
  if (value === 'exhausted') return { status: 'exhausted' };
  if (typeof value !== 'string') throw new Error('Invalid search-session state from Redis.');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid search-session state from Redis.');
  }
  const result = parsed as Record<string, unknown>;
  if ((result.status === 'recorded' || result.status === 'replay') && typeof result.response === 'object') {
    return { status: result.status, response: parseResponse(JSON.stringify(result.response)) };
  }
  if (result.status === 'replay' && typeof result.response === 'object') {
    return { status: 'replay', response: parseResponse(JSON.stringify(result.response)) };
  }
  throw new Error('Invalid search-session state from Redis.');
}

function bindingHash(binding: MemorySearchBinding): string {
  const canonical = JSON.stringify({
    roomInstanceId: binding.roomInstanceId,
    identityType: binding.identityType,
    ...(binding.personaId ? { personaId: binding.personaId } : {}),
    ...(binding.principalId ? { principalId: binding.principalId } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function hashRequestId(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex');
}

export interface RedisSearchSessionStoreOptions {
  readonly namespace?: string;
  readonly ttlSeconds?: number;
}

/** Redis implementation; the injected client keeps storage replaceable for hosts and tests. */
export class RedisSearchSessionStore implements MemorySearchSessionStore {
  private readonly namespace: string;
  private readonly ttlSeconds: number;

  constructor(private readonly redis: RedisCommandClient, options: RedisSearchSessionStoreOptions = {}) {
    this.namespace = options.namespace ?? 'agent-memory-search-v1';
    this.ttlSeconds = options.ttlSeconds ?? 600;
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(this.namespace)) throw new TypeError('Invalid Redis key namespace.');
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1 || this.ttlSeconds > 86_400) {
      throw new TypeError('Search session TTL must be from 1 to 86400 seconds.');
    }
  }

  async create(binding: MemorySearchBinding): Promise<string> {
    const hash = bindingHash(binding);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = randomUUID();
      const state = JSON.stringify({ binding: hash, rounds: 0, completed: false, receipts: {} });
      const response = await this.redis.sendCommand([
        'EVAL', CREATE_SCRIPT, '2', this.rateLimitKey(hash), this.sessionKey(hash, id),
        state, String(this.ttlSeconds), id,
      ]);
      if (response === 'limited') throw new SearchSessionRateLimitError();
      if (response === id) return id;
    }
    throw new Error('Unable to allocate a search session.');
  }

  async getRequestReplay(binding: MemorySearchBinding, requestId: string): Promise<MemorySearchResponse | null> {
    const response = await this.redis.sendCommand(['GET', this.requestKey(bindingHash(binding), requestId)]);
    return response === null ? null : parseResponse(response);
  }

  async inspect(
    binding: MemorySearchBinding,
    searchSessionId: string,
    requestId: string,
  ): Promise<SearchSessionInspection> {
    const hash = bindingHash(binding);
    const response = await this.redis.sendCommand([
      'EVAL', INSPECT_SCRIPT, '1', this.sessionKey(hash, searchSessionId), hash, hashRequestId(requestId),
    ]);
    return parseScriptResult(response) as SearchSessionInspection;
  }

  async record(
    binding: MemorySearchBinding,
    searchSessionId: string,
    requestId: string,
    outcome: MemorySearchOutcome,
  ): Promise<SearchSessionCommit> {
    const hash = bindingHash(binding);
    const response = await this.redis.sendCommand([
      'EVAL', RECORD_SCRIPT, '2', this.sessionKey(hash, searchSessionId), this.requestKey(hash, requestId),
      hash,
      hashRequestId(requestId),
      JSON.stringify(outcome),
      searchSessionId,
      String(this.ttlSeconds),
    ]);
    return parseScriptResult(response) as SearchSessionCommit;
  }

  private sessionKey(binding: string, id: string): string {
    return `${this.namespace}:{${binding}}:session:${id}`;
  }

  private requestKey(binding: string, requestId: string): string {
    return `${this.namespace}:{${binding}}:request:${hashRequestId(requestId)}`;
  }

  private rateLimitKey(binding: string): string {
    return `${this.namespace}:{${binding}}:create-rate`;
  }
}

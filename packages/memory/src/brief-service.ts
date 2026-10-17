import { MemoryService, MemoryServiceError, type MemoryBriefSourceEntry, type TrustedMemoryCaller } from './service.js';
import type { MemoryBriefBinding, MemoryBriefSessionStore } from './brief-session-store.js';
import { MemoryForbiddenError } from './types.js';

export interface MemoryBriefAuthorization {
  /** Must verify the active Room seat and its current Room instance server-side. */
  authorize(caller: TrustedMemoryCaller): Promise<boolean>;
}

/** Reads the Room topic/background from the server-owned Room record, if available. */
export interface MemoryBriefRoomContextReader {
  readRoomTopic(roomInstanceId: string): Promise<string | null>;
}

export type MemoryBriefResult =
  | {
    readonly loaded: true;
    readonly brief: string;
    readonly estimated: true;
    readonly estimatedTokens: number;
    readonly memoryIds: readonly string[];
  }
  | {
    readonly loaded: false;
    readonly brief: null;
    readonly estimated: true;
    readonly estimatedTokens: 0;
    readonly memoryIds: readonly [];
  };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateCaller(caller: TrustedMemoryCaller): TrustedMemoryCaller {
  const hasPersona = typeof caller?.personaId === 'string' && Boolean(caller.personaId.trim());
  const hasPrincipal = typeof caller?.principalId === 'string' && Boolean(caller.principalId.trim());
  if (!caller || typeof caller !== 'object'
    || typeof caller.roomInstanceId !== 'string' || !UUID_PATTERN.test(caller.roomInstanceId)
    || !['persona', 'room_member', 'room_owner'].includes(caller.identityType)
    || (caller.identityType === 'persona'
      ? !hasPersona
      : !hasPrincipal || caller.personaId !== undefined)) {
    throw new MemoryForbiddenError('A trusted Room seat context is required.');
  }
  return {
    roomInstanceId: caller.roomInstanceId,
    identityType: caller.identityType,
    ...(caller.identityType === 'persona' ? { personaId: caller.personaId } : { principalId: caller.principalId }),
  };
}

function validateSessionKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError('A valid server-issued session key is required.');
  }
  return value;
}

function oneLine(value: string): string {
  return value.trim().replace(/[\r\n\t ]+/gu, ' ');
}

function dateLabel(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return 'unknown date';
  return value.toISOString().slice(0, 10);
}

function sourceTopicTerms(entries: readonly MemoryBriefSourceEntry[]): Array<{ term: string; id: string }> {
  const seen = new Set<string>();
  const result: Array<{ term: string; id: string }> = [];
  for (const entry of [...entries].sort(recentFirst)) {
    const terms = entry.searchText.split(/[\s,;|]+/u).map(oneLine).filter(Boolean);
    for (const term of terms) {
      const boundedTerm = [...term].slice(0, 64).join('');
      const normalized = term.normalize('NFKC').toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push({ term: boundedTerm, id: entry.id });
      if (result.length >= 12) return result;
    }
  }
  return result;
}

function recentFirst(left: MemoryBriefSourceEntry, right: MemoryBriefSourceEntry): number {
  return right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id);
}

/** Deterministic rendering uses only stored fields; it never invents a summary. */
export function renderMemoryBrief(
  entries: readonly MemoryBriefSourceEntry[],
  roomTopic: string | null,
): { brief: string; estimatedTokens: number; memoryIds: string[] } {
  const ordered = [...entries].sort(recentFirst);
  const shared = ordered.filter(entry => entry.scope === 'room');
  const privateEntries = ordered.filter(entry => entry.scope === 'persona');
  const lines = ['Memory Brief (character-count estimate)'];
  const topic = roomTopic ? oneLine(roomTopic) : '';
  if (topic) lines.push(`Room context: ${topic}`);

  const topics = sourceTopicTerms(ordered);
  if (topics.length) {
    lines.push('Important topics (stored search terms):');
    lines.push(`- ${topics.map(item => `${item.term} [${item.id}]`).join('; ')}`);
  }
  if (ordered.length) {
    lines.push('Recent changes:');
    for (const entry of ordered.slice(0, 5)) {
      lines.push(`- ${dateLabel(entry.updatedAt)} [${entry.id}] ${oneLine(entry.title)}`);
    }
  }
  if (shared.length) {
    lines.push('Room shared memories:');
    for (const entry of shared) {
      lines.push(`- [${entry.id}] ${oneLine(entry.title)} — ${oneLine(entry.preview)}`);
    }
  }
  if (privateEntries.length) {
    lines.push('Current Persona memories:');
    for (const entry of privateEntries) {
      lines.push(`- [${entry.id}] ${oneLine(entry.title)} — ${oneLine(entry.preview)}`);
    }
  }
  if (!ordered.length && !topic) lines.push('No saved memories.');

  // No character budget: every approved Room memory and every caller Persona memory is listed.
  const brief = lines.join('\n');
  return {
    brief,
    // One estimated token per UTF-16 character is intentionally conservative
    // for mixed Chinese/English text. This is a budget estimate, not a tokenizer.
    estimatedTokens: brief.length,
    memoryIds: ordered.filter(entry => brief.includes(`[${entry.id}]`)).map(entry => entry.id),
  };
}

/** Join/Resume-only Brief path with a Redis marker bound to room/persona/session. */
export class MemoryBriefService {
  constructor(
    private readonly memories: MemoryService,
    private readonly sessions: MemoryBriefSessionStore,
    private readonly authorization: MemoryBriefAuthorization,
    private readonly roomContext?: MemoryBriefRoomContextReader,
  ) {}

  async loadOnce(caller: TrustedMemoryCaller, sessionKey: string): Promise<MemoryBriefResult> {
    try {
      const trusted = validateCaller(caller);
      const key = validateSessionKey(sessionKey);
      const allowed = await this.authorization.authorize(trusted);
      if (!allowed) throw new MemoryServiceError('FORBIDDEN');

      const binding: MemoryBriefBinding = {
        roomInstanceId: trusted.roomInstanceId,
        ...(trusted.personaId ? { personaId: trusted.personaId } : {}),
        ...(trusted.principalId ? { principalId: trusted.principalId } : {}),
        sessionKey: key,
      };
      if (await this.sessions.hasLoaded(binding)) return alreadyLoaded();

      const [entries, roomTopic] = await Promise.all([
        this.memories.listBriefSourceEntries(trusted),
        this.roomContext?.readRoomTopic(trusted.roomInstanceId) ?? Promise.resolve(null),
      ]);
      const brief = renderMemoryBrief(entries, roomTopic);
      if (!(await this.sessions.claimLoad(binding))) return alreadyLoaded();
      return {
        loaded: true,
        brief: brief.brief,
        estimated: true,
        estimatedTokens: brief.estimatedTokens,
        memoryIds: brief.memoryIds,
      };
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      if (error instanceof MemoryForbiddenError) throw new MemoryServiceError('FORBIDDEN');
      if (error instanceof TypeError) throw new MemoryServiceError('INVALID_INPUT');
      throw new MemoryServiceError('STORAGE_ERROR');
    }
  }
}

function alreadyLoaded(): MemoryBriefResult {
  return { loaded: false, brief: null, estimated: true, estimatedTokens: 0, memoryIds: [] };
}

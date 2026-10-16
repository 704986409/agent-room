import { createHash } from 'node:crypto';
import type { MemoryProposalInput } from './types.js';

/** Shared exact-duplicate normalization (NFKC, trimmed, collapsed whitespace, lower-case). */
export function normalizeForDuplicate(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizedPayload(payload: object): Array<[string, string | null]> {
  return Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]): [string, string | null] => [key,
      value === null ? null : normalizeForDuplicate(String(value))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Stable key for "same action, same target, same normalized content". */
export function proposalDedupKey(input: MemoryProposalInput): string {
  const shape = input.action === 'create'
    ? ['create', null, normalizedPayload(input.content)]
    : input.action === 'update'
      ? ['update', input.targetMemoryId, normalizedPayload(input.update)]
      : ['delete', input.targetMemoryId, []];
  return createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex');
}

import { createHash } from 'node:crypto';
import type { RedisCommandClient } from './search-session-store.js';

export interface MemoryBriefBinding {
  readonly roomInstanceId: string;
  readonly sessionKey: string;
  readonly personaId?: string;
  readonly principalId?: string;
}

/** A short-lived distributed marker; process-local state is deliberately insufficient. */
export interface MemoryBriefSessionStore {
  hasLoaded(binding: MemoryBriefBinding): Promise<boolean>;
  claimLoad(binding: MemoryBriefBinding): Promise<boolean>;
}

export interface RedisMemoryBriefSessionStoreOptions {
  readonly namespace?: string;
  readonly ttlSeconds?: number;
}

function keyFor(namespace: string, binding: MemoryBriefBinding): string {
  const canonical = JSON.stringify({
    roomInstanceId: binding.roomInstanceId,
    sessionKey: binding.sessionKey,
    ...(binding.personaId ? { personaId: binding.personaId } : {}),
    ...(binding.principalId ? { principalId: binding.principalId } : {}),
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${namespace}:${digest}`;
}

/** Redis-backed, injectable marker store. Raw session keys never become Redis keys. */
export class RedisMemoryBriefSessionStore implements MemoryBriefSessionStore {
  private readonly namespace: string;
  private readonly ttlSeconds: number;

  constructor(private readonly redis: RedisCommandClient, options: RedisMemoryBriefSessionStoreOptions = {}) {
    this.namespace = options.namespace ?? 'agent-memory-brief-v1';
    this.ttlSeconds = options.ttlSeconds ?? 604_800;
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(this.namespace)) throw new TypeError('Invalid Redis key namespace.');
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1 || this.ttlSeconds > 604_800) {
      throw new TypeError('Brief marker TTL must be from 1 to 604800 seconds.');
    }
  }

  async hasLoaded(binding: MemoryBriefBinding): Promise<boolean> {
    const value = await this.redis.sendCommand(['EXISTS', keyFor(this.namespace, binding)]);
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid Redis EXISTS response.');
    const count = Number(value);
    if (count !== 0 && count !== 1) throw new Error('Invalid Redis EXISTS response.');
    return count === 1;
  }

  async claimLoad(binding: MemoryBriefBinding): Promise<boolean> {
    const result = await this.redis.sendCommand([
      'SET', keyFor(this.namespace, binding), '1', 'EX', String(this.ttlSeconds), 'NX',
    ]);
    if (result === 'OK') return true;
    if (result === null) return false;
    throw new Error('Invalid Redis SET response.');
  }
}

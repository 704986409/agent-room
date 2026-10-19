// In-memory Upstash stand-in for account and proxy tests. Production code
// talks to Redis REST; tests must not touch the machine's Redis.

import type { UpstashClient } from '@agent-room/upstash-client';

type Entry = { value: string };

export class MemoryRedis implements UpstashClient {
  private readonly kv = new Map<string, Entry>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly lists = new Map<string, string[]>();
  private readonly expiry = new Map<string, number>();

  async command<T = unknown>(cmd: readonly (string | number)[]): Promise<T> {
    return this.run(cmd) as T;
  }

  async pipeline<T = unknown>(cmds: readonly (readonly (string | number)[])[]): Promise<T[]> {
    return cmds.map(cmd => this.run(cmd) as T);
  }

  run(raw: readonly (string | number)[]): unknown {
    const cmd = raw.map(part => String(part));
    const op = (cmd[0] ?? '').toUpperCase();
    const key = cmd[1];
    if (key) this.purge(key);
    switch (op) {
      case 'PING':
        return 'PONG';
      case 'GET':
        return key ? (this.kv.get(key)?.value ?? null) : null;
      case 'MGET':
        return cmd.slice(1).map(item => {
          this.purge(item);
          return this.kv.get(item)?.value ?? null;
        });
      case 'SET':
        return this.set(cmd);
      case 'DEL': {
        let removed = 0;
        for (const item of cmd.slice(1)) {
          this.purge(item);
          if (this.kv.delete(item)) removed += 1;
          if (this.sets.delete(item)) removed += 1;
          if (this.lists.delete(item)) removed += 1;
          this.expiry.delete(item);
        }
        return removed;
      }
      case 'RPUSH': {
        if (!key) return 0;
        const list = this.lists.get(key) ?? [];
        for (const item of cmd.slice(2)) list.push(item);
        this.lists.set(key, list);
        return list.length;
      }
      case 'LLEN':
        return key ? (this.lists.get(key)?.length ?? 0) : 0;
      case 'LRANGE': {
        const list = key ? (this.lists.get(key) ?? []) : [];
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        return list.slice(from, to + 1);
      }
      case 'LTRIM': {
        if (!key) return 'OK';
        const list = this.lists.get(key) ?? [];
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        this.lists.set(key, list.slice(from, to + 1));
        return 'OK';
      }
      case 'EVAL':
        return this.eval(cmd);
      case 'EXISTS':
        return key && (this.kv.has(key) || this.sets.has(key)) ? 1 : 0;
      case 'INCR': {
        if (!key) return 0;
        const next = Number(this.kv.get(key)?.value ?? 0) + 1;
        this.kv.set(key, { value: String(next) });
        return next;
      }
      case 'EXPIRE': {
        if (!key || !this.kv.has(key) && !this.sets.has(key)) return 0;
        const seconds = Number(cmd[2]);
        if (!Number.isFinite(seconds)) return 0;
        this.expiry.set(key, Date.now() + seconds * 1000);
        return 1;
      }
      case 'EXPIREAT': {
        if (!key || !this.hasKey(key)) return 0;
        const unix = Number(cmd[2]);
        if (!Number.isFinite(unix)) return 0;
        this.expiry.set(key, unix * 1000);
        return 1;
      }
      case 'TTL': {
        if (!key || (!this.kv.has(key) && !this.sets.has(key))) return -2;
        const at = this.expiry.get(key);
        if (at === undefined) return -1;
        return Math.max(0, Math.ceil((at - Date.now()) / 1000));
      }
      case 'SADD':
        return this.sadd(key, cmd.slice(2));
      case 'SREM':
        return this.srem(key, cmd.slice(2));
      case 'SMEMBERS':
        return key ? [...(this.sets.get(key) ?? [])] : [];
      case 'SISMEMBER':
        return key && this.sets.get(key)?.has(cmd[2] ?? '') ? 1 : 0;
      case 'SCARD':
        return key ? (this.sets.get(key)?.size ?? 0) : 0;
      default:
        throw new Error(`MemoryRedis does not implement ${op}`);
    }
  }

  private set(cmd: string[]): string | null {
    const key = cmd[1];
    if (!key) return null;
    let nx = false;
    let keepttl = false;
    let exSeconds: number | undefined;
    for (let i = 3; i < cmd.length; i++) {
      const flag = cmd[i]!.toUpperCase();
      if (flag === 'NX') nx = true;
      else if (flag === 'KEEPTTL') keepttl = true;
      else if (flag === 'EX') {
        exSeconds = Number(cmd[i + 1]);
        i += 1;
      }
    }
    if (nx && (this.kv.has(key) || this.sets.has(key))) return null;
    const previousExpiry = keepttl ? this.expiry.get(key) : undefined;
    this.sets.delete(key);
    this.kv.set(key, { value: cmd[2] ?? '' });
    if (exSeconds !== undefined && Number.isFinite(exSeconds)) {
      this.expiry.set(key, Date.now() + exSeconds * 1000);
    } else if (keepttl && previousExpiry !== undefined) {
      this.expiry.set(key, previousExpiry);
    } else if (!keepttl) {
      this.expiry.delete(key);
    }
    return 'OK';
  }

  private sadd(key: string | undefined, members: string[]): number {
    if (!key) return 0;
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    this.sets.set(key, set);
    return added;
  }

  private srem(key: string | undefined, members: string[]): number {
    if (!key) return 0;
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  private hasKey(key: string): boolean {
    return this.kv.has(key) || this.sets.has(key) || this.lists.has(key);
  }

  private eval(cmd: string[]): number {
    const script = cmd[1] ?? '';
    if (script.includes('AR11 listen-presence CAS')) {
      const key = cmd[3] ?? '';
      const expected = cmd[4] ?? '';
      const next = cmd[5] ?? '';
      this.purge(key);
      if ((this.kv.get(key)?.value ?? null) !== expected) return 0;
      const expiresAt = this.expiry.get(key);
      this.kv.set(key, { value: next });
      if (expiresAt !== undefined) this.expiry.set(key, expiresAt);
      return 1;
    }
    throw new Error('MemoryRedis EVAL is only implemented for presence CAS');
  }

  private purge(key: string): void {
    const at = this.expiry.get(key);
    if (at === undefined || at > Date.now()) return;
    this.kv.delete(key);
    this.sets.delete(key);
    this.lists.delete(key);
    this.expiry.delete(key);
  }
}

/** Point Upstash REST fetches for `baseUrl` at `store`. Other fetches pass through. */
export function installFetchRedis(baseUrl: string, store: MemoryRedis): () => void {
  const real = globalThis.fetch.bind(globalThis);
  const base = baseUrl.replace(/\/$/, '');
  const patched: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) return real(input, init);
    const path = url.slice(base.length);
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    const payload = path === '/pipeline' || path.startsWith('/pipeline')
      ? (body as unknown[][]).map(cmd => ({ result: store.run(cmd as (string | number)[]) }))
      : { result: store.run(body as (string | number)[]) };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = real;
  };
}

// In-memory command model for wake tests. Never connects to Redis or external APIs.
import { POLL_SNAPSHOT_SCRIPT, ROOM_REPLACE_SCRIPT } from './_wakeBind.js';
import { CREATE_EVENT_SCRIPT, EVENT_CAS_SCRIPT, SCAN_CAS_SCRIPT, HANDOFF_SCRIPT, LISTEN_EPOCH_SCRIPT, MESSAGE_SNAPSHOT_SCRIPT } from './_wakeRedis.js';
export class WakeTestRedis {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly sets = new Map<string, Set<string>>();
  readonly expires = new Map<string, number>();
  readonly commands: (readonly (string | number)[])[] = [];
  beforeEval?: (script: string, keys: string[], args: string[]) => void;
  now = 1_000;
  failCreateAt?: number;
  creates = 0;
  async command<T>(command: readonly (string | number)[]): Promise<T> {
    this.commands.push(command);
    return this.execute(command) as T;
  }
  async pipeline<T>(commands: readonly (readonly (string | number)[])[]): Promise<T[]> {
    const results: T[] = [];
    for (const command of commands) results.push(await this.command<T>(command));
    return results;
  }
  private get(key: string): string | null {
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.values.delete(key); this.sets.delete(key); this.expires.delete(key);
    }
    return this.values.get(key) ?? null;
  }
  private put(key: string, value: string, expiry?: number): void {
    this.values.set(key, value);
    if (expiry !== undefined) this.expires.set(key, expiry);
  }
  private execute(command: readonly (string | number)[]): unknown {
    const [name, key] = command.map(String);
    if (name === 'GET') return this.get(key!);
    if (name === 'SMEMBERS') { this.get(key!); return [...(this.sets.get(key!) ?? [])]; }
    if (name === 'SADD') {
      const members = this.sets.get(key!) ?? new Set<string>();
      for (const member of command.slice(2).map(String)) members.add(member);
      this.sets.set(key!, members);
      return members.size;
    }
    if (name === 'SREM') {
      const members = this.sets.get(key!);
      if (!members) return 0;
      let removed = 0;
      for (const member of command.slice(2).map(String)) if (members.delete(member)) removed += 1;
      return removed;
    }
    if (name === 'DEL') {
      let removed = 0;
      for (const item of command.slice(1).map(String)) {
        const had = this.values.delete(item);
        const hadSet = this.sets.delete(item);
        const hadList = this.lists.delete(item);
        this.expires.delete(item);
        if (had || hadSet || hadList) removed += 1;
      }
      return removed;
    }
    if (name === 'MGET') return command.slice(1).map(item => this.get(String(item)));
    if (name === 'LLEN') return (this.lists.get(key!) ?? []).length;
    if (name === 'LRANGE') {
      const list = this.lists.get(key!) ?? [];
      const start = Number(command[2]);
      const end = Number(command[3]);
      const from = start < 0 ? Math.max(0, list.length + start) : start;
      const to = end < 0 ? list.length + end : end;
      return list.slice(from, to + 1);
    }
    if (name === 'RPUSH') {
      const list = this.lists.get(key!) ?? [];
      list.push(String(command[2]));
      this.lists.set(key!, list);
      return list.length;
    }
    if (name === 'INCR') {
      const next = Number(this.get(key!) ?? 0) + 1;
      this.put(key!, String(next));
      return next;
    }
    if (name === 'LTRIM') {
      const list = this.lists.get(key!) ?? [];
      const start = Number(command[2]);
      const end = Number(command[3]);
      const from = start < 0 ? Math.max(0, list.length + start) : start;
      const to = end < 0 ? list.length + end : end;
      this.lists.set(key!, list.slice(from, to + 1));
      return 'OK';
    }
    if (name === 'EXPIRE' || name === 'EXPIREAT') return 1;
    if (name === 'SET') {
      if (command.includes('NX') && this.get(key!) !== null) return null;
      const expiryAt = command.indexOf('PXAT');
      this.put(key!, String(command[2]), expiryAt < 0 ? undefined : Number(command[expiryAt + 1]));
      return 'OK';
    }
    if (name !== 'EVAL') throw new Error(`Unsupported test command: ${name}`);
    const script = String(command[1]);
    const count = Number(command[2]);
    const keys = command.slice(3, 3 + count).map(String);
    const args = command.slice(3 + count).map(String);
    this.beforeEval?.(script, keys, args);
    const [a, b, c, d] = args;
    const [first, second, third] = keys as [string, string, string];
    if (script === MESSAGE_SNAPSHOT_SCRIPT) {
      if (this.get(first) === null) return [0];
      const total = this.get(second);
      if (total === null) return [1];
      const rows = this.lists.get(third) ?? [];
      const oldest = Number(total) - rows.length;
      if (oldest < 0) throw new Error('invalid absolute message count');
      const start = Math.max(Number(a), oldest);
      return [2, Number(total), oldest, rows.slice(start - oldest)];
    }
    if (script === CREATE_EVENT_SCRIPT) {
      if (++this.creates === this.failCreateAt) throw new Error('injected_write_failure');
      const created = this.get(first) === null;
      if (created) this.put(first, a!, Number(c));
      this.get(second);
      const members = this.sets.get(second) ?? new Set<string>(); members.add(b!); this.sets.set(second, members);
      this.expires.set(second, Math.max(this.expires.get(second) ?? 0, Number(c)));
      return created ? 1 : 0;
    }
    if (script === EVENT_CAS_SCRIPT) {
      if (this.get(first) !== a || (d !== '' && this.get(second) !== d)) return 0;
      this.put(first, b!, Number(c)); return 1;
    }
    if (script === SCAN_CAS_SCRIPT) {
      const current = this.get(first);
      if (current === null || Number(current) !== Number(a) || Number(b) <= Number(current)) return 0;
      this.put(first, b!); return 1;
    }
    if (script === HANDOFF_SCRIPT) {
      if (this.get(first) !== a) return 0;
      const total = this.get(second);
      if (total === null) return -1;
      if (Number(b) > Number(total)) return -2;
      this.put(third, c!, Number(d)); return 1;
    }
    if (script === LISTEN_EPOCH_SCRIPT) {
      if (this.get(first) !== a) return 0;
      const epoch = Number(this.get(second) ?? 0) + 1;
      this.put(second, String(epoch), Number(b)); return epoch;
    }
    if (script === POLL_SNAPSHOT_SCRIPT) {
      const ids = [...(this.sets.get(first) ?? [])];
      return ids.map(id => {
        const bind = this.get(`wake-bind:${id}`);
        const meta = this.get(`wake-meta:${id}`);
        const match = meta?.match(/^(\S+)\t(\S+)$/);
        const count = match ? this.get(`room-msg-count:${match[1]}`) : null;
        const scan = match ? this.get(`wake-scan:${match[2]}:${id}`) : null;
        const events = match ? (this.sets.get(`wake-seat:${match[2]}:${id}`)?.size ?? 0) : 0;
        return [id, bind ?? false, count ?? false, scan ?? false, events];
      });
    }
    if (script === ROOM_REPLACE_SCRIPT) {
      if (this.get(first) !== a) return 0;
      this.put(first, b!);
      return 1;
    }
    throw new Error('Unknown wake script');
  }
}

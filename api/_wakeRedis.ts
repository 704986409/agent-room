import { ROOM_TTL_SECONDS, type Message, type Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  acknowledge, absoluteCursor, active, eventsForMessage, gapEvent, registrationCursor, sameSeat,
  transition, verifySeat, type DeliveredMessage, type ManagedSeat, type ReadBatch, type SeatAuthority,
  type SeatRef, type WakeAction, type WakeEvent,
} from './_wakeCore.js';

export const wakeKeys = {
  event: (id: string) => `wake-evt:${id}`,
  seat: (s: SeatRef) => `wake-seat:${s.roomInstanceId}:${s.seatId}`,
  scan: (s: SeatRef) => `wake-scan:${s.roomInstanceId}:${s.seatId}`,
  handoff: (s: SeatRef) => `seat-handoff:${s.roomInstanceId}:${s.seatId}`,
  listen: (s: SeatRef) => `seat-listen:${s.roomInstanceId}:${s.seatId}`,
};

// NX and seat membership must be atomic: a crash cannot leave an unindexed event.
export const CREATE_EVENT_SCRIPT = `
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[2])
local ttl = redis.call('PTTL', KEYS[2])
if ttl < 0 or tonumber(ARGV[3]) > tonumber(ARGV[4]) + ttl then
  redis.call('PEXPIREAT', KEYS[2], ARGV[3])
end
if created then return 1 else return 0 end`;

// Full snapshot comparison includes state, claimId and leaseUntil. The reducer is
// server-only; no client-supplied next state is ever passed to this script.
export const EVENT_CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[4] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[4] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
return 1`;

export const SCAN_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or tonumber(current) ~= tonumber(ARGV[1]) then return 0 end
if tonumber(ARGV[2]) <= tonumber(current) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1`;

export const HANDOFF_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local total = redis.call('GET', KEYS[2])
if not total then return -1 end
if tonumber(ARGV[2]) > tonumber(total) then return -2 end
redis.call('SET', KEYS[3], ARGV[3], 'PXAT', ARGV[4])
return 1`;

export const LISTEN_EPOCH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local epoch = redis.call('INCR', KEYS[2])
redis.call('PEXPIREAT', KEYS[2], ARGV[2])
return epoch`;

/** Count, retention offset and rows are read atomically to avoid trimming/append races. */
export const MESSAGE_SNAPSHOT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {0} end
local raw = redis.call('GET', KEYS[2])
if not raw then return {1} end
local total = tonumber(raw)
local length = redis.call('LLEN', KEYS[3])
local oldest = total - length
if oldest < 0 then return redis.error_reply('invalid absolute message count') end
local from = math.max(tonumber(ARGV[1]), oldest)
local rows = {}
if from < total then rows = redis.call('LRANGE', KEYS[3], from - oldest, -1) end
return {2, total, oldest, rows}`;

interface AuthoritySnapshot { raw: string; seat: SeatAuthority; roomExpiresAt: number }
export interface ScanSnapshot {
  total: number;
  oldestRetained: number;
  /** Complete, consistent retained suffix [max(scanFrom, oldestRetained), total). */
  messages: readonly (DeliveredMessage & { message: Parameters<typeof eventsForMessage>[2] })[];
}

/** No connections or timers are created here. All I/O uses an injected command client. */
export class RedisWakeStore {
  constructor(private readonly client: Pick<UpstashClient, 'command'>) {}

  private async raw(key: string): Promise<string | null> {
    const value = await this.client.command<unknown>(['GET', key]);
    return value == null ? null : String(value);
  }
  private async eval(script: string, keys: string[], args: (string | number)[]): Promise<number> {
    return Number(await this.client.command(['EVAL', script, keys.length, ...keys, ...args]));
  }
  async create(event: WakeEvent, now: number): Promise<boolean> {
    if (event.retainUntil <= now) throw new Error('retention_elapsed');
    return await this.eval(CREATE_EVENT_SCRIPT, [wakeKeys.event(event.eventId), wakeKeys.seat(event)],
      [JSON.stringify(event), event.eventId, event.retainUntil, now]) === 1;
  }
  async get(eventId: string): Promise<WakeEvent | null> {
    const raw = await this.raw(wakeKeys.event(eventId));
    return raw === null ? null : JSON.parse(raw);
  }
  async list(seat: SeatRef): Promise<WakeEvent[]> {
    const ids = await this.client.command<string[] | null>(['SMEMBERS', wakeKeys.seat(seat)]);
    const events = await Promise.all((ids ?? []).map(id => this.get(id)));
    return events.filter((e): e is WakeEvent => !!e && sameSeat(e, seat));
  }
  private async mutate(eventId: string, reduce: (e: WakeEvent) => WakeEvent | null,
    guard?: { code: string; raw: string }): Promise<WakeEvent | null> {
    // Bounded contention retries, always recomputing against the newest state.
    for (let i = 0; i < 8; i++) {
      const raw = await this.raw(wakeKeys.event(eventId));
      if (raw === null) return null;
      const next = reduce(JSON.parse(raw));
      if (!next) return null;
      if (await this.eval(EVENT_CAS_SCRIPT, [wakeKeys.event(eventId), `room:${guard?.code ?? ''}`],
        [raw, JSON.stringify(next), next.retainUntil, guard?.raw ?? '']) === 1) return next;
      if (guard && await this.raw(`room:${guard.code}`) !== guard.raw) return null;
    }
    throw new Error('wake_cas_contention');
  }
  /** Claim authorization and single-run admission are the phase 2 binding/run layer's responsibility. */
  apply(eventId: string, action: WakeAction, now: number): Promise<WakeEvent | null> {
    return this.mutate(eventId, e => transition(e, action, now));
  }
  async generate(seats: readonly ManagedSeat[], index: number, message: Parameters<typeof eventsForMessage>[2], now: number, roomExpiresAt: number): Promise<void> {
    for (const event of eventsForMessage(seats, index, message, now, roomExpiresAt)) await this.create(event, now);
  }
  async handoff(seat: SeatRef): Promise<{ cursor: number; at: number } | null> {
    const raw = await this.raw(wakeKeys.handoff(seat));
    return raw === null ? null : JSON.parse(raw);
  }
  async initializeScan(seat: SeatRef, requested: number | undefined, total: number | undefined, roomExpiresAt: number): Promise<number> {
    const cursor = registrationCursor(requested, (await this.handoff(seat))?.cursor, total);
    await this.client.command(['SET', wakeKeys.scan(seat), cursor, 'NX', 'PXAT', roomExpiresAt]);
    // Never reset an existing cursor on re-registration.
    const stored = await this.raw(wakeKeys.scan(seat));
    if (stored === null) throw new Error('scan_not_initialized');
    return absoluteCursor(Number(stored));
  }
  async advanceScan(seat: SeatRef, expected: number, next: number): Promise<boolean> {
    absoluteCursor(expected); absoluteCursor(next);
    return await this.eval(SCAN_CAS_SCRIPT, [wakeKeys.scan(seat)], [expected, next]) === 1;
  }
  /** null means room expired; a missing absolute count is explicitly unsupported. */
  async loadMessages(code: string, from: number): Promise<ScanSnapshot | null> {
    absoluteCursor(from);
    const result = await this.client.command<unknown[]>(['EVAL', MESSAGE_SNAPSHOT_SCRIPT, 3,
      `room:${code}`, `room-msg-count:${code}`, `room-msgs:${code}`, from]);
    if (Number(result[0]) === 0) return null;
    if (Number(result[0]) === 1) throw new Error('absolute_count_required');
    const total = absoluteCursor(Number(result[1]));
    const oldestRetained = absoluteCursor(Number(result[2]));
    const start = Math.max(from, oldestRetained);
    const messages = (result[3] as string[]).map((raw, i) => ({ index: start + i, message: JSON.parse(raw) as Message }));
    return { total, oldestRetained, messages };
  }
  async scan(seat: ManagedSeat, load: (from: number) => Promise<ScanSnapshot>, now: number, roomExpiresAt: number): Promise<boolean> {
    const raw = await this.raw(wakeKeys.scan(seat));
    if (raw === null) throw new Error('scan_not_initialized');
    const from = absoluteCursor(Number(raw));
    const snapshot = await load(from);
    const { total, oldestRetained, messages } = snapshot;
    absoluteCursor(total); absoluteCursor(oldestRetained);
    if (oldestRetained > total || total < from) throw new Error('invalid_scan_snapshot');
    const start = Math.max(from, oldestRetained);
    if (messages.length !== total - start || messages.some((m, i) => m.index !== start + i)) throw new Error('incomplete_scan_snapshot');
    if (from < oldestRetained) await this.create(gapEvent(seat, from, oldestRetained, now, roomExpiresAt), now);
    for (const { index, message } of messages) await this.generate([seat], index, message, now, roomExpiresAt);
    // Nothing advances if any event write above fails.
    return this.advanceScan(seat, from, total);
  }
  async maintain(seat: SeatRef, roomExists: boolean, oldestRetained: number, now: number): Promise<void> {
    absoluteCursor(oldestRetained);
    for (const event of await this.list(seat)) if (active(event))
      await this.apply(event.eventId, { kind: 'maintain', roomExists, oldestRetained }, now);
  }
  /** Phase 2 calls from poll and its patrol scheduler; no process-global timer. */
  async patrol(seats: readonly { seat: ManagedSeat; roomExpiresAt: number; load: () => Promise<ScanSnapshot | null> }[], now: number): Promise<{ seat: SeatRef; error: unknown }[]> {
    const errors: { seat: SeatRef; error: unknown }[] = [];
    for (const entry of seats) {
      try {
        const snapshot = await entry.load();
        if (snapshot) await this.scan(entry.seat, async from => ({ ...snapshot, messages: snapshot.messages.filter(m => m.index >= from) }), now, entry.roomExpiresAt);
        await this.maintain(entry.seat, snapshot !== null, snapshot?.oldestRetained ?? 0, now);
      } catch (error) { errors.push({ seat: entry.seat, error }); }
    }
    return errors;
  }
  private async authority(code: string, name: string, seatKey?: string): Promise<AuthoritySnapshot | null> {
    const raw = await this.raw(`room:${code}`);
    if (!raw) return null;
    const room = JSON.parse(raw) as Room;
    if (room.status !== 'active' || !room.roomInstanceId) return null;
    const participant = room.participants.find(p => p.name === name && p.client === 'cc') as
      (Room['participants'][number] & { seatId?: string }) | undefined;
    if (!participant?.seatId || !participant.seatKeyHash) return null;
    const seat = { roomInstanceId: room.roomInstanceId, seatId: participant.seatId, name, seatKeyHash: participant.seatKeyHash };
    if (!verifySeat(seat, name, seatKey)) return null;
    return { raw, seat, roomExpiresAt: room.createdAt + ROOM_TTL_SECONDS * 1_000 };
  }
  /** Return null for ordinary/unverified reads; never trusts a supplied seatId or eventIds. */
  async confirmRead(code: string, name: string, managed: { seatKey: string; wakeRunId?: string } | undefined,
    batch: Omit<ReadBatch, 'wakeRunId'>, now: number): Promise<string[]> {
    if (!managed) return [];
    const auth = await this.authority(code, name, managed.seatKey);
    if (!auth) return [];
    const acked: string[] = [];
    for (const event of await this.list(auth.seat)) {
      const next = await this.mutate(event.eventId, e => acknowledge(e, auth.seat,
        { ...batch, wakeRunId: managed.wakeRunId }, now), { code, raw: auth.raw });
      if (next) acked.push(event.eventId);
    }
    return acked;
  }
  async beginListen(code: string, name: string, seatKey: string): Promise<number | null> {
    const auth = await this.authority(code, name, seatKey);
    if (!auth) return null;
    const epoch = await this.eval(LISTEN_EPOCH_SCRIPT, [`room:${code}`, wakeKeys.listen(auth.seat)], [auth.raw, auth.roomExpiresAt]);
    return epoch || null;
  }
  async sleep(code: string, name: string, seatKey: string, cursor: number, now: number): Promise<SeatRef> {
    absoluteCursor(cursor);
    const auth = await this.authority(code, name, seatKey);
    if (!auth) throw new Error('seat_unauthorized');
    const result = await this.eval(HANDOFF_SCRIPT, [`room:${code}`, `room-msg-count:${code}`, wakeKeys.handoff(auth.seat)],
      [auth.raw, cursor, JSON.stringify({ cursor, at: now }), auth.roomExpiresAt]);
    if (result !== 1) throw new Error(result === -1 ? 'absolute_count_required' : result === -2 ? 'cursor_ahead' : 'seat_changed');
    return { roomInstanceId: auth.seat.roomInstanceId, seatId: auth.seat.seatId };
  }
}

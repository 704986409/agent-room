import { randomBytes } from 'node:crypto';
import { ROOM_TTL_SECONDS, type Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { active, type SeatRef, type WakeEvent } from './_wakeCore.js';
import { RedisWakeStore } from './_wakeRedis.js';

export type BindingStatus = 'active' | 'rebind_required' | 'revoked';

export interface WakeBinding {
  deviceId: string;
  roomInstanceId: string;
  code: string;
  name: string;
  seatId: string;
  seatKeyHash: string;
  status: BindingStatus;
  /** Absolute milliseconds. Carried on the record so rebind does not need PTTL. */
  expiresAt: number;
}

export const bindKey = (seatId: string) => `wake-bind:${seatId}`;
export const bindMetaKey = (seatId: string) => `wake-meta:${seatId}`;
export const deviceKey = (deviceId: string) => `wake-device:${deviceId}`;
export const managedKey = (roomInstanceId: string) => `wake-managed:${roomInstanceId}`;
export const roomsKey = 'wake-rooms';

/** One round trip for poll: device seats, binding JSON, absolute counts, scan cursors. Does not read Room. */
export const POLL_SNAPSHOT_SCRIPT = `
local ids = redis.call('SMEMBERS', KEYS[1])
local rows = {}
for i, id in ipairs(ids) do
  local bind = redis.call('GET', 'wake-bind:' .. id)
  local meta = redis.call('GET', 'wake-meta:' .. id)
  local count = false
  local scan = false
  local events = 0
  if meta then
    local code, roomInstance = string.match(meta, '^(%S+)\t(%S+)$')
    if code and roomInstance then
      count = redis.call('GET', 'room-msg-count:' .. code)
      scan = redis.call('GET', 'wake-scan:' .. roomInstance .. ':' .. id)
      events = redis.call('SCARD', 'wake-seat:' .. roomInstance .. ':' .. id)
    end
  end
  rows[i] = { id, bind or false, count or false, scan or false, events }
end
return rows`;

/** Whole-room snapshot CAS used only to backfill a missing seatId. */
export const ROOM_REPLACE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1`;

export function newSeatId(): string {
  return `st_${randomBytes(4).toString('hex')}`;
}

export function roomExpiresAt(room: Pick<Room, 'createdAt'>): number {
  return room.createdAt + ROOM_TTL_SECONDS * 1000;
}

type CommandClient = Pick<UpstashClient, 'command'>;

export async function readBinding(client: CommandClient, seatId: string): Promise<WakeBinding | null> {
  const raw = await client.command<string | null>(['GET', bindKey(seatId)]);
  return raw ? JSON.parse(raw) as WakeBinding : null;
}

export async function writeBinding(client: CommandClient, binding: WakeBinding, expiresAt: number): Promise<void> {
  const meta = `${binding.code}\t${binding.roomInstanceId}`;
  const stored = { ...binding, expiresAt };
  await client.command(['SET', bindKey(binding.seatId), JSON.stringify(stored), 'PXAT', expiresAt]);
  await client.command(['SET', bindMetaKey(binding.seatId), meta, 'PXAT', expiresAt]);
  await client.command(['SADD', deviceKey(binding.deviceId), binding.seatId]);
  if (binding.status === 'revoked') {
    await client.command(['SREM', managedKey(binding.roomInstanceId), binding.seatId]);
    return;
  }
  await client.command(['SADD', managedKey(binding.roomInstanceId), binding.seatId]);
  await client.command(['SADD', roomsKey, binding.roomInstanceId]);
}

/** seatKey rotation: keep the seat managed and its events, but poll must say rebind_required. */
export async function markRebindRequired(client: CommandClient, seatId: string): Promise<void> {
  const binding = await readBinding(client, seatId);
  if (!binding || binding.status === 'revoked') return;
  await writeBinding(client, { ...binding, status: 'rebind_required' }, binding.expiresAt);
}

export async function deleteBinding(client: CommandClient, binding: WakeBinding): Promise<void> {
  await client.command(['DEL', bindKey(binding.seatId), bindMetaKey(binding.seatId)]);
  await client.command(['SREM', deviceKey(binding.deviceId), binding.seatId]);
  await client.command(['SREM', managedKey(binding.roomInstanceId), binding.seatId]);
}

async function mutateSeatEvents(client: CommandClient, seat: SeatRef, now: number,
  action: { kind: 'cancel'; reason: string } | { kind: 'release' }): Promise<void> {
  const store = new RedisWakeStore(client);
  for (const event of await store.list(seat)) {
    if (!active(event)) continue;
    await store.apply(event.eventId, action, now);
  }
}

/** Seat removed, kicked, or room ended: drop the binding and cancel unfinished events. */
export async function removeManagedSeat(client: CommandClient, roomInstanceId: string, seatId: string, reason: string, now: number): Promise<void> {
  const binding = await readBinding(client, seatId);
  await mutateSeatEvents(client, { roomInstanceId, seatId }, now, { kind: 'cancel', reason });
  if (binding) await deleteBinding(client, binding);
}

/** Device revocation: drop managed membership, surface revoked on poll, return in-flight claims to PENDING. */
export async function revokeDevice(client: CommandClient, deviceId: string, now: number): Promise<void> {
  const seatIds = await client.command<string[]>(['SMEMBERS', deviceKey(deviceId)]) ?? [];
  for (const seatId of seatIds) {
    const binding = await readBinding(client, seatId);
    if (!binding || binding.deviceId !== deviceId) continue;
    await mutateSeatEvents(client, { roomInstanceId: binding.roomInstanceId, seatId }, now, { kind: 'release' });
    await writeBinding(client, { ...binding, status: 'revoked' }, binding.expiresAt);
  }
}

export interface PollSeatSnapshot {
  seatId: string;
  binding: WakeBinding | null;
  count: number | null;
  scan: number | null;
  /** Size of the seat's event index; 0 + no unscanned messages means nothing to do. */
  events: number;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === false) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export async function readPollSnapshot(client: CommandClient, deviceId: string): Promise<PollSeatSnapshot[]> {
  const rows = await client.command<unknown>(['EVAL', POLL_SNAPSHOT_SCRIPT, 1, deviceKey(deviceId)]);
  const list = Array.isArray(rows) ? rows : [];
  return list.map(row => {
    const [seatId, bindRaw, countRaw, scanRaw, eventsRaw] = row as [string, string | false | null, string | number | false | null, string | number | false | null, number | null | undefined];
    return {
      seatId: String(seatId),
      binding: bindRaw ? JSON.parse(String(bindRaw)) as WakeBinding : null,
      count: asNumber(countRaw),
      scan: asNumber(scanRaw),
      events: Number(eventsRaw ?? 0),
    };
  });
}

export async function listManagedRoomIds(client: CommandClient): Promise<string[]> {
  return await client.command<string[]>(['SMEMBERS', roomsKey]) ?? [];
}

export async function listManagedSeatIds(client: CommandClient, roomInstanceId: string): Promise<string[]> {
  return await client.command<string[]>(['SMEMBERS', managedKey(roomInstanceId)]) ?? [];
}

export function visibleFailure(event: WakeEvent): boolean {
  return event.state === 'FAILED' && event.reason !== 'room_expired';
}

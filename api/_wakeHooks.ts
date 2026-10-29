import type { Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { listManagedSeatIds, readBinding, removeManagedSeat } from './_wakeBind.js';

type CommandClient = Pick<UpstashClient, 'command'>;

export function commandClient(store: unknown): CommandClient | null {
  if (!store || typeof (store as { command?: unknown }).command !== 'function') return null;
  return store as CommandClient;
}

/** Same seat kept its seatId while seatKey rotated. Binding stays, poll returns rebind_required. */
export async function invalidateSeatKeyRotation(store: unknown, seatId: string | undefined): Promise<void> {
  const client = commandClient(store);
  if (!client || !seatId) return;
  await markRebindRequired(client, seatId);
}

/** Seats that disappeared from the room (leave, kick, end, orphan reclaim). */
export async function invalidateRemovedSeats(store: unknown, before: Room, after: Room, reason: string, now = Date.now()): Promise<void> {
  const client = commandClient(store);
  const roomInstanceId = before.roomInstanceId;
  if (!client || !roomInstanceId) return;
  const remaining = new Set(after.participants.map(p => p.seatId).filter(Boolean));
  const gone = before.participants.filter(p => !after.participants.some(
    next => next.client === p.client && next.name === p.name,
  ));
  for (const participant of gone) {
    if (participant.seatId && !remaining.has(participant.seatId)) {
      await removeManagedSeat(client, roomInstanceId, participant.seatId, reason, now);
      continue;
    }
    if (participant.seatId || participant.client !== 'cc') continue;
    for (const seatId of await listManagedSeatIds(client, roomInstanceId)) {
      const binding = await readBinding(client, seatId);
      if (!binding || binding.name !== participant.name || binding.code !== before.code) continue;
      await removeManagedSeat(client, roomInstanceId, seatId, reason, now);
    }
  }
}

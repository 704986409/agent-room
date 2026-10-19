import type { Message } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { verifySeat, type DeliveredMessage } from './_wakeCore.js';
import { RedisWakeStore } from './_wakeRedis.js';

type CommandClient = Pick<UpstashClient, 'command'>;

export interface ManagedListenInput {
  seatKey: string;
  wakeRunId?: string;
  eventIds?: string[];
}

/** eventIds are correlation metadata. A missing or invalid seatKey is an ordinary read. */
export function parseManaged(value: unknown): ManagedListenInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const seatKey = (value as { seatKey?: unknown }).seatKey;
  if (typeof seatKey !== 'string' || !seatKey) return undefined;
  const wakeRunId = (value as { wakeRunId?: unknown }).wakeRunId;
  const eventIds = (value as { eventIds?: unknown }).eventIds;
  return {
    seatKey,
    ...(typeof wakeRunId === 'string' && wakeRunId ? { wakeRunId } : {}),
    ...(Array.isArray(eventIds) ? { eventIds: eventIds.filter((id): id is string => typeof id === 'string') } : {}),
  };
}

function sameMessage(a: Message, b: Message): boolean {
  return a.id === b.id && a.name === b.name && a.text === b.text;
}

export function alignDelivered(indexed: readonly { index: number; message: Message }[], returned: readonly Message[]): DeliveredMessage[] {
  const delivered: DeliveredMessage[] = [];
  let cursor = 0;
  for (const message of returned) {
    const found = indexed.slice(cursor).findIndex(row => sameMessage(row.message, message));
    if (found < 0) continue;
    const row = indexed[cursor + found]!;
    delivered.push({ index: row.index, message: row.message });
    cursor += found + 1;
  }
  return delivered;
}

export interface SettledRead {
  cursor: number;
  acked: string[];
  listenEpoch?: number;
}

/**
 * Confirms wake events only after seatKey verification. timeoutMs > 0 also
 * mints a listenEpoch. Returns null when the seatKey does not authenticate,
 * leaving the caller on the ordinary non-managed path.
 */
export async function settleManagedRead(client: CommandClient, input: {
  code: string;
  name: string;
  managed: ManagedListenInput;
  since: number;
  messages: readonly Message[];
  timeoutMs: number;
  now?: number;
}): Promise<SettledRead | null> {
  const raw = await client.command<string | null>(['GET', `room:${input.code}`]);
  if (!raw) return null;
  const room = JSON.parse(raw) as { status?: string; roomInstanceId?: string; participants?: { name: string; client: string; seatId?: string; seatKeyHash?: string }[] };
  if (room.status !== 'active' || !room.roomInstanceId) return null;
  const participant = room.participants?.find(p => p.client === 'cc' && p.name === input.name);
  if (!participant?.seatId || !participant.seatKeyHash) return null;
  if (!verifySeat({
    roomInstanceId: room.roomInstanceId, seatId: participant.seatId, name: input.name, seatKeyHash: participant.seatKeyHash,
  }, input.name, input.managed.seatKey)) return null;
  const store = new RedisWakeStore(client);
  const snapshot = await store.loadMessages(input.code, input.since);
  if (!snapshot) return null;
  let listenEpoch: number | undefined;
  if (input.timeoutMs > 0) {
    const epoch = await store.beginListen(input.code, input.name, input.managed.seatKey);
    if (!epoch) return null;
    listenEpoch = epoch;
  }
  const acked = await store.confirmRead(input.code, input.name, {
    seatKey: input.managed.seatKey, wakeRunId: input.managed.wakeRunId,
  }, {
    since: input.since,
    cursor: snapshot.total,
    delivered: alignDelivered(snapshot.messages, input.messages),
    timeoutMs: input.timeoutMs,
    listenEpoch,
  }, input.now ?? Date.now());
  return { cursor: snapshot.total, acked, ...(listenEpoch ? { listenEpoch } : {}) };
}

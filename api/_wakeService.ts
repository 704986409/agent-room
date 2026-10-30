import { randomBytes } from 'node:crypto';
import type { Message, Participant, Room } from '@agent-room/shared';
import { appendSystemMessage, type UpstashClient } from '@agent-room/upstash-client';
import { MapDeviceAuthenticator, type DeviceAuthenticator } from './_wakeDevice.js';
import {
  deleteBinding, listManagedRoomIds, listManagedSeatIds, markRebindRequired, newSeatId,
  readBinding, readPollSnapshot, revokeDevice, ROOM_REPLACE_SCRIPT, roomExpiresAt,
  visibleFailure, writeBinding, type WakeBinding,
} from './_wakeBind.js';
import { active, inFlight, readStart, verifySeat, type ManagedSeat, type WakeEvent } from './_wakeCore.js';
import { RedisWakeStore } from './_wakeRedis.js';
import { wakeFactsForAgent } from './_agentWake.js';

type CommandClient = Pick<UpstashClient, 'command'>;

export class WakeRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'WakeRequestError';
  }
}

const ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  invalid_cursor: 400,
  cursor_required: 400,
  cursor_ahead: 400,
  unauthorized: 401,
  seat_unauthorized: 403,
  not_bound: 403,
  absolute_count_required: 409,
  rebind_required: 409,
  run_active: 409,
  run_unknown: 409,
  conflict: 409,
  scan_not_initialized: 409,
  wake_cas_contention: 503,
};

function fail(code: string): never {
  throw new WakeRequestError(ERROR_STATUS[code] ?? 400, code);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface WakeServiceOptions {
  authenticator: DeviceAuthenticator;
  now?: () => number;
  ids?: () => string;
  /** Server override for the daemon's poll interval. Overloaded deployments lengthen this. */
  nextPollMs?: number;
}

interface ClaimBody {
  eventId: string;
  claimId?: string;
  leaseUntil?: number;
  error?: string;
}

export class WakeService {
  readonly store: RedisWakeStore;
  constructor(private readonly client: CommandClient, private readonly options: WakeServiceOptions) {
    this.store = new RedisWakeStore(client);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private id(prefix: string): string {
    return this.options.ids?.() ?? `${prefix}_${randomBytes(8).toString('hex')}`;
  }

  async handle(authorization: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
    try {
      const device = await this.options.authenticator.authenticate(authorization);
      if (!device) return { status: 401, body: { error: 'unauthorized' } };
      const record = asRecord(body);
      switch (str(record.action)) {
        case 'register': return { status: 200, body: await this.register(device.deviceId, record) };
        case 'unregister': return { status: 200, body: await this.unregister(device.deviceId, record) };
        case 'poll': return { status: 200, body: await this.poll(device.deviceId) };
        case 'claim': return { status: 200, body: await this.claim(device.deviceId, record) };
        case 'renew': return { status: 200, body: await this.renew(device.deviceId, record) };
        case 'progress': return { status: 200, body: await this.progress(device.deviceId, record) };
        default: return { status: 400, body: { error: 'bad_request' } };
      }
    } catch (error) {
      if (error instanceof WakeRequestError) return { status: error.status, body: { error: error.code } };
      const code = error instanceof Error ? error.message : '';
      const status = ERROR_STATUS[code];
      if (status) return { status, body: { error: code } };
      console.error(`[wake] handle failed reason=${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: { error: 'internal' } };
    }
  }

  async register(deviceId: string, body: Record<string, unknown>): Promise<unknown> {
    const code = str(body.code);
    const name = str(body.name);
    const seatKey = typeof body.seatKey === 'string' ? body.seatKey : '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(code) || !name || name.includes('\t') || !seatKey) fail('bad_request');
    const requested = body.cursor === undefined ? undefined : Number(body.cursor);
    const room = await this.readRoom(code);
    if (!room || room.status !== 'active' || !room.roomInstanceId) fail('seat_unauthorized');
    const issued = await this.ensureSeatId(code, room, name, seatKey);
    const seat = { roomInstanceId: issued.roomInstanceId, seatId: issued.seatId };
    const totalRaw = await this.client.command<string | number | null>(['GET', `room-msg-count:${code}`]);
    if (totalRaw === null || totalRaw === undefined) fail('absolute_count_required');
    const total = Number(totalRaw);
    const scanFrom = await this.store.initializeScan(seat, Number.isFinite(requested) ? requested : undefined, total, roomExpiresAt(room));
    const previous = await readBinding(this.client, seat.seatId);
    if (previous && previous.deviceId !== deviceId) {
      await this.client.command(['SREM', `wake-device:${previous.deviceId}`, seat.seatId]);
      for (const event of await this.store.list(seat)) {
        if (inFlight(event) && event.deviceId === previous.deviceId)
          await this.store.apply(event.eventId, { kind: 'release' }, this.now());
      }
    }
    const binding: WakeBinding = {
      deviceId, roomInstanceId: issued.roomInstanceId, code, name, seatId: issued.seatId,
      seatKeyHash: issued.seatKeyHash, status: 'active', expiresAt: roomExpiresAt(room),
    };
    await writeBinding(this.client, binding, binding.expiresAt);
    console.info(`[host] wake registered roomCode=${code} seatId=${issued.seatId} scanFrom=${scanFrom}`);
    return { roomInstanceId: issued.roomInstanceId, seatId: issued.seatId, scanFrom };
  }

  async unregister(deviceId: string, body: Record<string, unknown>): Promise<unknown> {
    const binding = await this.requireActiveBinding(deviceId, str(body.seatId));
    const seat = { roomInstanceId: binding.roomInstanceId, seatId: binding.seatId };
    for (const event of await this.store.list(seat)) {
      if (active(event)) await this.store.apply(event.eventId, { kind: 'cancel', reason: 'unregistered' }, this.now());
    }
    await deleteBinding(this.client, binding);
    console.info(`[leave] wake unregistered roomCode=${binding.code} seatId=${binding.seatId}`);
    return { unregistered: true, seatId: binding.seatId };
  }

  /** Binding snapshot is one EVAL. Room JSON is read only when a seat actually has unscanned messages.
   *  Per-seat isolation matches patrol: one bad bind/scan/JSON must not 500 the whole device poll. */
  async poll(deviceId: string): Promise<unknown> {
    const now = this.now();
    const seats = [];
    for (const snap of await readPollSnapshot(this.client, deviceId)) {
      const binding = snap.binding;
      if (!binding || binding.deviceId !== deviceId) continue;
      try {
        if (binding.status !== 'active') {
          seats.push({ seatId: binding.seatId, code: binding.code, name: binding.name, status: binding.status, pending: [], inFlight: [], failed: [] });
          continue;
        }
        const seat = { roomInstanceId: binding.roomInstanceId, seatId: binding.seatId };
        // Idle fast path (design §3.4/P1-4): no unscanned messages and no events for this seat ->
        // the snapshot EVAL was the only Redis work. Room expiry and leases are left to patrol.
        if (snap.count !== null && snap.scan !== null && snap.count <= snap.scan && snap.events === 0) {
          seats.push({ seatId: binding.seatId, code: binding.code, name: binding.name, status: 'active' as const, pending: [], inFlight: [], failed: [] });
          continue;
        }
        if (snap.count !== null && snap.scan !== null && snap.count > snap.scan) {
          const managed = await this.managedSeat(binding);
          if (managed) {
            await this.store.scan(managed.seat, async from => {
              const snapshot = await this.store.loadMessages(binding.code, from);
              if (!snapshot) throw new Error('room_expired');
              return snapshot;
            }, now, managed.expiresAt);
          }
        }
        const length = Number(await this.client.command(['LLEN', `room-msgs:${binding.code}`]) ?? 0);
        const oldest = snap.count === null ? 0 : Math.max(0, snap.count - length);
        await this.store.maintain(seat, snap.count !== null, oldest, now);
        const events = await this.store.list(seat);
        if (events.some(e => e.state === 'PENDING' || inFlight(e))) {
          console.info(`[wake] poll roomCode=${binding.code} seatId=${binding.seatId} pendingEventIds=${events.filter(e => e.state === 'PENDING').map(e => e.eventId).join(',')} inFlightEventIds=${events.filter(inFlight).map(e => e.eventId).join(',')}`);
        }
        await this.noteFailures(binding, events);
        seats.push({
          seatId: binding.seatId, code: binding.code, name: binding.name, status: 'active' as const,
          pending: events.filter(e => e.state === 'PENDING').map(summarize),
          inFlight: events.filter(e => inFlight(e) && e.deviceId === deviceId).map(summarize),
          failed: events.filter(e => e.state === 'FAILED' || e.state === 'EXPIRED').map(summarize),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[wake] poll seat failed roomCode=${binding.code} seatId=${binding.seatId} reason=${reason}`);
        seats.push({
          seatId: binding.seatId, code: binding.code, name: binding.name,
          status: binding.status === 'active' ? 'active' as const : binding.status,
          pending: [], inFlight: [], failed: [],
        });
      }
    }
    return { seats, nextPollMs: this.options.nextPollMs ?? 5000 };
  }

  async claim(deviceId: string, body: Record<string, unknown>): Promise<unknown> {
    const eventIds = Array.isArray(body.eventIds) ? body.eventIds.map(str).filter(Boolean) : [];
    if (!eventIds.length) fail('bad_request');
    const requestedRun = str(body.wakeRunId) || undefined;
    const loaded = [];
    for (const eventId of eventIds) {
      const event = await this.store.get(eventId);
      if (!event) fail('conflict');
      loaded.push(event);
    }
    const seat = { roomInstanceId: loaded[0]!.roomInstanceId, seatId: loaded[0]!.seatId };
    if (loaded.some(e => e.roomInstanceId !== seat.roomInstanceId || e.seatId !== seat.seatId)) fail('bad_request');
    const binding = await this.requireActiveBinding(deviceId, seat.seatId);
    console.info(`[wake] claim start roomCode=${binding.code} seatId=${seat.seatId} eventIds=${eventIds.join(',')}`);
    const existing = (await this.store.list(seat)).filter(e => inFlight(e) && e.deviceId === deviceId && e.wakeRunId);
    const activeRun = existing[0]?.wakeRunId;
    let wakeRunId: string;
    if (requestedRun) {
      if (activeRun && activeRun !== requestedRun) fail('run_active');
      if (!activeRun) fail('run_unknown');
      wakeRunId = requestedRun;
    } else if (activeRun) {
      fail('run_active');
    } else {
      wakeRunId = this.id('wr');
    }
    const now = this.now();
    const claims: ClaimBody[] = [];
    for (const event of loaded) {
      const claimId = this.id('cl');
      const next = await this.store.apply(event.eventId, { kind: 'claim', claimId, deviceId, wakeRunId }, now);
      claims.push(next ? { eventId: event.eventId, claimId: next.claimId, leaseUntil: next.leaseUntil }
        : { eventId: event.eventId, error: 'conflict' });
    }
    const runEvents = (await this.store.list(seat)).filter(e => e.wakeRunId === wakeRunId && active(e));
    if (!runEvents.length) return { wakeRunId, claims };
    const snapshot = await this.store.loadMessages(binding.code, 0);
    if (!snapshot) fail('seat_unauthorized');
    const handoff = await this.store.handoff(seat);
    const start = readStart(runEvents, seat, snapshot.oldestRetained, handoff?.cursor);
    console.info(`[wake] claim delivered roomCode=${binding.code} seatId=${seat.seatId} eventIds=${claims.filter(c => c.claimId).map(c => c.eventId).join(',')} readFrom=${start.readFrom}`);
    return { wakeRunId, readFrom: start.readFrom, ...(start.gap ? { gap: start.gap } : {}), claims };
  }

  async renew(deviceId: string, body: Record<string, unknown>): Promise<unknown> {
    const claimIds = Array.isArray(body.claimIds) ? body.claimIds.map(str).filter(Boolean) : [];
    if (!claimIds.length) fail('bad_request');
    const now = this.now();
    const renewed = [];
    const rejected = [];
    for (const claimId of claimIds) {
      const event = await this.eventByClaim(deviceId, claimId);
      if (!event) { rejected.push({ claimId, error: 'conflict' }); continue; }
      const next = await this.store.apply(event.eventId, { kind: 'renew', claimId, deviceId }, now);
      if (!next) rejected.push({ claimId, error: 'conflict' });
      else renewed.push({ claimId, eventId: next.eventId, leaseUntil: next.leaseUntil });
    }
    return { renewed, rejected };
  }

  async progress(deviceId: string, body: Record<string, unknown>): Promise<unknown> {
    const updates = Array.isArray(body.claims) ? body.claims : [];
    if (!updates.length) fail('bad_request');
    const now = this.now();
    const updated = [];
    const rejected = [];
    for (const raw of updates) {
      const item = asRecord(raw);
      const claimId = str(item.claimId);
      const status = str(item.status);
      if (status !== 'resume_started' && status !== 'resume_failed') fail('bad_request');
      const event = await this.eventByClaim(deviceId, claimId);
      if (!event) { rejected.push({ claimId, error: 'conflict' }); continue; }
      const next = await this.store.apply(event.eventId, { kind: status, claimId, deviceId }, now);
      if (!next) rejected.push({ claimId, error: 'conflict' });
      else {
        updated.push({ eventId: next.eventId, state: next.state });
        if (next.state === 'FAILED') {
          const binding = await readBinding(this.client, next.seatId);
          if (binding) await this.noteFailures(binding, [next]);
        }
      }
    }
    return { updated, rejected };
  }

  /** Patrol entry. Isolated per seat by RedisWakeStore.patrol. */
  async patrol(now = this.now()): Promise<{ seatId: string; error: string }[]> {
    const entries = [];
    for (const roomInstanceId of await listManagedRoomIds(this.client)) {
      for (const seatId of await listManagedSeatIds(this.client, roomInstanceId)) {
        const binding = await readBinding(this.client, seatId);
        if (!binding || binding.roomInstanceId !== roomInstanceId || binding.status === 'revoked') continue;
        const managed = await this.managedSeat(binding);
        entries.push({
          seat: managed?.seat ?? { roomInstanceId, seatId, name: binding.name, facts: { sole: false, humanBroadcastsToMe: true } },
          roomExpiresAt: managed?.expiresAt ?? binding.expiresAt,
          load: () => this.store.loadMessages(binding.code, 0),
        });
      }
    }
    const errors = await this.store.patrol(entries, now);
    for (const entry of entries) {
      const binding = await readBinding(this.client, entry.seat.seatId);
      if (!binding) continue;
      await this.noteFailures(binding, await this.store.list(entry.seat));
    }
    return errors.map(e => ({ seatId: e.seat.seatId, error: e.error instanceof Error ? e.error.message : String(e.error) }));
  }

  async revoke(deviceId: string, now = this.now()): Promise<void> {
    await revokeDevice(this.client, deviceId, now);
  }

  private async readRoom(code: string): Promise<Room | null> {
    const raw = await this.client.command<string | null>(['GET', `room:${code}`]);
    return raw ? JSON.parse(raw) as Room : null;
  }

  private async ensureSeatId(code: string, room: Room, name: string, seatKey: string): Promise<{ roomInstanceId: string; seatId: string; seatKeyHash: string }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = attempt === 0 ? room : await this.readRoom(code);
      if (!current?.roomInstanceId) fail('seat_unauthorized');
      const raw = await this.client.command<string | null>(['GET', `room:${code}`]);
      if (!raw) fail('seat_unauthorized');
      const parsed = JSON.parse(raw) as Room;
      const participant = parsed.participants.find(p => p.client === 'cc' && p.name === name);
      if (!participant?.seatKeyHash || !verifySeat({
        roomInstanceId: parsed.roomInstanceId!, seatId: participant.seatId ?? 'pending', name, seatKeyHash: participant.seatKeyHash,
      }, name, seatKey)) fail('seat_unauthorized');
      if (!parsed.roomInstanceId) fail('seat_unauthorized');
      if (participant.seatId) return { roomInstanceId: parsed.roomInstanceId, seatId: participant.seatId, seatKeyHash: participant.seatKeyHash };
      participant.seatId = newSeatId();
      const ok = await this.client.command(['EVAL', ROOM_REPLACE_SCRIPT, 1, `room:${code}`, raw, JSON.stringify(parsed)]);
      if (Number(ok) === 1) return { roomInstanceId: parsed.roomInstanceId, seatId: participant.seatId, seatKeyHash: participant.seatKeyHash };
    }
    fail('wake_cas_contention');
  }

  private async requireActiveBinding(deviceId: string, seatId: string): Promise<WakeBinding> {
    const binding = seatId ? await readBinding(this.client, seatId) : null;
    if (!binding || binding.deviceId !== deviceId) fail('not_bound');
    if (binding.status === 'rebind_required') fail('rebind_required');
    if (binding.status !== 'active') fail('not_bound');
    return binding;
  }

  private async managedSeat(binding: WakeBinding): Promise<{ seat: ManagedSeat; expiresAt: number } | null> {
    const room = await this.readRoom(binding.code);
    if (!room?.roomInstanceId || room.roomInstanceId !== binding.roomInstanceId) return null;
    const participant = room.participants.find(p => p.seatId === binding.seatId) as Participant | undefined;
    const name = participant?.name ?? binding.name;
    return {
      seat: { roomInstanceId: binding.roomInstanceId, seatId: binding.seatId, name, facts: wakeFactsForAgent(room, name) },
      expiresAt: roomExpiresAt(room),
    };
  }

  private async eventByClaim(deviceId: string, claimId: string): Promise<WakeEvent | null> {
    if (!claimId) return null;
    const snaps = await readPollSnapshot(this.client, deviceId);
    for (const snap of snaps) {
      if (!snap.binding || snap.binding.deviceId !== deviceId || snap.binding.status !== 'active') continue;
      const events = await this.store.list({ roomInstanceId: snap.binding.roomInstanceId, seatId: snap.binding.seatId });
      const found = events.find(e => e.claimId === claimId && e.deviceId === deviceId);
      if (found) return found;
    }
    return null;
  }

  private async noteFailures(binding: WakeBinding, events: readonly WakeEvent[]): Promise<void> {
    for (const event of events) {
      if (!visibleFailure(event)) continue;
      const noted = await this.client.command(['SET', `wake-noted:${event.eventId}`, '1', 'NX', 'PXAT', event.retainUntil]);
      if (noted === null) continue;
      const label = event.reason === 'messages_trimmed' ? '消息已被裁剪'
        : event.reason === 'launcher_unavailable' ? '启动器不可用' : '本地唤醒失败';
      // No @ and no targetAgentName: the notice must not create another wake event.
      await appendSystemMessage(this.client as UpstashClient, binding.code, {
        id: this.now(), type: 'sys', name: 'system', initials: 'SY', color: '#888888', role: 'System',
        text: `未送达：${binding.name}（${label}）`, client: 'cc', time: this.now(),
      }).catch(() => {});
    }
  }
}

function summarize(event: WakeEvent) {
  return {
    eventId: event.eventId,
    state: event.state,
    ...(event.sourceMessageIndex !== undefined ? { sourceMessageIndex: event.sourceMessageIndex, sourceCursorBefore: event.sourceCursorBefore } : {}),
    ...(event.gap ? { gap: event.gap } : {}),
    ...(event.from ? { from: event.from } : {}),
    ...(event.preview ? { preview: event.preview } : {}),
    ...(event.claimId ? { claimId: event.claimId, leaseUntil: event.leaseUntil } : {}),
    ...(event.wakeRunId ? { wakeRunId: event.wakeRunId } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
  };
}

/** Process-local patrol. Started from the VPS entrypoint, never from tests or module import. */
export function startWakePatrol(client: CommandClient, intervalMs = 180_000): { stop(): void } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error('invalid_patrol_interval');
  const service = new WakeService(client, { authenticator: new MapDeviceAuthenticator(new Map()) });
  const timer = setInterval(() => { void service.patrol().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}

export async function invalidateRotatedSeat(client: CommandClient, seatId: string): Promise<void> {
  await markRebindRequired(client, seatId);
}

/** Used by send hooks. Generates only for seats currently in the managed set. */
export async function generateForCommittedMessage(client: CommandClient, code: string, index: number, message: Message, now = Date.now()): Promise<void> {
  const raw = await client.command<string | null>(['GET', `room:${code}`]);
  if (!raw) return;
  const room = JSON.parse(raw) as Room;
  if (!room.roomInstanceId) return;
  const seatIds = await listManagedSeatIds(client, room.roomInstanceId);
  if (!seatIds.length) return;
  const seats: ManagedSeat[] = [];
  for (const seatId of seatIds) {
    const binding = await readBinding(client, seatId);
    if (!binding || binding.status === 'revoked' || binding.roomInstanceId !== room.roomInstanceId) continue;
    const name = room.participants.find(p => p.seatId === seatId)?.name ?? binding.name;
    seats.push({ roomInstanceId: room.roomInstanceId, seatId, name, facts: wakeFactsForAgent(room, name) });
  }
  if (!seats.length) return;
  await new RedisWakeStore(client).generate(seats, index, message, now, roomExpiresAt(room));
}

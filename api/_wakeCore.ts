import { createHash, timingSafeEqual } from 'node:crypto';
import type { Message } from '@agent-room/shared';
import { messageAddressesAgent, type WakeFacts } from './_agentWake.js';

export const MAX_ATTEMPTS = 2;
export const CLAIM_LEASE_MS = 60_000;
export const ACK_LEASE_MS = 180_000;
export const MAX_WAIT_MS = 86_400_000;
export type WakeState = 'PENDING' | 'CLAIMED' | 'WAITING_ACK' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type FailureReason = 'messages_trimmed' | 'room_expired' | 'attempts_exhausted' | 'launcher_unavailable';
export interface SeatRef { roomInstanceId: string; seatId: string }
export interface WakeReceipt {
  receiptKind: 'managed_read' | 'managed_listen';
  wakeRunId?: string;
  ackedAt: number;
  listenEpoch?: number;
}
export interface WakeEvent extends SeatRef {
  eventId: string;
  sourceMessageIndex?: number;
  sourceCursorBefore?: number;
  sourceMessageId?: Message['id'];
  gap?: [number, number];
  from?: string;
  preview?: string;
  state: WakeState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  /** Absolute milliseconds: room expiry plus one day. */
  retainUntil: number;
  claimId?: string;
  deviceId?: string;
  wakeRunId?: string;
  leaseUntil?: number;
  reason?: FailureReason | string;
  receipt?: WakeReceipt;
}
export const active = (e: WakeEvent): boolean => ['PENDING', 'CLAIMED', 'WAITING_ACK'].includes(e.state);
export const inFlight = (e: WakeEvent): boolean => e.state === 'CLAIMED' || e.state === 'WAITING_ACK';
export const sameSeat = (a: SeatRef, b: SeatRef): boolean => a.roomInstanceId === b.roomInstanceId && a.seatId === b.seatId;
export function absoluteCursor(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_cursor');
  return n;
}
export function registrationCursor(requested?: number, handoff?: number, total?: number): number {
  if (total === undefined) throw new Error('absolute_count_required');
  absoluteCursor(total);
  const cursors = [requested, handoff].filter((n): n is number => n !== undefined).map(absoluteCursor);
  if (!cursors.length) throw new Error('cursor_required');
  if (cursors.some(n => n > total)) throw new Error('cursor_ahead');
  return Math.min(...cursors);
}
export function readStart(events: readonly WakeEvent[], seat: SeatRef, oldestRetained: number, handoff?: number): { readFrom: number; gap?: [number, number] } {
  absoluteCursor(oldestRetained);
  const cursors = events.filter(e => sameSeat(e, seat) && active(e) && e.sourceCursorBefore !== undefined)
    .map(e => absoluteCursor(e.sourceCursorBefore!));
  if (handoff !== undefined) cursors.push(absoluteCursor(handoff));
  if (!cursors.length) throw new Error('cursor_required');
  const from = Math.min(...cursors);
  return from < oldestRetained ? { readFrom: oldestRetained, gap: [from, oldestRetained] } : { readFrom: from };
}
export function messageEvent(seat: SeatRef, index: number, message: Message, now: number, roomExpiresAt: number): WakeEvent {
  absoluteCursor(index);
  return { roomInstanceId: seat.roomInstanceId, seatId: seat.seatId, eventId: `wk:${seat.roomInstanceId}:${index}:${seat.seatId}`, sourceMessageIndex: index,
    sourceCursorBefore: index, sourceMessageId: message.id, from: message.name, preview: (message.text ?? '').slice(0, 160),
    state: 'PENDING', attempts: 0, createdAt: now, updatedAt: now, deadlineAt: now + MAX_WAIT_MS,
    retainUntil: roomExpiresAt + MAX_WAIT_MS };
}
export function gapEvent(seat: SeatRef, from: number, to: number, now: number, roomExpiresAt: number): WakeEvent {
  absoluteCursor(from); absoluteCursor(to);
  if (from >= to) throw new Error('invalid_gap');
  return { roomInstanceId: seat.roomInstanceId, seatId: seat.seatId, eventId: `wk:${seat.roomInstanceId}:gap:${from}-${to}:${seat.seatId}`, gap: [from, to], state: 'FAILED',
    reason: 'messages_trimmed', attempts: 0, createdAt: now, updatedAt: now, deadlineAt: now,
    retainUntil: roomExpiresAt + MAX_WAIT_MS };
}
export interface ManagedSeat extends SeatRef { name: string; facts: WakeFacts }
export function eventsForMessage(seats: readonly ManagedSeat[], index: number, message: Message, now: number, roomExpiresAt: number): WakeEvent[] {
  return seats.filter(s => messageAddressesAgent(message, s.name, s.facts)).map(s => messageEvent(s, index, message, now, roomExpiresAt));
}

export type WakeAction =
  | { kind: 'claim'; claimId: string; deviceId: string; wakeRunId: string }
  | { kind: 'renew' | 'resume_started' | 'resume_failed'; claimId: string; deviceId: string }
  | { kind: 'maintain'; roomExists: boolean; oldestRetained: number }
  | { kind: 'cancel'; reason: string }
  | { kind: 'release' }
  | { kind: 'fail'; reason: FailureReason };
function clearClaim(e: WakeEvent): WakeEvent {
  const { claimId, deviceId, wakeRunId, leaseUntil, ...rest } = e;
  return rest;
}
function rollback(e: WakeEvent, now: number): WakeEvent {
  const attempts = e.attempts + 1;
  return { ...clearClaim(e), attempts, updatedAt: now, state: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
    ...(attempts >= MAX_ATTEMPTS ? { reason: 'attempts_exhausted' } : {}) };
}
/** Pure reducer. null means conflict/no change; persistence must CAS the entire snapshot. */
export function transition(e: WakeEvent, action: WakeAction, now: number): WakeEvent | null {
  if (!active(e)) return null;
  if (action.kind === 'cancel') return { ...clearClaim(e), state: 'CANCELLED', reason: action.reason, updatedAt: now };
  if (action.kind === 'fail') return { ...clearClaim(e), state: 'FAILED', reason: action.reason, updatedAt: now };
  if (action.kind === 'maintain') {
    if (!action.roomExists) return transition(e, { kind: 'fail', reason: 'room_expired' }, now);
    if (e.sourceMessageIndex !== undefined && e.sourceMessageIndex < action.oldestRetained)
      return transition(e, { kind: 'fail', reason: 'messages_trimmed' }, now);
  }
  if (now >= e.deadlineAt) return { ...clearClaim(e), state: 'EXPIRED', updatedAt: now };
  if (action.kind === 'maintain') return inFlight(e) && now >= e.leaseUntil! ? rollback(e, now) : null;
  // Every rollback of an in-flight claim consumes the same bounded retry budget.
  if (action.kind === 'release') return inFlight(e) ? rollback(e, now) : null;
  if (action.kind === 'claim') {
    if (e.state !== 'PENDING' || !action.claimId || !action.deviceId || !action.wakeRunId) return null;
    return { ...e, claimId: action.claimId, deviceId: action.deviceId, wakeRunId: action.wakeRunId,
      state: 'CLAIMED', leaseUntil: now + CLAIM_LEASE_MS, updatedAt: now };
  }
  if (!inFlight(e) || e.claimId !== action.claimId || e.deviceId !== action.deviceId || now >= e.leaseUntil!) return null;
  if (action.kind === 'resume_failed') return rollback(e, now);
  if (action.kind === 'resume_started' && e.state !== 'CLAIMED') return null;
  const state = action.kind === 'resume_started' ? 'WAITING_ACK' : e.state;
  return { ...e, state, updatedAt: now, leaseUntil: Math.max(e.leaseUntil!, now + (state === 'WAITING_ACK' ? ACK_LEASE_MS : CLAIM_LEASE_MS)) };
}

export interface SeatAuthority extends SeatRef { name: string; seatKeyHash: string }
export function verifySeat(authority: SeatAuthority, name: string, seatKey?: string): boolean {
  if (authority.name !== name || !seatKey || !/^[a-f0-9]{64}$/i.test(authority.seatKeyHash)) return false;
  const hash = createHash('sha256').update(seatKey, 'utf8').digest();
  return timingSafeEqual(Buffer.from(authority.seatKeyHash, 'hex'), hash);
}
export interface DeliveredMessage { index: number; message: Pick<Message, 'id'> }
export interface ReadBatch {
  since: number;
  cursor: number;
  /** Only messages actually returned to the caller, indexed by their absolute sequence. */
  delivered: readonly DeliveredMessage[];
  timeoutMs: number;
  wakeRunId?: string;
  listenEpoch?: number;
}
/** Caller must authenticate the seat using the authoritative Room snapshot, never daemon metadata. */
export function acknowledge(e: WakeEvent, seat: SeatRef, batch: ReadBatch, now: number): WakeEvent | null {
  absoluteCursor(batch.since); absoluteCursor(batch.cursor);
  if (!active(e) || now >= e.deadlineAt || !sameSeat(e, seat) || e.sourceMessageIndex === undefined
    || batch.since > e.sourceMessageIndex || e.sourceMessageIndex >= batch.cursor
    || !batch.delivered.some(m => m.index === e.sourceMessageIndex && m.message.id === e.sourceMessageId)) return null;
  if (batch.timeoutMs > 0 && (!Number.isSafeInteger(batch.listenEpoch) || batch.listenEpoch! <= 0)) return null;
  return { ...clearClaim(e), state: 'SUCCEEDED', updatedAt: now, retainUntil: now + MAX_WAIT_MS,
    receipt: { receiptKind: batch.timeoutMs > 0 ? 'managed_listen' : 'managed_read', ackedAt: now,
      ...(batch.wakeRunId ? { wakeRunId: batch.wakeRunId } : {}),
      ...(batch.timeoutMs > 0 ? { listenEpoch: batch.listenEpoch } : {}) } };
}

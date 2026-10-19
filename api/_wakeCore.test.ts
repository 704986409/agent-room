import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-room/shared';
import {
  ACK_LEASE_MS, CLAIM_LEASE_MS, MAX_WAIT_MS, acknowledge, eventsForMessage, gapEvent, messageEvent,
  readStart, registrationCursor, transition, verifySeat, type ManagedSeat, type ReadBatch, type WakeEvent,
} from './_wakeCore.js';

const seat: ManagedSeat = { roomInstanceId: 'ri', seatId: 'st', name: 'bot', facts: { sole: false, humanBroadcastsToMe: false } };
const msg = (id = 7, text = '@bot work'): Message => ({ id, type: 'msg', client: 'cc', name: 'sender', text, initials: 'S', color: '#000', role: '', time: 0 });
const pending = () => messageEvent(seat, 184, msg(), 1_000, 700_000_000);
const claim = { kind: 'claim', claimId: 'c', deviceId: 'd', wakeRunId: 'r' } as const;
const owned = (kind: 'renew' | 'resume_started' | 'resume_failed') => ({ kind, claimId: 'c', deviceId: 'd' });
const claimed = () => transition(pending(), claim, 1_001)!;
const batch = (extra: Partial<ReadBatch> = {}): ReadBatch => ({ since: 183, cursor: 187, timeoutMs: 0,
  delivered: [{ index: 184, message: msg() }, { index: 186, message: msg(9) }], ...extra });

describe('wake reducer', () => {
  it('claims only pending; startup is not success; renew extends the correct lease', () => {
    const e = claimed();
    expect(e).toMatchObject({ state: 'CLAIMED', attempts: 0, leaseUntil: 1_001 + CLAIM_LEASE_MS });
    expect(transition(e, claim, 1_002)).toBeNull();
    const started = transition(e, owned('resume_started'), 1_003)!;
    expect(started).toMatchObject({ state: 'WAITING_ACK', leaseUntil: 1_003 + ACK_LEASE_MS });
    expect(transition(started, owned('resume_started'), 1_004)).toBeNull();
    expect(transition(started, owned('renew'), 2_000)?.leaseUntil).toBe(2_000 + ACK_LEASE_MS);
    expect(started.receipt).toBeUndefined();
  });
  it.each(['CLAIMED', 'WAITING_ACK'] as const)('bounds retries after %s lease expiry', state => {
    let e: WakeEvent = { ...claimed(), state };
    expect(transition(e, { kind: 'maintain', roomExists: true, oldestRetained: 0 }, e.leaseUntil! - 1)).toBeNull();
    e = transition(e, { kind: 'maintain', roomExists: true, oldestRetained: 0 }, e.leaseUntil!)!;
    expect(e).toMatchObject({ state: 'PENDING', attempts: 1 });
    expect(e.claimId).toBeUndefined();
    e = transition(e, { ...claim, claimId: 'c2' }, 70_000)!;
    e = transition(e, { kind: 'maintain', roomExists: true, oldestRetained: 0 }, e.leaseUntil!)!;
    expect(e).toMatchObject({ state: 'FAILED', attempts: 2, reason: 'attempts_exhausted' });
  });
  it('bounds reported failures and rejects wrong, stale, or expired ownership', () => {
    const e = claimed();
    for (const kind of ['renew', 'resume_started', 'resume_failed'] as const) {
      expect(transition(e, { ...owned(kind), claimId: 'wrong' }, 2_000)).toBeNull();
      expect(transition(e, { ...owned(kind), deviceId: 'wrong' }, 2_000)).toBeNull();
      expect(transition(e, owned(kind), e.leaseUntil!)).toBeNull();
    }
    const retry = transition(e, owned('resume_failed'), 2_000)!;
    const second = transition(retry, claim, 2_001)!;
    expect(transition(second, owned('resume_failed'), 2_002)).toMatchObject({ state: 'FAILED', attempts: 2 });
  });
  it('makes room expiry and trimmed triggers visible; supports cancel, timeout, launcher failure and rebind', () => {
    expect(transition(claimed(), { kind: 'maintain', roomExists: false, oldestRetained: 0 }, 2_000))
      .toMatchObject({ state: 'FAILED', reason: 'room_expired' });
    expect(transition(pending(), { kind: 'maintain', roomExists: true, oldestRetained: 185 }, 2_000))
      .toMatchObject({ state: 'FAILED', reason: 'messages_trimmed' });
    expect(transition(pending(), { kind: 'maintain', roomExists: true, oldestRetained: 184 }, 2_000)).toBeNull();
    expect(transition(pending(), { kind: 'maintain', roomExists: true, oldestRetained: 0 }, 1_000 + MAX_WAIT_MS)?.state).toBe('EXPIRED');
    expect(transition(claimed(), { kind: 'cancel', reason: 'seat_removed' }, 2_000)?.state).toBe('CANCELLED');
    expect(transition(pending(), { kind: 'fail', reason: 'launcher_unavailable' }, 2_000)?.state).toBe('FAILED');
    const released = transition(claimed(), { kind: 'release' }, 2_000)!;
    expect(released).toMatchObject({ state: 'PENDING', attempts: 1 });
    expect(released.claimId).toBeUndefined();
  });
  it.each(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const)('keeps %s terminal', state => {
    const e = { ...pending(), state };
    expect(transition(e, claim, 2_000)).toBeNull();
    expect(transition(e, { kind: 'cancel', reason: 'removed' }, 2_000)).toBeNull();
    expect(acknowledge(e, seat, batch(), 2_000)).toBeNull();
  });
});

describe('verified delivery rules', () => {
  it.each(['PENDING', 'CLAIMED', 'WAITING_ACK'] as const)('acknowledges %s without requiring a run claim', state => {
    expect(acknowledge({ ...pending(), state }, seat, batch({ wakeRunId: 'old-run' }), 2_000))
      .toMatchObject({ state: 'SUCCEEDED', receipt: { receiptKind: 'managed_read', wakeRunId: 'old-run', ackedAt: 2_000 }, retainUntil: 2_000 + MAX_WAIT_MS });
  });
  it('checks actual returned indexes, id, range, instance and seat, not just end cursor', () => {
    for (const b of [batch({ since: 185 }), batch({ cursor: 184 }), batch({ delivered: [] }),
      batch({ delivered: [{ index: 184, message: msg(999) }] }), batch({ delivered: [{ index: 183, message: msg() }] })]) {
      expect(acknowledge(pending(), seat, b, 2_000)).toBeNull();
    }
    expect(acknowledge(pending(), { ...seat, seatId: 'other' }, batch(), 2_000)).toBeNull();
    expect(acknowledge(pending(), { ...seat, roomInstanceId: 'new' }, batch(), 2_000)).toBeNull();
    expect(acknowledge(pending(), seat, batch(), pending().deadlineAt)).toBeNull();
  });
  it('records authenticated listen epoch and confirms merged events individually', () => {
    const b = batch({ timeoutMs: 5_000, listenEpoch: 2 });
    expect(acknowledge(pending(), seat, b, 2_000)?.receipt).toMatchObject({ receiptKind: 'managed_listen', listenEpoch: 2 });
    expect(acknowledge(messageEvent(seat, 186, msg(9), 1_000, 700_000_000), seat, b, 2_000)?.state).toBe('SUCCEEDED');
    expect(acknowledge(pending(), seat, batch({ timeoutMs: 5_000 }), 2_000)).toBeNull();
  });
  it('verifies the current seatKey hash with constant-time comparison', () => {
    const authority = { ...seat, seatKeyHash: createHash('sha256').update('key').digest('hex') };
    expect(verifySeat(authority, 'bot', 'key')).toBe(true);
    for (const key of [undefined, '', 'other-seat-key']) expect(verifySeat(authority, 'bot', key)).toBe(false);
    expect(verifySeat(authority, 'other', 'key')).toBe(false);
    expect(verifySeat({ ...authority, seatKeyHash: 'invalid' }, 'bot', 'key')).toBe(false);
  });
});

describe('absolute cursors and generation', () => {
  it('uses earliest handoff/event, including the falling-asleep race, and reports half-open gaps', () => {
    expect(readStart([pending(), messageEvent(seat, 186, msg(), 1_000, 700_000_000)], seat, 0, 183)).toEqual({ readFrom: 183 });
    expect(readStart([pending()], seat, 0, 190)).toEqual({ readFrom: 184 });
    expect(readStart([pending()], seat, 0)).toEqual({ readFrom: 184 });
    expect(readStart([pending()], seat, 185, 120)).toEqual({ readFrom: 185, gap: [120, 185] });
    expect(readStart([messageEvent(seat, 100, msg(), 1_000, 700_000_000)], seat, 0, 100)).toEqual({ readFrom: 100 });
    expect(() => readStart([], seat, 0)).toThrow('cursor_required');
  });
  it('requires registration history and rejects unreliable, negative, fractional and future cursors', () => {
    expect(registrationCursor(190, 183, 200)).toBe(183);
    expect(registrationCursor(undefined, 183, 200)).toBe(183);
    expect(() => registrationCursor(undefined, undefined, 200)).toThrow('cursor_required');
    expect(() => registrationCursor(1, undefined, undefined)).toThrow('absolute_count_required');
    for (const n of [-1, 1.1, NaN, Infinity]) expect(() => registrationCursor(n, undefined, 200)).toThrow('invalid_cursor');
    expect(() => registrationCursor(201, undefined, 200)).toThrow('cursor_ahead');
  });
  it('deduplicates by absolute index rather than timestamp and generates visible deterministic gaps', () => {
    expect(messageEvent(seat, 184, msg(), 1_000, 700_000_000).eventId).not.toBe(messageEvent(seat, 185, msg(), 1_000, 700_000_000).eventId);
    expect(gapEvent(seat, 100, 183, 1_000, 700_000_000)).toMatchObject({ eventId: 'wk:ri:gap:100-183:st', state: 'FAILED', reason: 'messages_trimmed' });
    expect(eventsForMessage([seat, { ...seat, seatId: 'st2', name: 'other' }], 184, msg(7, '@bot @other'), 1_000, 700_000_000)).toHaveLength(2);
    expect(eventsForMessage([seat], 184, msg(7, 'unaddressed'), 1_000, 700_000_000)).toHaveLength(0);
  });
});

describe('send/scan addressing parity with room_listen', () => {
  it.each([
    { name: 'Bot', text: '@bot work', facts: seat.facts, expected: true },
    { name: 'Bot(2)', text: '@Bot work', facts: seat.facts, expected: true },
    { name: 'bot', text: 'routing', metadata: { targetAgentName: 'bot' }, facts: seat.facts, expected: true },
    { name: 'bot', text: 'quiet cc note', facts: seat.facts, expected: false },
    { name: 'bot', text: 'human goal', client: 'web', facts: { sole: false, humanBroadcastsToMe: true }, expected: true },
    { name: 'bot', text: 'human goal for moderator only', client: 'web', facts: seat.facts, expected: false },
    { name: 'bot', text: 'single agent question', facts: { sole: true, humanBroadcastsToMe: false }, expected: true },
    { name: 'bot', text: '[BLOCKER] need help', facts: { ...seat.facts, deliverLead: true }, expected: true },
    { name: 'bot', text: '[RESULT] done', facts: seat.facts, expected: false },
  ])('generates an event for $name / $text: $expected', ({ name, text, metadata, client, facts, expected }) => {
    const target = { ...seat, name, facts };
    const input = { ...msg(7, text), metadata, client: (client ?? 'cc') as Message['client'] };
    expect(eventsForMessage([target], 184, input, 1_000, 700_000_000)).toHaveLength(expected ? 1 : 0);
  });
  it('copies only stable identity fields into event metadata', () => {
    const authority = { ...seat, seatKeyHash: 'never-copy' };
    const result = messageEvent(authority, 184, msg(), 1_000, 700_000_000);
    expect(result).not.toHaveProperty('facts');
    expect(result).not.toHaveProperty('seatKeyHash');
  });
});

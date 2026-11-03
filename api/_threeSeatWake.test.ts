// Point-test: three HostLocal managed seats (Codex / Cursor / Gemini-agy) in one
// open-mode room. Hard rule: an @ wakes ONLY the @'d seat; no-@ wakes none.
import { describe, expect, it } from 'vitest';
import type { Message, Room } from '@agent-room/shared';
import { eventsForMessage, type ManagedSeat } from './_wakeCore.js';
import { managedWakeFacts, messageAddressesAgent, wakeFactsForAgent } from './_agentWake.js';

const room = {
  replyMode: 'open',
  createdBy: 'jie',
  modeConfig: {},
  participants: [
    { name: 'jie', client: 'web' },
    { name: 'Codex', client: 'cc', seatId: 's-codex' },
    { name: 'Cursor', client: 'cc', seatId: 's-cursor' },
    { name: 'Gemini', client: 'cc', seatId: 's-gemini' },
  ],
} as unknown as Room;

const seats: ManagedSeat[] = ['Codex', 'Cursor', 'Gemini'].map(name => ({
  roomInstanceId: 'ri1', seatId: `s-${name.toLowerCase()}`, name, facts: managedWakeFacts(room, name),
}));
const human = (text: string, id = 1): Message => ({ id, type: 'msg', client: 'web', name: 'jie', text, initials: 'J', color: '#000', role: '', time: 0 });
const agent = (name: string, text: string, id = 2): Message => ({ id, type: 'msg', client: 'cc', name, text, initials: 'A', color: '#000', role: '', time: 0 });
const woken = (m: Message) => eventsForMessage(seats, 10, m, 1_000, 9_000_000).map(e => e.seatId).sort();
const listenWoken = (m: Message) => ['Codex', 'Cursor', 'Gemini'].filter(n => messageAddressesAgent(m, n, wakeFactsForAgent(room, n)));

describe('three managed seats: wake routing', () => {
  it.each([
    ['@codex 看下', ['s-codex']],
    ['@Codex 看下', ['s-codex']],
    ['＠cursor 帮我', ['s-cursor']],
    ['@gemini summarize', ['s-gemini']],
    ['@Gemini看下这个', ['s-gemini']],
    ['@codex @gemini 一起', ['s-codex', 's-gemini']],
    ['大家好，有人吗', []],
    ['mail me at a@codex.com', []],
  ])('server wake %s → %j', (text, expected) => {
    expect(woken(human(text))).toEqual(expected);
  });

  it.each([
    ['@codex 看下', ['Codex']],
    ['@cursor 帮我', ['Cursor']],
    ['@gemini summarize', ['Gemini']],
  ])('room_listen hold %s wakes only the @ seat', (text, expected) => {
    expect(listenWoken(human(text))).toEqual(expected);
  });

  it('agent replies do not wake the other seats unless they @ them', () => {
    expect(woken(agent('Codex', '已完成'))).toEqual([]);
    expect(woken(agent('Codex', '@Cursor 请 review'))).toEqual(['s-cursor']);
  });

  it('token boundary: @Codex does not wake a seat named Codex2', () => {
    const s2: ManagedSeat[] = [...seats, { roomInstanceId: 'ri1', seatId: 's-codex2', name: 'Codex2', facts: managedWakeFacts(room, 'Codex2') }];
    expect(eventsForMessage(s2, 10, human('@Codex 看下'), 1, 9e6).map(e => e.seatId)).toEqual(['s-codex']);
    expect(eventsForMessage(s2, 10, human('@Codex2 看下'), 1, 9e6).map(e => e.seatId)).toEqual(['s-codex2']);
  });

  it('per-seat wake events carry distinct ids (independent wakeRunId claims)', () => {
    const ev = eventsForMessage(seats, 10, human('@codex @cursor @gemini'), 1, 9e6);
    expect(new Set(ev.map(e => e.eventId)).size).toBe(3);
  });

  it('sole-agent room keeps un-@ fallback', () => {
    const solo = { ...room, participants: room.participants.slice(0, 2) } as Room;
    const s = [{ roomInstanceId: 'ri1', seatId: 's-codex', name: 'Codex', facts: managedWakeFacts(solo, 'Codex') }];
    expect(eventsForMessage(s, 1, human('hi'), 1, 9e6)).toHaveLength(1);
  });
});

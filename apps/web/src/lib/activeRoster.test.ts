import { PRESENCE_DISCONNECTED_MS, type Participant } from '@agent-room/shared';
import { describe, expect, it } from 'vitest';
import { rosterWithActiveSeats, terminalSeatIdFor } from './activeRoster.js';

const host: Participant = {
  name: '杰', role: '', color: '#111', initials: '杰', client: 'web',
  joinedAt: 1, lastSeenAt: 1, canSpeak: true,
};

describe('rosterWithActiveSeats', () => {
  it('keeps a speaking managed seat when the room document has no cc participant', () => {
    const now = 1_000_000;
    const roster = rosterWithActiveSeats(
      [host],
      [{ name: '测试333', client: 'cc', type: 'msg', time: now - 1000, role: '开发工程师' }],
      [],
      'ABC-DEF-GHJ',
      now,
    );
    expect(roster.map(p => `${p.name}:${p.client}`)).toEqual(['杰:web', '测试333:cc']);
  });

  it('adds a live PTY seat that has not reached the room document yet', () => {
    const roster = rosterWithActiveSeats(
      [host],
      [],
      [{ seatId: 'st_1', pid: 4, cols: 80, rows: 24, name: 'Codex', code: 'ABC-DEF-GHJ' }],
      'ABC-DEF-GHJ',
    );
    expect(roster.find(p => p.name === 'Codex')).toMatchObject({ client: 'cc', seatId: 'st_1' });
  });

  it('does not resurrect a cc speaker who went quiet', () => {
    const now = 5_000_000;
    const roster = rosterWithActiveSeats(
      [host],
      [{ name: 'Gone', client: 'cc', type: 'msg', time: now - PRESENCE_DISCONNECTED_MS - 1 }],
      [],
      'ABC-DEF-GHJ',
      now,
    );
    expect(roster).toEqual([host]);
  });
});

describe('terminalSeatIdFor', () => {
  const rows = [{ seatId: 'st_pty', pid: 1, cols: 80, rows: 24, name: '测试333', code: 'ABC-DEF-GHJ' }];

  it('prefers the live PTY id over the room seat id', () => {
    expect(terminalSeatIdFor(
      { name: '测试333', client: 'cc', seatId: 'seat_server' },
      rows,
      'ABC-DEF-GHJ',
    )).toBe('st_pty');
  });

  it('uses a managed seat id when this PC has no matching PTY', () => {
    expect(terminalSeatIdFor(
      { name: 'Codex', client: 'cc', seatId: 'st_managed' },
      [],
      'ABC-DEF-GHJ',
    )).toBe('st_managed');
  });

  it('stays hidden for a browser seat', () => {
    expect(terminalSeatIdFor({ name: '杰', client: 'web' }, rows, 'ABC-DEF-GHJ')).toBeNull();
  });
});

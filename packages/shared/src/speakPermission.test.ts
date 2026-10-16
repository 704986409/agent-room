import { describe, it, expect } from 'vitest';
import { findSpeakerSeat, webSpeakGate } from './speakPermission.js';
import type { Participant, Room } from './types.js';

function seat(over: Partial<Participant> = {}): Participant {
  return {
    name: 'Robin', role: '', color: '#111', initials: 'RO', client: 'web',
    joinedAt: 0, lastSeenAt: 0, canSpeak: true, ...over,
  };
}

function room(participants: Participant[], createdBy = 'Robin'): Room {
  return {
    code: 'ABC-DEF-GHJ', topic: 't', createdAt: 0, createdBy,
    status: 'active', version: 1, participants,
  };
}

describe('findSpeakerSeat (server rule)', () => {
  it('returns the seat for a matching (name, client) that can speak', () => {
    const r = room([seat(), seat({ name: 'Claude', client: 'cc' })]);
    expect(findSpeakerSeat(r, 'Claude', 'cc')?.name).toBe('Claude');
  });

  it('treats a legacy seat without canSpeak as allowed', () => {
    const r = room([seat({ canSpeak: undefined })]);
    expect(findSpeakerSeat(r, 'Robin', 'web')).not.toBeNull();
  });

  it('requires the client kind to match, not just the name', () => {
    const r = room([seat({ name: 'Claude', client: 'cc' })]);
    expect(findSpeakerSeat(r, 'Claude', 'web')).toBeNull();
  });

  it('does not exempt the host from the roster requirement', () => {
    expect(findSpeakerSeat(room([], 'Robin'), 'Robin', 'web')).toBeNull();
  });

  // The overload issue #6 is about: a muted seat and an absent seat are both
  // null here, so callers cannot tell the two apart.
  it('returns null for both a muted seat and a missing seat', () => {
    expect(findSpeakerSeat(room([seat({ canSpeak: false })]), 'Robin', 'web')).toBeNull();
    expect(findSpeakerSeat(room([]), 'Robin', 'web')).toBeNull();
  });
});

describe('webSpeakGate (composer rule, as shipped)', () => {
  it('allows a seated participant who is not muted', () => {
    const gate = webSpeakGate(room([seat({ name: 'Guest' })], 'Robin'), 'Guest');
    expect(gate).toMatchObject({ isHost: false, myCanSpeak: true });
  });

  it('blocks a seated participant the host muted', () => {
    const gate = webSpeakGate(room([seat({ name: 'Guest', canSpeak: false })], 'Robin'), 'Guest');
    expect(gate.myCanSpeak).toBe(false);
  });

  // Both of these disagree with findSpeakerSeat above — the gap issue #6
  // closes. Pinned so the alignment shows up as a deliberate change.
  it('allows the host even with no seat on the roster', () => {
    expect(webSpeakGate(room([], 'Robin'), 'Robin').myCanSpeak).toBe(true);
  });

  it('allows a non-member whose seat is absent', () => {
    expect(webSpeakGate(room([seat({ name: 'Guest' })], 'Robin'), 'Stranger').myCanSpeak).toBe(true);
  });

  it('ignores a cc seat when judging the web viewer', () => {
    const r = room([seat({ name: 'Claude', client: 'cc', canSpeak: false })], 'Robin');
    expect(webSpeakGate(r, 'Claude').myParticipant).toBeUndefined();
  });
});

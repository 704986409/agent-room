import { describe, it, expect } from 'vitest';
import { evaluateSpeakPermission, findSpeakerSeat, webSpeakGate } from './speakPermission.js';
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

describe('evaluateSpeakPermission', () => {
  it('allows a seated participant who is not muted', () => {
    const r = room([seat(), seat({ name: 'Claude', client: 'cc' })]);
    expect(evaluateSpeakPermission(r, 'Claude', 'cc')).toEqual({
      allowed: true, participant: r.participants[1],
    });
  });

  // The distinction issue #6 is about: these two were both `null` before, so
  // a stranger was told the host had muted them.
  it('separates a muted seat from a missing one', () => {
    const muted = seat({ canSpeak: false });
    expect(evaluateSpeakPermission(room([muted]), 'Robin', 'web')).toEqual({
      allowed: false, reason: 'muted', participant: muted,
    });
    expect(evaluateSpeakPermission(room([]), 'Robin', 'web')).toEqual({
      allowed: false, reason: 'not_member',
    });
  });

  it('treats a legacy seat without canSpeak as allowed', () => {
    expect(evaluateSpeakPermission(room([seat({ canSpeak: undefined })]), 'Robin', 'web').allowed).toBe(true);
  });

  it('counts a seat on another client as a different seat', () => {
    const r = room([seat({ name: 'Claude', client: 'cc' })]);
    expect(evaluateSpeakPermission(r, 'Claude', 'web')).toEqual({ allowed: false, reason: 'not_member' });
  });
});

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

  it('returns null for both a muted seat and a missing seat', () => {
    expect(findSpeakerSeat(room([seat({ canSpeak: false })]), 'Robin', 'web')).toBeNull();
    expect(findSpeakerSeat(room([]), 'Robin', 'web')).toBeNull();
  });
});

describe('webSpeakGate (composer rule)', () => {
  it('allows a seated participant who is not muted', () => {
    const gate = webSpeakGate(room([seat({ name: 'Guest' })], 'Robin'), 'Guest');
    expect(gate).toMatchObject({ isHost: false, blockedReason: null });
  });

  it('blocks a seated participant the host muted', () => {
    const gate = webSpeakGate(room([seat({ name: 'Guest', canSpeak: false })], 'Robin'), 'Guest');
    expect(gate.blockedReason).toBe('muted');
  });

  // The host the room actually has: created the room, joined through the web,
  // holds a seat. Removing the host exemption must not touch this person.
  it('allows the host that joined through the web, like any other seat', () => {
    const gate = webSpeakGate(room([seat({ name: 'Robin' })], 'Robin'), 'Robin');
    expect(gate).toMatchObject({ isHost: true, blockedReason: null });
  });

  // Both of these used to disagree with findSpeakerSeat — the gap issue #6
  // closes. The composer now refuses exactly what the server refuses.
  it('blocks the host when the roster has no seat for them', () => {
    expect(webSpeakGate(room([], 'Robin'), 'Robin').blockedReason).toBe('not_member');
  });

  it('blocks a non-member whose seat is absent', () => {
    expect(webSpeakGate(room([seat({ name: 'Guest' })], 'Robin'), 'Stranger').blockedReason).toBe('not_member');
  });

  it('ignores a cc seat when judging the web viewer', () => {
    const r = room([seat({ name: 'Claude', client: 'cc', canSpeak: false })], 'Robin');
    expect(webSpeakGate(r, 'Claude').myParticipant).toBeUndefined();
  });

  it('keeps the muted seat available to the caller', () => {
    const r = room([seat({ name: 'Guest', canSpeak: false })], 'Robin');
    expect(webSpeakGate(r, 'Guest').myParticipant?.name).toBe('Guest');
  });
});

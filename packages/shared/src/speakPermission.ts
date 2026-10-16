/**
 * Who may put a message in a room, as pure rules both tiers can read.
 *
 * The authority is the server: `appendMessage` accepts a sender only when the
 * roster holds a seat for that exact (name, client) tuple whose `canSpeak` is
 * not false. The web composer decides the same question locally so it can grey
 * itself out instead of letting a user type into a message that will bounce.
 *
 * Both tiers answer from `evaluateSpeakPermission` below, so the two places
 * where the composer used to be more generous than the server — the host was
 * always allowed, and a missing seat read as permission — are gone. Keep this
 * module pure: it must stay importable from the browser bundle and from the
 * storage layer alike.
 */

import type { ClientKind, Participant, Room } from './types.js';

/** Why a sender may not speak: no seat at all, or a seat the host muted. */
export type SpeakDenialReason = 'muted' | 'not_member';

/**
 * The answer to "may this (name, client) speak here", with the two refusals
 * kept apart. They need different words — one asks the host for an unmute,
 * the other asks the sender to join — and a single `null` could not say which.
 */
export type SpeakPermission =
  | { allowed: true; participant: Participant }
  | { allowed: false; reason: 'muted'; participant: Participant }
  | { allowed: false; reason: 'not_member' };

/**
 * `canSpeak === undefined` counts as allowed: rooms created before the field
 * existed have no value there, and every joiner since flows through joinRoom,
 * which always writes one.
 */
export function evaluateSpeakPermission(
  room: Pick<Room, 'participants'>,
  name: string,
  clientKind: ClientKind,
): SpeakPermission {
  const participant = room.participants.find(p => p.name === name && p.client === clientKind);
  if (!participant) return { allowed: false, reason: 'not_member' };
  if (participant.canSpeak === false) return { allowed: false, reason: 'muted', participant };
  return { allowed: true, participant };
}

/** The seat allowed to speak, or null. For callers that only need the verdict. */
export function findSpeakerSeat(
  room: Pick<Room, 'participants'>,
  name: string,
  clientKind: ClientKind,
): Participant | null {
  const permission = evaluateSpeakPermission(room, name, clientKind);
  return permission.allowed ? permission.participant : null;
}

export interface WebSpeakGate {
  /** Viewer owns the host slot by display name. */
  isHost: boolean;
  /** The viewer's own web seat, if the roster still has one. */
  myParticipant: Participant | undefined;
  /** Null while the composer renders; otherwise which notice stands in for it. */
  blockedReason: SpeakDenialReason | null;
}

/**
 * The web composer's rule: the server's rule, asked about the viewer's own web
 * seat. The host gets no exemption here because it gets none on the server —
 * a host who joined through the web holds a seat like everyone else.
 */
export function webSpeakGate(
  room: Pick<Room, 'participants' | 'createdBy'>,
  selfName: string,
): WebSpeakGate {
  const permission = evaluateSpeakPermission(room, selfName, 'web');
  return {
    isHost: room.createdBy === selfName,
    myParticipant: 'participant' in permission ? permission.participant : undefined,
    blockedReason: permission.allowed ? null : permission.reason,
  };
}

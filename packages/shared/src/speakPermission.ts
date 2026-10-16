/**
 * Who may put a message in a room, as pure rules both tiers can read.
 *
 * The authority is the server: `appendMessage` accepts a sender only when the
 * roster holds a seat for that exact (name, client) tuple whose `canSpeak` is
 * not false. The web composer decides the same question locally so it can grey
 * itself out instead of letting a user type into a message that will bounce.
 *
 * Those two answers do not currently agree — the web gate exempts the host and
 * reads a missing seat as permission, neither of which the server does. Both
 * rules live here, side by side and named for the tier that owns them, so the
 * divergence is visible in one file rather than inferred from two screens of
 * unrelated code. Keep them pure: this module must stay importable from the
 * browser bundle and from the storage layer alike.
 */

import type { ClientKind, Participant, Room } from './types.js';

/**
 * The server's rule. Returns the seat allowed to speak, or null.
 *
 * `canSpeak === undefined` counts as allowed: rooms created before the field
 * existed have no value there, and every joiner since flows through joinRoom,
 * which always writes one.
 *
 * Null is currently overloaded — it means both "no such seat" and "that seat is
 * muted", which is why a non-member is told they were muted by the host.
 */
export function findSpeakerSeat(
  room: Pick<Room, 'participants'>,
  name: string,
  clientKind: ClientKind,
): Participant | null {
  const p = room.participants.find(x => x.name === name && x.client === clientKind);
  if (!p) return null;
  if (p.canSpeak === false) return null;
  return p;
}

export interface WebSpeakGate {
  /** Viewer owns the host slot by display name. */
  isHost: boolean;
  /** The viewer's own web seat, if the roster still has one. */
  myParticipant: Participant | undefined;
  /** Whether the composer renders instead of the muted banner. */
  myCanSpeak: boolean;
}

/**
 * The web composer's rule, as the room screen has always applied it: the host
 * is always allowed, and anyone whose seat is absent is treated as allowed.
 */
export function webSpeakGate(
  room: Pick<Room, 'participants' | 'createdBy'>,
  selfName: string,
): WebSpeakGate {
  const isHost = room.createdBy === selfName;
  const myParticipant = room.participants.find(p => p.name === selfName && p.client === 'web');
  return {
    isHost,
    myParticipant,
    myCanSpeak: isHost || myParticipant?.canSpeak !== false,
  };
}

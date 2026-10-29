import { type Participant } from '@agent-room/shared';

/** How long a cc chat line may stand in for a seat the room document has not stored yet. */
const SPEAKER_LAG_MS = 15_000;
import { colorForName, initialsFor } from './colors.js';
import { terminalsForRoom, type DesktopTerminalRow } from './desktopTerminal.js';

export interface RosterSpeaker {
  name: string;
  client: string;
  type?: string;
  time: number;
  role?: string;
}

/**
 * Chat is the message list. The room document can lag a managed join, or a
 * presence write can land before that seat is visible to this client, while
 * the agent is already sending. The member list unions the stored roster with
 * live PTY seats and cc speakers from the last few seconds (join lag only).
 * Older lines must not put a kicked seat back on the member list.
 */
export function rosterWithActiveSeats(
  participants: readonly Participant[],
  messages: readonly RosterSpeaker[],
  terminals: readonly DesktopTerminalRow[],
  roomCode: string,
  now = Date.now(),
): Participant[] {
  const next = [...participants];
  const hasAgent = (name: string) => next.some(p => p.client === 'cc' && p.name === name);

  for (const row of terminalsForRoom(terminals, roomCode)) {
    const name = row.name?.trim();
    if (!name || hasAgent(name)) continue;
    next.push(agentSeat(name, now, row.seatId));
  }

  const latest = new Map<string, RosterSpeaker>();
  for (const message of messages) {
    if (message.client !== 'cc' || message.type === 'sys' || !message.name.trim()) continue;
    const prev = latest.get(message.name);
    if (!prev || message.time >= prev.time) latest.set(message.name, message);
  }
  for (const message of latest.values()) {
    if (hasAgent(message.name)) continue;
    if (now - message.time > SPEAKER_LAG_MS) continue;
    next.push(agentSeat(message.name, message.time, undefined, message.role));
  }
  return next;
}

function agentSeat(name: string, at: number, seatId?: string, role = ''): Participant {
  return {
    name,
    role,
    color: colorForName(name),
    initials: initialsFor(name),
    client: 'cc',
    joinedAt: at,
    lastSeenAt: at,
    canSpeak: true,
    ...(seatId ? { seatId } : {}),
  };
}

/**
 * PTY id when this PC has a live terminal for the seat; otherwise the managed
 * seat id stored on the participant. Web seats have neither.
 */
export function terminalSeatIdFor(
  participant: Pick<Participant, 'name' | 'client' | 'seatId'>,
  terminals: readonly DesktopTerminalRow[],
  roomCode: string,
): string | null {
  if (participant.client !== 'cc') return null;
  const rows = terminalsForRoom(terminals, roomCode);
  const byName = rows.find(row => row.name?.trim() === participant.name);
  if (byName) return byName.seatId;
  const byId = participant.seatId ? rows.find(row => row.seatId === participant.seatId) : undefined;
  if (byId) return byId.seatId;
  return participant.seatId ?? null;
}

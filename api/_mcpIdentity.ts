// How an MCP caller's name and text become a seat and a room message.
//
// Leaf module: the dispatcher builds Participants with these (room_create,
// room_join), the send tool builds the message it posts with them, and the
// join greeting uses both. Nothing here talks to the room API.

import { AVATAR_PALETTE, normalizeEscapedWhitespace, redactSecretText } from '@agent-room/shared';
import type { Message, Participant } from '@agent-room/shared';

export function initialsFor(name: string): string {
  const parts = (typeof name === 'string' ? name : '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase().padEnd(2, '?');
  return '??';
}

export function colorForName(name: string): string {
  const safe = typeof name === 'string' ? name : '';
  let h = 0;
  for (let i = 0; i < safe.length; i++) h = (h * 31 + safe.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length]!;
}

export function buildMessage(name: string, role: string, text: string, speaker?: Participant): Message {
  return {
    id: Date.now(),
    type: 'msg',
    name,
    initials: speaker?.initials ?? initialsFor(name),
    color: speaker?.color ?? colorForName(name),
    role,
    text: redactSecretText(normalizeEscapedWhitespace(text)),
    client: 'cc',
    time: Date.now(),
  };
}

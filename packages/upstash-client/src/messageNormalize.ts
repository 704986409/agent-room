// Field-level repair for messages crossing the room-list boundary. Pulled out
// of messages.ts so the write choke point (`rpushMessage`,
// `commitTaskVerification`) and the read path (`listMessages`) share one
// definition of "a message we are willing to store / hand to a renderer",
// and so those rules are unit-testable without a Redis double.

import type { Message } from '@agent-room/shared';

/**
 * How far a client-supplied `time` may sit from the server clock before we
 * stop believing it. A laptop with a wrong clock, an agent replaying an old
 * payload and a hand-rolled curl call all land outside this window; inside it
 * the client value is kept, so the ordering the sender saw locally survives.
 */
export const MAX_MESSAGE_TIME_SKEW_MS = 5 * 60 * 1000;

/**
 * The server is the clock.
 *
 * `time` is stamped with `now` when it is missing, null, a string, NaN /
 * Infinity, or further than MAX_MESSAGE_TIME_SKEW_MS from `now` in either
 * direction. A finite number inside that window is left exactly as the sender
 * set it.
 *
 * Never rejects and never touches `id`: old clients that omit `time`
 * altogether must keep working. They were the bug — a message stored with no
 * `time` reached the web app as `new Date(undefined)`, which renders as
 * "Invalid Date" in every bubble.
 */
export function normalizeMessageTime(message: Message, now: number = Date.now()): Message {
  const time: unknown = message.time;
  if (
    typeof time === 'number'
    && Number.isFinite(time)
    && Math.abs(time - now) <= MAX_MESSAGE_TIME_SKEW_MS
  ) {
    return message;
  }
  return { ...message, time: now };
}

/**
 * Everything a message is fixed up with on its way into the room list.
 * Applied at the single write choke point so no append path — chat message,
 * status ping, system event, task verification — can skip it.
 */
export function normalizeMessageForWrite(message: Message, now: number = Date.now()): Message {
  const timed = normalizeMessageTime(message, now);
  // Older MCP clients (and raw API callers) can send a message with no
  // `text` — persisting it verbatim crashed every web viewer of the room
  // ("Cannot read properties of undefined (reading 'length')" in Bubble
  // rendering).
  return typeof timed.text === 'string' ? timed : { ...timed, text: '' };
}

/**
 * Read-side heal for messages written before the rules above existed. One
 * text-less message already in a list would otherwise brick the room page for
 * every viewer, and we cannot rewrite history in Redis.
 */
export function healStoredMessage(message: Message): Message {
  return typeof message.text === 'string' ? message : { ...message, text: '' };
}

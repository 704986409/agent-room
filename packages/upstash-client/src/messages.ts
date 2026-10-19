import type { Message, MessageMetadata, RoleInTurn, InvocationType, Room } from '@agent-room/shared';
import { evaluateSpeakPermission, MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { MutedError, NotParticipantError, NotYourTurnError, getRoom } from './rooms.js';
import { RoomNotFoundError, UpstashError } from './errors.js';
import { healStoredMessage, normalizeMessageForWrite } from './messageNormalize.js';
import type { TurnSpokenEntry } from './turnState.js';
import {
  advanceOnTimeout,
  advanceTurn,
  applyGraceSupplementReply,
  canAgentSpeakNow,
  casTurnState,
  consumeHostDirectedDetailed,
  isGraceSupplementSpeaker,
  isHumanSender,
  isDeliverLead,
  moderatorReply,
  newModeratorTurn,
  newSequentialTurn,
  renewTurnDeadline,
  shouldStartNewTurn,
  skipQueueHead,
} from './turnState.js';

function msgsKey(code: string): string { return `room-msgs:${code}`; }
// Tracks the absolute count of messages ever appended to this room. Used by
// listMessages to translate an agent's logical cursor (= "I've consumed N
// messages so far") into the right LRANGE start position even after LTRIM has
// dropped the oldest entries. Without this, once the list crosses
// MAX_MESSAGES_PER_ROOM the index stored in the cursor stops mapping to the
// list slot the agent thinks it does, and agents silently MISS messages
// (witnessed: 999 in list, +2 RPUSH, LTRIM keeps last 1000 → first new
// message is now at index 998, but cursor=999 LRANGEs from 999 and only
// returns the second new message). The counter key is INCRed in the same
// pipeline as RPUSH/LTRIM so it can never drift relative to the list.
function msgCountKey(code: string): string { return `room-msg-count:${code}`; }

function roomExpirationTimestamp(roomCreatedAt: number): number {
  if (!Number.isSafeInteger(roomCreatedAt) || roomCreatedAt <= 0) {
    throw new UpstashError('Invalid room creation time for message retention.');
  }
  const expireAt = Math.floor(roomCreatedAt / 1000) + ROOM_TTL_SECONDS;
  if (!Number.isSafeInteger(expireAt) || expireAt <= Math.floor(Date.now() / 1000)) {
    throw new UpstashError('Room retention deadline has passed; refusing to write messages.');
  }
  return expireAt;
}

/** Next poll cursor after a full `listMessages(..., 0)` when the room has a counter key; `null` = legacy room. */
export async function getMessageTotalCount(client: UpstashClient, code: string): Promise<number | null> {
  const countRaw = await client.command<unknown>(['GET', msgCountKey(code)]);
  if (countRaw === null || countRaw === undefined) return null;
  const totalCount = typeof countRaw === 'number' ? countRaw : parseInt(String(countRaw), 10);
  return Number.isFinite(totalCount) ? totalCount : null;
}

// Supplement-skip token. A supplement agent that has nothing to add MUST
// emit this exact string (after trim) — appendMessage detects it, advances
// the turn with status='no_addition', and does NOT append a message to the
// chat. Slice B does exact-match only; fuzzy matching ("无补充", "Nothing
// to add", etc.) is deferred to a later iteration once we have real prompt
// outputs to calibrate against.
export const NO_ADDITION_TOKEN = '__no_addition__';

// Result of a successful appendMessage call. `appended` is true for normal
// chat messages (the message ended up in the list); false for messages
// that were absorbed by the turn machinery (the supplement-skip token, or
// any future "swallowed" case). Callers like the MCP room_send handler use
// this to decide what hint to send back to the agent.
export interface AppendResult {
  appended: boolean;
  reason?: 'no_addition';
  // The metadata that ended up on the message (or, in the no_addition
  // case, the metadata that WOULD have been attached). Useful for
  // surfacing roleAtSend/turnId in the tool response.
  metadata: MessageMetadata;
  // Sequential lead-grace path: when a queue-head supplement preempts the
  // Lead, the Lead is logged as skipped_by_grace inside the CAS mutator.
  // We surface that entry here so the MCP layer can post a sys message
  // explaining the skip (mirrors how advanceOnTimeout's skipped[] flows
  // to emitTimeoutSysMessage).
  leadSkipped?: TurnSpokenEntry;
}

// Append a message. Server-side gates, in order:
//   1. Speaker gate: (name, client) must be a non-muted participant. Throws
//      MutedError for a muted seat, NotParticipantError when there is no
//      seat at all — the sender needs to join, not wait for an unmute.
//   2. Turn gate (sequential/moderator modes only): the sender must be the
//      current turn-holder, OR a human (web client / host), OR present in
//      the host-directed one-shot allowlist. Throws NotYourTurnError
//      otherwise.
//
// Side effects on success:
//   - Sequential mode: a human message kicks off a new turn if none is
//     active; an agent message advances the turn cursor. Lazy timeout
//     check runs first, silently skipping past expired speakers (callers
//     that want sys messages for those skips watch via the listen poll).
//   - Message metadata is enriched with modeAtSend / roleAtSend / turnId
//     / invocationType. Callers that pre-set message.metadata fields keep
//     them — server-side fields are merged in, server wins on conflict.
//   - Supplement-skip token (`__no_addition__`) advances the turn WITHOUT
//     appending a chat message; returns { appended: false, reason: 'no_addition' }.
//   - `kind: 'status'` (from room_status) posts a status-tagged message that
//     never advances the turn. In sequential mode, when the sender is the
//     current speaker, it also renews their turn deadline (heartbeat) — a
//     long-running agent can signal "still working" without losing the floor.
const DELIVER_SIGNAL = /\[(RESULT|BLOCKER|DECISION|PLAN)\]/i;

/** Deliver mode: should this agent message be posted as a status note? */
export function isDeliverQuietSend(room: Room, message: Message, kind: 'message' | 'status'): boolean {
  if (message.client !== 'cc' || isHumanSender(room, message.name, message.client)) return false;
  if (kind === 'status') return true;
  if (isDeliverLead(room, message.name, message.client)) return false;
  return !DELIVER_SIGNAL.test(message.text ?? '');
}

export async function appendMessage(
  client: UpstashClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<AppendResult> {
  const room = await getRoom(client, code);
  const permission = evaluateSpeakPermission(room, message.name, message.client);
  if (!permission.allowed) {
    if (permission.reason === 'muted') throw new MutedError(message.name, room.createdBy);
    throw new NotParticipantError(message.name, 'sending messages');
  }
  const mode = room.replyMode ?? 'open';

  // Fast path: open mode — and the orchestrated modes (consensus / debate),
  // which are driven entirely server-side by a multi-round runner rather than
  // by the turn machinery. They post via appendDemoAgentMessage with no floor
  // to wait for, exactly like open mode, so they take the same gating-free path.
  //
  // Deliver mode rides the same turn-less path. Its one rule is quiet
  // execution: an agent other than the lead posts a status note unless the
  // message carries [RESULT] / [BLOCKER] / [DECISION] / [PLAN]. The note is
  // still stored and shown — it just does not read as, or wake, a reply.
  if (mode === 'open' || mode === 'consensus' || mode === 'debate' || mode === 'deliver') {
    const quiet = mode === 'deliver' && isDeliverQuietSend(room, message, kind);
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: quiet ? 'status' : 'open',
      invocationType: quiet ? 'status_update' : (message.metadata?.invocationType ?? 'normal_turn'),
    };
    const enriched: Message = { ...message, metadata };
    await rpushMessage(client, code, enriched, room.createdAt);
    return { appended: true, metadata };
  }

  // Non-open mode: validate and advance turn state atomically.
  // `casTurnState`'s mutator is synchronous and may throw NotYourTurnError
  // to reject — casTurnState re-throws non-Concurrency errors, which we
  // propagate up to the caller (MCP room_send turns this into
  // sent=false/not_your_turn).
  const text = message.text ?? '';
  const isSupplementSkipToken = text.trim() === NO_ADDITION_TOKEN;
  const decision: {
    roleAtSend: RoleInTurn;
    invocationType: InvocationType;
    turnId?: number;
    skipMessage: boolean;
    leadSkipped?: TurnSpokenEntry;
    extendsTurn?: boolean;
  } = {
    roleAtSend: 'open',
    invocationType: 'normal_turn',
    skipMessage: false,
  };

  await casTurnState(client, code, (prev) => {
    // Reset per-attempt decision state so a CAS retry doesn't carry over
    // leadSkipped / extendsTurn from a stale earlier attempt.
    decision.leadSkipped = undefined;
    decision.extendsTurn = false;
    // Lazy cleanup: skip any expired speakers before evaluating this
    // sender. Skipped sys messages are emitted by the listen poll, not
    // here — appendMessage is on the hot path and must not RPUSH a sys
    // event from inside a CAS mutator. We *do* update state.spoken so
    // the listen poll sees the skips and can emit the appropriate
    // events.
    const after = advanceOnTimeout(prev, room);
    let cur = after.state;
    const now = Date.now();

    if (isHumanSender(room, message.name, message.client)) {
      // Humans (web client or the host) are never turn-gated. If a new
      // turn should start, kick one off — sequential and moderator
      // modes each have their own initial-state shape.
      if (shouldStartNewTurn(cur, room)) {
        if (mode === 'sequential') {
          cur = newSequentialTurn(room, message.id);
        } else if (mode === 'moderator') {
          cur = newModeratorTurn(room, message.id);
          // Moderator mode requires a configured Moderator who is
          // currently present in the room. If we couldn't pick one,
          // newModeratorTurn returns null — the human message stands
          // alone and no agent is expected to reply. (The room remains
          // in moderator mode; sweepTimeouts will eventually auto-
          // fallback to open if this stays broken.)
        }
      }
      decision.roleAtSend = 'human';
      decision.invocationType = 'normal_turn';
      decision.turnId = cur?.turnId;
      return cur;
    }

    // cc agent (not the host) — must be the current speaker, or the
    // grace-eligible queue-head supplement, or in the host-directed
    // allowlist.
    if (cur && canAgentSpeakNow(cur, message.name, message.client, now)) {
      const isGrace = isGraceSupplementSpeaker(cur, message.name, message.client, now);
      const role: RoleInTurn = isGrace ? 'supplement' : cur.currentRole!;
      const turnId = cur.turnId;
      // room_status heartbeat: a status ping is posted as a status-tagged
      // message and never advances the turn. When the sender is the actual
      // current speaker in sequential mode, it also renews their deadline
      // (extendsTurn) — that is the "still working" heartbeat. A grace-
      // eligible queue-head supplement, or a moderator, just posts a side
      // note with no turn-state change.
      if (kind === 'status') {
        decision.roleAtSend = 'status';
        decision.invocationType = 'status_update';
        decision.turnId = turnId;
        if (!isGrace && cur.mode === 'sequential') {
          decision.extendsTurn = true;
          return renewTurnDeadline(cur, now);
        }
        return cur;
      }
      decision.roleAtSend = role;
      decision.invocationType = 'normal_turn';
      decision.turnId = turnId;
      // Supplement-skip token: advance with status='no_addition', do NOT
      // append a chat message. During lead grace we treat this as the
      // supplement bowing out (drop from queue, lead keeps the floor),
      // NOT as a preemption — opting out is a soft signal, not a claim
      // on the mic.
      if (isSupplementSkipToken) {
        decision.skipMessage = true;
        if (isGrace) {
          return skipQueueHead(cur, 'no_addition', now);
        }
        return advanceTurn(cur, 'no_addition', room, now);
      }
      // Moderator mode: Moderator-as-current keeps current after reply
      // (no queue pop). They route via room_direct_invoke; their
      // deadline resets each time they actually post a message.
      if (cur.mode === 'moderator' && role === 'moderator') {
        return moderatorReply(cur, room, now);
      }
      // Grace path: queue-head supplement preempts Lead. Log the Lead
      // as skipped_by_grace and surface that entry so the caller can
      // post a sys message.
      if (isGrace) {
        const result = applyGraceSupplementReply(
          cur, message.name, message.client, room, now,
        );
        decision.leadSkipped = result.leadSkipped;
        return result.state;
      }
      const closeOnResult = cur.mode === 'sequential'
        && (role === 'lead' || role === 'wrap')
        && /\[RESULT\]/i.test(text);
      return advanceTurn(cur, 'replied', room, now, closeOnResult ? { result: true } : undefined);
    }
    if (cur) {
      const directed = consumeHostDirectedDetailed(cur, message.name, message.client);
      if (directed.consumed) {
        // Moderator dispatch ('assignee') vs host override
        // ('host_directed') are tracked separately for reporting.
        decision.roleAtSend = directed.source === 'moderator' ? 'assignee' : 'host_directed';
        decision.invocationType = directed.source === 'moderator' ? 'moderator_assigned' : 'host_directed';
        decision.turnId = cur.turnId;
        // Directed messages don't consume the main turn queue slot —
        // the named current speaker stays current. The mutated
        // hostDirected list (one entry popped) is what gets persisted.
        return cur;
      }
    }
    // Moderator mode: a non-moderator cc agent that is neither the current
    // speaker nor a directly-invoked assignee may still post a *status
    // update* — a short "received / on it / done" signal back to the
    // Moderator. It is always allowed, never consumes the Moderator's
    // floor, and does NOT mutate turn state (queue / current / deadline
    // are untouched). Substantive analysis or challenge still requires a
    // Moderator @-invoke — that flows through the consumeHostDirected path
    // above. The message is appended normally, tagged roleAtSend='status'
    // / invocationType='status_update' so the UI and reports can render it
    // as a status ping rather than a turn reply.
    if (mode === 'moderator') {
      decision.roleAtSend = 'status';
      decision.invocationType = 'status_update';
      decision.turnId = cur?.turnId;
      // Return turn state unchanged — a status update is a side channel.
      return cur;
    }
    throw new NotYourTurnError(message.name, mode);
  });

  if (decision.skipMessage) {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: decision.roleAtSend,
      invocationType: decision.invocationType,
      ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    };
    return {
      appended: false,
      reason: 'no_addition',
      metadata,
      ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
    };
  }

  const metadata: MessageMetadata = {
    ...(message.metadata ?? {}),
    modeAtSend: mode,
    roleAtSend: decision.roleAtSend,
    invocationType: decision.invocationType,
    ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    ...(decision.extendsTurn ? { extendsTurn: true } : {}),
  };
  const enriched: Message = { ...message, metadata };
  await rpushMessage(client, code, enriched, room.createdAt);
  return {
    appended: true,
    metadata,
    ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
  };
}

// Internal helper: write a message to the Redis list, pinning TTL no later than
// the room's hard 7-day deadline and keeping the absolute-count counter in lockstep.
// INCR on the count key MUST sit in the same pipeline as RPUSH so the count
// stays in lock-step with the list — listMessages relies on the invariant
// `totalCount - listLen = number of LTRIMmed entries` to compensate cursors.
// EXPIREAT LT (a fixed creation+TTL deadline) rather than EXPIRE means the
// message list cannot slide forward or extend an earlier expiration.
async function rpushMessage(
  client: UpstashClient,
  code: string,
  message: Message,
  roomCreatedAt: number,
): Promise<void> {
  const expireAt = roomExpirationTimestamp(roomCreatedAt);
  // Single choke point for message field repair — see messageNormalize.ts.
  // Every append path (chat, status ping, system event) funnels through here,
  // so a message can never reach the list with an unusable `text` or `time`.
  const safe = normalizeMessageForWrite(message);
  await client.pipeline([
    ['RPUSH', msgsKey(code), JSON.stringify(safe)],
    ['INCR', msgCountKey(code)],
    ['LTRIM', msgsKey(code), -MAX_MESSAGES_PER_ROOM, -1],
    ['EXPIREAT', msgsKey(code), expireAt, 'LT'],
    ['EXPIREAT', msgCountKey(code), expireAt, 'LT'],
  ]);
}

// Append a server-originated system message. Bypasses the speaker/mute/turn
// gates because system messages are not sent by a participant — they are
// emitted by the server itself in response to events like mode changes,
// turn timeouts, host-driven skips, or moderator fallbacks. Callers should
// set `message.type = 'sys'` and use a synthetic sender (typically
// `name: 'system'`, `client: 'cc'`). The room must still exist; we hit
// getRoom() to refresh TTL and keep the count key aligned with the list.
export async function appendSystemMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<void> {
  const room = await getRoom(client, code); // throws RoomNotFoundError if the room is gone
  await rpushMessage(client, code, message, room.createdAt);
}

// The task board CAS and its verification event must commit together. Keep
// the message keys, cap, counter, and fixed room deadline alongside the
// ordinary message writer so this path cannot drift from listMessages().
const TASK_VERIFY_COMMIT_SCRIPT =
  "local board = redis.call('GET', KEYS[1])\n" +
  "if ARGV[1] == 'absent' then\n" +
  "  if board then return 0 end\n" +
  "elseif board ~= ARGV[2] then return 0 end\n" +
  "if redis.call('TYPE', KEYS[4]).ok ~= 'string' then return -1 end\n" +
  "local listType = redis.call('TYPE', KEYS[2]).ok\n" +
  "local countType = redis.call('TYPE', KEYS[3]).ok\n" +
  "if (listType ~= 'none' and listType ~= 'list') or (countType ~= 'none' and countType ~= 'string') then return -2 end\n" +
  "local expireAt = tonumber(ARGV[4])\n" +
  "local maxMessages = tonumber(ARGV[6])\n" +
  "if not expireAt or expireAt < 1 or expireAt % 1 ~= 0 or not maxMessages or maxMessages < 1 or maxMessages % 1 ~= 0 then return -2 end\n" +
  "if countType == 'string' then\n" +
  "  local countRaw = redis.call('GET', KEYS[3])\n" +
  "  if countRaw ~= '0' and not string.match(countRaw, '^[1-9][0-9]*$') then return -2 end\n" +
  "  if string.len(countRaw) > 19 or (string.len(countRaw) == 19 and countRaw > '9223372036854775806') then return -2 end\n" +
  "end\n" +
  "local legacyCount = 0\n" +
  "if countType == 'none' and listType == 'list' then\n" +
  "  legacyCount = redis.call('LLEN', KEYS[2])\n" +
  "end\n" +
  "if legacyCount > 0 then redis.call('SET', KEYS[3], legacyCount, 'KEEPTTL') end\n" +
  "redis.call('SET', KEYS[1], ARGV[3], 'KEEPTTL')\n" +
  "redis.call('EXPIREAT', KEYS[1], expireAt, 'LT')\n" +
  "redis.call('RPUSH', KEYS[2], ARGV[5])\n" +
  "redis.call('INCR', KEYS[3])\n" +
  "redis.call('LTRIM', KEYS[2], -maxMessages, -1)\n" +
  "redis.call('EXPIREAT', KEYS[2], expireAt, 'LT')\n" +
  "redis.call('EXPIREAT', KEYS[3], expireAt, 'LT')\n" +
  "return 1";

/**
 * Atomically compare-and-swap a task board and append its verification event.
 * Returns false only for a board CAS conflict. Storage-layout errors and a
 * room expiring between its read and commit fail closed before any writes.
 */
export async function commitTaskVerification(
  client: UpstashClient,
  code: string,
  expectedRaw: string | null,
  nextRaw: string,
  roomCreatedAt: number,
  message: Message,
): Promise<boolean> {
  const expireAt = roomExpirationTimestamp(roomCreatedAt);
  const safe = normalizeMessageForWrite(message);
  const result = Number(await client.command<number>([
    'EVAL', TASK_VERIFY_COMMIT_SCRIPT, '4',
    `task-board:${code}`, msgsKey(code), msgCountKey(code), `room:${code}`,
    expectedRaw === null ? 'absent' : 'present', expectedRaw ?? '', nextRaw,
    String(expireAt), JSON.stringify(safe), String(MAX_MESSAGES_PER_ROOM),
  ]));
  if (result === -1) throw new RoomNotFoundError(code);
  if (result === -2) throw new UpstashError('Task verification message storage has an invalid Redis key type, counter, or retention metadata.');
  return result === 1;
}

export interface ListMessagesResult {
  messages: Message[];
  cursor: number;
  oldestRetained: number;
}

// Cursor semantics: `fromIndex` is the absolute count of messages the caller
// has already consumed (0 on first call, advanced by `msgs.length` after
// each call). It is NOT a list-index — the on-disk list shifts whenever
// LTRIM trims the head, so a list-index cursor would skip messages past
// MAX_MESSAGES_PER_ROOM. The counter key + LLEN let us reconstruct where the
// caller's next unread message actually lives in the (possibly trimmed) list.
export async function listMessages(
  client: UpstashClient,
  code: string,
  fromIndex: number
): Promise<ListMessagesResult> {
  // One pipeline: ask for both the absolute count and the current list length.
  // count===null means this is a legacy room created before the counter was
  // introduced — fall back to treating fromIndex as a list-index (matches
  // pre-fix behavior; still buggy past MAX_MESSAGES_PER_ROOM messages but no worse than before
  // and avoids breaking in-flight conversations during the rollout).
  const meta = await client.pipeline<unknown>([
    ['GET', msgCountKey(code)],
    ['LLEN', msgsKey(code)],
  ]);
  const countRaw = meta[0] as string | number | null;
  const listLen = Number(meta[1] ?? 0);

  let totalCount: number;
  let trimmed: number;
  let start: number;

  if (countRaw === null || countRaw === undefined) {
    totalCount = Math.max(fromIndex, listLen);
    trimmed = 0;
    start = fromIndex;
  } else {
    totalCount = typeof countRaw === 'number' ? countRaw : parseInt(countRaw, 10);
    if (!Number.isFinite(totalCount)) totalCount = 0;
    // `trimmed` is the number of head entries LTRIM has dropped over this
    // room's lifetime. Subtracting it from the agent's absolute cursor
    // gives the right list-index for the next unread message.
    trimmed = Math.max(0, totalCount - listLen);
    start = fromIndex - trimmed;
    // If the agent's cursor lags so far that messages it never saw have
    // already been LTRIMmed away, the best we can do is hand back the
    // surviving prefix from index 0 — those older messages are gone for
    // good (LTRIM is destructive; the report/minutes export is the only
    // way to recover full transcripts past the cap).
    if (start < 0) start = 0;
  }

  const cursor = totalCount;
  const oldestRetained = trimmed;

  if (listLen === 0 || start >= listLen) {
    return { messages: [], cursor, oldestRetained };
  }

  const raw = await client.command<string[]>(['LRANGE', msgsKey(code), start, -1]);
  // Heal text-less messages already stored by older clients — without this,
  // one bad message bricks the room page for every viewer.
  const messages = raw.map(line => healStoredMessage(JSON.parse(line) as Message));
  return { messages, cursor, oldestRetained };
}

/**
 * Status-ping body posted after a task submit in turn-taking rooms. Kept here
 * (not at the call site) so every client emits the same recognisable prefix —
 * the room UI and the minutes digest both key off `[STATUS]`.
 */
export function buildTaskSubmitStatusText(taskId: string, evidenceSummary: string): string {
  const summary = evidenceSummary.trim().replace(/\s+/g, ' ').slice(0, 180);
  return `[STATUS] 待审核 / awaiting_review ${taskId}: ${summary || '(no run output)'}`;
}

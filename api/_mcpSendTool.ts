// room_send (and room_status, which resolves to it), plus the refusal hints
// every tool shares when the room API says no.
//
// Split out of _mcpTools.ts, which keeps the dispatcher and routes `room_send`
// here and its catch for RemoteRoomApiError through `remoteApiErrorResult`.
// The two belong together: most of those refusals — muted, not_your_turn,
// garbled_text, not_participant — are a send that did not happen, and the
// hint each carries is about what to do instead of sending again.

import type { Participant } from '@agent-room/shared';
import {
  appendMessage,
  getRoom,
  listMessages,
  type RemoteRoomApiError,
  type RemoteRoomClient,
} from './_mcpRoomClient.js';
import { buildMessage } from './_mcpIdentity.js';
import { ok, type McpToolResult } from './_mcpResult.js';
import {
  boardInbox,
  inboxRequiresWork,
  nextActionForInbox,
  NEXT_LISTEN,
} from './_mcpListen.js';
import { declaresObjectOutput, type McpProfile } from './_mcpToolDefs.js';

async function findSpeaker(client: RemoteRoomClient, code: string, name: string): Promise<Participant | undefined> {
  try {
    const room = await getRoom(client, code);
    return room.participants.find(p => p.name === name && p.client === 'cc');
  } catch {
    return undefined;
  }
}

export async function dispatchRoomSend(
  client: RemoteRoomClient,
  a: Record<string, any>,
  profile: McpProfile,
  structured: boolean,
): Promise<McpToolResult> {
  const sendOk = (value: unknown) => ok(value, [], structured);
  const isStatus = a.kind === 'status';
  const senderName = typeof a.name === 'string' ? a.name.trim() : '';
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!senderName || !text) {
    return sendOk({ sent: false, error: 'bad_request', hint: 'room_send requires both "name" and "text".' });
  }
  const speaker = await findSpeaker(client, a.code, senderName);
  const role: string = a.role || speaker?.role || '';
  const result = (await appendMessage(
    client,
    a.code,
    buildMessage(senderName, role, a.text, speaker),
    isStatus ? 'status' : 'message',
  )) as {
    appended?: boolean;
    reason?: string;
    metadata?: { roleAtSend?: string; turnId?: number; extendsTurn?: boolean; modeAtSend?: string };
  };
  const listed = await listMessages(client, a.code, 0);
  const cursor = Array.isArray(listed) ? listed.length : listed.cursor;
  const sendInbox = await boardInbox(client, profile, a.code, senderName, false, result?.metadata?.modeAtSend);
  const sendNextAction = nextActionForInbox(sendInbox, a.code, cursor, senderName);
  const sendContinuation = inboxRequiresWork(sendInbox)
    ? sendInbox.hint
    : NEXT_LISTEN(a.code, cursor);
  if (result && result.appended === false && result.reason === 'no_addition') {
    return sendOk({
      sent: true,
      appended: false,
      reason: 'no_addition',
      cursor,
      nextAction: sendNextAction,
      ...(sendInbox.hint ? { yourTasks: sendInbox } : {}),
      hint: `Your "__no_addition__" was accepted — the supplement turn was skipped without posting. ${sendContinuation}`,
    });
  }
  const extended = result?.metadata?.extendsTurn === true;
  const postedAsStatus = result?.metadata?.roleAtSend === 'status';
  // Off-floor in moderator mode: the message IS stored, but tagged as a
  // status side note (roleAtSend='status') and rendered as one — it does
  // not read as the agent taking a turn. `sent: true` alone made that
  // indistinguishable from a normal reply, so an agent whose delivery got
  // demoted had no way to know. Say it plainly.
  const demoted = !isStatus && postedAsStatus;
  const sentHint = !demoted
    ? 'Sent.'
    : result?.metadata?.modeAtSend === 'deliver'
      ? 'Posted as a STATUS note — in deliver mode only [RESULT] evidence, a [BLOCKER], or a [DECISION] request posts as a message. Keep working on your task.'
      : 'Posted, but as a STATUS SIDE NOTE — you did not hold the floor, so this is not counted as your turn. In moderator mode wait to be @-assigned by the Moderator before delivering substantive work.';
  return sendOk({
    sent: true,
    appended: true,
    cursor,
    nextAction: sendNextAction,
    ...(sendInbox.hint ? { yourTasks: sendInbox } : {}),
    ...(postedAsStatus ? { extendsTurn: extended } : {}),
    ...(result?.metadata?.roleAtSend ? { roleAtSend: result.metadata.roleAtSend } : {}),
    ...(demoted ? { degradedToStatus: true } : {}),
    // Sending a progress line must not erase durable board work. The old
    // hint offered "or wait via room_listen" next to the task, so agents
    // posted "working on it" and went straight back to polling. The
    // continuation is the task when there is one, the listen otherwise.
    hint: [
      postedAsStatus
        ? (extended ? 'Status posted — turn deadline renewed.' : 'Status posted (no turn change).')
        : sentHint,
      sendContinuation,
    ].join(' '),
  });
}

/**
 * The result for a refusal the room API handed back by code.
 *
 * A handled API error is still a normal result, not an isError one — a muted
 * seat, a turn that is not yours, an unknown room code. So it is covered by
 * the calling tool's declared outputSchema and has to carry structuredContent
 * like any other result of that tool. The name decides, which is why it is
 * passed in: the dispatcher resolves aliases first, so room_status arrives
 * here as room_send and gets room_send's answer and room_send's promise.
 */
export function remoteApiErrorResult(e: RemoteRoomApiError, name: string): McpToolResult {
  const handled = (value: Record<string, unknown>) => ok(value, [], declaresObjectOutput(name));
  if (e.code === 'MutedError') {
    return handled({ sent: false, error: 'muted', hint: `${e.message} Wait via room_listen; do not retry until unmuted.` });
  }
  if (e.code === 'NotYourTurnError') {
    return handled({ sent: false, error: 'not_your_turn', hint: `${e.message} Wait for your turn via room_listen.` });
  }
  if (e.code === 'garbled_text') {
    return handled({
      sent: false,
      error: 'garbled_text',
      hint: `${e.message} Nothing was posted — the room is still waiting on you, so compose the message again and call room_send once more.`,
    });
  }
  if (e.code === 'NotHostError') {
    return handled({ ok: false, error: 'not_host', hint: `${e.message} Only the host (with the hostKey from room_create) can do this.` });
  }
  if (e.code === 'HostNameTakenError') {
    return handled({ error: 'host_name_taken', hint: 'That name is reserved for the room\'s host. Pick a different display name.' });
  }
  if (e.code === 'RoomNotFoundError') {
    return handled({ error: 'room_not_found', hint: 'No room with that code (rooms expire 7 days after creation). Double-check the code.' });
  }
  if (e.code === 'SEAT_IN_USE') {
    return handled({ error: 'SEAT_IN_USE', code: 'SEAT_IN_USE', hint: `${e.message} Call room_join again with the seatKey you were given; if it is lost, wait until that seat has been offline for 120s and rejoin to reclaim it.` });
  }
  if (e.code === 'invite_code_required' || e.code === 'invite_code_invalid' || e.code === 'invite_code_expired') {
    // e.message already carries the Chinese guidance (see AGENT_INVITE_MESSAGES).
    return handled({ error: e.code, code: e.code, hint: e.message });
  }
  if (e.code === 'invalid_session_id') {
    return handled({ error: 'invalid_session_id', hint: 'sessionId 必须是 1–256 个字符的非空文本，且不含控制字符。请传入你当前聊天会话的 ID，或不传 sessionId。' });
  }
  if (e.code === 'NotParticipantError') {
    // A send from an agent that never joined fails the same shape as any
    // other refused send (`sent: false`), and is told to join rather than
    // to wait — "wait until unmuted" is a dead end for someone with no
    // seat. room_status resolves to room_send above, so it lands here too.
    if (name === 'room_send') {
      return handled({
        sent: false,
        error: 'not_participant',
        hint: `${e.message} Call room_join with this room code and your agent name, then send again.`,
      });
    }
    return handled({ error: 'not_participant', hint: `${e.message} Call room_join first.` });
  }
  if (e.code === 'WebhookLimitError') {
    return handled({ error: 'webhook_limit', hint: `${e.message} Unregister one first (room_webhook action="unregister").` });
  }
  // isError results stay as they are: the spec exempts them from an
  // outputSchema, and the memory tools — which declare one — do not add
  // structuredContent here either.
  return { ...ok({ error: e.code, message: e.message }), isError: true };
}

// Tool surface for the hosted MCP endpoint (`/api/mcp`).
//
// Design goals, in order:
//   1. Small surface — hosted `/mcp` defaults to `full` (12 tools); `?profile=core`
//      is the 7-tool guest opt-in. Families
//      that used to be one-tool-per-verb (task board, webhooks, host
//      controls) are single tools with an `action` enum, GitHub-MCP style.
//   2. Terse definitions — descriptions are 1–3 sentences; the room
//      etiquette (listen loop, trust model, task-board rules) lives once in
//      SERVER_INSTRUCTIONS instead of being repeated per tool.
//   3. Nothing breaks — every pre-consolidation tool name still works as a
//      hidden alias (dispatched, never listed), so old sessions, saved
//      client rules, and third-party scripts keep functioning.
//
// The endpoint stays stateless: the client carries code/name/cursor, and
// room_create returns the hostKey the creator needs for host actions.
//
// This file is the dispatcher. Three leaf modules carry what it used to hold
// inline, and every name it used to export is re-exported below so no import
// path changes:
//   _mcpResult.ts   — the tool-result shape and ok()
//   _mcpListen.ts   — room_listen's hold, hints and listen-only fields
//   _mcpToolDefs.ts — the declared tool surface and SERVER_INSTRUCTIONS

import {
  AVATAR_PALETTE,
  buildRoomContextView,
  normalizeEscapedWhitespace,
  redactSecretText,
  ROOM_POLICY_VERSION,
  roomPolicySummary,
  safeAttachmentPromptText,
  roleBriefFor,
  slimMessage,
  taskInboxFor,
} from '@agent-room/shared';
import type { ClientKind, Message, Participant, Room, TaskBoard, Task } from '@agent-room/shared';
import { buildRoomRetro, isConfiguredModerator, isDeliverLead } from '@agent-room/upstash-client';
import type { TaskBoard as RetroBoard } from '@agent-room/shared';
import {
  appendMessage,
  createRoom,
  createRoomReport,
  endRoom,
  getRoom,
  joinRoom,
  listMessages,
  reactivateRoom,
  removeParticipant,
  RemoteRoomApiError,
  type RemoteRoomClient,
} from './_mcpRoomClient.js';
import {
  clampListenMs,
  type HttpHarness,
} from './_mcpHarness.js';
import { dispatchMemoryTool, isMemoryEnabled, isMemoryToolName, loadJoinBrief } from './_memoryTools.js';
import type { MemoryToolDependencies } from './_memoryTools.js';
import { ok, type McpToolResult } from './_mcpResult.js';
import {
  boardInbox,
  contextFields,
  hydrateListenImages,
  inboxRequiresWork,
  listenPrefsFor,
  listenStatusFields,
  listenWindowHint,
  listMessagesResilient,
  LISTEN_DEFAULT_MS,
  nextActionForInbox,
  nextListenAction,
  NEXT_LISTEN,
  runListen,
  type WakeOn,
} from './_mcpListen.js';
import { declaresObjectOutput, FULL_TOOLS, listTools, type McpProfile } from './_mcpToolDefs.js';

export { CORE_TOOLS, FULL_TOOLS, listTools, SERVER_INSTRUCTIONS } from './_mcpToolDefs.js';
export type { McpProfile } from './_mcpToolDefs.js';
export { hydrateListenImages, isTrustedAttachmentImageUrl, listMessagesResilient } from './_mcpListen.js';
export type { WakeOn } from './_mcpListen.js';

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || 'https://www.agent-room.com';
}

function initialsFor(name: string): string {
  const parts = (typeof name === 'string' ? name : '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase().padEnd(2, '?');
  return '??';
}

function colorForName(name: string): string {
  const safe = typeof name === 'string' ? name : '';
  let h = 0;
  for (let i = 0; i < safe.length; i++) h = (h * 31 + safe.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length]!;
}

function buildMessage(name: string, role: string, text: string, speaker?: Participant): Message {
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

function minutesTranscript(messages: Message[]): string {
  return messages.map(message => {
    const attach = (message.attachments ?? [])
      .map(attachment => {
        const tag = attachment.type === 'image' ? 'IMAGE' : 'FILE';
        const extracted = safeAttachmentPromptText(attachment.name, attachment.mime, attachment.extractedText);
        const head = `[${tag}: ${attachment.name} ${attachment.url}]`;
        return extracted ? `${head}\n${extracted.slice(0, 12_000)}` : head;
      })
      .join('\n');
    return attach ? `${message.name}: ${message.text}\n${attach}` : `${message.name}: ${message.text}`;
  }).join('\n\n');
}

/**
 * Which kind of participant is this name?
 *
 * room_task used to stamp `ownerClient`/`verifierClient` as 'cc' on create and
 * reassign, reasoning from the caller: an MCP agent is calling, so the people
 * it names must be agents too. They need not be. Observed 2026-09-08: an agent
 * correctly named the human host as verifier and the task was recorded as
 * `verifierClient: "cc"` for a web participant.
 *
 * The record was simply false, and it is read in two places — verifyTask gates
 * on `task.verifierClient === undefined || task.verifierClient === caller.client`,
 * and claimTask's owner==verifier deadlock check reads the same field. reassign
 * is reachable from the web too, so the same wrong assumption can be written
 * from either side.
 *
 * An unknown name returns undefined rather than a guess, which both call sites
 * then omit. Both gates read a missing client as "match on name alone", so the
 * tolerant path is the honest answer when we do not know.
 */
function participantClientKind(room: Room, name: string): ClientKind | undefined {
  const wanted = name.trim().toLowerCase();
  return room.participants.find(p => p.name.trim().toLowerCase() === wanted)?.client;
}

/** Reads the room once for the two role fields create/reassign may carry. */
async function roleClients(
  client: RemoteRoomClient,
  code: string,
  owner?: string,
  verifier?: string,
): Promise<{ ownerClient?: ClientKind; verifierClient?: ClientKind }> {
  if (!owner && !verifier) return {};
  let room: Room;
  try {
    room = await getRoom(client, code);
  } catch {
    // Never fail a task write over a lookup. Omitting the kind lands on the
    // name-only path, which is what the old hardcoded 'cc' was pretending to be.
    return {};
  }
  const ownerClient = owner ? participantClientKind(room, owner) : undefined;
  const verifierClient = verifier ? participantClientKind(room, verifier) : undefined;
  return {
    ...(ownerClient ? { ownerClient } : {}),
    ...(verifierClient ? { verifierClient } : {}),
  };
}

// ─── Aliases (old surface → consolidated surface) ────────────────────────
//
// Dispatched but never listed: old sessions and saved client rules keep
// working at zero context cost.

function resolveAlias(name: string, a: Record<string, any>): { name: string; args: Record<string, any> } {
  switch (name) {
    case 'room_status':
      return { name: 'room_send', args: { ...a, kind: 'status' } };
    case 'room_list_messages':
      return { name: 'room_listen', args: { ...a, timeoutMs: 0 } };
    case 'room_export':
      return { name: 'room_minutes', args: { ...a, export: true } };
    case 'room_reactivate':
      return { name: 'room_admin', args: { ...a, action: 'reactivate' } };
    case 'room_task_list':
      return { name: 'room_task', args: { ...a, action: 'list' } };
    case 'room_task_create':
      return { name: 'room_task', args: { ...a, action: 'create' } };
    case 'room_task_claim':
      return { name: 'room_task', args: { ...a, action: 'claim' } };
    case 'room_task_submit':
      return { name: 'room_task', args: { ...a, action: 'submit' } };
    case 'room_task_verify':
      return { name: 'room_task', args: { ...a, action: 'verify' } };
    case 'room_task_reassign':
      return { name: 'room_task', args: { ...a, action: 'reassign' } };
    case 'room_task_reopen':
      return { name: 'room_task', args: { ...a, action: 'reopen' } };
    case 'room_task_delete':
    case 'room_task_cancel':
      return { name: 'room_task', args: { ...a, action: 'cancel' } };
    case 'room_webhook_register':
      return { name: 'room_webhook', args: { ...a, action: 'register' } };
    case 'room_webhook_list':
      return { name: 'room_webhook', args: { ...a, action: 'list' } };
    case 'room_webhook_unregister':
      return { name: 'room_webhook', args: { ...a, action: 'unregister' } };
    default:
      return { name, args: a };
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

async function findSpeaker(client: RemoteRoomClient, code: string, name: string): Promise<Participant | undefined> {
  try {
    const room = await getRoom(client, code);
    return room.participants.find(p => p.name === name && p.client === 'cc');
  } catch {
    return undefined;
  }
}

export async function callTool(
  client: RemoteRoomClient,
  profile: McpProfile,
  rawName: string,
  rawArgs: Record<string, unknown>,
  harness?: HttpHarness,
  memoryDependencies?: MemoryToolDependencies,
): Promise<McpToolResult> {
  const { name, args } = resolveAlias(rawName, rawArgs as Record<string, any>);
  const available = new Set(listTools(profile).map(t => t.name));
  if (!available.has(name)) {
    return {
      ...ok({
        error: 'unknown_tool',
        hint: profile === 'core' && FULL_TOOLS.some(t => t.name === name)
          ? `"${rawName}" is only available on the full profile (hosted /mcp default). You are on ?profile=core. Drop the parameter or use /mcp?profile=full.`
          : `Unknown tool "${rawName}".`,
      }),
      isError: true,
    };
  }
  try {
    return await dispatch(client, name, args, harness, profile, memoryDependencies);
  } catch (e) {
    if (e instanceof RemoteRoomApiError) {
      // A handled API error is still a normal result, not an isError one — a
      // seat conflict or an unknown code comes back here for room_join and
      // room_listen. So it is covered by their declared outputSchema and has
      // to carry structuredContent like any other result of theirs.
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
      if (e.code === 'NotParticipantError') {
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
    throw e;
  }
}

function requireFields(a: Record<string, any>, fields: string[]): string | null {
  const missing = fields.filter(f => a[f] === undefined || a[f] === null || a[f] === '');
  return missing.length > 0 ? `Missing required field(s) for this action: ${missing.join(', ')}.` : null;
}

// The reader's own policy line: how speaking works in this mode, plus — for
// the Moderator seat — what the Moderator's job actually is. Without it an MCP
// moderator was never told it was supposed to assign and synthesize rather
// than do the work itself.
function policyFor(room: Room, name: string): string {
  return roomPolicySummary(
    room.replyMode,
    undefined, // legacy gameId slot; game mode was sunset
    isConfiguredModerator(room, name, 'cc') ? 'moderator'
      : isDeliverLead(room, name, 'cc') ? 'lead'
        : 'member',
  );
}

async function dispatch(
  client: RemoteRoomClient,
  name: string,
  a: Record<string, any>,
  harness?: HttpHarness,
  profile: McpProfile = 'full',
  memoryDependencies?: MemoryToolDependencies,
): Promise<McpToolResult> {
  // Memory tools declare an object outputSchema, so every result (including
  // error-code objects) must also carry structuredContent per the MCP spec.
  if (isMemoryToolName(name)) return ok(await dispatchMemoryTool(client, name, a, memoryDependencies), [], true);
  // Same promise, same obligation, for every other tool that declares one:
  // room_create, room_join, room_listen and room_task.
  const structured = declaresObjectOutput(name);
  switch (name) {
    case 'room_create': {
      const created = await createRoom(client, { topic: a.topic, createdBy: a.name });
      const code = created.code;
      const participant: Participant = {
        name: a.name,
        role: a.role ?? '',
        color: colorForName(a.name),
        initials: initialsFor(a.name),
        client: 'cc',
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      const hostSeat = await joinRoom(client, code, participant, {
        hostKey: created.hostKey,
        personaId: typeof a.personaId === 'string' ? a.personaId : undefined,
      });
      const msgs = await listMessages(client, code, 0);
      return ok({
        code,
        topic: created.topic,
        joinUrl: `${publicBaseUrl()}/j/${code}`,
        cursor: msgs.length,
        nextAction: nextListenAction(code, msgs.length, a.name),
        hostKey: created.hostKey,
        seatKey: hostSeat.seatKey,
        roleBrief: roleBriefFor(a.role ?? ''),
        hint: `Room created — share the joinUrl; keep the hostKey private. ${NEXT_LISTEN(code, msgs.length)} ${listenWindowHint(harness)}`,
      }, [], structured);
    }

    case 'room_join': {
      const participant: Participant = {
        name: a.name,
        role: a.role ?? '',
        color: colorForName(a.name),
        initials: initialsFor(a.name),
        client: 'cc',
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      const before = await getRoom(client, a.code);
      const updated = await joinRoom(client, a.code, participant, {
        hostKey: typeof a.hostKey === 'string' && a.hostKey ? a.hostKey : undefined,
        seatKey: typeof a.seatKey === 'string' && a.seatKey ? a.seatKey : undefined,
        personaId: typeof a.personaId === 'string' ? a.personaId : undefined,
      });
      const finalName = updated.participant.name;
      const reconnecting = finalName === a.name
        && before.participants.some(p => p.name === finalName && p.client === 'cc');
      const myEntry = updated.participants.find(p => p.name === finalName && p.client === 'cc');
      const muted = myEntry?.canSpeak === false;
      if (!reconnecting && !muted) {
        try {
          await appendMessage(
            client,
            a.code,
            buildMessage(finalName, updated.participant.role, `Hi all — ${finalName} here. I'm in the room and listening.`, updated.participant),
          );
        } catch { /* greeting is nice-to-have */ }
      }
      const msgs = await listMessages(client, a.code, 0);
      const recentMessages = msgs.slice(-16).map(slimMessage);
      const joinInbox = await boardInbox(client, profile, a.code, finalName, false, updated.replyMode);
      const joinListenPrefs = listenPrefsFor(
        { wakeOn: 'any' },
        updated,
        isConfiguredModerator(updated, finalName, 'cc'),
        undefined,
        finalName,
      );
      let memoryBrief: Record<string, unknown> | undefined;
      if (isMemoryEnabled()) {
        memoryBrief = await loadJoinBrief(client, a.code, updated.seatKey!, memoryDependencies);
      }
      return ok({
        code: a.code,
        topic: updated.topic,
        assignedName: finalName,
        renamed: finalName !== a.name,
        // Hand this back on your next room_join to keep this seat. Only this
        // caller ever sees it; the server stores a hash.
        seatKey: updated.seatKey,
        ...(memoryBrief?.loaded === true ? {
          memoryBrief: memoryBrief.brief,
          memoryBriefEstimated: memoryBrief.estimated,
          memoryBriefEstimatedTokens: memoryBrief.estimatedTokens,
          memoryIds: memoryBrief.memoryIds,
        } : memoryBrief?.code ? { memoryBriefError: memoryBrief.code } : {}),
        canSpeak: !muted,
        replyMode: updated.replyMode ?? 'open',
        participants: updated.participants.map(p => ({
          name: p.name,
          role: p.role,
          client: p.client,
          canSpeak: p.canSpeak !== false,
        })),
        cursor: msgs.length,
        nextAction: nextActionForInbox(joinInbox, a.code, msgs.length, finalName, joinListenPrefs),
        recentMessages,
        ...contextFields(msgs),
        ...(joinInbox.hint ? { yourTasks: joinInbox } : {}),
        roleBrief: roleBriefFor(a.role ?? ''),
        roomPolicy: policyFor(updated, finalName),
        policyVersion: ROOM_POLICY_VERSION,
        hint: [
          muted
            ? `Joined as "${finalName}" but the host has muted you — keep listening until unmuted.`
            : `Joined as "${finalName}".`,
          joinInbox.hint,
          // Board work outranks presence: an agent told to listen right after
          // being handed a task listens, and the task sits.
          ...(inboxRequiresWork(joinInbox) ? [] : [NEXT_LISTEN(a.code, msgs.length), listenWindowHint(harness)]),
        ].filter(Boolean).join(' '),
      }, await hydrateListenImages(recentMessages), structured);
    }

    case 'room_send': {
      const isStatus = a.kind === 'status';
      const senderName = typeof a.name === 'string' ? a.name.trim() : '';
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!senderName || !text) {
        return ok({ sent: false, error: 'bad_request', hint: 'room_send requires both "name" and "text".' });
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
      const msgs = await listMessages(client, a.code, 0);
      const sendInbox = await boardInbox(client, profile, a.code, senderName, false, result?.metadata?.modeAtSend);
      const sendNextAction = nextActionForInbox(sendInbox, a.code, msgs.length, senderName);
      const sendContinuation = inboxRequiresWork(sendInbox)
        ? sendInbox.hint
        : NEXT_LISTEN(a.code, msgs.length);
      if (result && result.appended === false && result.reason === 'no_addition') {
        return ok({
          sent: true,
          appended: false,
          reason: 'no_addition',
          cursor: msgs.length,
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
      return ok({
        sent: true,
        appended: true,
        cursor: msgs.length,
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

    case 'room_listen': {
      const since = typeof a.since === 'number' ? a.since : 0;
      const selfName = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined;
      // timeoutMs: 0 → non-blocking history read (the old room_list_messages).
      if (a.timeoutMs === 0) {
        const listed = await listMessagesResilient(listMessages, client, a.code, since);
        if (!listed.ok) {
          return ok({
            messages: [],
            cursor: since,
            ...listenStatusFields(),
            nextAction: nextListenAction(a.code, since, selfName),
            hint: `Transient listMessages failure — retry. ${NEXT_LISTEN(a.code, since)}`,
          }, [], structured);
        }
        const cursor = since + listed.messages.length;
        const all = since === 0
          ? listed.messages
          : await Promise.resolve(listMessages(client, a.code, 0)).then(
            fetched => fetched ?? listed.messages,
            () => listed.messages,
          );
        const messages = listed.messages.map(slimMessage);
        let catchUpMode: string | undefined;
        try { catchUpMode = (await getRoom(client, a.code)).replyMode; } catch { /* lean */ }
        const readInbox = await boardInbox(client, profile, a.code, selfName ?? '', false, catchUpMode);
        const readMustWork = inboxRequiresWork(readInbox);
        return ok({
          messages,
          cursor,
          ...listenStatusFields(),
          nextAction: nextActionForInbox(readInbox, a.code, cursor, selfName),
          ...contextFields(all),
          ...(readInbox.hint ? { yourTasks: readInbox } : {}),
          hint: readMustWork
            ? readInbox.hint
            : [readInbox.hint, NEXT_LISTEN(a.code, cursor)].filter(Boolean).join(' '),
        }, await hydrateListenImages(messages), structured);
      }
      // A hold longer than the client's own tool-call timeout does not return
      // messages — it returns a tool error, and a tool error is the single
      // result most likely to end the agent's turn (see _mcpHarness.ts). So an
      // identified weak client is held to its cap no matter what it asked for.
      const timeoutMs = clampListenMs(
        typeof a.timeoutMs === 'number' && Number.isFinite(a.timeoutMs)
          ? a.timeoutMs
          : LISTEN_DEFAULT_MS,
        harness,
      );
      const wakeOn: WakeOn = a.wakeOn === 'addressed' ? 'addressed' : 'any';
      const result = await runListen(client, a.code, since, timeoutMs, selfName, wakeOn);
      let replyMode: string | undefined;
      let roomPolicy: string | undefined;
      let isModerator = false;
      // Kept outside the try so a quiet timeout can still shape the next
      // call's arguments — a quiet hold is exactly the round trip where
      // losing the client's window matters most.
      let room: Room | undefined;
      if (!result.terminated) {
        try {
          room = await getRoom(client, a.code);
          replyMode = room.replyMode ?? 'open';
          if (selfName) isModerator = isConfiguredModerator(room, selfName, 'cc');
          // Re-brief on every listen that actually returns messages — i.e.
          // right before the agent decides what to do. A one-shot line at join
          // is invisible 170 messages later, and the host can switch the room's
          // mode at any time (setReplyMode), so the contract the agent joined
          // under may no longer be the one it is acting under. Quiet timeouts
          // return nothing to act on and stay lean.
          if (selfName && result.messages.length > 0) {
            roomPolicy = policyFor(room, selfName);
          }
        } catch { /* best effort */ }
      }
      const nextPrefs = listenPrefsFor({ timeoutMs, wakeOn }, room, isModerator, harness, selfName);
      let digestFields = {};
      if (!result.terminated && result.messages.length > 0) {
        // since=0 already returned the full list; don't issue a second read
        // (and don't assume the client always returns a thenable).
        const all = since === 0
          ? result.messages
          : await Promise.resolve(listMessages(client, a.code, 0)).then(
            listed => listed ?? result.messages,
            () => result.messages,
          );
        digestFields = contextFields(all);
      }
      const messages = result.messages.map(slimMessage);
      const inbox = result.messages.length > 0 && !result.terminated
        ? await boardInbox(client, profile, a.code, selfName ?? '', result.addressedYou === true, room?.replyMode)
        : { toVerify: [], toDo: [], current: [], queued: [], hint: '' };
      const mustWork = inboxRequiresWork(inbox);
      return ok({
        messages,
        cursor: result.cursor,
        ...digestFields,
        ...listenStatusFields(result.terminated),
        ...(result.addressedYou ? { addressedYou: true } : {}),
        ...(result.terminated ? { terminated: result.terminated } : {}),
        ...(!result.terminated
          ? { nextAction: nextActionForInbox(inbox, a.code, result.cursor, selfName, nextPrefs) }
          : {}),
        ...(inbox.hint ? { yourTasks: inbox } : {}),
        ...(replyMode ? { replyMode } : {}),
        ...(roomPolicy ? { roomPolicy, policyVersion: ROOM_POLICY_VERSION } : {}),
        // The Moderator reminder rides along with the brief, on listens that
        // actually returned something to act on. Knowing the seat is a
        // Moderator is now also needed for wakeOn, which is why the flag is
        // computed on quiet holds too — but a quiet hold stays lean.
        hint: [
          isModerator && result.messages.length > 0
            ? "You are this room's Moderator — follow roomPolicy: assign the work by name and synthesize, do not do it yourself."
            : '',
          inbox.hint,
          mustWork ? `${messages.length} new message(s). BOARD WORK OVERRIDES PRESENCE; do not call room_listen before the required board transition.` : result.hint,
        ].filter(Boolean).join(' '),
      }, await hydrateListenImages(messages), structured);
    }

    case 'room_minutes': {
      const all = await listMessages(client, a.code, 0);
      const room = await getRoom(client, a.code);
      let retro;
      if (a.stats === true) {
        const board = await client
          .post<{ board: RetroBoard }>({ action: 'taskBoard', code: a.code })
          .then(b => b.board)
          .catch(() => null);
        retro = buildRoomRetro(room, all, board);
      }
      if (a.snapshot === true) {
        const view = buildRoomContextView(all);
        return ok({
          topic: room.topic,
          participants: room.participants.map(p => p.name),
          snapshot: true,
          seed: view.seed,
          digest: view.digest,
          recent: view.recent,
          olderCount: view.olderCount,
          hint: view.digest
            ? 'Compact room view. Digest supersedes older listen dumps.'
            : 'Whole room still fits in recent; no digest yet.',
          ...(retro ? { retro } : {}),
        });
      }
      const base = {
        topic: room.topic,
        participants: room.participants.map(p => p.name),
        transcript: minutesTranscript(all),
        ...(retro ? { retro } : {}),
      };
      if (a.export === true) {
        const report = await createRoomReport(client, a.code);
        return ok({
          ...base,
          exported: true,
          reportUrl: `${publicBaseUrl()}/r/${a.code}/report`,
          messageCount: report.messageCount,
        });
      }
      return ok(base);
    }

    case 'room_leave': {
      try {
        await removeParticipant(client, a.code, a.name, a.name);
      } catch { /* room may already be ended / expired */ }
      return ok({ left: true, code: a.code });
    }

    case 'room_end': {
      await endRoom(client, a.code, a.name ?? '', typeof a.hostKey === 'string' ? a.hostKey : undefined);
      return ok({ ended: true, code: a.code });
    }

    case 'room_task': {
      const taskOk = (value: unknown) => ok(value, [], true);
      switch (a.action) {
        case 'list': {
          const body = await client.post<{ board: TaskBoard }>({ action: 'taskBoard', code: a.code });
          return taskOk({ board: body.board });
        }
        case 'create': {
          const err = requireFields(a, ['name', 'title']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskCreate',
            code: a.code,
            requesterName: a.name,
            title: a.title,
            ...(a.id ? { id: a.id } : {}),
            ...(a.owner ? { owner: a.owner } : {}),
            ...(a.verifier ? { verifier: a.verifier } : {}),
            ...(await roleClients(client, a.code, a.owner, a.verifier)),
            ...(a.dod ? { dod: a.dod } : {}),
          });
          return taskOk({ task: body.task, board: body.board });
        }
        case 'claim': {
          const err = requireFields(a, ['name', 'id']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskClaim', code: a.code, id: a.id, name: a.name, client: 'cc',
          });
          return taskOk({
            task: body.task,
            board: body.board,
            workNext: {
              required: true,
              action: 'execute_task',
              id: body.task.id,
              instruction:
                `Work on ${body.task.id} now. Do not send a status-only room message. `
                + 'Return to room_task submit only after producing verifiable evidence, or report one concrete blocker.',
            },
          });
        }
        case 'submit': {
          const err = requireFields(a, ['name', 'id', 'fileListing', 'fileExcerpt']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const ran = typeof a.runOutput === 'string' && a.runOutput.trim() !== '';
          const coded = typeof a.exitCode === 'number' && Number.isFinite(a.exitCode);
          if (ran !== coded) {
            return taskOk({
              error: 'bad_request',
              hint: ran
                ? 'runOutput needs a numeric exitCode with it.'
                : 'exitCode needs the runOutput it came from.',
            });
          }
          if (!ran && !(typeof a.checks === 'string' && a.checks.trim())) {
            return taskOk({
              error: 'bad_request',
              hint: 'submit needs proof you checked it: runOutput + exitCode for work with a run, '
                + 'or checks — each done-when criterion and how you verified it — for work without one.',
            });
          }
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskSubmit',
            code: a.code,
            id: a.id,
            name: a.name,
            client: 'cc',
            evidence: {
              fileListing: a.fileListing,
              fileExcerpt: a.fileExcerpt,
              ...(ran ? { runOutput: a.runOutput, exitCode: a.exitCode } : {}),
              ...(typeof a.checks === 'string' && a.checks.trim() ? { checks: a.checks } : {}),
            },
          });
          const inbox = taskInboxFor(body.board, a.name);
          const nextOwned = (body.board.tasks as Task[]).find(
            task => task.state === 'todo'
              && task.owner?.trim().toLowerCase() === a.name.trim().toLowerCase(),
          );
          return taskOk({
            task: body.task,
            board: body.board,
            taskStateUpdated: body.task.state === 'awaiting_review',
            submittedForReview: body.task.state === 'awaiting_review',
            ...(nextOwned ? {
              workNext: {
                required: true,
                action: 'claim_next_task',
                id: nextOwned.id,
                instruction:
                  `${body.task.id} is now awaiting_review. Immediately claim ${nextOwned.id} and continue working; `
                  + 'do not stop at a status report or wait for review unless it is a real dependency.',
              },
            } : {
              workNext: {
                required: false,
                action: 'await_review',
                instruction:
                  `${body.task.id} is now awaiting_review. The owner cannot mark it done; a different verifier must rule.`,
              },
            }),
            ...(inbox.hint ? { yourTasks: inbox } : {}),
          });
        }
        case 'verify': {
          const err = requireFields(a, ['name', 'id', 'verdict']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskVerify', code: a.code, id: a.id, name: a.name, client: 'cc', verdict: a.verdict, note: a.note,
            ...(a.followUp !== undefined ? { followUp: a.followUp } : {}),
          });
          const followUpRecorded = Boolean(body.task.verdict?.followUp);
          return taskOk({
            task: body.task,
            board: body.board,
            verified: true,
            notificationSent: true,
            followUpRecorded,
            nextAction: 'no_duplicate_report',
            hint: 'The system posted the single official review notice with the note and optional followUp. Do not repeat the ruling with room_send; use it only for new substantive information, reconsideration, or complex coordination. If acceptance fails, choose rejected; do not use done + followUp to bypass it.',
          });
        }
        case 'reassign': {
          const err = requireFields(a, ['name', 'id']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskReassign',
            code: a.code,
            id: a.id,
            requesterName: a.name,
            requesterClient: 'cc',
            ...(a.owner ? { owner: a.owner } : {}),
            ...(a.verifier ? { verifier: a.verifier } : {}),
            ...(await roleClients(client, a.code, a.owner, a.verifier)),
          });
          return taskOk({ task: body.task, board: body.board });
        }
        case 'cancel': {
          const err = requireFields(a, ['name', 'id']);
          if (err) return taskOk({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskCancel',
            code: a.code,
            id: a.id,
            requesterName: a.name,
            requesterClient: 'cc',
            ...(a.reason ? { reason: a.reason } : {}),
          });
          return taskOk({ task: body.task, board: body.board });
        }
        case 'reopen': {
          const err = requireFields(a, ['name', 'id']);
          if (err) return ok({ error: 'bad_request', hint: err });
          const body = await client.post<{ board: TaskBoard; task: Task }>({
            action: 'taskReopen',
            code: a.code,
            id: a.id,
            requesterName: a.name,
            requesterClient: 'cc',
            ...(a.state ? { state: a.state } : {}),
          });
          return ok({ task: body.task, board: body.board });
        }
        default:
          return taskOk({ error: 'bad_request', hint: 'room_task action must be one of: list, create, claim, submit, verify, reassign, reopen, cancel.' });
      }
    }

    case 'room_webhook': {
      switch (a.action) {
        case 'register': {
          const err = requireFields(a, ['name', 'url']);
          if (err) return ok({ error: 'bad_request', hint: err });
          const body = await client.post<{ webhook: { id: string; url: string } }>({
            action: 'webhookSet',
            code: a.code,
            requesterName: a.name,
            url: a.url,
            ...(typeof a.secret === 'string' && a.secret ? { secret: a.secret } : {}),
          });
          return ok({
            registered: true,
            webhook: body.webhook,
            hint:
              'Webhook active — the room POSTs each new message from others to your URL. ' +
              'On wake: room_listen({ since: <last cursor you processed>, timeoutMs: 0 }), reply via room_send, sleep again. ' +
              'Registering does NOT mean leave now: end your run only if you are actually going to sleep between events. ' +
              `If you are staying online, keep looping room_listen — the webhook is just a backstop. ${NEXT_LISTEN(a.code, 0).replace('since: 0', 'since: <your cursor>')}`,
          });
        }
        case 'list': {
          const body = await client.post<{ webhooks: unknown[] }>({ action: 'webhookList', code: a.code });
          return ok({ webhooks: body.webhooks });
        }
        case 'unregister': {
          const err = requireFields(a, ['name', 'id']);
          if (err) return ok({ error: 'bad_request', hint: err });
          const body = await client.post<{ removed: boolean }>({ action: 'webhookDelete', code: a.code, requesterName: a.name, id: a.id });
          return ok({ removed: body.removed });
        }
        default:
          return ok({ error: 'bad_request', hint: 'room_webhook action must be one of: register, list, unregister.' });
      }
    }

    case 'room_admin': {
      const hostKey = typeof a.hostKey === 'string' && a.hostKey ? a.hostKey : undefined;
      switch (a.action) {
        case 'reactivate': {
          await reactivateRoom(client, a.code, a.name ?? '', hostKey);
          return ok({ reactivated: true, code: a.code });
        }
        case 'set_mode': {
          if (!a.mode) return ok({ error: 'bad_request', hint: 'set_mode requires "mode" (open | sequential | moderator).' });
          const config =
            a.mode === 'sequential' && a.leadAgentName
              ? { leadAgentName: a.leadAgentName, leadAgentClient: 'cc' }
              : a.mode === 'moderator'
                ? { moderatorAgentName: a.moderatorAgentName, moderatorAgentClient: 'cc' }
                : undefined;
          if (a.mode === 'moderator' && !a.moderatorAgentName) {
            return ok({ error: 'bad_request', hint: 'moderator mode requires "moderatorAgentName".' });
          }
          const body = await client.post<{ room: Room }>({
            action: 'setReplyMode',
            code: a.code,
            requesterName: a.name,
            hostKey,
            mode: a.mode,
            ...(config ? { config } : {}),
          });
          return ok({ replyMode: body.room.replyMode, modeConfig: body.room.modeConfig });
        }
        case 'invoke': {
          if (!a.targetName) return ok({ error: 'bad_request', hint: 'invoke requires "targetName".' });
          // An MCP agent acting as Moderator has no hostKey, so the host-only
          // form left it with no way to hand anyone the floor — it could name
          // an assignee but never authorise one. The server already exposes
          // source="moderator" (gated by requireModerator); use it when the
          // caller IS this room's configured moderator and isn't holding a key.
          let source: 'host' | 'moderator' = 'host';
          if (!hostKey) {
            const room = await getRoom(client, a.code).catch(() => null);
            if (
              room && (room.replyMode ?? 'open') === 'moderator'
              && room.modeConfig?.moderatorAgentName === a.name
            ) {
              source = 'moderator';
            }
          }
          const body = await client.post<{ added: boolean }>({
            action: 'directInvoke',
            code: a.code,
            requesterName: a.name,
            hostKey,
            target: { name: a.targetName, client: 'cc' },
            source,
          });
          return ok({ invoked: body.added, targetName: a.targetName, as: source });
        }
        case 'skip': {
          const body = await client.post<{ skipped: unknown }>({
            action: 'skipCurrent',
            code: a.code,
            requesterName: a.name,
            hostKey,
          });
          return ok({ skipped: body.skipped });
        }
        default:
          return ok({ error: 'bad_request', hint: 'room_admin action must be one of: reactivate, set_mode, invoke, skip.' });
      }
    }

    default:
      return { ...ok({ error: 'unknown_tool', hint: `Unknown tool "${name}".` }), isError: true };
  }
}

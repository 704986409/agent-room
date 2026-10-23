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
// This file is the dispatcher. Leaf modules carry what it used to hold inline,
// and every name it used to export is re-exported below so no import path
// changes:
//   _mcpResult.ts   — the tool-result shape and ok()
//   _mcpListen.ts   — room_listen's hold, hints and listen-only fields
//   _mcpToolDefs.ts — the declared tool surface and SERVER_INSTRUCTIONS
//   _mcpIdentity.ts — initials, colour and the message an agent posts
//   _mcpArgs.ts     — the required-field check the action tools share
//   _mcpSendTool.ts — room_send and the room API's refusal hints
//   _mcpTaskTool.ts — room_task, one handler per board action

import {
  buildRoomContextView,
  parseRoomCode,
  ROOM_POLICY_VERSION,
  roomPolicySummary,
  safeAttachmentPromptText,
  roleBriefFor,
  slimMessage,
} from '@agent-room/shared';
import type { Message, Participant, Room } from '@agent-room/shared';
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
import { dispatchMemoryTool, isMemoryEnabled, isMemoryToolName, loadJoinBrief, saveRoleProfileMemory } from './_memoryTools.js';
import type { MemoryToolDependencies } from './_memoryTools.js';
import { requireFields } from './_mcpArgs.js';
import { buildMessage, colorForName, initialsFor } from './_mcpIdentity.js';
import { ok, type McpToolResult } from './_mcpResult.js';
import { dispatchRoomSend, remoteApiErrorResult } from './_mcpSendTool.js';
import { dispatchRoomTask } from './_mcpTaskTool.js';
import {
  boardInbox,
  contextFields,
  REJOIN_RECENT_HINT,
  rejoinRecentFields,
  hydrateListenImages,
  inboxRequiresWork,
  listenPrefsFor,
  listenStatusFields,
  listenWindowHint,
  listMessagesResilient,
  LISTEN_DEFAULT_MS,
  applyAddressedReply,
  messagesAddressCaller,
  nextActionForInbox,
  nextListenAction,
  nextSleepAction,
  NEXT_LISTEN,
  quietSleepHint,
  runListen,
  type WakeOn,
} from './_mcpListen.js';
import { declaresObjectOutput, FULL_TOOLS, isRoomCreateEnabled, listTools, type McpProfile } from './_mcpToolDefs.js';
import { parseManaged, settleManagedRead } from './_wakeListen.js';
import { RedisWakeStore } from './_wakeRedis.js';

export { CORE_TOOLS, FULL_TOOLS, isRoomCreateEnabled, listTools, SERVER_INSTRUCTIONS, serverInstructions } from './_mcpToolDefs.js';
export type { McpProfile } from './_mcpToolDefs.js';
export { hydrateListenImages, isTrustedAttachmentImageUrl, listMessagesResilient } from './_mcpListen.js';
export type { WakeOn } from './_mcpListen.js';

export function memoryJoinNote(enabled: boolean, brief?: Record<string, unknown>): string | undefined {
  if (!enabled || (brief?.loaded === true && typeof brief.brief === 'string' && brief.brief.trim())) return undefined;
  // Same chat session already received the Brief: memoryBriefSkipped says so; no generic note.
  if (brief?.skipped === 'already_read_this_session') return undefined;
  return 'This room uses shared memory: search it before unfamiliar work; propose durable conventions/decisions/lessons with memory_write scope room (reviewed).';
}

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || 'https://www.agent-room.com';
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

export async function callTool(
  client: RemoteRoomClient,
  profile: McpProfile,
  rawName: string,
  rawArgs: Record<string, unknown>,
  harness?: HttpHarness,
  memoryDependencies?: MemoryToolDependencies,
): Promise<McpToolResult> {
  const { name, args } = resolveAlias(rawName, rawArgs as Record<string, any>);
  // Agents often paste the full /j/ or /r/ URL as `code` (invite copy says to).
  // Canonicalize before any getRoom/joinRoom so URL-as-code is not room_not_found.
  if (typeof args.code === 'string') {
    const parsed = parseRoomCode(args.code);
    if (parsed) args.code = parsed;
  }
  if (name === 'room_create' && !isRoomCreateEnabled()) {
    return {
      ...ok({
        error: 'room_create_disabled',
        message: 'Rooms can only be created by a signed-in user in the web UI.',
        hint: 'Rooms can only be created by a signed-in user in the web UI.',
      }, [], true),
      isError: true,
    };
  }
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
    if (e instanceof RemoteRoomApiError) return remoteApiErrorResult(e, name);
    throw e;
  }
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
  // Same promise, same obligation, for every other tool that declares one —
  // which is now all of them, including the refusal objects a tool hands back
  // instead of a payload (bad_request hints here, the API's own codes in
  // remoteApiErrorResult).
  const structured = declaresObjectOutput(name);
  switch (name) {
    case 'room_create': {
      if (!isRoomCreateEnabled()) {
        return {
          ...ok({
            error: 'room_create_disabled',
            message: 'Rooms can only be created by a signed-in user in the web UI.',
            hint: 'Rooms can only be created by a signed-in user in the web UI.',
          }, [], structured),
          isError: true,
        };
      }
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
      const listed = await listMessages(client, code, 0);
      const cursor = Array.isArray(listed) ? listed.length : listed.cursor;
      return ok({
        code,
        topic: created.topic,
        joinUrl: `${publicBaseUrl()}/j/${code}`,
        cursor,
        nextAction: nextListenAction(code, cursor, a.name),
        hostKey: created.hostKey,
        seatKey: hostSeat.seatKey,
        roleBrief: roleBriefFor(a.role ?? ''),
        hint: `Room created — share the joinUrl; keep the hostKey private. ${NEXT_LISTEN(code, cursor)} ${listenWindowHint(harness)}`,
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
        sessionId: typeof a.sessionId === 'string' ? a.sessionId : undefined,
        inviteCode: typeof a.inviteCode === 'string' && a.inviteCode.trim() ? a.inviteCode : undefined,
        machineId: typeof a.machineId === 'string' && a.machineId.trim() ? a.machineId : undefined,
        // New agent seats need the host's one-time invite; resume/reclaim/host seat do not.
        requireAgentInvite: true,
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
      const listed = await listMessages(client, a.code, 0);
      const msgs = Array.isArray(listed) ? listed : listed.messages;
      const cursor = Array.isArray(listed) ? listed.length : listed.cursor;
      const recentMessages = msgs.slice(-16).map(slimMessage);
      const joinInbox = await boardInbox(client, profile, a.code, finalName, false, updated.replyMode);
      const joinListenPrefs = listenPrefsFor(
        { wakeOn: 'any' },
        updated,
        isConfiguredModerator(updated, finalName, 'cc'),
        undefined,
        finalName,
      );
      // An invite's 「职业设定与技能」 goes back to the agent and into its Persona memory
      // (saved before the Brief loads, so this join's Brief already lists it).
      const roleProfile = updated.agentInvite?.roleProfile;
      let roleProfileMemory: Record<string, unknown> | undefined;
      if (roleProfile && isMemoryEnabled()) {
        roleProfileMemory = await saveRoleProfileMemory(
          client, a.code, updated.seatKey!, updated.agentInvite!.role, roleProfile, memoryDependencies,
        );
      }
      let memoryBrief: Record<string, unknown> | undefined;
      if (isMemoryEnabled()) {
        memoryBrief = await loadJoinBrief(client, a.code, updated.seatKey!, memoryDependencies);
      }
      const memoryNote = memoryJoinNote(isMemoryEnabled(), memoryBrief);
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
        } : memoryBrief?.skipped === 'already_read_this_session'
          ? { memoryBriefSkipped: 'already_read_this_session' }
          : memoryBrief?.code ? { memoryBriefError: memoryBrief.code } : {}),
        ...(memoryNote ? { memoryNote } : {}),
        ...(roleProfile ? { roleProfile } : {}),
        ...(roleProfileMemory ? { roleProfileMemory } : {}),
        canSpeak: !muted,
        replyMode: updated.replyMode ?? 'open',
        participants: updated.participants.map(p => ({
          name: p.name,
          role: p.role,
          client: p.client,
          canSpeak: p.canSpeak !== false,
        })),
        cursor,
        nextAction: nextActionForInbox(joinInbox, a.code, cursor, finalName, joinListenPrefs),
        recentMessages,
        ...rejoinRecentFields(reconnecting),
        ...contextFields(msgs),
        ...(joinInbox.hint ? { yourTasks: joinInbox } : {}),
        roleBrief: roleBriefFor(updated.participant.role ?? a.role ?? ''),
        roomPolicy: policyFor(updated, finalName),
        policyVersion: ROOM_POLICY_VERSION,
        hint: [
          muted
            ? `Joined as "${finalName}" but the host has muted you — keep listening until unmuted.`
            : `Joined as "${finalName}".`,
          joinInbox.hint,
          // Board work outranks presence: an agent told to listen right after
          // being handed a task listens, and the task sits.
          ...(inboxRequiresWork(joinInbox) ? [] : [NEXT_LISTEN(a.code, cursor), listenWindowHint(harness)]),
          ...(reconnecting ? [REJOIN_RECENT_HINT] : []),
        ].filter(Boolean).join(' '),
      }, await hydrateListenImages(recentMessages), structured);
    }

    case 'room_send':
      return dispatchRoomSend(client, a, profile, structured);

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
        let cursor = listed.cursor;
        const managedRead = parseManaged(a.managed);
        if (managedRead && selfName) {
          try {
            const settled = await settleManagedRead(client.store, {
              code: a.code, name: selfName, managed: managedRead, since,
              messages: listed.messages, timeoutMs: 0,
            });
            if (settled) cursor = settled.cursor;
          } catch { /* ordinary read; an unacked trigger stays until lease retry */ }
        }
        const all = since === 0
          ? listed.messages
          : await Promise.resolve(listMessages(client, a.code, 0)).then(
            fetched => (Array.isArray(fetched) ? fetched : fetched?.messages) ?? listed.messages,
            () => listed.messages,
          );
        const messages = listed.messages.map(slimMessage);
        let catchUpRoom: Room | undefined;
        try { catchUpRoom = await getRoom(client, a.code); } catch { /* lean */ }
        const readInbox = await boardInbox(client, profile, a.code, selfName ?? '', false, catchUpRoom?.replyMode);
        const readMustWork = inboxRequiresWork(readInbox);
        const readAddressed = messagesAddressCaller(listed.messages, selfName, catchUpRoom);
        const readHint = readMustWork
          ? readInbox.hint
          : [readInbox.hint, NEXT_LISTEN(a.code, cursor)].filter(Boolean).join(' ');
        const readOverlaid = applyAddressedReply(
          nextActionForInbox(readInbox, a.code, cursor, selfName),
          readHint,
          readAddressed,
          readMustWork,
          a.code,
          cursor,
          selfName,
        );
        return ok({
          messages,
          cursor,
          ...listenStatusFields(),
          nextAction: readOverlaid.nextAction,
          ...contextFields(all),
          ...(readInbox.hint ? { yourTasks: readInbox } : {}),
          hint: readOverlaid.hint,
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
            listed => (Array.isArray(listed) ? listed : listed?.messages) ?? result.messages,
            () => result.messages,
          );
        digestFields = contextFields(all);
      }
      let listenEpoch: number | undefined;
      let managedCursor: number | undefined;
      const managedListen = parseManaged(a.managed);
      if (managedListen && selfName && !result.terminated) {
        try {
          const settled = await settleManagedRead(client.store, {
            code: a.code, name: selfName, managed: managedListen, since,
            messages: result.messages, timeoutMs,
          });
          if (settled) {
            managedCursor = settled.cursor;
            listenEpoch = settled.listenEpoch;
          }
        } catch { /* ordinary listen result; receipt can be retried */ }
      }
      const messages = result.messages.map(slimMessage);
      // Read the board on EVERY hold that returns, not only the ones that
      // returned messages. A quiet hold used to skip it to stay lean, which
      // meant an agent holding 40s–240s with an open task of its own got
      // `nextAction: presence` back and dutifully went back to listening —
      // the board said "work", the result said "wait". One board read per
      // returned hold (not per 2s poll) is what that costs.
      const inbox = result.terminated
        ? { toVerify: [], toDo: [], current: [], queued: [], hint: '' }
        : await boardInbox(client, profile, a.code, selfName ?? '', result.addressedYou === true, room?.replyMode);
      const mustWork = inboxRequiresWork(inbox);
      const cursor = managedCursor ?? result.cursor;
      const addressed = !result.terminated && (
        result.addressedYou === true || messagesAddressCaller(result.messages, selfName, room)
      );
      // Managed seats: one quiet round with nothing to do is room_sleep, then
      // end the turn. The wake prompt already says this; a presence nextAction
      // made them loop quiet listens. Fresh Codex launch after sleep is out of
      // scope (session reset stays with the daemon).
      const managedSeatKey = managedListen?.seatKey;
      if (managedSeatKey && selfName && !result.terminated && messages.length === 0 && !mustWork && !addressed) {
        const status = listenStatusFields();
        return ok({
          messages,
          cursor,
          listenStatus: status.listenStatus,
          stay: false,
          meaning: 'Call room_sleep with nextAction.arguments, then end the turn. Do not start another room_listen.',
          nextAction: nextSleepAction(a.code, cursor, selfName, managedSeatKey),
          ...(listenEpoch ? { listenEpoch } : {}),
          ...(replyMode ? { replyMode } : {}),
          hint: quietSleepHint(a.code, cursor, selfName, managedSeatKey),
        }, [], structured);
      }
      const showBoard = mustWork || messages.length > 0;
      const hint = [
        isModerator && result.messages.length > 0
          ? "You are this room's Moderator — follow roomPolicy: assign the work by name and synthesize, do not do it yourself."
          : '',
        showBoard ? inbox.hint : '',
        mustWork
          ? `${messages.length > 0 ? `${messages.length} new message(s). ` : ''}`
            + 'BOARD WORK OVERRIDES PRESENCE; do not call room_listen before the required board transition.'
          : result.hint,
      ].filter(Boolean).join(' ');
      const overlaid = applyAddressedReply(
        result.terminated ? undefined : nextActionForInbox(inbox, a.code, cursor, selfName, nextPrefs),
        hint,
        addressed,
        mustWork,
        a.code,
        cursor,
        selfName,
        nextPrefs,
      );
      return ok({
        messages,
        cursor,
        ...digestFields,
        ...listenStatusFields(result.terminated),
        ...(result.addressedYou ? { addressedYou: true } : {}),
        ...(result.terminated ? { terminated: result.terminated } : {}),
        ...(overlaid.nextAction ? { nextAction: overlaid.nextAction } : {}),
        ...(listenEpoch ? { listenEpoch } : {}),
        ...(showBoard && inbox.hint ? { yourTasks: inbox } : {}),
        ...(replyMode ? { replyMode } : {}),
        ...(roomPolicy ? { roomPolicy, policyVersion: ROOM_POLICY_VERSION } : {}),
        // The Moderator reminder rides along with the brief, on listens that
        // actually returned something to act on. Knowing the seat is a
        // Moderator is now also needed for wakeOn, which is why the flag is
        // computed on quiet holds too — but a quiet hold stays lean.
        hint: overlaid.hint,
      }, await hydrateListenImages(messages), structured);
    }

    case 'room_minutes': {
      const listed = await listMessages(client, a.code, 0);
      const all = Array.isArray(listed) ? listed : listed.messages;
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
        }, [], structured);
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
        }, [], structured);
      }
      return ok(base, [], structured);
    }

    case 'room_sleep': {
      const cursor = typeof a.cursor === 'number' ? a.cursor : Number.NaN;
      const seatKey = typeof a.seatKey === 'string' ? a.seatKey : '';
      const name = typeof a.name === 'string' ? a.name.trim() : '';
      if (seatKey.includes('AGENT_ROOM_SEAT_KEY')) {
        return ok({
          slept: false,
          error: 'bad_request',
          hint: 'seatKey 要填环境变量 AGENT_ROOM_SEAT_KEY 的实际值，不要填占位符。托管进程会把这个值放进环境变量。',
        }, [], structured);
      }
      if (!name || !seatKey || !Number.isFinite(cursor)) {
        return ok({ slept: false, error: 'bad_request' }, [], structured);
      }
      try {
        const seat = await new RedisWakeStore(client.store).sleep(a.code, name, seatKey, cursor, Date.now());
        return ok({ slept: true, cursor, roomInstanceId: seat.roomInstanceId, seatId: seat.seatId }, [], structured);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'seat_unauthorized';
        return ok({ slept: false, error: code }, [], structured);
      }
    }

    case 'room_leave': {
      try {
        await removeParticipant(client, a.code, a.name, a.name);
      } catch { /* room may already be ended / expired */ }
      return ok({ left: true, code: a.code }, [], structured);
    }

    case 'room_end': {
      await endRoom(client, a.code, a.name ?? '', typeof a.hostKey === 'string' ? a.hostKey : undefined);
      return ok({ ended: true, code: a.code }, [], structured);
    }

    case 'room_task':
      return dispatchRoomTask(client, a);

    case 'room_webhook': {
      switch (a.action) {
        case 'register': {
          const err = requireFields(a, ['name', 'url', 'seatKey']);
          if (err) return ok({ error: 'bad_request', hint: err }, [], structured);
          const body = await client.post<{ webhook: { id: string; url: string; hasSecret?: boolean } }>({
            action: 'webhookSet',
            code: a.code,
            requesterName: a.name,
            seatKey: a.seatKey,
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
          }, [], structured);
        }
        case 'list': {
          const body = await client.post<{ webhooks: unknown[] }>({ action: 'webhookList', code: a.code });
          return ok({ webhooks: body.webhooks }, [], structured);
        }
        case 'unregister': {
          const err = requireFields(a, ['name', 'id', 'seatKey']);
          if (err) return ok({ error: 'bad_request', hint: err }, [], structured);
          const body = await client.post<{ removed: boolean }>({
            action: 'webhookDelete',
            code: a.code,
            requesterName: a.name,
            seatKey: a.seatKey,
            id: a.id,
          });
          return ok({ removed: body.removed }, [], structured);
        }
        default:
          return ok({ error: 'bad_request', hint: 'room_webhook action must be one of: register, list, unregister.' }, [], structured);
      }
    }

    case 'room_admin': {
      const hostKey = typeof a.hostKey === 'string' && a.hostKey ? a.hostKey : undefined;
      switch (a.action) {
        case 'reactivate': {
          await reactivateRoom(client, a.code, a.name ?? '', hostKey);
          return ok({ reactivated: true, code: a.code }, [], structured);
        }
        case 'set_mode': {
          if (!a.mode) return ok({ error: 'bad_request', hint: 'set_mode requires "mode" (open | sequential | moderator).' }, [], structured);
          const config =
            a.mode === 'sequential' && a.leadAgentName
              ? { leadAgentName: a.leadAgentName, leadAgentClient: 'cc' }
              : a.mode === 'moderator'
                ? { moderatorAgentName: a.moderatorAgentName, moderatorAgentClient: 'cc' }
                : undefined;
          if (a.mode === 'moderator' && !a.moderatorAgentName) {
            return ok({ error: 'bad_request', hint: 'moderator mode requires "moderatorAgentName".' }, [], structured);
          }
          const body = await client.post<{ room: Room }>({
            action: 'setReplyMode',
            code: a.code,
            requesterName: a.name,
            hostKey,
            mode: a.mode,
            ...(config ? { config } : {}),
          });
          return ok({ replyMode: body.room.replyMode, modeConfig: body.room.modeConfig }, [], structured);
        }
        case 'invoke': {
          if (!a.targetName) return ok({ error: 'bad_request', hint: 'invoke requires "targetName".' }, [], structured);
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
          return ok({ invoked: body.added, targetName: a.targetName, as: source }, [], structured);
        }
        case 'skip': {
          const body = await client.post<{ skipped: unknown }>({
            action: 'skipCurrent',
            code: a.code,
            requesterName: a.name,
            hostKey,
          });
          return ok({ skipped: body.skipped }, [], structured);
        }
        default:
          return ok({ error: 'bad_request', hint: 'room_admin action must be one of: reactivate, set_mode, invoke, skip.' }, [], structured);
      }
    }

    default:
      return { ...ok({ error: 'unknown_tool', hint: `Unknown tool "${name}".` }), isError: true };
  }
}

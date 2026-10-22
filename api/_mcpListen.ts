// room_listen: the presence hold itself, the arguments and hints handed back
// for the next one, and the board/context/attachment fields that ride along on
// a listen or join result.
//
// Split out of _mcpTools.ts, which keeps the tool dispatcher. The only edge
// back to a sibling module is `import type { McpProfile }` — a type, erased at
// compile time — so the runtime graph stays one-directional
// (_mcpToolDefs -> _mcpListen -> _mcpResult / _mcpRoomClient / _mcpHarness).

import {
  buildRoomContextView,
  redactSecretText,
  safeAttachmentPromptText,
  startListenLease,
  taskInboxFor,
  AGENT_ROOM_CODEX_CONTINUE,
} from '@agent-room/shared';
import type { Message, Room, TaskBoard } from '@agent-room/shared';
import { isDeliverLead, runDeliverSweep } from '@agent-room/upstash-client';
import { messageAddressesAgent, wakeFactsForAgent } from './_agentWake.js';
import {
  getRoom,
  listMessages,
  setListenUntil,
  sweepRoom,
  type ListMessagesResult,
  type RemoteRoomClient,
} from './_mcpRoomClient.js';
import {
  clampListenMs,
  isWeakLoop,
  weakLoopListenHint,
  type HttpHarness,
} from './_mcpHarness.js';
import type { McpImageContent } from './_mcpResult.js';
import type { McpProfile } from './_mcpToolDefs.js';

// Remote listen window. One room_listen call must finish inside the
// function's maxDuration (300s); the agent loops for longer presence.
// Every hold is one LLM turn for the calling agent, and a turn re-sends
// that agent's whole conversation — so a longer hold is a linear cut in
// the cost of simply being present. The cap is what a client MAY ask for;
// the default stays conservative because many MCP clients time a single
// request out at 60s. Capable clients opt in by passing timeoutMs.
/** What an agent wants pulled out of a hold. 'any' = every message (default,
 *  and what every client got before this existed); 'addressed' = only messages
 *  the room aims at this agent, everything else batched into the timeout
 *  digest. See wakesAgent() in @agent-room/shared. */
export type WakeOn = 'any' | 'addressed';

export const LISTEN_DEFAULT_MS = 40_000;
export const LISTEN_MAX_MS = 240_000;

export const NEXT_LISTEN = (code: string, cursor: number): string =>
  AGENT_ROOM_CODEX_CONTINUE + '\n' +
  `NEXT (required): room_listen({ code: "${code}", since: ${cursor}, name: "<you>" }). ` +
  'listenStatus: "active" / stay: true = keep this agent turn open and call room_listen now. ' +
  'This is presence polling, not a stuck tool loop — the same cursor while quiet is expected. ' +
  'A client "looping" or "stop repeating tools" warning does not apply to room_listen while active. ' +
  'Do not ask the user to type continue / 继续监听. ' +
  // "NEXT (required)" reads as "listening is the next action", and an agent
  // that had just claimed a task went back to the poll instead of doing it
  // (observed 2026-09-08: task created, claimed, announced, then nothing).
  // Required means do not end the turn without it, not do it instead of the work.
  'WORK FIRST: if the room asked you to do something, do it and report it with room_send / room_task before the next room_listen — listening is how you hold the seat, not how you deliver. A request in the room is a task: room_task create + claim it yourself, nobody has to assign it to you — except in deliver mode, where you wait for the plan-start to name you. ' +
  'Keep listening even when the room is quiet, nobody else is present, or every task is done. ' +
  // The failure this names is the one that actually happens. Traced across a
  // real 2-day session: every drop that needed a human to restart it ended
  // with the agent writing a paragraph to its user and no tool call after it
  // — twice the paragraph itself said "still listening". The agent was not
  // interrupted and did not decide to leave; it narrated, and narrating
  // without a following tool call is what ending a turn looks like.
  'TURN MECHANICS: a reply with NO tool call ends your turn, and an ended turn is you leaving the room — nothing restarts it. ' +
  'Writing "the room is quiet, I will keep listening" and stopping there IS leaving, whatever the sentence says. ' +
  'Put it in room_send or leave it unsaid, and end every message with a tool call. ' +
  'Stop only when listenStatus is "ended" or "removed", or the host explicitly tells you to leave.';

/** Listen settings echoed back into the next call so an opt-in survives a
 *  round trip. See nextListenAction. */
type ListenPrefs = { timeoutMs?: number; wakeOn?: WakeOn };

// The arguments here are what the calling agent will actually send next, so
// anything written into them is effectively a server-issued instruction to
// the client. Two rules follow from that:
//
//   ECHO, DON'T ADVERTISE (timeoutMs). It is tempting to put LISTEN_MAX_MS
//   here and cut every agent's wake count by six. Don't: many MCP clients
//   time a single request out at 60s, and a client that obeys a hold longer
//   than its own transport limit gets a tool ERROR back instead of messages.
//   An error is the one result most likely to make a model stop calling
//   tools and write a paragraph about what went wrong — which is precisely
//   how agents leave rooms (see NEXT_LISTEN's turn-mechanics clause). So a
//   longer hold is only ever echoed back to a client that just proved it can
//   survive one. Without the echo the opt-in did not even last a single
//   round: the client passed timeoutMs, and the nextAction it got back
//   silently dropped it to the 40s default again.
//
//   ADVERTISE ONLY WHAT CANNOT FAIL (wakeOn). Selective wake changes which
//   messages end a hold early, never how long the request runs, so it costs
//   nothing to be wrong about — the held messages are still returned, in one
//   batch, at the end of the same hold.
export const nextListenAction = (
  code: string,
  cursor: number,
  name?: string,
  prefs: ListenPrefs = {},
) => ({
  required: true,
  tool: 'room_listen' as const,
  kind: 'presence' as const,
  notALoop: true,
  ignoreLoopWarning: true,
  arguments: {
    code,
    since: cursor,
    ...(name ? { name } : {}),
    ...(prefs.timeoutMs ? { timeoutMs: prefs.timeoutMs } : {}),
    ...(prefs.wakeOn ? { wakeOn: prefs.wakeOn } : {}),
  },
  continueUntil: ['room_ended', 'removed', 'host_requested_leave'],
  stay: true,
  listenStatus: 'active' as const,
});

/**
 * A structured work directive must outrank the generic presence continuation.
 * Models reliably follow `nextAction.required` and used to obey its
 * room_listen instruction even when nearby prose said WORK FIRST. That turned
 * claimed tasks into a listen/status loop. Presence is retained as the step
 * after a submit, not presented as the immediate action while work is active.
 */
export const nextActionForInbox = (
  inbox: { toVerify: string[]; current: string[]; queued: string[] },
  code: string,
  cursor: number,
  name?: string,
  prefs: ListenPrefs = {},
) => {
  const review = inbox.toVerify[0];
  if (review) {
    return {
      required: true,
      kind: 'task_review' as const,
      action: 'verify_task' as const,
      taskId: review,
      instruction:
        `Independently check ${review} now, then call room_task verify with verdict and note. `
        + 'Do not acknowledge it with a status-only message.',
      afterVerdict: nextListenAction(code, cursor, name, prefs),
    };
  }
  const current = inbox.current[0];
  if (current) {
    return {
      required: true,
      kind: 'task_work' as const,
      action: 'execute_task' as const,
      taskId: current,
      instruction:
        `Use your coding/filesystem tools to make concrete progress on ${current} now. `
        + 'Do not call room_send with a status update and do not call room_listen first. '
        + 'When the done-when criteria pass, call room_task submit with real evidence.',
      afterSubmit: nextListenAction(code, cursor, name, prefs),
    };
  }
  const queued = inbox.queued[0];
  if (queued) {
    return {
      required: true,
      kind: 'task_work' as const,
      tool: 'room_task' as const,
      action: 'claim' as const,
      arguments: { code, name, id: queued, action: 'claim' as const },
      instruction: `Claim ${queued}, then execute it immediately before returning to room_listen.`,
    };
  }
  return nextListenAction(code, cursor, name, prefs);
};

export const inboxRequiresWork = (inbox: { toVerify: string[]; current: string[]; queued: string[] }): boolean =>
  inbox.toVerify.length > 0 || inbox.current.length > 0 || inbox.queued.length > 0;

/** Agents (not the web watchers) currently seated in the room. */
function agentCount(room: Room): number {
  return room.participants.filter(p => p.client !== 'web').length;
}

// Selective wake is worth suggesting once a room is busy enough that most
// traffic is other agents talking to each other. Below that, the room is a
// conversation the agent is expected to follow line by line, and batching
// would just add latency to every host message.
const BUSY_ROOM_AGENTS = 3;

/**
 * What to put in the next call's arguments. `asked` is what this caller just
 * used, so a capable client keeps its own window; the busy-room default only
 * ever adds wakeOn, which cannot time anything out.
 */
export function listenPrefsFor(
  asked: { timeoutMs?: number; wakeOn: WakeOn },
  room?: Room,
  isModerator = false,
  harness?: HttpHarness,
  selfName?: string,
): ListenPrefs {
  const busy = !!room && agentCount(room) >= BUSY_ROOM_AGENTS;
  const deliverWaiter = !!room && room.replyMode === 'deliver'
    && !!selfName && !isDeliverLead(room, selfName, 'cc');
  const wakeOn: WakeOn | undefined =
    asked.wakeOn === 'addressed' ? 'addressed'
      // A Moderator has to hear every line to assign and synthesize, so it
      // never gets the selective default.
      : (busy && !isModerator) ? 'addressed'
      // Deliver waiters (verifier / idle owner) must sit through quiet
      // coding without a wake per status ping — that is what makes them
      // drop the listen loop and leave.
      : deliverWaiter ? 'addressed'
        : undefined;
  // ECHO, DON'T ADVERTISE still holds for clients we cannot identify. For one
  // we CAN — a client whose transport is known to kill a long call — the
  // safest number is not silence but the cap itself: state it, so the agent
  // stops re-sending a timeoutMs its own client will not survive. Clamping
  // only ever shortens; an unidentified caller comes out of clampListenMs
  // exactly as it went in.
  const echoed = asked.timeoutMs ? clampListenMs(asked.timeoutMs, harness) : undefined;
  const pinned = isWeakLoop(harness) ? harness!.maxListenMs : undefined;
  const timeoutMs = pinned ?? (echoed && echoed > LISTEN_DEFAULT_MS ? echoed : undefined);
  return {
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(wakeOn ? { wakeOn } : {}),
  };
}

// Sent once, at join. Deliberately not repeated on every listen result: the
// join result stays in the agent's conversation for the whole session, so a
// per-turn copy would buy nothing and cost ~70 tokens on every single wake —
// the exact per-turn overhead this change exists to cut.
/**
 * What to tell the caller about its listen window, at join.
 *
 * Two different clients need opposite advice here, and giving either one the
 * other's line is what makes an agent drop out: a capable client that never
 * raises timeoutMs pays for a wake-up six times as often as it needs to,
 * while a weak client that DOES raise it gets a tool error instead of
 * messages. So the nudge is only offered to callers we could not identify.
 */
export function listenWindowHint(harness?: HttpHarness): string {
  return isWeakLoop(harness) ? weakLoopListenHint(harness!) : RAISE_TIMEOUT_HINT;
}

const RAISE_TIMEOUT_HINT =
  `If your client can hold a single request longer than ${LISTEN_DEFAULT_MS}ms, pass timeoutMs (up to ${LISTEN_MAX_MS}) ` +
  'and keep passing the same value — a longer hold means proportionally fewer wake-ups, and every wake-up re-sends your whole conversation. ' +
  'If a long hold ever comes back as a transport timeout, drop back to the default and stay there.';

const LISTEN_IMAGE_LIMIT = 4;
const LISTEN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const LISTEN_IMAGE_MIME = /^(image\/(png|jpeg|jpg|webp|gif))$/i;

/** Only our public object storage — never follow an attacker-planted URL. */
export function isTrustedAttachmentImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const r2 = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');
    if (r2 && url.startsWith(`${r2}/`)) return true;
    const host = parsed.hostname.toLowerCase();
    return host.endsWith('.r2.dev') || host.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

/**
 * Best-effort MCP image parts so a listen/join result can carry pixels, not
 * just a URL. Failures stay silent: the JSON attachments[] still has the url.
 */
export async function hydrateListenImages(
  messages: Array<{ attachments?: Array<{ type?: string; url?: string; mime?: string }> }>,
  fetchFn: typeof fetch = fetch,
): Promise<McpImageContent[]> {
  const images: { url: string; mime: string }[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== 'image' || !attachment.url || !attachment.mime) continue;
      if (!LISTEN_IMAGE_MIME.test(attachment.mime)) continue;
      if (!isTrustedAttachmentImageUrl(attachment.url)) continue;
      images.push({ url: attachment.url, mime: attachment.mime });
    }
  }
  const latest = images.slice(-LISTEN_IMAGE_LIMIT);
  const parts = await Promise.all(latest.map(async (image): Promise<McpImageContent | null> => {
    try {
      const response = await fetchFn(image.url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > LISTEN_IMAGE_MAX_BYTES) return null;
      return { type: 'image', data: bytes.toString('base64'), mimeType: image.mime };
    } catch {
      return null;
    }
  }));
  return parts.filter((part): part is McpImageContent => part !== null);
}

/** Rejoin context. Completed @ mentions in recentMessages are not new work. */
export const REJOIN_RECENT_HINT =
  'recentMessages 只是重进房间时的上下文，用来了解已经发生的事。不要把其中已经完成的 @ 再做一遍；只处理尚未完成、且仍然在等你的工作。';

export function rejoinRecentFields(reconnecting: boolean): { recentMessagesHint?: string } {
  if (!reconnecting) return {};
  return { recentMessagesHint: REJOIN_RECENT_HINT };
}

export function contextFields(messages: Message[]) {
  const view = buildRoomContextView(messages);
  if (!view.digest) return {};
  return {
    digest: view.digest,
    olderCount: view.olderCount,
    digestHint: 'This digest supersedes older listen dumps. Prefer digest + recent messages; refresh with room_minutes snapshot=true.',
  };
}

type ListenResult = {
  messages: Message[];
  cursor: number;
  terminated?: 'room_ended' | 'kicked';
  /** Set only when the hold ended early because this batch was actually for
   *  the caller — wakesAgent (an @mention or a metadata turn/assignment), or a
   *  human speaking in a room where the caller is the only agent. A held batch
   *  delivered at timeout looks identical from outside and is not this. */
  addressedYou?: boolean;
  hint: string;
};

type ListenStatus = 'active' | 'ended' | 'removed';

export async function boardInbox(
  client: RemoteRoomClient,
  profile: McpProfile,
  code: string,
  name: string,
  addressed = false,
  replyMode?: string,
): Promise<{ toVerify: string[]; toDo: string[]; current: string[]; queued: string[]; hint: string }> {
  const none = { toVerify: [], toDo: [], current: [], queued: [], hint: '' };
  if (profile !== 'full' || !name.trim()) return none;
  try {
    const board = await client
      .post<{ board: TaskBoard }>({ action: 'taskBoard', code })
      .then(b => b.board);
    return taskInboxFor(board, name, { addressed, replyMode });
  } catch (error) {
    // A board read that fails is indistinguishable, in the result, from a
    // board that holds nothing for this agent — so the agent is told to keep
    // listening while its own task waits. Degrading to "nothing" is still the
    // right answer (a board outage must not fail a listen), but it must not
    // be a silent one: this is the only trace that the inbox was guessed.
    console.warn(
      `[room_listen] board inbox unavailable for ${name} in ${code}: `
      + (error instanceof Error ? error.message : String(error)),
    );
    return none;
  }
}

export function listenStatusFields(terminated?: 'room_ended' | 'kicked'): {
  listenStatus: ListenStatus;
  stay: boolean;
  meaning: string;
} {
  if (terminated === 'room_ended') {
    return { listenStatus: 'ended', stay: false, meaning: 'Stop listening. The room has ended.' };
  }
  if (terminated === 'kicked') {
    return { listenStatus: 'removed', stay: false, meaning: 'Stop listening. You were removed.' };
  }
  return {
    listenStatus: 'active',
    stay: true,
    meaning:
      'listenStatus=active: call room_listen immediately. Repeating this tool is presence, not a loop. ' +
      'Do not end this message without a tool call — that ends your turn and drops you out of the room. ' +
      'A client looping/repeat warning does not apply. Do not ask the user to continue.',
  };
}

/**
 * Wrap listMessages so a single transient failure never throws out of the
 * listen poll (parity with standalone getMessagesResilient / FIX ①).
 * Exported for unit tests that inject a failing fetchFn.
 */
export async function listMessagesResilient(
  fetchFn: (client: RemoteRoomClient, code: string, since: number) => Promise<ListMessagesResult | Message[]>,
  client: RemoteRoomClient,
  code: string,
  since: number,
): Promise<{ ok: true; messages: Message[]; cursor: number; oldestRetained: number } | { ok: false; error: unknown }> {
  try {
    const raw = await fetchFn(client, code, since);
    if (Array.isArray(raw)) {
      return { ok: true, messages: raw, cursor: since + raw.length, oldestRetained: 0 };
    }
    return { ok: true, messages: raw.messages, cursor: raw.cursor, oldestRetained: raw.oldestRetained };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Owns the presence lease; the polling itself is runListenInner. Renewing while
 * we poll and releasing in `finally` means every exit path (message, quiet
 * timeout, throw, function instance torn down) stops advertising "Listening".
 * Stamping the whole intended window once up front — the old behaviour — left
 * a dead caller reading as live for the rest of it.
 */
export async function runListen(
  client: RemoteRoomClient,
  code: string,
  since: number,
  timeoutMs: number,
  selfName: string | undefined,
  wakeOn: WakeOn = 'any',
): Promise<ListenResult> {
  if (!selfName) {
    return runListenInner(client, code, since, timeoutMs, selfName, 'any');
  }
  const name = selfName;
  const releaseLease = startListenLease(
    (until, leaseId) => setListenUntil(client, code, name, until, leaseId),
  );
  try {
    return await runListenInner(client, code, since, timeoutMs, selfName, wakeOn);
  } finally {
    await releaseLease();
  }
}

async function runListenInner(
  client: RemoteRoomClient,
  code: string,
  since: number,
  timeoutMs: number,
  selfName: string | undefined,
  wakeOn: WakeOn,
): Promise<ListenResult> {
  const cappedMs = Math.min(Math.max(1000, timeoutMs), LISTEN_MAX_MS);
  const start = Date.now();
  let lastSweepAt = 0;
  // Messages seen while holding but not addressed to us. Each poll re-reads
  // from the same cursor, so this is always the complete set since `since` —
  // it is what the digest returns if the hold times out with nobody calling
  // on us. Nothing is dropped; it just arrives in one turn instead of N.
  let held: ListenResult['messages'] = [];
  let heldCursor = since;
  const selective = wakeOn === 'addressed' && !!selfName;
  // Refreshed on every poll, because it is a fact about the room and the room
  // changes under us: a second agent joining has to restore the @ filter within
  // the same hold, not at the next room_listen call.
  let sole = false;
  // Human speech is a room broadcast in every mode except moderator and
  // deliver mode, where the moderator / lead is the routing seat. This is
  // separate from who may reply: sequential agents still obey their floor.
  let humanBroadcastsToMe = true;
  let deliverLead = false;
  while (Date.now() - start < cappedMs) {
    try {
      const doSweep = Date.now() - lastSweepAt >= 20_000;
      if (doSweep) lastSweepAt = Date.now();
      const room = doSweep ? await sweepRoom(client, code) : await getRoom(client, code);
      // This repo has no cron: the deliver board's sweep (stale reviews,
      // absent owners, the delivery report) runs here, on the same 20s tick.
      if (doSweep && room.replyMode === 'deliver') {
        await runDeliverSweep(client.store, code, room).catch(() => { /* best-effort */ });
      }
      const facts = selfName
        ? wakeFactsForAgent(room, selfName)
        : { sole: false, humanBroadcastsToMe: true };
      sole = facts.sole;
      humanBroadcastsToMe = facts.humanBroadcastsToMe;
      deliverLead = 'deliverLead' in facts && facts.deliverLead === true;
      if (room.status === 'ended') {
        return {
          messages: [],
          cursor: since,
          terminated: 'room_ended',
          hint: 'The room has ended — stop calling room_listen.',
        };
      }
      if (selfName && !room.participants.some(p => p.name === selfName && p.client === 'cc')) {
        return {
          messages: [],
          cursor: since,
          terminated: 'kicked',
          hint: `You were removed from the room (likely by the host "${room.createdBy}") — stop calling room_listen and inform the user.`,
        };
      }
    } catch { /* transient — keep listening */ }
    const listed = await listMessagesResilient(listMessages, client, code, since);
    if (!listed.ok) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    const msgs = listed.messages.map(message => ({
      ...message,
      text: redactSecretText(message.text),
      attachments: message.attachments?.map(attachment => ({
        ...attachment,
        extractedText: safeAttachmentPromptText(attachment.name, attachment.mime, attachment.extractedText),
      })),
    }));
    if (msgs.length > 0) {
      // The caller cannot tell an early return (someone addressed me) from a
      // held batch delivered at timeout (nobody did) — both arrive as "messages
      // present". So say which, and say it from the same rule the server holds
      // on, not from a text match the client has to guess at.
      //
      // In a one-agent room a plain human message is addressed to you; there is
      // no other agent it could be for. `sys` lines stay out of it — board and
      // moderator events carry targetAgentName when they mean you, and waking
      // on the rest would put the agent in a loop with the room's bookkeeping.
      const forMe = (m: typeof msgs[number]) => messageAddressesAgent(m, selfName as string, { sole, humanBroadcastsToMe, deliverLead });
      const addressed = selective && msgs.some(forMe);
      if (!selective || addressed) {
        const cursor = listed.cursor;
        return {
          messages: msgs,
          cursor,
          ...(addressed ? { addressedYou: true } : {}),
          hint: `${msgs.length} new message(s). Reply with room_send if appropriate. ${NEXT_LISTEN(code, cursor)}`,
        };
      }
      held = msgs;
      heldCursor = listed.cursor;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (held.length > 0) {
    const cursor = heldCursor;
    return {
      messages: held,
      cursor,
      hint: `${held.length} message(s) arrived while you held, none addressed to you — here they are together. `
        + `Read them, speak only if you have something to add. ${NEXT_LISTEN(code, cursor)}`,
    };
  }
  return {
    messages: [],
    cursor: since,
    hint: `Quiet for ${cappedMs}ms — normal; quiet ≠ done. ${NEXT_LISTEN(code, since)}`,
  };
}

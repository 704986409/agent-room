// The seam between the MCP tool surface and room storage.
//
// The hosted deployment puts an HTTP server in this position: its MCP tools
// POST to `/api/room`, and that server owns auth, billing and the ledger on
// top of the room write. This repo has no such server — the web app talks to
// Upstash directly from the browser (`apps/web/src/screens/CreateMeeting.tsx`,
// `Join.tsx`, `hooks/useRoom.ts` all import `@agent-room/upstash-client`) —
// so an HTTP indirection here would be a layer with nothing in it.
//
// So this file implements the SAME eleven functions against
// `@agent-room/upstash-client` directly. `_mcpTools.ts` is written against
// this module's signatures, never against HTTP, which is what lets the tool
// surface be shared between the two deployments unchanged.
//
// ERROR TRANSLATION IS PART OF THE CONTRACT. `_mcpTools.ts` catches
// `RemoteRoomApiError` and turns known `code` values into the guidance an
// agent acts on — "you are muted, wait via room_listen" rather than a stack
// trace. upstash-client throws its own classes, so every call below is wrapped
// and re-thrown with the matching code. Miss one and the agent gets a raw
// error where it expected an instruction, which is exactly the kind of result
// that makes a model stop calling tools.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateCode, hasActiveListenLease } from '@agent-room/shared';
import type { Message, Participant, Room, RoomReport } from '@agent-room/shared';
import {
  createClient,
  createRoom as storeCreateRoom,
  createRoomReport as storeCreateRoomReport,
  endRoom as storeEndRoom,
  getRoom as storeGetRoom,
  joinRoom as storeJoinRoom,
  listMessages as storeListMessages,
  appendSystemMessage as storeAppendSystemMessage,
  getMessageTotalCount,
  sweepTimeouts,
  appendMessage as storeAppendMessage,
  reactivateRoom as storeReactivateRoom,
  removeParticipant as storeRemoveParticipant,
  casRoom as storeCasRoom,
  setListenUntil as storeSetListenUntil,
  verifyHostKey,
  HostNameTakenError,
  MutedError,
  NotHostError,
  NotYourTurnError,
  RoomNotFoundError,
  getTaskBoard,
  claimTask,
  submitTask,
  reassignTaskRoles,
  registerRoomWebhook,
  listRoomWebhooks,
  unregisterRoomWebhook,
  WebhookLimitError,
  NotParticipantError,
  TaskVerifyFollowUpError,
  TaskVerifyReasonError,
  setReplyMode,
  getTurnState,
  setTurnState,
  addHostDirected,
  skipQueueHead,
  cancelRoomTask,
  onDeliverHostMessage,
  createRoomTask,
  deliverClaimProblem,
  DeliverRuleError,
  reopenTask,
  verifyRoomTask,
  VerifyNoteRequiredError,
} from '@agent-room/upstash-client';
import type { UpstashClient } from '@agent-room/upstash-client';
import { dispatchRoomWebhooks, validateWebhookUrl } from './_webhookDispatch.js';

/** Same shape the hosted deployment's client throws, so the tool layer's
 *  error handling is identical on both. */
export class RemoteRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RemoteRoomApiError';
  }
}

export interface RemoteRoomClient {
  readonly store: UpstashClient;
  /**
   * The rest of the room API, as an action envelope.
   *
   * The eleven named functions below cover the room lifecycle, but the task
   * board, webhook and moderator-admin tools in `_mcpTools.ts` reach past them
   * and post an `{ action }` payload directly. That is the hosted deployment's
   * HTTP body; here it is dispatched onto upstash-client instead. Every action
   * the tool layer sends must be handled — an unknown one throws rather than
   * returning a plausible empty result, because a task board that silently
   * does nothing is worse than one that fails loudly.
   */
  post<T>(payload: Record<string, unknown>): Promise<T>;
}

export function createRemoteRoomClient(_requestHost: string | undefined): RemoteRoomClient {
  // Env names match the web app's, so a self-hoster configures one pair of
  // credentials and both surfaces work.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.VITE_UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.VITE_UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RemoteRoomApiError(
      'Room storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the deployment.',
      500,
      'not_configured',
    );
  }
  const store = createClient({ url, token });
  return { store, post: (payload) => dispatchAction(store, payload) as never };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const agent = (name: unknown) => ({ name: str(name), client: 'cc' as const });

/** The `{ action }` envelope, mapped onto upstash-client. */
async function dispatchAction(store: UpstashClient, p: Record<string, unknown>): Promise<unknown> {
  const code = str(p.code);
  try {
    switch (p.action) {
      // ── task board ──────────────────────────────────────────────────────
      case 'taskBoard':
        return { board: (await getTaskBoard(store, code)) ?? { code, tasks: [], version: 0 } };
      case 'taskCreate':
        // Deliver rooms check the roles and file the task under the lead's
        // plan (announcing a newly opened one); other modes create as before.
        return await createRoomTask(store, code, await storeGetRoom(store, code), {
          title: str(p.title),
          createdBy: str(p.requesterName),
          ...(p.id ? { id: str(p.id) } : {}),
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
          ...(p.dod ? { dod: str(p.dod) } : {}),
        });
      case 'taskClaim': {
        const room = await storeGetRoom(store, code);
        if (room.replyMode === 'deliver') {
          const problem = deliverClaimProblem(await getTaskBoard(store, code), str(p.id));
          if (problem) throw new RemoteRoomApiError(problem, 409, 'plan_not_started');
        }
        return await claimTask(store, code, str(p.id), agent(p.name));
      }
      case 'taskSubmit':
        return await submitTask(
          store, code, str(p.id), agent(p.name),
          p.evidence as Parameters<typeof submitTask>[4],
        );
      case 'taskVerify':
        return await verifyRoomTask(
          store, code, await storeGetRoom(store, code), str(p.id), agent(p.name),
          p.verdict === 'done' ? 'done' : 'rejected',
          typeof p.note === 'string' ? p.note : undefined,
          Date.now(),
          p.followUp as Parameters<typeof verifyRoomTask>[8],
        );
      case 'taskReassign':
        return await reassignTaskRoles(store, code, str(p.id), {
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
        }, agent(p.requesterName));
      case 'taskCancel':
        return await cancelRoomTask(
          store, code, await storeGetRoom(store, code), str(p.id), agent(p.requesterName),
          typeof p.reason === 'string' ? p.reason : undefined,
        );
      case 'taskReopen': {
        const state = p.state === 'in_progress' || p.state === 'awaiting_review' || p.state === 'blocked' ? p.state : 'todo';
        return await reopenTask(store, code, str(p.id), state);
      }

      // ── resident webhooks ───────────────────────────────────────────────
      case 'webhookSet': {
        // upstash-client's registerRoomWebhook accepts any string. That is
        // harmless while nothing in this repo calls it, but the moment a
        // webhook is registrable over an open HTTP endpoint, an unvalidated
        // URL is an SSRF: an agent holding a room code could point the room at
        // `http://169.254.169.254/...` and have the server POST chat content
        // to it. The check has to happen before the write, not at delivery.
        const check = validateWebhookUrl(str(p.url));
        if (!check.ok) {
          throw new RemoteRoomApiError(`Refusing that webhook URL: ${check.reason}`, 400, 'bad_request');
        }
        const webhook = await registerRoomWebhook(store, code, {
          url: str(p.url),
          registeredBy: str(p.requesterName),
          ...(typeof p.secret === 'string' && p.secret ? { secret: p.secret } : {}),
        });
        return { webhook };
      }
      case 'webhookList':
        return { webhooks: await listRoomWebhooks(store, code) };
      case 'webhookDelete':
        // Deliberate parity gap, documented rather than papered over: the
        // hosted server checks the requester before unregistering, this
        // repo's unregisterRoomWebhook takes no requester at all. Registering
        // already requires being a participant, so the exposure is "one
        // participant can drop another's webhook in a room they are both in",
        // not "anyone with the code can". Left as-is instead of inventing a
        // check the web app does not apply either.
        return { removed: await unregisterRoomWebhook(store, code, str(p.id)) };

      // ── host / moderator controls ───────────────────────────────────────
      case 'setReplyMode': {
        await assertHostFor(store, code, p.hostKey as string | undefined);
        const room = await setReplyMode(
          store, code, str(p.requesterName),
          p.mode as Parameters<typeof setReplyMode>[3],
          p.config as Parameters<typeof setReplyMode>[4],
        );
        return { room };
      }
      case 'directInvoke': {
        await assertHostFor(store, code, p.hostKey as string | undefined);
        const target = p.target as { name?: string } | undefined;
        const source = p.source === 'moderator' ? 'moderator' : 'host';
        const state = await getTurnState(store, code);
        const next = addHostDirected(state ?? { queue: [], startedAt: Date.now() } as never, str(target?.name), 'cc', source);
        await setTurnState(store, code, next);
        return { added: true };
      }
      case 'skipCurrent': {
        await assertHostFor(store, code, p.hostKey as string | undefined);
        const state = await getTurnState(store, code);
        if (!state) return { skipped: null };
        const next = skipQueueHead(state);
        await setTurnState(store, code, next);
        return { skipped: next.currentName ?? null };
      }

      default:
        throw new RemoteRoomApiError(
          `Unsupported room action "${String(p.action)}" on this deployment.`,
          400,
          'unsupported_action',
        );
    }
  } catch (e) {
    if (e instanceof WebhookLimitError) throw new RemoteRoomApiError(e.message, 409, 'WebhookLimitError');
    if (e instanceof NotParticipantError) throw new RemoteRoomApiError(e.message, 403, 'NotParticipantError');
    return translate(e);
  }
}

function notHostError(room: Room): RemoteRoomApiError {
  return new RemoteRoomApiError(
    `Only the host (${room.createdBy}) can do this. Pass the hostKey you got from room_create.`,
    403,
    'NotHostError',
  );
}

async function requireHostKey(
  store: UpstashClient,
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await storeGetRoom(store, code);

  if (!hostKey) {
    throw notHostError(room);
  }

  try {
    await verifyHostKey(store, code, hostKey);
  } catch (error) {
    if (error instanceof HostNameTakenError) {
      throw notHostError(room);
    }
    throw error;
  }
}

/** Shared by the admin actions; requesterName is display data, not auth. */
async function assertHostFor(
  store: UpstashClient,
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  await requireHostKey(store, code, hostKey);
}

/**
 * Map a storage-layer throw onto the code the tool layer knows how to explain.
 * Anything unrecognised is rethrown untouched — inventing a code for an error
 * we do not understand would hand the agent confident, wrong guidance.
 */
function translate(e: unknown): never {
  if (e instanceof RemoteRoomApiError) throw e;
  if (e instanceof DeliverRuleError) throw new RemoteRoomApiError(e.message, 400, 'bad_request');
  if (e instanceof VerifyNoteRequiredError) throw new RemoteRoomApiError(e.message, 400, 'VerifyNoteRequiredError');
  if (e instanceof MutedError) throw new RemoteRoomApiError(e.message, 403, 'MutedError');
  // appendMessage throws this for a sender with no seat. Same 403 as a mute —
  // both mean "not your seat", and a 404 would leak whether the code exists.
  if (e instanceof NotParticipantError) throw new RemoteRoomApiError(e.message, 403, 'NotParticipantError');
  if (e instanceof NotYourTurnError) throw new RemoteRoomApiError(e.message, 409, 'NotYourTurnError');
  if (e instanceof NotHostError) throw new RemoteRoomApiError(e.message, 403, 'NotHostError');
  if (e instanceof HostNameTakenError) throw new RemoteRoomApiError(e.message, 409, 'HostNameTakenError');
  if (e instanceof RoomNotFoundError) throw new RemoteRoomApiError(e.message, 404, 'RoomNotFoundError');
  if (e instanceof TaskVerifyFollowUpError) throw new RemoteRoomApiError(e.message, 400, 'bad_request');
  if (e instanceof TaskVerifyReasonError) throw new RemoteRoomApiError(e.message, 400, 'bad_request');
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return translate(e);
  }
}

export async function createRoom(
  client: RemoteRoomClient,
  input: { topic: string; createdBy: string },
): Promise<Room & { hostKey: string }> {
  // Codes are generated here rather than by the caller, matching the hosted
  // server. A collision is a 1-in-many-millions event, but retrying twice is
  // cheaper than explaining to a user why their room code was already taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      return await storeCreateRoom(client.store, { code, topic: input.topic, createdBy: input.createdBy });
    } catch (e) {
      lastError = e;
    }
  }
  return translate(lastError);
}

export async function getRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

export async function sweepRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);

    // Advance timeout/fallback state without emitting timeout system messages.
    await sweepTimeouts(client.store, code, room);

    return storeGetRoom(client.store, code);
  });
}

export async function joinRoom(
  client: RemoteRoomClient,
  code: string,
  participant: Participant,
  options: {
    hostKey?: string;
    seatKey?: string;
    personaId?: string;
    priorIdentity?: { name: string; client: 'web' | 'cc' };
  } = {},
): Promise<Room & { participant: Participant; seatKey?: string }> {
  return guarded(async () => {
    const current = await storeGetRoom(client.store, code);
    const isHostClaim = participant.name.trim().toLowerCase() === current.createdBy.trim().toLowerCase();
    if (isHostClaim) {
      await verifyHostKey(client.store, code, options.hostKey);
    }

    let previous = current.participants.find(p => p.name === participant.name && p.client === participant.client);
    let validResume = Boolean(previous?.seatKeyHash && options.seatKey
      && seatKeyMatches(previous.seatKeyHash, options.seatKey));
    // A seatKey may also resume a same-persona seat whose name differs from the request.
    if (!validResume && options.seatKey && !isHostClaim) {
      const keyed = current.participants.find(p => p.client === participant.client && p.seatKeyHash
        && seatKeyMatches(p.seatKeyHash, options.seatKey!));
      if (keyed) { previous = keyed; validResume = true; }
    }
    let reclaimed = false;
    if (!validResume && !isHostClaim && options.personaId !== undefined && options.personaId.trim()) {
      // Same Persona rejoining without a valid seatKey: never open a "(2)" seat.
      const samePersona = current.participants.filter(p => p.client === participant.client
        && p.seatKeyHash && p.memoryIdentityType === 'persona' && p.memoryPersonaId === options.personaId);
      if (samePersona.some(p => isMemorySeatOnline(p))) {
        throw new RemoteRoomApiError(
          'This Persona already holds an online seat in this room. Reconnect with that seat\'s seatKey; an online seat is never evicted.',
          409,
          'SEAT_IN_USE',
        );
      }
      const target = samePersona.find(p => p.name === participant.name) ?? samePersona[0];
      if (target) { previous = target; reclaimed = true; }
    }
    if (validResume && options.personaId !== undefined
      && options.personaId !== previous?.memoryPersonaId) {
      throw new RemoteRoomApiError('The seat identity cannot be changed during resume.', 403, 'seat_identity_mismatch');
    }

    const roomInstanceId = current.roomInstanceId ?? randomUUID();
    const seatKey = randomBytes(32).toString('base64url');
    const personaId = validResume ? previous?.memoryPersonaId : options.personaId;
    if (personaId !== undefined && (!personaId.trim() || [...personaId].length > 128)) {
      throw new RemoteRoomApiError('Invalid Persona ID.', 400, 'invalid_persona_id');
    }
    const identityType = personaId
      ? 'persona'
      : isHostClaim ? 'room_owner' : 'room_member';
    const principalId = identityType === 'room_owner' ? roomInstanceId : validResume
      ? previous?.memoryPrincipalId ?? randomUUID()
      : randomUUID();
    const boundParticipant: Participant = {
      ...participant,
      ...((validResume || reclaimed) && previous ? { name: previous.name } : {}),
      seatKeyHash: hashSeatKey(seatKey),
      memoryIdentityType: identityType,
      memoryPrincipalId: principalId,
      ...(personaId ? { memoryPersonaId: personaId } : {}),
      ...(identityType === 'room_owner' ? { memoryIsRoomOwner: true } : {}),
    };

    const result = await storeJoinRoom(client.store, code, boundParticipant, {
      ...(options.hostKey ? { hostKey: options.hostKey } : {}),
      priorIdentity: validResume || reclaimed
        ? { name: previous!.name, client: previous!.client }
        : previous && !previous.seatKeyHash
          ? { name: previous.name, client: previous.client }
          : options.priorIdentity,
    });
    let finalRoom: Room = result;
    if (personaId && identityType === 'persona') {
      finalRoom = await removeOrphanPersonaSeats(client, code, personaId, result.participant.name, participant.client);
    }
    return { ...finalRoom, participant: result.participant, seatKey, ...(reclaimed ? { reclaimed: true } : {}) } as
      Room & { participant: Participant; seatKey: string };
  });
}

/** Seconds a memory seat may be silent before it counts as offline (a live listen lease always counts as online). */
export const MEMORY_SEAT_STALE_MS = 120_000;

export function isMemorySeatOnline(participant: Participant, now: number = Date.now()): boolean {
  if (hasActiveListenLease(participant, now)) return true;
  return typeof participant.lastSeenAt === 'number' && Number.isFinite(participant.lastSeenAt)
    && now - participant.lastSeenAt <= MEMORY_SEAT_STALE_MS;
}

/** Drop other OFFLINE seats bound to the same Persona (orphans from earlier key-less joins). Online seats are kept. */
async function removeOrphanPersonaSeats(
  client: RemoteRoomClient,
  code: string,
  personaId: string,
  keepName: string,
  seatClient: Participant['client'],
): Promise<Room> {
  const now = Date.now();
  const isOrphan = (p: Participant) => p.client === seatClient && p.name !== keepName
    && p.memoryIdentityType === 'persona' && p.memoryPersonaId === personaId && !isMemorySeatOnline(p, now);
  const current = await storeGetRoom(client.store, code);
  if (!current.participants.some(isOrphan)) return current;
  return storeCasRoom(client.store, code, room => ({
    ...room,
    participants: room.participants.filter(p => !isOrphan(p)),
  }));
}

function hashSeatKey(seatKey: string): string {
  return createHash('sha256').update(seatKey, 'utf8').digest('hex');
}

function seatKeyMatches(storedHash: string, seatKey: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(storedHash) || typeof seatKey !== 'string' || !seatKey) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashSeatKey(seatKey), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function listMessages(client: RemoteRoomClient, code: string, since: number): Promise<Message[]> {
  return guarded(() => storeListMessages(client.store, code, since));
}

export async function getMessagesWithTotal(
  client: RemoteRoomClient,
  code: string,
  since: number,
): Promise<{ messages: Message[]; total: number | null }> {
  return guarded(async () => {
    const messages = await storeListMessages(client.store, code, since);
    const total = await getMessageTotalCount(client.store, code);
    return { messages, total };
  });
}

export async function getCurrentTurnState(
  client: RemoteRoomClient,
  code: string,
) {
  return guarded(() => getTurnState(client.store, code));
}

export async function appendMessage(
  client: RemoteRoomClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<unknown> {
  const result = await guarded(() => storeAppendMessage(client.store, code, message, kind));
  await fanOutAppended(client, code, message, (result as { cursor?: number } | null)?.cursor ?? null);
  return result;
}

// Fan out to resident webhooks. The hosted server does this from its send
// path; storage does not do it for us, so without this a registered webhook
// would be a row in Redis that never fires — a tool that appears to work and
// silently does nothing, which is worse than one that refuses.
//
// Best-effort and never fatal: a subscriber's broken endpoint must not turn
// a delivered message into a failed room_send.
async function fanOutAppended(
  client: RemoteRoomClient,
  code: string,
  message: Message,
  cursor: number | null,
): Promise<void> {
  try {
    const room = await storeGetRoom(client.store, code);
    await dispatchRoomWebhooks(client.store, room, message, cursor);
    // Deliver: the host's message is either the go for a waiting plan or a
    // goal the lead should plan for. The web client does the same after its
    // own sends; this covers a host speaking through MCP.
    if (room.replyMode === 'deliver' && message.name === room.createdBy) {
      await onDeliverHostMessage(client.store, code, room, message.text ?? '');
    }
  } catch { /* delivery is not the sender's problem */ }
}

/**
 * A server-originated room event (`type: 'sys'`, synthetic sender).
 *
 * Bypasses the speaker/mute/turn gates the way appendSystemMessage does — the
 * server is not a participant and must not consume anyone's turn — but still
 * fans out to webhooks like appendMessage, because an event nobody is woken by
 * is not an event. No hostKey: the caller here is our own code, not a request.
 */
export async function appendRoomEvent(
  client: RemoteRoomClient,
  code: string,
  message: Message,
): Promise<void> {
  await guarded(() => storeAppendSystemMessage(client.store, code, message));
  await fanOutAppended(client, code, message, null);
}

export async function appendSystemMessage(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
  message: Message,
): Promise<void> {
  await guarded(async () => {
    await assertHost(client, code, hostKey);
    await storeAppendSystemMessage(client.store, code, message);
  });
}

export async function setListenUntil(
  client: RemoteRoomClient,
  code: string,
  name: string,
  until: number | null,
  leaseId?: string,
): Promise<void> {
  await guarded(async () => {
    await storeSetListenUntil(client.store, code, name, until, leaseId);
  });
}

export async function removeParticipant(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc' = 'cc',
  hostKey?: string,
): Promise<Room> {
  return guarded(async () => {
    const isSelfRemoval = requesterName === targetName;

    if (!isSelfRemoval) {
      await requireHostKey(client.store, code, hostKey);
    }

    return storeRemoveParticipant(client.store, code, requesterName, targetName, targetClient);
  });
}

/**
 * Ending and reviving are host-only, and the check lives HERE.
 *
 * upstash-client's endRoom/reactivateRoom take no requester at all — in this
 * repo the browser is trusted, because the person clicking already holds the
 * host key in their own session. An MCP caller is not that: the room code
 * alone reaches this endpoint, so without a check any agent that knows a code
 * could end someone else's meeting. The hosted server does this check in
 * `api/room.ts`; with no server here it has to be done at this seam.
 */
async function assertHost(
  client: RemoteRoomClient,
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  await requireHostKey(client.store, code, hostKey);
}

export async function endRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, hostKey);
    return storeEndRoom(client.store, code);
  });
}

export async function reactivateRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, hostKey);
    return storeReactivateRoom(client.store, code);
  });
}

export async function createRoomReport(client: RemoteRoomClient, code: string): Promise<RoomReport> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);
    const messages = await storeListMessages(client.store, code, 0);
    return storeCreateRoomReport(client.store, room, messages);
  });
}

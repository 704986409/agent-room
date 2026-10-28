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
import { invalidateRemovedSeats, invalidateSeatKeyRotation } from './_wakeHooks.js';
import { newSeatId } from './_wakeBind.js';
import { installWakeSendHook } from './_wakeSend.js';
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
  type ListMessagesResult,
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
  submitRoomTask,
  reassignRoomTaskRoles,
  registerRoomWebhook,
  listRoomWebhooks,
  toPublicRoomWebhook,
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
import {
  AGENT_INVITE_MESSAGES,
  AgentInviteError,
  claimAgentInvite,
  createAgentInvite as storeCreateAgentInvite,
  lookupAgentInvite,
  markAgentInviteUsed,
  releaseAgentInvite,
  type AgentInviteRecord,
} from './_agentInvite.js';

/** Same shape the hosted deployment's client throws, so the tool layer's
 *  error handling is identical on both. */
export class RemoteRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RemoteRoomApiError';
  }
}

/**
 * Recoverable refusal when this Persona is already online and the caller did not
 * present a seatKey or machineId. Static text only — never interpolate a live seatKey.
 * The managed CLI already has the key in its first-run prompt and AGENT_ROOM_SEAT_KEY.
 */
export const ALREADY_JOINED_HINT = [
  '该身份的席位已在线（例如本机托管 / HostLocal 已经加入）。不要向用户索要邀请码，也不要只用邀请码再调用 room_join。',
  '请用首次启动说明里的 managed.seatKey，或环境变量 AGENT_ROOM_SEAT_KEY，调用 room_listen；如果首次说明或环境变量 AGENT_ROOM_CURSOR 里有 cursor，一并传入。',
  '如果仍要调用 room_join，必须带上同一个 seatKey 恢复座位。座位在线时不要做新的仅邀请码加入。',
  'This Persona seat is already online (HostLocal / the desktop daemon already joined). Do not ask the user for an invite code. Call room_listen with the seatKey from your first-run instructions or AGENT_ROOM_SEAT_KEY.',
].join('');

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
  installWakeSendHook(store);
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
      case 'taskSubmit': {
        const submitted = await submitRoomTask(
          store, code, str(p.id), agent(p.name),
          p.evidence as Parameters<typeof submitRoomTask>[4],
        );
        return submitted;
      }
      case 'taskVerify':
        return await verifyRoomTask(
          store, code, await storeGetRoom(store, code), str(p.id), agent(p.name),
          p.verdict === 'done' ? 'done' : 'rejected',
          typeof p.note === 'string' ? p.note : undefined,
          Date.now(),
          p.followUp as Parameters<typeof verifyRoomTask>[8],
        );
      case 'taskReassign': {
        const reassigned = await reassignRoomTaskRoles(store, code, await storeGetRoom(store, code), str(p.id), {
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
        }, agent(p.requesterName));
        return reassigned;
      }
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
        // A display name is not a seat. seatKey has to match the stored hash
        // before a webhook can be registered, or anyone with the room code
        // can attach a URL to someone else's seat (R11).
        await assertWebhookSeat(store, code, str(p.requesterName), str(p.seatKey));
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
        return { webhook: toPublicRoomWebhook(webhook) };
      }
      case 'webhookList':
        return { webhooks: (await listRoomWebhooks(store, code)).map(toPublicRoomWebhook) };
      case 'webhookDelete':
        await assertWebhookSeat(store, code, str(p.requesterName), str(p.seatKey));
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
  if (e instanceof AgentInviteError) throw new RemoteRoomApiError(e.message, e.status, e.code);
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

/** What a spent agent invite contributes to the join response. */
export interface JoinedAgentInvite {
  role: string;
  personaId?: string;
  roleProfile?: string;
}

export async function joinRoom(
  client: RemoteRoomClient,
  code: string,
  participant: Participant,
  options: {
    hostKey?: string;
    seatKey?: string;
    /** Stable id of the joining computer. Only its hash is stored. Same machine may reclaim its seat. */
    machineId?: string;
    personaId?: string;
    /** Agent's current chat session ID; scopes the one-time Memory Brief. */
    sessionId?: string;
    /** One-time agent invite code from the host's '+' dialog (MCP room_join). */
    inviteCode?: string;
    /**
     * MCP room_join sets this: a NEW agent ('cc') seat needs a valid invite code.
     * A seatKey resume, an offline same-Persona reclaim and the host's own seat do not.
     */
    requireAgentInvite?: boolean;
    priorIdentity?: { name: string; client: 'web' | 'cc' };
  } = {},
): Promise<Room & { participant: Participant; seatKey?: string; agentInvite?: JoinedAgentInvite }> {
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
    // Agent invite: on a non-resume, non-host agent join, a valid code fixes role + Persona
    // (invite values win over what the agent sent) before the same-Persona reclaim check.
    let invite: { hash: string; record: AgentInviteRecord } | undefined;
    let inviteFailure: 'invite_code_invalid' | 'invite_code_expired' | undefined;
    if (!validResume && !isHostClaim && participant.client === 'cc'
      && typeof options.inviteCode === 'string' && options.inviteCode.trim()) {
      const lookup = await lookupAgentInvite(client.store, current, options.inviteCode);
      if (lookup.ok) {
        invite = { hash: lookup.hash, record: lookup.record };
        options = { ...options, personaId: lookup.record.personaId };
        participant = { ...participant, role: lookup.record.role };
      } else {
        inviteFailure = lookup.reason;
      }
    }
    const machineHash = hashMachineId(options.machineId);
    let reclaimed = false;
    // Same computer, same seat: a reconnect that lost its seatKey still replaces
    // the stale session. A different computer does not — that stays SEAT_IN_USE.
    // No machineId (the managed CLI calling room_join again) is already_joined:
    // the daemon already holds the seatKey, and we must not strand the user on an invite.
    if (!validResume && !isHostClaim && machineHash) {
      const owned = current.participants.find(p => p.client === participant.client
        && !!p.seatKeyHash && hashesMatch(p.machineIdHash, machineHash)
        && ((options.personaId !== undefined && options.personaId.trim() !== '' && p.memoryPersonaId === options.personaId)
          || p.name === participant.name));
      if (owned) { previous = owned; reclaimed = true; }
    }
    if (!validResume && !reclaimed && !isHostClaim && options.personaId !== undefined && options.personaId.trim()) {
      // Same Persona rejoining without a valid seatKey: never open a "(2)" seat.
      const samePersona = current.participants.filter(p => p.client === participant.client
        && p.seatKeyHash && p.memoryIdentityType === 'persona' && p.memoryPersonaId === options.personaId);
      if (samePersona.some(p => isMemorySeatOnline(p))) {
        refuseHeldOnlineSeat(options.requireAgentInvite, machineHash);
      }
      const target = samePersona.find(p => p.name === participant.name) ?? samePersona[0];
      if (target) { previous = target; reclaimed = true; }
    }
    if (validResume && options.personaId !== undefined
      && options.personaId !== previous?.memoryPersonaId) {
      throw new RemoteRoomApiError('The seat identity cannot be changed during resume.', 403, 'seat_identity_mismatch');
    }
    // A brand-new agent seat (no resume, no reclaim, not the host) must spend a valid invite.
    const needsInvite = Boolean(options.requireAgentInvite) && participant.client === 'cc'
      && !validResume && !reclaimed && !isHostClaim;
    let claimedInvite: { hash: string; record: AgentInviteRecord } | undefined;
    if (needsInvite) {
      if (!invite) {
        const reason = inviteFailure ?? 'invite_code_required';
        // Codex's first call is role-only (no personaId, no invite) while HostLocal
        // already put that persona online. Say so instead of demanding a code.
        if (reason === 'invite_code_required'
          && onlinePersonaSeatHeld(current.participants, participant, options.personaId)) {
          refuseHeldOnlineSeat(true, machineHash);
        }
        throw new RemoteRoomApiError(AGENT_INVITE_MESSAGES[reason], 403, reason);
      }
      if (!(await claimAgentInvite(client.store, code, invite.hash))) {
        throw new RemoteRoomApiError(AGENT_INVITE_MESSAGES.invite_code_invalid, 403, 'invite_code_invalid');
      }
      claimedInvite = invite;
    } else if (options.requireAgentInvite && invite && reclaimed) {
      // Reclaiming an offline same-Persona seat needs no code, but a valid one that was sent is
      // still spent so its role profile reaches the agent (and refreshes its Persona memory).
      if (await claimAgentInvite(client.store, code, invite.hash)) claimedInvite = invite;
    }

    const roomInstanceId = current.roomInstanceId ?? randomUUID();
    const seatKey = randomBytes(32).toString('base64url');
    const personaId = validResume || (reclaimed && (options.personaId === undefined || !options.personaId.trim()))
      ? previous?.memoryPersonaId
      : options.personaId;
    if (personaId !== undefined && (!personaId.trim() || [...personaId].length > 128)) {
      throw new RemoteRoomApiError('Invalid Persona ID.', 400, 'invalid_persona_id');
    }
    const sessionId = options.sessionId === undefined ? undefined : options.sessionId.trim();
    if (sessionId !== undefined && (!sessionId || [...sessionId].length > 256
      || /[\u0000-\u001f\u007f]/.test(sessionId))) {
      throw new RemoteRoomApiError('Invalid session ID.', 400, 'invalid_session_id');
    }
    const identityType = personaId
      ? 'persona'
      : isHostClaim ? 'room_owner' : 'room_member';
    const principalId = identityType === 'room_owner' ? roomInstanceId : validResume
      ? previous?.memoryPrincipalId ?? randomUUID()
      : randomUUID();
    // A resumed or reclaimed seat keeps its seatId across seatKey rotation.
    // Legacy rows without one are assigned here; register backfills anything still missing.
    const continuing = Boolean(previous && (validResume || reclaimed || !previous.seatKeyHash));
    const seatId = continuing && previous?.seatId ? previous.seatId : newSeatId();
    const boundParticipant: Participant = {
      ...participant,
      ...((validResume || reclaimed) && previous ? { name: previous.name } : {}),
      seatId,
      seatKeyHash: hashSeatKey(seatKey),
      ...(machineHash
        ? { machineIdHash: machineHash }
        : previous?.machineIdHash ? { machineIdHash: previous.machineIdHash } : {}),
      memoryIdentityType: identityType,
      memoryPrincipalId: principalId,
      ...(personaId ? { memoryPersonaId: personaId } : {}),
      // Only the sessionId sent on this join counts; a join without one gets a Brief every time.
      ...(sessionId ? { memorySessionId: sessionId } : {}),
      ...(identityType === 'room_owner' ? { memoryIsRoomOwner: true } : {}),
    };

    let result: Awaited<ReturnType<typeof storeJoinRoom>>;
    try {
      result = await storeJoinRoom(client.store, code, boundParticipant, {
        ...(options.hostKey ? { hostKey: options.hostKey } : {}),
        priorIdentity: validResume || reclaimed
          ? { name: previous!.name, client: previous!.client }
          : previous && !previous.seatKeyHash
            ? { name: previous.name, client: previous.client }
            : options.priorIdentity,
      });
    } catch (error) {
      // The join did not happen: give the invite back so the agent can retry with it.
      if (claimedInvite) await releaseAgentInvite(client.store, code, claimedInvite.hash).catch(() => {});
      throw error;
    }
    if (claimedInvite) {
      await markAgentInviteUsed(client.store, code, claimedInvite.hash, claimedInvite.record, result.participant.name)
        .catch(() => {});
    }
    let finalRoom: Room = result;
    if (personaId && identityType === 'persona') {
      finalRoom = await removeOrphanPersonaSeats(client, code, personaId, result.participant.name, participant.client);
    }
    if (previous?.seatId && previous.seatId === seatId) {
      await invalidateSeatKeyRotation(client.store, previous.seatId);
    }
    await invalidateRemovedSeats(client.store, current, finalRoom, 'seat_removed');
    // The invite this join spent: room_join hands its role profile to the agent and saves it as Persona memory.
    const agentInvite: JoinedAgentInvite | undefined = claimedInvite ? {
      role: claimedInvite.record.role,
      personaId: claimedInvite.record.personaId,
      ...(claimedInvite.record.roleProfile ? { roleProfile: claimedInvite.record.roleProfile } : {}),
    } : undefined;
    return {
      ...finalRoom, participant: result.participant, seatKey,
      ...(reclaimed ? { reclaimed: true } : {}),
      ...(agentInvite ? { agentInvite } : {}),
    } as Room & { participant: Participant; seatKey: string; agentInvite?: JoinedAgentInvite };
  });
}

/** Host-only: mint a one-time agent invite (5-minute validity) bound to this room + role/Persona. */
export async function createAgentInvite(
  client: RemoteRoomClient,
  code: string,
  input: { hostKey?: string; role: unknown; roleProfile?: unknown },
): Promise<Awaited<ReturnType<typeof storeCreateAgentInvite>>> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);
    return storeCreateAgentInvite(client.store, room, input);
  });
}

function identityText(value: string | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

/**
 * An online cc persona seat whose stored personaId or role equals the requested
 * personaId or role. Empty strings never match. Does not read seatKey material.
 */
function onlinePersonaSeatHeld(
  participants: Participant[],
  participant: Participant,
  personaId: string | undefined,
): boolean {
  const wanted = new Set<string>();
  const requestedPersona = identityText(personaId);
  const requestedRole = identityText(participant.role);
  if (requestedPersona) wanted.add(requestedPersona);
  if (requestedRole) wanted.add(requestedRole);
  if (wanted.size === 0) return false;
  return participants.some(p => {
    if (p.client !== 'cc' || !p.seatKeyHash || p.memoryIdentityType !== 'persona') return false;
    if (!isMemorySeatOnline(p)) return false;
    const persona = identityText(p.memoryPersonaId);
    const role = identityText(p.role);
    return (persona !== undefined && wanted.has(persona)) || (role !== undefined && wanted.has(role));
  });
}

/**
 * Online persona, caller cannot resume or reclaim.
 * MCP without a machineId → already_joined (do not ask for an invite).
 * A presented machineId that did not match, and non-MCP joins, stay SEAT_IN_USE.
 */
function refuseHeldOnlineSeat(requireAgentInvite: boolean | undefined, machineHash: string | undefined): never {
  if (requireAgentInvite && !machineHash) {
    throw new RemoteRoomApiError(ALREADY_JOINED_HINT, 409, 'already_joined');
  }
  throw new RemoteRoomApiError(
    'This Persona already holds an online seat in this room. Reconnect with that seat\'s seatKey; an online seat is never evicted.',
    409,
    'SEAT_IN_USE',
  );
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

/** Undefined when missing or not a stable id. Callers treat that as "no machine claim". */
function hashMachineId(machineId: string | undefined): string | undefined {
  if (typeof machineId !== 'string') return undefined;
  const id = machineId.trim();
  if (id.length < 8 || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) return undefined;
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function hashesMatch(stored: string | undefined, incoming: string | undefined): boolean {
  if (!stored || !incoming || !/^[0-9a-f]{64}$/i.test(stored) || !/^[0-9a-f]{64}$/i.test(incoming)) return false;
  const expected = Buffer.from(stored, 'hex');
  const actual = Buffer.from(incoming, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function seatKeyMatches(storedHash: string, seatKey: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(storedHash) || typeof seatKey !== 'string' || !seatKey) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashSeatKey(seatKey), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function assertWebhookSeat(
  store: UpstashClient,
  code: string,
  name: string,
  seatKey: string,
): Promise<void> {
  if (!name || !seatKey) {
    throw new RemoteRoomApiError('webhookSet and webhookDelete require seatKey and the participant name.', 400, 'bad_request');
  }
  const room = await storeGetRoom(store, code);
  const matched = room.participants.some(participant =>
    participant.name === name && !!participant.seatKeyHash && seatKeyMatches(participant.seatKeyHash, seatKey));
  if (!matched) {
    throw new RemoteRoomApiError('seatKey does not match that participant.', 403, 'seat_key_invalid');
  }
}

export type { ListMessagesResult };

export async function listMessages(client: RemoteRoomClient, code: string, since: number): Promise<ListMessagesResult> {
  return guarded(() => storeListMessages(client.store, code, since));
}

export async function getMessagesWithTotal(
  client: RemoteRoomClient,
  code: string,
  since: number,
): Promise<{ messages: Message[]; total: number | null }> {
  return guarded(async () => {
    const listed = await storeListMessages(client.store, code, since);
    const messages = Array.isArray(listed) ? listed : listed.messages;
    const total = await getMessageTotalCount(client.store, code);
    const cursor = total ?? (Array.isArray(listed) ? (since + messages.length) : listed.cursor);
    return { messages, total: cursor };
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

    const before = await storeGetRoom(client.store, code);
    const removed = await storeRemoveParticipant(client.store, code, requesterName, targetName, targetClient);
    await invalidateRemovedSeats(client.store, before, removed, 'seat_removed');
    return removed;
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
    const before = await storeGetRoom(client.store, code);
    const ended = await storeEndRoom(client.store, code);
    await invalidateRemovedSeats(client.store, before, { ...ended, participants: [] }, 'room_ended');
    return ended;
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
    const { messages } = await storeListMessages(client.store, code, 0);
    return storeCreateRoomReport(client.store, room, messages);
  });
}

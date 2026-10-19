// Browser writes. Identity comes from the account session or the room guest
// cookie. Callers cannot pick someone else's name, and system messages are
// produced only on the paths below.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateCode, isValidCode, type Message, type MessageMetadata, type ReplyMode, type ReplyModeConfig, type SystemEventType } from '@agent-room/shared';
import {
  appendMessage,
  appendSystemMessage,
  blockTask,
  cancelTask,
  createRoom,
  createRoomReport,
  createRoomTask,
  directInvoke,
  endRoom,
  getRoom,
  hostSkipCurrent,
  joinRoom,
  listMessages,
  NotParticipantError,
  onDeliverHostMessage,
  reactivateRoom,
  reassignRoomTaskRoles,
  removeParticipant,
  runDeliverSweep,
  setMuted,
  setReplyMode,
  startDeliverPlanAndWake,
  updatePresence,
  updateTask,
  verifyHostClaim,
  verifyTask,
  MutedError,
  NotHostError,
} from '@agent-room/upstash-client';
import { AccountError, touchSession } from './_accounts.js';
import { colorForName, initialsFor } from './_mcpIdentity.js';
import { GUEST_COOKIE, SESSION_COOKIE, guestCookie, jsonBody, readCookie, requireUser, sendAccountError, sendJson } from './_httpAuth.js';
import { serverRedis } from './_redisEnv.js';
import {
  assertCanChat,
  assertOwner,
  consumeInvite,
  createInvite,
  findMemberByName,
  inviteUnusable,
  isRoomMember,
  isRoomOwner,
  issueGuest,
  loadRoomActor,
  readInvite,
  rememberMember,
  removeMember,
  revokeGuestByName,
  revokeInvite,
  type RoomActor,
} from './_roomAccess.js';
import type { Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function sendFailure(res: VercelResponse, error: unknown): void {
  if (error instanceof AccountError) {
    sendAccountError(res, error);
    return;
  }
  if (error instanceof NotParticipantError || error instanceof MutedError || error instanceof NotHostError) {
    sendJson(res, 403, { error: error.name, message: error.message });
    return;
  }
  if (error instanceof Error && error.name.endsWith('Error')) {
    sendJson(res, 400, { error: error.name, message: error.message });
    return;
  }
  console.error('[web-write] request failed', error instanceof Error ? error.name : 'Error');
  sendJson(res, 500, { error: 'internal_server_error', message: 'Request failed.' });
}

async function actorFor(req: VercelRequest, code: string) {
  return loadRoomActor(serverRedis(), code, readCookie(req, SESSION_COOKIE), readCookie(req, GUEST_COOKIE));
}

function webSeat(name: string, role: string) {
  const now = Date.now();
  return {
    name,
    role,
    color: colorForName(name),
    initials: initialsFor(name),
    client: 'web' as const,
    joinedAt: now,
    lastSeenAt: now,
  };
}

async function ensureWebSeat(redis: UpstashClient, room: Room, actor: RoomActor, role = ''): Promise<string> {
  const joined = await joinRoom(redis, room.code, webSeat(actor.displayName, role), {
    authedUserId: actor.user?.id,
    priorIdentity: { name: actor.displayName, client: 'web' },
  });
  return joined.participant.name;
}

export async function roomCreateHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const auth = await requireUser(req);
    const body = jsonBody(req);
    const topic = str(body.topic).trim();
    const displayName = str(body.displayName).trim() || auth.user.username;
    const role = str(body.role).trim();
    if (!topic) throw new AccountError('A topic is required.', 400, 'bad_request');
    const requested = str(body.code).trim();
    const code = requested && isValidCode(requested) ? requested : generateCode();
    const redis = auth.redis;
    const created = await createRoom(redis, {
      code,
      topic,
      createdBy: displayName,
      ownerId: auth.user.id,
      ownerUserId: auth.user.id,
      ownerName: auth.user.username,
    });
    await verifyHostClaim(redis, code, { authedUserId: auth.user.id });
    const joined = await joinRoom(redis, code, webSeat(displayName, role), {
      authedUserId: auth.user.id,
      priorIdentity: { name: displayName, client: 'web' },
    });
    await rememberMember(redis, created, auth.user.id, joined.participant.name);
    sendJson(res, 201, { code, topic: created.topic, name: joined.participant.name, role, hostKey: created.hostKey });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function joinHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const code = str(jsonBody(req).code);
    const { room, actor } = await actorFor(req, code);
    const role = str(jsonBody(req).role);
    const name = await ensureWebSeat(serverRedis(), room, actor, role);
    sendJson(res, 200, { code: room.code, name, role: actor.role });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function whoamiHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const code = str(req.query.code);
    const { actor } = await actorFor(req, code);
    sendJson(res, 200, { code, name: actor.displayName, role: actor.role, userId: actor.user?.id ?? null });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function chatSendHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertCanChat(actor);
    const text = str(body.text);
    const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : Date.now();
    const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
    const message: Message = {
      id,
      type: 'msg',
      name: actor.displayName,
      role: str(body.role),
      initials: initialsFor(actor.displayName),
      color: colorForName(actor.displayName),
      client: 'web',
      text,
      time: Date.now(),
      ...(attachments ? { attachments: attachments as Message['attachments'] } : {}),
    };
    const redis = serverRedis();
    await ensureWebSeat(redis, room, actor, str(body.role));
    await appendMessage(redis, room.code, message);
    if (actor.role === 'owner' && room.replyMode === 'deliver') {
      await onDeliverHostMessage(redis, room.code, room, text);
    }
    sendJson(res, 200, { message });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function presenceHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const { room, actor } = await actorFor(req, str(jsonBody(req).code));
    assertCanChat(actor);
    const redis = serverRedis();
    await ensureWebSeat(redis, room, actor);
    await updatePresence(redis, room.code, actor.displayName, Date.now());
    if (actor.session && actor.sessionHash) await touchSession(redis, actor.sessionHash, actor.session);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function typingHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertCanChat(actor);
    const redis = serverRedis();
    const key = `room-typing:${room.code}`;
    if (body.active === false) {
      await redis.command(['DEL', key]);
    } else {
      await redis.command(['SET', key, JSON.stringify({ name: actor.displayName, until: Date.now() + 5000 }), 'EX', 5]);
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function taskHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertOwner(actor);
    const redis = serverRedis();
    const op = str(body.op);
    const id = str(body.id);
    const by = { name: actor.displayName, client: 'web' as const };
    if (op === 'create') {
      const result = await createRoomTask(redis, room.code, room, {
        title: str(body.title),
        createdBy: actor.displayName,
        ...(str(body.owner) ? { owner: str(body.owner), ownerClient: body.ownerClient === 'cc' ? 'cc' : 'web' } : {}),
        ...(str(body.verifier) ? { verifier: str(body.verifier), verifierClient: body.verifierClient === 'cc' ? 'cc' : 'web' } : {}),
        ...(str(body.dod) ? { dod: str(body.dod) } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (op === 'verify') {
      const followUp = body.followUp && typeof body.followUp === 'object' ? body.followUp as { target: string; request: string; targetClient?: 'web' | 'cc' } : undefined;
      const result = await verifyTask(
        redis, room.code, id, by,
        body.verdict === 'rejected' ? 'rejected' : 'done',
        str(body.note) || undefined,
        Date.now(),
        followUp,
      );
      sendJson(res, 200, result);
      return;
    }
    if (op === 'reopen') {
      sendJson(res, 200, await updateTask(redis, room.code, id, { state: 'todo' }));
      return;
    }
    if (op === 'block') {
      sendJson(res, 200, await blockTask(redis, room.code, id, by, str(body.reason)));
      return;
    }
    if (op === 'cancel') {
      sendJson(res, 200, await cancelTask(redis, room.code, id, by, str(body.reason) || undefined));
      return;
    }
    if (op === 'reassign') {
      const patch = body.patch && typeof body.patch === 'object' ? body.patch as { owner?: string; ownerClient?: 'web' | 'cc'; verifier?: string; verifierClient?: 'web' | 'cc' } : {};
      sendJson(res, 200, await reassignRoomTaskRoles(redis, room.code, room, id, patch, by));
      return;
    }
    throw new AccountError('Unknown task operation.', 400, 'bad_request');
  } catch (error) {
    sendFailure(res, error);
  }
}

async function systemNote(
  redis: UpstashClient,
  room: Room,
  text: string,
  eventType: SystemEventType,
  target: { name: string; client: 'web' | 'cc' },
  extra: Partial<MessageMetadata> = {},
): Promise<void> {
  const now = Date.now();
  await appendSystemMessage(redis, room.code, {
    id: now,
    type: 'sys',
    name: 'system',
    role: '',
    initials: 'AR',
    color: '#5B6AFF',
    client: 'cc',
    text,
    time: now,
    metadata: {
      eventType,
      modeAtSend: room.replyMode,
      targetAgentName: target.name,
      targetAgentClient: target.client,
      ...extra,
    },
  });
}

export async function hostHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertOwner(actor);
    const redis = serverRedis();
    const op = str(body.op);
    if (op === 'mute') {
      const roomNext = await setMuted(redis, room.code, actor.displayName, str(body.name), body.client === 'cc' ? 'cc' : 'web', body.muted !== false);
      sendJson(res, 200, { room: roomNext });
      return;
    }
    if (op === 'remove') {
      const name = str(body.name);
      const client = body.client === 'cc' ? 'cc' : 'web';
      const roomNext = await removeParticipant(redis, room.code, actor.displayName, name, client);
      if (client === 'web') {
        await revokeGuestByName(redis, room, name);
        const member = await findMemberByName(redis, room, name);
        if (member && !isRoomOwner(room, member.userId)) await removeMember(redis, room, member.userId);
      }
      sendJson(res, 200, { room: roomNext });
      return;
    }
    if (op === 'end') {
      sendJson(res, 200, { room: await endRoom(redis, room.code) });
      return;
    }
    if (op === 'reactivate') {
      sendJson(res, 200, { room: await reactivateRoom(redis, room.code) });
      return;
    }
    if (op === 'set-mode') {
      const mode = str(body.mode) as ReplyMode;
      const config = body.config && typeof body.config === 'object' ? body.config as ReplyModeConfig : undefined;
      sendJson(res, 200, { room: await setReplyMode(redis, room.code, actor.displayName, mode, config) });
      return;
    }
    if (op === 'direct-invoke') {
      const target = { name: str(body.name), client: 'cc' as const };
      const added = await directInvoke(redis, room.code, target, 'host');
      if (added) {
        await systemNote(redis, room, `Host directly invoked @${target.name}.`, 'host_invoked', target, { invocationType: 'host_directed' });
      }
      sendJson(res, 200, { added });
      return;
    }
    if (op === 'skip') {
      const skipped = await hostSkipCurrent(redis, room.code, room);
      if (skipped) {
        await systemNote(
          redis, room,
          `Host skipped @${skipped.name}'s ${skipped.role} slot.`,
          'skipped_by_host',
          { name: skipped.name, client: skipped.client },
          { roleAtSend: skipped.role, skippedBy: 'host' },
        );
      }
      sendJson(res, 200, { skipped });
      return;
    }
    if (op === 'report') {
      const messages = await listMessages(redis, room.code, 0);
      sendJson(res, 200, { report: await createRoomReport(redis, room, messages) });
      return;
    }
    if (op === 'seat-agent') {
      const name = str(body.name).trim();
      const role = str(body.role);
      if (!name) throw new AccountError('A name is required.', 400, 'bad_request');
      const now = Date.now();
      const joined = await joinRoom(redis, room.code, {
        name, role, color: colorForName(name), initials: initialsFor(name), client: 'cc', joinedAt: now, lastSeenAt: now,
      }, { priorIdentity: { name, client: 'cc' } });
      sendJson(res, 200, { name: joined.participant.name });
      return;
    }
    if (op === 'scripted-send') {
      const name = str(body.name);
      const seated = room.participants.find(p => p.name === name && p.client === 'cc' && !p.seatKeyHash);
      if (!seated) throw new AccountError('That scripted seat is not in the room.', 403, 'forbidden');
      const now = Date.now();
      const message: Message = {
        id: typeof body.id === 'number' ? body.id : now,
        type: 'msg',
        name: seated.name,
        role: seated.role,
        initials: seated.initials,
        color: seated.color,
        client: 'cc',
        text: str(body.text),
        time: now,
      };
      await appendMessage(redis, room.code, message);
      sendJson(res, 200, { message });
      return;
    }
    throw new AccountError('Unknown host operation.', 400, 'bad_request');
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function deliverHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertOwner(actor);
    const redis = serverRedis();
    if (str(body.op) === 'start') {
      sendJson(res, 200, await startDeliverPlanAndWake(redis, room.code, room.createdBy));
      return;
    }
    if (str(body.op) === 'sweep') {
      await runDeliverSweep(redis, room.code, room);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new AccountError('Unknown deliver operation.', 400, 'bad_request');
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function inviteCreateHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertOwner(actor);
    const expiresInMs = typeof body.expiresInMs === 'number' && body.expiresInMs > 0 ? body.expiresInMs : undefined;
    const maxUses = typeof body.maxUses === 'number' && body.maxUses > 0 ? Math.floor(body.maxUses) : undefined;
    const created = await createInvite(serverRedis(), room, actor.user!.id, {
      ...(expiresInMs ? { expiresAt: Date.now() + expiresInMs } : {}),
      ...(maxUses ? { maxUses } : {}),
    });
    sendJson(res, 201, {
      token: created.token,
      inviteId: created.id,
      expiresAt: created.invite.expiresAt ?? null,
      maxUses: created.invite.maxUses ?? null,
    });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function inviteRevokeHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const { room, actor } = await actorFor(req, str(body.code));
    assertOwner(actor);
    const inviteId = str(body.inviteId);
    const raw = await serverRedis().command<string | null>(['GET', `invite:${inviteId}`]);
    if (!raw) throw new AccountError('Invite not found.', 404, 'invite_not_found');
    const invite = JSON.parse(raw) as { roomCode: string };
    if (invite.roomCode !== room.code) throw new AccountError('Invite not found.', 404, 'invite_not_found');
    await revokeInvite(serverRedis(), inviteId, { revokeGuests: body.revokeGuests === true });
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendFailure(res, error);
  }
}

export async function inviteAcceptHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
  try {
    const body = jsonBody(req);
    const token = str(body.token);
    const redis = serverRedis();
    const found = await readInvite(redis, token);
    if (!found) throw new AccountError('Invite not found.', 404, 'invite_not_found');
    const problem = inviteUnusable(found.invite);
    if (problem) throw new AccountError(`Invite is ${problem}.`, 403, `invite_${problem}`);
    const room = await getRoom(redis, found.invite.roomCode);
    let auth: Awaited<ReturnType<typeof requireUser>> | null = null;
    try { auth = await requireUser(req, redis); } catch (error) {
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
    }
    if (auth) {
      const owner = isRoomOwner(room, auth.user.id);
      if (!owner && namesEqual(auth.user.username, room.createdBy)) {
        throw new AccountError('That name is reserved for the room owner.', 403, 'forbidden');
      }
      const already = owner || await isRoomMember(redis, room, auth.user.id);
      if (!already) await consumeInvite(redis, found.id, found.invite);
      const name = owner ? room.createdBy : auth.user.username;
      if (!isRoomOwner(room, auth.user.id)) await rememberMember(redis, room, auth.user.id, name);
      if (owner) await verifyHostClaim(redis, room.code, { authedUserId: auth.user.id });
      const joined = await joinRoom(redis, room.code, webSeat(name, ''), {
        authedUserId: auth.user.id,
        priorIdentity: { name, client: 'web' },
      });
      sendJson(res, 200, { code: room.code, name: joined.participant.name, role: owner ? 'owner' : 'member' });
      return;
    }
    const displayName = str(body.displayName).trim();
    if (!displayName) throw new AccountError('A display name is required.', 400, 'bad_request');
    if (namesEqual(displayName, room.createdBy)) {
      throw new AccountError('That name is reserved for the room owner.', 403, 'forbidden');
    }
    await consumeInvite(redis, found.id, found.invite);
    const guest = await issueGuest(redis, found.id, found.invite, displayName);
    const joined = await joinRoom(redis, room.code, webSeat(displayName, ''), {
      priorIdentity: { name: displayName, client: 'web' },
    });
    if (joined.participant.name !== displayName) {
      await redis.command(['SET', `guest-by-room:${found.invite.roomInstanceId}:${joined.participant.name}`, guest.id]);
    }
    res.setHeader('Set-Cookie', guestCookie(guest.token));
    sendJson(res, 200, { code: room.code, name: joined.participant.name, role: 'guest' });
  } catch (error) {
    sendFailure(res, error);
  }
}

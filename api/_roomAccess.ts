// Room access option B: the signed-in creator owns the room, other accounts
// join through an invite, and people without an account get a one-day guest
// token scoped to that room.

import type { Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';
import { getRoom } from '@agent-room/upstash-client';
import { AccountError, hashToken, newToken, readSession, type SessionRecord, type UserRecord } from './_accounts.js';

export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_COOKIE = 'ar_guest';

export type RoomRole = 'owner' | 'member' | 'guest';

export interface RoomActor {
  role: RoomRole;
  roomCode: string;
  roomInstanceId: string;
  displayName: string;
  user?: UserRecord;
  guestId?: string;
  /** Present for an account session. Callers that should slide expiry use this; reads must not. */
  sessionHash?: string;
  session?: SessionRecord;
}

export interface InviteRecord {
  roomInstanceId: string;
  roomCode: string;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  maxUses?: number;
  uses: number;
  revoked: boolean;
}

export interface GuestRecord {
  roomInstanceId: string;
  roomCode: string;
  displayName: string;
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface MemberRecord {
  userId: string;
  name: string;
  joinedAt: number;
}

function instanceOf(room: Room): string {
  return room.roomInstanceId || room.code;
}

function inviteKey(hash: string): string { return `invite:${hash}`; }
function guestKey(hash: string): string { return `guest:${hash}`; }
function membersKey(instanceId: string): string { return `room-members:${instanceId}`; }
function memberKey(instanceId: string, userId: string): string { return `room-member:${instanceId}:${userId}`; }

async function readJson<T>(client: UpstashClient, key: string): Promise<T | null> {
  const raw = await client.command<string | null>(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function isRoomOwner(room: Room, userId: string | undefined): boolean {
  if (!userId) return false;
  return room.ownerUserId === userId || room.ownerId === userId;
}

export async function rememberMember(
  client: UpstashClient,
  room: Room,
  userId: string,
  name: string,
  now = Date.now(),
): Promise<void> {
  const instanceId = instanceOf(room);
  await client.command(['SADD', membersKey(instanceId), userId]);
  const record: MemberRecord = { userId, name, joinedAt: now };
  await client.command(['SET', memberKey(instanceId, userId), JSON.stringify(record)]);
}

export async function memberName(client: UpstashClient, room: Room, userId: string): Promise<string | null> {
  const record = await readJson<MemberRecord>(client, memberKey(instanceOf(room), userId));
  return record?.name ?? null;
}

export async function isRoomMember(client: UpstashClient, room: Room, userId: string): Promise<boolean> {
  const hit = await client.command<number>(['SISMEMBER', membersKey(instanceOf(room)), userId]);
  return Number(hit) === 1;
}

export async function removeMember(client: UpstashClient, room: Room, userId: string): Promise<void> {
  const instanceId = instanceOf(room);
  await client.command(['SREM', membersKey(instanceId), userId]);
  await client.command(['DEL', memberKey(instanceId, userId)]);
}

export async function findMemberByName(client: UpstashClient, room: Room, name: string): Promise<MemberRecord | null> {
  const ids = await client.command<string[]>(['SMEMBERS', membersKey(instanceOf(room))]);
  for (const id of ids ?? []) {
    const record = await readJson<MemberRecord>(client, memberKey(instanceOf(room), id));
    if (record?.name === name) return record;
  }
  return null;
}

export async function createInvite(
  client: UpstashClient,
  room: Room,
  createdBy: string,
  options: { expiresAt?: number; maxUses?: number } = {},
  now = Date.now(),
): Promise<{ token: string; id: string; invite: InviteRecord }> {
  const token = newToken();
  const id = hashToken(token);
  const invite: InviteRecord = {
    roomInstanceId: instanceOf(room),
    roomCode: room.code,
    createdBy,
    createdAt: now,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.maxUses ? { maxUses: options.maxUses } : {}),
    uses: 0,
    revoked: false,
  };
  await client.command(['SET', inviteKey(id), JSON.stringify(invite)]);
  await client.command(['SADD', `room-invites:${invite.roomInstanceId}`, id]);
  return { token, id, invite };
}

export async function readInvite(client: UpstashClient, token: string): Promise<{ id: string; invite: InviteRecord } | null> {
  if (!token) return null;
  const id = hashToken(token);
  const invite = await readJson<InviteRecord>(client, inviteKey(id));
  if (!invite) return null;
  return { id, invite };
}

export function inviteUnusable(invite: InviteRecord, now = Date.now()): 'revoked' | 'expired' | 'exhausted' | null {
  if (invite.revoked) return 'revoked';
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) return 'expired';
  if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) return 'exhausted';
  return null;
}

async function saveInvite(client: UpstashClient, id: string, invite: InviteRecord): Promise<void> {
  await client.command(['SET', inviteKey(id), JSON.stringify(invite)]);
}

export async function consumeInvite(client: UpstashClient, id: string, invite: InviteRecord, now = Date.now()): Promise<InviteRecord> {
  const problem = inviteUnusable(invite, now);
  if (problem) throw new AccountError(`Invite is ${problem}.`, 403, `invite_${problem}`);
  const next = { ...invite, uses: invite.uses + 1 };
  await saveInvite(client, id, next);
  return next;
}

export async function revokeInvite(
  client: UpstashClient,
  id: string,
  options: { revokeGuests?: boolean } = {},
): Promise<void> {
  const invite = await readJson<InviteRecord>(client, inviteKey(id));
  if (!invite) throw new AccountError('Invite not found.', 404, 'invite_not_found');
  invite.revoked = true;
  await saveInvite(client, id, invite);
  if (options.revokeGuests) {
    const hashes = await client.command<string[]>(['SMEMBERS', `invite-guests:${id}`]);
    for (const hash of hashes ?? []) await revokeGuest(client, hash);
  }
}

export async function issueGuest(
  client: UpstashClient,
  inviteId: string,
  invite: InviteRecord,
  displayName: string,
  now = Date.now(),
): Promise<{ token: string; id: string; guest: GuestRecord }> {
  const token = newToken();
  const id = hashToken(token);
  const guest: GuestRecord = {
    roomInstanceId: invite.roomInstanceId,
    roomCode: invite.roomCode,
    displayName,
    inviteId,
    createdAt: now,
    expiresAt: now + GUEST_TTL_MS,
    revoked: false,
  };
  await client.command(['SET', guestKey(id), JSON.stringify(guest), 'EX', Math.ceil(GUEST_TTL_MS / 1000)]);
  await client.command(['SADD', `invite-guests:${inviteId}`, id]);
  await client.command(['SET', `guest-by-room:${invite.roomInstanceId}:${displayName}`, id]);
  return { token, id, guest };
}

export async function readGuest(client: UpstashClient, token: string, now = Date.now()): Promise<{ id: string; guest: GuestRecord } | null> {
  if (!token) return null;
  const id = hashToken(token);
  const guest = await readJson<GuestRecord>(client, guestKey(id));
  if (!guest || guest.revoked || guest.expiresAt <= now) return null;
  return { id, guest };
}

export async function revokeGuest(client: UpstashClient, guestId: string): Promise<void> {
  const guest = await readJson<GuestRecord>(client, guestKey(guestId));
  if (!guest) return;
  guest.revoked = true;
  await client.command(['SET', guestKey(guestId), JSON.stringify(guest)]);
  await client.command(['DEL', `guest-by-room:${guest.roomInstanceId}:${guest.displayName}`]);
}

export async function revokeGuestByName(client: UpstashClient, room: Room, name: string): Promise<boolean> {
  const id = await client.command<string | null>(['GET', `guest-by-room:${instanceOf(room)}:${name}`]);
  if (!id) return false;
  await revokeGuest(client, id);
  return true;
}

export async function resolveRoomActor(
  client: UpstashClient,
  room: Room,
  sessionToken: string,
  guestToken: string,
  now = Date.now(),
): Promise<RoomActor> {
  const instanceId = instanceOf(room);
  const session = sessionToken ? await readSession(client, sessionToken, now) : null;
  if (session && isRoomOwner(room, session.user.id)) {
    return {
      role: 'owner', roomCode: room.code, roomInstanceId: instanceId, displayName: room.createdBy,
      user: session.user, sessionHash: session.hash, session: session.session,
    };
  }
  if (session && await isRoomMember(client, room, session.user.id)) {
    const name = await memberName(client, room, session.user.id) ?? session.user.username;
    return {
      role: 'member', roomCode: room.code, roomInstanceId: instanceId, displayName: name,
      user: session.user, sessionHash: session.hash, session: session.session,
    };
  }
  const guest = await readGuest(client, guestToken, now);
  if (guest && guest.guest.roomCode === room.code && guest.guest.roomInstanceId === instanceId) {
    return {
      role: 'guest',
      roomCode: room.code,
      roomInstanceId: instanceId,
      displayName: guest.guest.displayName,
      guestId: guest.id,
    };
  }
  throw new AccountError('Authentication required.', 401, 'unauthenticated');
}

export async function loadRoomActor(
  client: UpstashClient,
  code: string,
  sessionToken: string,
  guestToken: string,
): Promise<{ room: Room; actor: RoomActor }> {
  if (!sessionToken && !guestToken) {
    throw new AccountError('Authentication required.', 401, 'unauthenticated');
  }
  let room: Room;
  try {
    room = await getRoom(client, code);
  } catch {
    throw new AccountError('Room not found.', 404, 'room_not_found');
  }
  const actor = await resolveRoomActor(client, room, sessionToken, guestToken);
  return { room, actor };
}

export function assertOwner(actor: RoomActor): void {
  if (actor.role !== 'owner') throw new AccountError('Only the room owner can do that.', 403, 'forbidden');
}

export function assertCanChat(actor: RoomActor): void {
  if (actor.role !== 'owner' && actor.role !== 'member' && actor.role !== 'guest') {
    throw new AccountError('Only the room owner can do that.', 403, 'forbidden');
  }
}

/** Read-proxy check. Does not slide the account session. */
export async function canReadRoom(
  client: UpstashClient,
  code: string,
  sessionToken: string,
  guestToken: string,
): Promise<boolean> {
  try {
    await loadRoomActor(client, code, sessionToken, guestToken);
    return true;
  } catch {
    return false;
  }
}

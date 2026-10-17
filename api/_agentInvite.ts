// One-time agent invite codes.
//
// The host generates a code in the web room ('+' dialog → POST /api/room
// action "createAgentInvite"). A NEW agent seat joining through MCP room_join
// must present an unused, unexpired code; the code fixes the seat's role and
// Persona (profession = Persona identity) and is spent by the join.
// Reconnects with a seatKey, an offline same-Persona seat reclaim, and the
// host's own seat do not need a code.
//
// Storage (same Redis store as rooms): only the SHA-256 of the code is kept,
//   room:<CODE>:agent-invite:<sha256>  JSON AgentInviteRecord
// The record lives for AGENT_INVITE_RETENTION_SECONDS so an expired code can
// still be told apart from a wrong one (invite_code_expired vs
// invite_code_invalid); the code itself is only usable for
// AGENT_INVITE_TTL_MS after creation. Spending it is an atomic SET NX on
//   room:<CODE>:agent-invite-used:<sha256>
// so two joins racing on one code cannot both win.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Room } from '@agent-room/shared';
import type { UpstashClient } from '@agent-room/upstash-client';

/** A code is usable for 5 minutes after it is generated. */
export const AGENT_INVITE_TTL_MS = 5 * 60 * 1000;
/** How long the record (and the used marker) stay readable, to report "expired" precisely. */
export const AGENT_INVITE_RETENTION_SECONDS = 24 * 60 * 60;
export const AGENT_INVITE_ROLE_MAX_CHARS = 128;

export interface AgentInviteRecord {
  code: string;
  roomInstanceId?: string;
  role: string;
  personaId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  usedAt?: number;
  usedBy?: string;
}

export type AgentInviteLookup =
  | { ok: true; hash: string; record: AgentInviteRecord }
  | { ok: false; reason: 'invite_code_invalid' | 'invite_code_expired' };

/** Thrown by the room client; kept free of the room client to avoid an import cycle. */
export class AgentInviteError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'AgentInviteError';
  }
}

export const AGENT_INVITE_MESSAGES = {
  invite_code_required: '新智能体加入房间需要一次性邀请码：请让房主在网页房间点击「+」生成邀请码，然后用 room_join 传入 inviteCode 重试。已有座位重连请传入原来的 seatKey。',
  invite_code_invalid: '邀请码无效或已被使用（每个邀请码只能用一次）：请核对后重试，或让房主在网页房间点击「+」重新生成。',
  invite_code_expired: '邀请码已过期（有效期 5 分钟）：请让房主在网页房间点击「+」重新生成邀请码后再用 room_join 加入。',
} as const;

function hashInviteCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function inviteKey(roomCode: string, hash: string): string {
  return `room:${roomCode}:agent-invite:${hash}`;
}

function usedKey(roomCode: string, hash: string): string {
  return `room:${roomCode}:agent-invite-used:${hash}`;
}

function hostKeyMatches(room: Room, hostKey: string): boolean {
  if (!room.hostKeyHash || !/^[0-9a-f]{64}$/i.test(room.hostKeyHash)) return false;
  const expected = Buffer.from(room.hostKeyHash, 'hex');
  const actual = createHash('sha256').update(hostKey, 'utf8').digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Role doubles as personaId: trimmed, 1–128 chars, no control characters. */
export function normalizeInviteRole(role: unknown): string {
  const value = typeof role === 'string' ? role.trim() : '';
  if (!value || [...value].length > AGENT_INVITE_ROLE_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AgentInviteError('Role must be 1–128 characters with no control characters.', 400, 'invalid_role');
  }
  return value;
}

/** Host-only: the room must carry a hostKeyHash and the presented hostKey must match it. */
export async function createAgentInvite(
  store: UpstashClient,
  room: Room,
  input: { hostKey?: string; role: unknown; now?: number },
): Promise<{ inviteCode: string; role: string; personaId: string; createdAt: number; expiresAt: number; ttlSeconds: number }> {
  if (typeof input.hostKey !== 'string' || !input.hostKey.trim() || input.hostKey.length > 256
    || !hostKeyMatches(room, input.hostKey)) {
    throw new AgentInviteError('Only the host (with the hostKey from room creation) can create agent invites.', 403, 'NotHostError');
  }
  if (room.status !== 'active') {
    throw new AgentInviteError('This room has ended; reactivate it before inviting agents.', 409, 'room_ended');
  }
  const role = normalizeInviteRole(input.role);
  const now = input.now ?? Date.now();
  // 16 random chars from an unambiguous alphabet, grouped for reading aloud/copying.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const raw = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  const inviteCode = `AI-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  const record: AgentInviteRecord = {
    code: room.code,
    ...(room.roomInstanceId ? { roomInstanceId: room.roomInstanceId } : {}),
    role,
    personaId: role,
    createdAt: now,
    expiresAt: now + AGENT_INVITE_TTL_MS,
    used: false,
  };
  await store.command(['SET', inviteKey(room.code, hashInviteCode(inviteCode)), JSON.stringify(record),
    'EX', AGENT_INVITE_RETENTION_SECONDS]);
  return {
    inviteCode, role, personaId: role, createdAt: record.createdAt, expiresAt: record.expiresAt,
    ttlSeconds: Math.round(AGENT_INVITE_TTL_MS / 1000),
  };
}

/** Read-only check: exists for this room (and room instance), unused, unexpired. */
export async function lookupAgentInvite(
  store: UpstashClient,
  room: Room,
  inviteCode: string,
  now = Date.now(),
): Promise<AgentInviteLookup> {
  const code = inviteCode.trim().toUpperCase();
  if (!code || code.length > 64) return { ok: false, reason: 'invite_code_invalid' };
  const hash = hashInviteCode(code);
  const [stored, used] = await store.pipeline<string | null>([
    ['GET', inviteKey(room.code, hash)],
    ['GET', usedKey(room.code, hash)],
  ]);
  if (!stored) return { ok: false, reason: 'invite_code_invalid' };
  let record: AgentInviteRecord;
  try {
    record = JSON.parse(stored) as AgentInviteRecord;
  } catch {
    return { ok: false, reason: 'invite_code_invalid' };
  }
  if (record.code !== room.code
    || (record.roomInstanceId && room.roomInstanceId && record.roomInstanceId !== room.roomInstanceId)) {
    return { ok: false, reason: 'invite_code_invalid' };
  }
  if (used || record.used) return { ok: false, reason: 'invite_code_invalid' };
  if (now >= record.expiresAt) return { ok: false, reason: 'invite_code_expired' };
  return { ok: true, hash, record };
}

/** Atomically spend the code. False when another join already spent it. */
export async function claimAgentInvite(store: UpstashClient, roomCode: string, hash: string, now = Date.now()): Promise<boolean> {
  const result = await store.command<string | null>(['SET', usedKey(roomCode, hash), String(now), 'NX', 'EX', AGENT_INVITE_RETENTION_SECONDS]);
  return result === 'OK';
}

/** Give the code back when the join it was claimed for failed. */
export async function releaseAgentInvite(store: UpstashClient, roomCode: string, hash: string): Promise<void> {
  await store.command(['DEL', usedKey(roomCode, hash)]);
}

/** Record who spent it (best effort; the used marker is what enforces one use). */
export async function markAgentInviteUsed(
  store: UpstashClient,
  roomCode: string,
  hash: string,
  record: AgentInviteRecord,
  usedBy: string,
  now = Date.now(),
): Promise<void> {
  const next: AgentInviteRecord = { ...record, used: true, usedAt: now, usedBy };
  await store.command(['SET', inviteKey(roomCode, hash), JSON.stringify(next), 'EX', AGENT_INVITE_RETENTION_SECONDS]);
}

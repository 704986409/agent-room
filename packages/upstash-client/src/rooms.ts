import type {
  Room,
  Participant,
  ReplyMode,
  ReplyModeConfig,
} from '@agent-room/shared';
import { AVATAR_PALETTE, DEFAULT_TURN_TIMEOUTS_MS, findSpeakerSeat, hasActiveListenLease, LISTEN_HOLD_COVER_MS, LISTEN_RETURN_GRACE_MS, PRESENCE_DISCONNECTED_MS, ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { sha256Hex } from './sha256.js';
import { RoomNotFoundError, ConcurrencyError } from './errors.js';

function roomKey(code: string): string { return `room:${code}`; }

// 32 hex chars (~128 bits). Stored on the host's sessionStorage; only the
// SHA-256 hash of this key lands on the server (`Room.hostKeyHash`) so a
// passive Redis dump doesn't leak the secret.
function generateHostKey(): string {
  const bytes = new Uint8Array(16);
  // Browsers, Workers, and modern Node all expose globalThis.crypto.
  const cryptoObj: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function generateRoomInstanceId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Hashing goes through sha256.ts, which falls back to a pure-JS SHA-256 when
// `crypto.subtle` is missing. That happens on any non-secure origin, notably
// the dev server opened on a phone at http://<lan-ip>:5173, where this used to
// throw and take room creation down with it.

export interface CreateRoomInput {
  code: string;
  topic: string;
  createdBy: string;
  ownerId?: string;
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  projectId?: string;
  projectName?: string;
  appId?: string;
  // Seed the project prompt at creation — used by the revive/recreate path so
  // a recreated room keeps the prompt (and its version counter) the original
  // room had. Fresh rooms leave these unset; the host edits via
  // setProjectPrompt.
  projectPrompt?: string;
  projectMemoryContext?: string;
  projectPromptVersion?: number;
  projectPromptUpdatedAt?: number;
}

// createRoom now returns the Room PLUS a one-time `hostKey`. The host stores
// hostKey in sessionStorage and presents it to verifyHostKey on any future
// (name === createdBy) join. Returning a flat shape (Room intersection,
// not a wrapper object) keeps existing callers working — they were already
// reading `room.code`, `room.participants`, etc., and those still work.
// New, host-aware callers destructure `hostKey` off the same value.
export type CreateRoomResult = Room & { hostKey: string };

export async function createRoom(client: UpstashClient, input: CreateRoomInput): Promise<CreateRoomResult> {
  const now = Date.now();
  const hostKey = generateHostKey();
  const room: Room = {
    code: input.code,
    roomInstanceId: generateRoomInstanceId(),
    topic: input.topic,
    createdAt: now,
    createdBy: input.createdBy,
    ownerId: input.ownerId,
    ownerUserId: input.ownerUserId ?? input.ownerId,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    projectId: input.projectId,
    projectName: input.projectName,
    appId: input.appId,
    status: 'active',
    version: 1,
    participants: [],
    hostKeyHash: await sha256Hex(hostKey),
    // Default: open mode. Host can switch to 'sequential' / 'moderator' via
    // setReplyMode(). Stored explicitly (rather than relying on the
    // undefined-means-open fallback) so newly created rooms surface the
    // field on the very first room_join response — clients can render the
    // mode chip without waiting for a setReplyMode round-trip.
    replyMode: 'open',
    // Empty string never stored — '' means "no prompt", represented as the
    // absent field (JSON.stringify drops undefined).
    projectPrompt: input.projectPrompt || undefined,
    projectMemoryContext: input.projectMemoryContext || undefined,
    projectPromptVersion: input.projectPromptVersion,
    projectPromptUpdatedAt: input.projectPromptUpdatedAt,
  };
  await client.command(['SET', roomKey(input.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS]);
  return { ...room, hostKey };
}

export async function getRoom(client: UpstashClient, code: string): Promise<Room> {
  const raw = await client.command<string | null>(['GET', roomKey(code)]);
  if (raw === null || raw === undefined) throw new RoomNotFoundError(code);
  return JSON.parse(raw) as Room;
}

const CAS_MAX_ATTEMPTS = 8;
const ROOM_CAS_MAX_ATTEMPTS = 25;

// Presence must use an atomic compare-and-swap: overlapping listeners or a
// delayed stamp racing a release/removal must not overwrite a newer Room.
// The script compares the whole room JSON but keeps all mutation logic in TS.
const CAS_LISTEN_PRESENCE_SCRIPT = `-- AR11 listen-presence CAS
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1`;

async function casPresenceRoom(
  client: UpstashClient,
  code: string,
  mutate: (current: Room) => Room,
): Promise<Room> {
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const current = await getRoom(client, code);
    const next = mutate(current);
    if (next === current) return current;
    next.version = current.version + 1;
    const swapped = await client.command<number>([
      'EVAL', CAS_LISTEN_PRESENCE_SCRIPT, '1', roomKey(code), JSON.stringify(current), JSON.stringify(next),
    ]);
    if (swapped === 1) return next;
  }
  throw new ConcurrencyError();
}

export async function casRoom(
  client: UpstashClient,
  code: string,
  mutator: (current: Room) => Room
): Promise<Room> {
  // Atomic compare-and-swap on the exact stored JSON. The previous
  // read-then-SET lost concurrent updates (e2e: 20 parallel joins kept 7
  // seats), and with server-side writes + wake seatIds that is no longer
  // acceptable. Retries back off with jitter under contention.
  let lastError: unknown;
  for (let attempt = 0; attempt < ROOM_CAS_MAX_ATTEMPTS; attempt++) {
    const raw = await client.command<string | null>(['GET', roomKey(code)]);
    if (raw === null || raw === undefined) throw new RoomNotFoundError(code);
    const current = JSON.parse(raw) as Room;
    let next: Room;
    try {
      next = mutator(current);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        lastError = e;
        continue;
      }
      throw e;
    }
    next.version = current.version + 1;
    // KEEPTTL preserves the 7-day deadline createRoom set.
    const swapped = await client.command<number>([
      'EVAL', CAS_LISTEN_PRESENCE_SCRIPT, '1', roomKey(code), raw, JSON.stringify(next),
    ]);
    if (Number(swapped) === 1) return next;
    lastError = new ConcurrencyError();
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 10 * (attempt + 1))));
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

// Thrown when a non-host tries to claim the host's display name. The room
// rejects rather than auto-suffixing because impersonation of the host has
// outsized blast radius — agents trust host instructions.
export class HostNameTakenError extends Error {
  constructor(host: string) {
    super(`The name "${host}" is reserved for the room host. Please pick a different display name.`);
    this.name = 'HostNameTakenError';
  }
}

// Thrown when a second candidate tries to join an interview room that is
// already in use. Interview rooms are 1-on-1 by design: host (web) + AI
// Interviewer (cc) + at most one candidate (web). The invite link is the
// candidate's exclusive seat — share a fresh room for each interview.
export class InterviewRoomBusyError extends Error {
  constructor(_code: string) {
    super(`This interview is already in progress. Please ask the host for a fresh invite link.`);
    this.name = 'InterviewRoomBusyError';
  }
}

// Interview rooms are identified by topic substring (set at createRoom time
// to "AI Interview"). Kept as a function rather than a regex to mirror the
// existing convention already in Join.tsx / Room.tsx / Report.tsx.
function isInterviewTopic(topic: string): boolean {
  return topic.toLowerCase().includes('interview');
}

// A candidate seat is "web client + not the host". The AI Interviewer joins
// as client='cc' so it never counts as a candidate, and the host's own row
// is excluded by name (createdBy). MCP-driven agents (Cursor, Codex, etc.)
// are also client='cc' so they can still observe an interview room.
function isCandidateSeat(p: Participant, createdBy: string): boolean {
  return p.client === 'web' && p.name !== createdBy;
}

// Identity is (name, client). Same name + same client from the same logical
// session is idempotent (browser refresh / agent reconnect just refreshes
// presence). Two important rules layered on top:
//
// 1. Host-name lock: if `participant.name === room.createdBy`, the caller
//    must present the matching `hostKey`. Without it, we throw
//    HostNameTakenError. This is what stops "anyone with the code can
//    impersonate the host".
//
// 2. Non-host name collision: if any other participant already uses the same
//    visible room name and the caller hasn't shown they own the original seat
//    (no shared client identity yet — see Tier B), we auto-suffix "(2)" /
//    "(3)" so two real humans or agents named "Robin" stay distinguishable.
//
// `priorIdentity` is the caller's previous (name, client) tuple if any —
// the web client passes its sessionStorage entry so a refresh on /r/CODE
// still updates the same row instead of getting a "(2)" suffix.
export interface JoinRoomOptions {
  hostKey?: string;
  // Set to the caller's prior identity in the room (from sessionStorage / MCP
  // state). When provided AND it matches an existing participant, that row
  // gets updated in place. Without it, the join is treated as fresh and
  // collisions get suffixed.
  priorIdentity?: { name: string; client: 'web' | 'cc' };
  // Authenticated Clerk user id. When it matches room.ownerId, join reclaims
  // the host slot under the canonical createdBy name and evicts stale host rows.
  authedUserId?: string | null;
}

// Returns the updated Room with an extra `participant` field showing the
// final, possibly-renamed participant tuple ("Robin (2)" if a name collision
// was suffixed). Existing callers reading `result.participants` etc. still
// work; new callers can read `result.participant.name` to learn what name
// was actually assigned.
export type JoinRoomResult = Room & { participant: Participant };

/** Agents the left-rail roster shows: seated cc, not muted. */
export function seatedTaskAgents(room: Pick<Room, 'participants'>): Participant[] {
  return room.participants.filter(p => p.client === 'cc' && p.canSpeak !== false);
}

/**
 * Owner / verifier must be a seated agent on the current roster. Stops
 * agents from assigning work to a name that is not in the room.
 */
export function taskRoleSeatProblem(
  room: Pick<Room, 'participants'>,
  owner?: string,
  verifier?: string,
): string | null {
  const here = seatedTaskAgents(room);
  const list = here.length ? here.map(p => p.name).join(', ') : '(no agents in the room)';
  const seated = (name: string) => here.find(p => namesEqualIgnoreCase(p.name, name));
  for (const [role, name] of [['owner', owner], ['verifier', verifier]] as const) {
    if (!name?.trim()) continue;
    if (!seated(name)) {
      return `The ${role} ${name} is not an agent in this room. Pick one of: ${list}.`;
    }
  }
  return null;
}

function namesEqualIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isPriorIdentity(
  p: Participant,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): boolean {
  return Boolean(
    priorIdentity
    && p.client === priorIdentity.client
    && namesEqualIgnoreCase(p.name, priorIdentity.name),
  );
}

function uniqueNameForRoom(
  desiredName: string,
  current: Room,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): string {
  const taken = new Set(
    current.participants
      .filter(p => !isPriorIdentity(p, priorIdentity))
      .map(p => p.name),
  );
  if (!taken.has(desiredName) || namesEqualIgnoreCase(desiredName, current.createdBy)) return desiredName;

  let n = 2;
  let candidate = `${desiredName} (${n})`;
  while (taken.has(candidate)) candidate = `${desiredName} (${++n})`;
  return candidate;
}

function uniqueColorForRoom(
  desiredColor: string,
  current: Room,
  priorIdentity: JoinRoomOptions['priorIdentity'],
): string {
  const used = new Set(
    current.participants
      .filter(p => !isPriorIdentity(p, priorIdentity))
      .map(p => p.color),
  );
  if (!used.has(desiredColor)) return desiredColor;
  return AVATAR_PALETTE.find(color => !used.has(color)) ?? desiredColor;
}

export async function joinRoom(
  client: UpstashClient,
  code: string,
  participant: Participant,
  options: JoinRoomOptions = {}
): Promise<JoinRoomResult> {
  let outParticipant = participant;
  const room = await casRoom(client, code, (current) => {
    let next = { ...participant };
    const isOwnerReclaim = Boolean(
      options.authedUserId && current.ownerId && options.authedUserId === current.ownerId,
    );
    const roomInstanceId = current.roomInstanceId ?? generateRoomInstanceId();
    // Host claim: exact/case-insensitive createdBy match, or signed-in room owner.
    const isClaimingHost = isOwnerReclaim || namesEqualIgnoreCase(participant.name, current.createdBy);

    // Interview rooms are 1-on-1 by design: at most one candidate (web,
    // non-host) seat per invite link. Reject a second candidate before
    // we touch the participants list. Host re-joins (covered above by
    // verifyHostKey) and cc agents (AI Interviewer, MCP observers) are
    // not gated here. priorIdentity lets the SAME candidate refresh.
    if (
      isInterviewTopic(current.topic)
      && !isClaimingHost
      && isCandidateSeat(participant, current.createdBy)
    ) {
      const existingCandidates = current.participants.filter(p => isCandidateSeat(p, current.createdBy));
      const isReturningSelf = existingCandidates.some(p => isPriorIdentity(p, options.priorIdentity));
      if (existingCandidates.length > 0 && !isReturningSelf) {
        throw new InterviewRoomBusyError(current.code);
      }
    }

    if (isClaimingHost) {
      // The host slot is gated by hostKey/ownerId, but the verification is
      // async (crypto.subtle.digest) so it can't run inside this synchronous
      // mutator. Callers MUST call verifyHostClaim() first when they intend
      // to claim the host name; that pre-flight throws HostNameTakenError
      // if the key is wrong. Reaching this branch means the caller has
      // already proven they own the host slot.
      // Canonicalize to room.createdBy so "Robin"/"robin" never fork Host.
      next = { ...next, name: current.createdBy };
    } else {
      // Non-host name collision: names are room-visible labels, so keep
      // them unique across client kinds too (web Robin vs agent Robin).
      // priorIdentity bypasses the suffix when the caller is updating their
      // own previous row.
      next = { ...next, name: uniqueNameForRoom(participant.name, current, options.priorIdentity) };
    }

    next = {
      ...next,
      color: uniqueColorForRoom(next.color, current, options.priorIdentity),
    };

    // Default canSpeak: TRUE for everyone (host, agents, walk-ins). The
    // earlier "host approves new joiners" gate added too much friction —
    // someone joining a fast-moving conversation had to wait for the host
    // to notice and click ✓ before they could even ack a message. Robin's
    // new framing: "进入都自动允许发言 但是只有主持人才可以关闭某个参会
    // 的 agent 或着 web 的发言也就是静音". Same Slack/Zoom mental model.
    //
    // Once joined, the host can mute (canSpeak → false) any participant
    // via setMuted(); muted participants stay in the room (presence intact,
    // can read) but room_send is rejected by appendMessage's speaker gate
    // with a MutedError. Unmute is just setMuted(..., false) flipping it back.
    if (next.canSpeak === undefined) {
      next = { ...next, canSpeak: true };
    }
    // The owner principal shares the Room's existing P5 identity on migrated Rooms.
    if (next.memoryIsRoomOwner === true) {
      next = { ...next, memoryPrincipalId: roomInstanceId };
    }
    // Assigned AFTER the canSpeak materialization so the returned
    // `outParticipant` reflects the final stored row, including its
    // approval state (callers like the MCP room_join handler look at this
    // to tell the agent whether it can speak immediately).
    outParticipant = next;

    // Replace priorIdentity / same (name, client). On host reclaim, also
    // drop every stale web row that matches createdBy case-insensitively
    // so "Robin" + "robin" never coexist with a wrong Host badge.
    const keep = current.participants.filter(p => {
      if (isClaimingHost && p.client === 'web' && namesEqualIgnoreCase(p.name, current.createdBy)) {
        return false;
      }
      if (isPriorIdentity(p, options.priorIdentity)) return false;
      return !(p.name === next.name && p.client === next.client);
    });

    return {
      ...current,
      roomInstanceId,
      participants: [...keep, next],
    };
  });

  return { ...room, participant: outParticipant };
}

// Pre-flight check used by callers that intend to join with the host's name.
// Returns the verified room or throws HostNameTakenError. After this check,
// callers proceed to joinRoom() which trusts that the host claim was
// validated. Splitting verify+write avoids putting async crypto work inside
// the synchronous CAS mutator above.
// Validate a claim to the host slot. Accepts EITHER proof:
//   1. a hostKey whose hash matches room.hostKeyHash (the browser-stored token), OR
//   2. an authenticated Clerk user whose id === room.ownerId (the account that
//      owns the room).
// The owner-identity path is what lets a signed-in owner stay the host even when
// the hostKey was lost — it's cleared on sign-out, on a different browser, or by
// the client's "you're not signed in as the owner" cleanup, and the server only
// ever stored the key's HASH so it cannot be re-handed out. Without this, losing
// the key permanently locked the real owner out of their own room.
// Anonymous rooms (no ownerId) and the bare-key path are unchanged, so a caller
// who only has the room code still cannot impersonate the host.
export async function verifyHostClaim(
  client: UpstashClient,
  code: string,
  proof: { hostKey?: string | undefined; authedUserId?: string | null },
): Promise<void> {
  const room = await getRoom(client, code);
  // Legacy rooms created before hostKeyHash existed: allow any claim.
  if (!room.hostKeyHash) return;
  // Authenticated room owner is always the host, key or no key.
  if (proof.authedUserId && room.ownerId && proof.authedUserId === room.ownerId) return;
  if (!proof.hostKey) throw new HostNameTakenError(room.createdBy);
  const hash = await sha256Hex(proof.hostKey);
  if (hash !== room.hostKeyHash) throw new HostNameTakenError(room.createdBy);
}

// Back-compat thin wrapper: key-only verification (no authenticated identity).
export async function verifyHostKey(
  client: UpstashClient,
  code: string,
  hostKey: string | undefined,
): Promise<void> {
  return verifyHostClaim(client, code, { hostKey });
}

// Mute or unmute a participant. Host-only. Mute flips `canSpeak` to false
// and the next room_send by that participant returns a MutedError;
// presence (visibility, ability to read) is unaffected. Unmute flips back
// to true. Idempotent — calling with the same value bumps version but is
// a no-op for the participant row.
export async function setMuted(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
  muted: boolean,
): Promise<Room> {
  return casRoom(client, code, (current) => {
    if (current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    return {
      ...current,
      participants: current.participants.map(p =>
        (p.name === targetName && p.client === targetClient)
          ? { ...p, canSpeak: !muted }
          : p,
      ),
    };
  });
}

/**
 * @deprecated Use `setMuted(..., false)`. Kept as a thin alias so older
 * callers still compile while we migrate the web UI to the mute toggle.
 */
export function approveParticipant(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
): Promise<Room> {
  return setMuted(client, code, requesterName, targetName, targetClient, false);
}

// Server-side check: is this (name, client) tuple a participant who's been
// approved to speak? Returns the participant on success, null on miss.
// Treats `canSpeak === undefined` as approved (legacy rooms without the
// field). All new joiners flow through joinRoom which always sets the
// field, so undefined only appears for participants from before this code
// landed.
//
// The rule itself lives in @agent-room/shared/speakPermission so the web
// composer can gate on the same logic the server enforces here.
export function findSpeaker(
  room: Room,
  name: string,
  clientKind: 'web' | 'cc',
): Participant | null {
  return findSpeakerSeat(room, name, clientKind);
}

// Set or clear reply-mode coordination on a room. Host-only. AI Interview
// rooms (topic includes "interview") are rejected — they have their own
// 1-on-1 flow that is incompatible with multi-agent turn-taking. Switching
// modes mid-conversation is supported; Slice B will additionally clear any
// in-flight turn state on switch (lazy-cleared on next listen/send).
//
// Validates that the right fields are present for the requested mode:
//   - 'open':       config can be empty / undefined
//   - 'sequential': leadAgentName + leadAgentClient required IF caller wants
//                   a non-default Lead; otherwise the room falls back to
//                   "first cc-client agent in join order" at turn time.
//                   Callers are encouraged to specify, but it's not enforced
//                   here so UI can offer a "start sequential with first agent
//                   as Lead" shortcut without forcing a selection.
//   - 'moderator':  moderatorAgentName + moderatorAgentClient REQUIRED —
//                   moderator mode is meaningless without a routing agent.
export class InvalidModeConfigError extends Error {
  constructor(mode: ReplyMode, missingField: string) {
    super(`replyMode='${mode}' requires modeConfig.${missingField}.`);
    this.name = 'InvalidModeConfigError';
  }
}

export class ModeNotSupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ModeNotSupportedError';
  }
}

function isInterviewTopicValue(topic: string): boolean {
  return topic.toLowerCase().includes('interview');
}

export async function setReplyMode(
  client: UpstashClient,
  code: string,
  requesterName: string,
  mode: ReplyMode,
  config: ReplyModeConfig | undefined,
): Promise<Room> {
  const updated = await casRoom(client, code, (current) => {
    if (current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    if (isInterviewTopicValue(current.topic)) {
      throw new ModeNotSupportedError(
        'AI Interview rooms run a fixed 1-on-1 flow and do not support reply-mode switching.',
      );
    }
    if (mode === 'moderator') {
      if (!config?.moderatorAgentName || !config?.moderatorAgentClient) {
        throw new InvalidModeConfigError('moderator', 'moderatorAgentName + moderatorAgentClient');
      }
    }
    // Deliver mode needs an owner AND a different verifier for every task.
    // With one agent nobody can verify, so refuse at the switch rather than
    // let the host discover it at the first review. (Enforced here, in the
    // shared core, so the MCP path is gated identically to the web UI.)
    if (mode === 'deliver') {
      const agents = current.participants.filter(
        p => p.client === 'cc' && p.canSpeak !== false && p.name !== current.createdBy,
      );
      if (agents.length < 2) {
        throw new ModeNotSupportedError(
          `Deliver mode needs at least 2 connected agents in the room — this room has ${agents.length}. Connect another agent over MCP, then switch.`,
        );
      }
    }
    if (config?.leadGraceMs !== undefined) {
      const leadDeadline = config.timeoutMs?.lead ?? DEFAULT_TURN_TIMEOUTS_MS.lead;
      if (
        !Number.isFinite(config.leadGraceMs)
        || config.leadGraceMs < 0
        || config.leadGraceMs > leadDeadline
      ) {
        throw new InvalidModeConfigError(
          mode,
          `leadGraceMs (must be a finite number in [0, ${leadDeadline}])`,
        );
      }
    }
    // Persist normalized config. For 'open' we still keep whatever the
    // caller passed (e.g. timeoutMs they pre-configured before switching
    // away from sequential) so a later switch back doesn't lose settings.
    return {
      ...current,
      replyMode: mode,
      modeConfig: config,
    };
  });
  // Any mode change aborts an in-flight turn. We do this as a best-effort
  // sibling write (not atomic with the room CAS) — the only failure mode
  // is "old turnState lingers", which the next human message will
  // overwrite via newSequentialTurn / moderator startup anyway. Keeping
  // it out of the CAS mutator avoids cyclic imports and keeps the room
  // module unaware of turnState internals.
  await client.command(['DEL', `turn-state:${code}`]);
  return updated;
}

// Set or clear the room's host-editable project prompt. An empty string
// clears it (the field is dropped, not stored as ''). Every successful write
// — set or clear — bumps projectPromptVersion and stamps
// projectPromptUpdatedAt so clients (and prompt-cache keys) can tell edits
// apart. Authorization is the caller's job: api/room.ts gates this behind
// verifyHostClaim (hostKey or signed-in owner), mirroring other host actions.
export async function setProjectPrompt(
  client: UpstashClient,
  code: string,
  prompt: string,
): Promise<Room> {
  return casRoom(client, code, (current) => ({
    ...current,
    projectPrompt: prompt || undefined,
    projectPromptVersion: (current.projectPromptVersion ?? 0) + 1,
    projectPromptUpdatedAt: Date.now(),
  }));
}

/**
 * Thrown by `appendMessage` when the sender is not allowed to speak under
 * the current reply-mode turn state. Slice A never throws this; Slice B
 * begins throwing it in 'sequential' / 'moderator' rooms.
 */
export class NotYourTurnError extends Error {
  constructor(name: string, mode: ReplyMode) {
    super(`"${name}" is not allowed to speak right now (reply mode: ${mode}).`);
    this.name = 'NotYourTurnError';
  }
}

/**
 * Thrown by `appendMessage` when the sender's `canSpeak` is false —
 * either because the host muted them, or (legacy) because they joined a
 * pre-mute-model room that still defaulted non-host to false.
 */
export class MutedError extends Error {
  constructor(name: string, host: string) {
    super(`"${name}" has been muted by the host (${host}). Ask the host to unmute (🔊) to keep talking.`);
    this.name = 'MutedError';
  }
}

/** @deprecated Same shape as MutedError, kept for backward compat. */
export const NotApprovedError = MutedError;

/**
 * Thrown when someone who holds no seat in the room tries to act as a member
 * of it — sending a message, registering a webhook. Distinct from MutedError:
 * a muted participant waits for the host, a non-participant joins.
 *
 * `action` completes the sentence so each caller says what was refused.
 * Re-exported from webhooks.ts, which threw this first.
 */
export class NotParticipantError extends Error {
  constructor(name: string, action = 'registering a webhook') {
    super(`"${name}" is not a participant of this room — join it before ${action}.`);
    this.name = 'NotParticipantError';
  }
}

// Remove a participant from the room. Only the host (createdBy) may kick.
// Upstash has no per-call auth so this is a soft guard inside the CAS — anyone
// with the REST token can still bypass it, but no path through the public web
// or MCP UI lets a non-host hit this. Identity is (name, client), same as
// joinRoom.
export class NotHostError extends Error {
  constructor(requester: string, host: string) {
    super(`Only the host (${host}) can remove participants — requester: ${requester}`);
    this.name = 'NotHostError';
  }
}

export async function removeParticipant(
  client: UpstashClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc'
): Promise<Room> {
  return casPresenceRoom(client, code, (current) => {
    // Self-removal is always allowed — agents that finish their turn or
    // were told to leave call this with requesterName === targetName.
    // Removing someone else still requires the host slot.
    const isSelfRemoval = requesterName === targetName;
    if (!isSelfRemoval && current.createdBy !== requesterName) {
      throw new NotHostError(requesterName, current.createdBy);
    }
    return {
      ...current,
      participants: current.participants.filter(
        p => !(p.name === targetName && p.client === targetClient)
      ),
    };
  });
}

// Silent no-op if the named participant is not in the room. In practice the
// caller passes its own name from session state, so a miss means the user was
// removed externally — we just skip the heartbeat. version still bumps so
// drift remains visible if it ever matters.
export async function endRoom(
  client: UpstashClient,
  code: string,
): Promise<Room> {
  return casPresenceRoom(client, code, (current) => {
    const endedAt = Date.now();
    return {
      ...current,
      status: 'ended' as const,
      endedAt,
      participants: current.participants.map(p => ({
        ...p,
        listenUntil: endedAt,
        listenLeases: undefined,
      })),
    };
  });
}

export async function reactivateRoom(
  client: UpstashClient,
  code: string,
): Promise<Room> {
  return casRoom(client, code, (current) => ({
    ...current,
    status: 'active' as const,
    endedAt: undefined,
  }));
}

export async function updatePresence(
  client: UpstashClient,
  code: string,
  name: string,
  at: number
): Promise<void> {
  await casPresenceRoom(client, code, (current) => {
    const participants = current.participants.map(p =>
      p.name === name ? { ...p, lastSeenAt: at } : p
    );
    return participants.every((p, i) => p === current.participants[i])
      ? current
      : { ...current, participants };
  });
}

// Stamp how long this participant intends to stay in their current room_listen
// window. Other participants can read this from the room's participant list
// to know who's actively listening vs just present-but-idle.
export async function setListenUntil(
  client: UpstashClient,
  code: string,
  name: string,
  until: number | null,
  leaseId?: string,
): Promise<void> {
  await casPresenceRoom(client, code, (current) => {
    // A released listener may clear its own lease after room_end; no new lease
    // can be created once the room is ended.
    if (current.status !== 'active' && until !== null) return current;
    const now = Date.now();
    const participants = current.participants.map(p => {
        // Listener presence belongs to an Agent seat, not merely a display
        // name. A late write must not mark a Web seat or recreate a removed one.
        if (p.name !== name || p.client !== 'cc') return p;
        if (until !== null && !Number.isFinite(until)) return p;
        const leases: Record<string, number> = Object.fromEntries(
          Object.entries(p.listenLeases ?? {}).filter(([, expiresAt]) =>
            typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now,
          ),
        );
        // Older Rooms and rolling-upgrade instances only have listenUntil.
        // Keep that legacy lease alive independently until it naturally ends.
        const trackedUntil = Object.values(leases).reduce((max, expiresAt) => Math.max(max, expiresAt), 0);
        if (typeof p.listenUntil === 'number' && Number.isFinite(p.listenUntil)
          && p.listenUntil > now && p.listenUntil > trackedUntil) {
          leases.legacy = p.listenUntil;
        }
        const leaseKey = leaseId ?? 'legacy';
        if (until === null) {
          delete leases[leaseKey];
        } else if (until <= now) {
          // CLI room_listen releases with until=Date.now(). That used to be a
          // no-op, so a dropped renewal left the seat idle for the rest of the
          // hold. A return we can see shortens the lease to a grace window.
          leases[leaseKey] = now + LISTEN_RETURN_GRACE_MS;
        } else if (!leaseId) {
          // No per-call id: this is the CLI presence stamp (now+15s). Keep the
          // seat listening for the whole long-poll; the release above cuts it.
          leases[leaseKey] = Math.max(until, now + LISTEN_HOLD_COVER_MS);
        } else {
          leases[leaseKey] = until;
        }
        const activeUntil = Object.values(leases).reduce((max, expiresAt) => Math.max(max, expiresAt), 0);
        // null drops one lease id and is not a check-in. A numeric until,
        // including a CLI return (until <= now), means the client is still
        // there, so lastSeenAt moves and the seat does not age into idle.
        return {
          ...p,
          listenUntil: activeUntil > now ? activeUntil : now,
          listenLeases: Object.keys(leases).length > 0 ? leases : undefined,
          ...(until !== null ? { lastSeenAt: now } : {}),
        };
      });
    // Missing member and stale/foreign release are deliberate no-ops.
    if (participants.every((p, i) => p === current.participants[i])) return current;
    return { ...current, participants };
  });
}

/**
 * Has this participant gone quiet long enough to count as disconnected?
 *
 * `listenUntil` is a lease an agent renews on every room_listen, so a seat
 * holding a live lease is never stale even if lastSeenAt is momentarily old —
 * the lease can only veto staleness, never assert it. Everything else falls
 * back to the lastSeenAt clock, which is what actually decides abandonment.
 */
export function isParticipantStale(p: Participant, now: number = Date.now()): boolean {
  if (hasActiveListenLease(p, now)) return false;
  const lastSeen = typeof p.lastSeenAt === 'number' && Number.isFinite(p.lastSeenAt) ? p.lastSeenAt : 0;
  return now - lastSeen > PRESENCE_DISCONNECTED_MS;
}

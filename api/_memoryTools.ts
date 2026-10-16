import { createHash, timingSafeEqual } from 'node:crypto';
import type { Participant, Room } from '@agent-room/shared';
import {
  MemoryBriefService,
  MemoryReviewService,
  MemorySearchService,
  MemoryService,
  MemoryServiceError,
  PostgresMemoryRepository,
  RedisMemoryBriefSessionStore,
  RedisSearchSessionStore,
  RedisUrlCommandClient,
  ReviewerPolicy,
  type MemoryIdentity,
  type MemoryReviewResult,
  type MemoryReviewRejectionReason,
  type MemoryServiceMutationResult,
  type ReviewerSeat,
  type MemoryContent,
  type MemoryRepository,
  type MemoryUpdate,
  type RedisCommandClient,
  type TrustedMemoryCaller,
  type TrustedMemoryReviewer,
} from '@agent-room/memory';
import {
  appendRoomEvent,
  getRoom,
  isMemorySeatOnline,
  RemoteRoomApiError,
  type RemoteRoomClient,
} from './_mcpRoomClient.js';
import {
  deliverMemoryReviewNotice,
  deliverMemoryReviewOutcomeNotice,
  deliverMemorySupersededNotice,
  type MemoryProposalKind,
} from './_memoryReviewNotify.js';
import { tryJevMemoryReview } from './_memoryJevReview.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_TOOL_NAMES = new Set([
  'memory_search', 'memory_read', 'memory_write', 'memory_update',
  'memory_delete', 'memory_list', 'memory_review', 'memory_brief',
]);

export interface MemoryToolDependencies {
  openRepository(): Promise<MemoryRepository & { close(): Promise<void> }>;
  redis: RedisCommandClient;
}

interface ResolvedSeat {
  readonly room: Room;
  readonly participant: Participant;
  readonly caller: TrustedMemoryCaller;
  readonly reviewer: MemoryIdentity;
}

export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.MEMORY_ENABLED?.trim().toLowerCase();
  return (enabled === 'true' || enabled === '1')
    && Boolean(env.MEMORY_DATABASE_URL?.trim() || env.DATABASE_URL?.trim());
}

export function isMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

function hashSeatKey(seatKey: string): Buffer {
  return createHash('sha256').update(seatKey, 'utf8').digest();
}

function matchesSeatKey(storedHash: string | undefined, seatKey: string): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = hashSeatKey(seatKey);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function identityForSeat(participant: Participant): MemoryIdentity | null {
  if (participant.memoryIdentityType === 'persona'
    && typeof participant.memoryPersonaId === 'string'
    && participant.memoryPersonaId.trim()) {
    return {
      type: 'persona',
      id: participant.memoryPersonaId,
      personaId: participant.memoryPersonaId,
    };
  }
  if ((participant.memoryIdentityType === 'room_member' || participant.memoryIdentityType === 'room_owner')
    && typeof participant.memoryPrincipalId === 'string'
    && participant.memoryPrincipalId.trim()) {
    return { type: participant.memoryIdentityType, id: participant.memoryPrincipalId };
  }
  return null;
}

function callerForSeat(room: Room, participant: Participant): TrustedMemoryCaller | null {
  if (!room.roomInstanceId || !UUID_PATTERN.test(room.roomInstanceId)) return null;
  const identityType = participant.memoryIdentityType;
  if (identityType === 'persona' && participant.memoryPersonaId?.trim()) {
    return { roomInstanceId: room.roomInstanceId, identityType, personaId: participant.memoryPersonaId };
  }
  if ((identityType === 'room_member' || identityType === 'room_owner')
    && participant.memoryPrincipalId?.trim()) {
    return { roomInstanceId: room.roomInstanceId, identityType, principalId: participant.memoryPrincipalId };
  }
  return null;
}

async function resolveSeat(
  client: RemoteRoomClient,
  code: unknown,
  seatKey: unknown,
): Promise<{ seat?: ResolvedSeat; error?: 'FORBIDDEN' | 'STORAGE_ERROR' }> {
  if (typeof code !== 'string' || !code.trim() || code.length > 64
    || typeof seatKey !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(seatKey)) {
    return { error: 'FORBIDDEN' };
  }
  let room: Room;
  try {
    room = await getRoom(client, code);
  } catch (error) {
    if (error instanceof RemoteRoomApiError && error.status === 404) return { error: 'FORBIDDEN' };
    return { error: 'STORAGE_ERROR' };
  }
  if (room.status !== 'active' || !room.roomInstanceId || !UUID_PATTERN.test(room.roomInstanceId)) {
    return { error: 'FORBIDDEN' };
  }
  const participant = room.participants.find(candidate => candidate.client === 'cc'
    && matchesSeatKey(candidate.seatKeyHash, seatKey));
  if (!participant) return { error: 'FORBIDDEN' };
  const caller = callerForSeat(room, participant);
  const reviewer = identityForSeat(participant);
  if (!caller || !reviewer) return { error: 'FORBIDDEN' };
  return { seat: { room, participant, caller, reviewer } };
}

class UpstashRestRedisCommandClient implements RedisCommandClient {
  constructor(private readonly endpoint: string, private readonly token: string) {}

  async sendCommand(command: readonly string[]): Promise<unknown> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error('Redis command failed.');
    const body = await response.json() as { result?: unknown; error?: string };
    if (body.error) throw new Error('Redis command failed.');
    return body.result;
  }
}

function productionDependencies(): MemoryToolDependencies {
  const databaseUrl = process.env.MEMORY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new MemoryServiceError('STORAGE_ERROR');
  const localRedisUrl = process.env.MEMORY_REDIS_URL?.trim();
  const redisUrl = localRedisUrl?.startsWith('redis://')
    ? localRedisUrl
    : process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.VITE_UPSTASH_REDIS_REST_URL?.trim();
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.VITE_UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!redisUrl) throw new MemoryServiceError('STORAGE_ERROR');
  const redis = redisUrl.startsWith('redis://')
    ? new RedisUrlCommandClient(redisUrl)
    : redisToken ? new UpstashRestRedisCommandClient(redisUrl, redisToken) : null;
  if (!redis) throw new MemoryServiceError('STORAGE_ERROR');
  return {
    openRepository: () => PostgresMemoryRepository.connect({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
    }),
    redis,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function memoryReviewerContext(seat: ResolvedSeat): TrustedMemoryReviewer {
  return {
    roomInstanceId: seat.caller.roomInstanceId,
    identity: seat.reviewer,
    verified: true,
  };
}

/** Who and what the room event announces. Assembled per memory_* call that can propose. */
interface ReviewNoticeContext {
  readonly client: RemoteRoomClient;
  readonly code: string;
  /** The room as the seat resolver read it; the fallback when a fresh read fails. */
  readonly room: Room;
  readonly kind: MemoryProposalKind;
  readonly proposerName: string;
  readonly title?: string | undefined;
  readonly preview?: string | undefined;
}

function reviewNoticeContext(
  client: RemoteRoomClient,
  seat: ResolvedSeat,
  kind: MemoryProposalKind,
  args: Record<string, unknown>,
): ReviewNoticeContext {
  return {
    client,
    code: seat.room.code,
    room: seat.room,
    kind,
    proposerName: seat.participant.name,
    title: text(args.title),
    preview: text(args.preview),
  };
}

/**
 * Reviewer identities back to the names the room addresses people by.
 *
 * The owner fallback is the one identity that may not be matchable this way —
 * a host who only ever spoke through the web client has no `cc` seat — so it
 * falls back to the room's recorded creator, which is the name the web host
 * answers to.
 */
function reviewerNamesFor(room: Room, recipients: readonly MemoryIdentity[]): string[] {
  const names: string[] = [];
  for (const recipient of recipients) {
    if (recipient.type === 'system') {
      if (!names.includes('Jev')) names.push('Jev');
      continue;
    }
    const seat = room.participants.find(candidate => candidate.client === 'cc'
      && hasSeatHash(candidate)
      && sameIdentity(identityForSeat(candidate), recipient));
    const name = seat?.name ?? (recipient.type === 'room_owner' ? room.createdBy : undefined);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function notifySupersededMemoryProposals(
  client: RemoteRoomClient,
  code: string,
  fallbackRoom: Room,
  reviews: MemoryReviewService,
  winningProposalId: string,
  superseded: readonly string[] | undefined,
): Promise<boolean | undefined> {
  if (!superseded?.length) return undefined;
  try {
    const notices = await reviews.supersededProposalNotices(fallbackRoom.roomInstanceId!, superseded);
    const room = await getRoom(client, code).catch(() => fallbackRoom);
    const items = notices.map(notice => ({
      proposalId: notice.id,
      title: notice.title,
      proposerName: reviewerNamesFor(room, [notice.proposer])[0] ?? notice.proposer.id,
      winningProposalId,
    }));
    return await deliverMemorySupersededNotice(
      (roomCode, message) => appendRoomEvent(client, roomCode, message), code, items,
    );
  } catch {
    // The approval is committed already; notice delivery is best effort.
    return false;
  }
}

export async function notifyRejectedMemoryProposal(
  client: RemoteRoomClient,
  code: string,
  fallbackRoom: Room,
  repository: Pick<MemoryRepository, 'getRoomProposal' | 'readEntry'>,
  result: MemoryReviewResult,
  reviewerName: string,
): Promise<boolean | undefined> {
  if (result.status !== 'rejected' || !result.reason) return undefined;
  try {
    const proposal = await repository.getRoomProposal(fallbackRoom.roomInstanceId!, result.proposalId);
    if (!proposal) return false;
    const proposer: MemoryIdentity = {
      type: proposal.proposer_identity_type,
      id: proposal.proposer_identity_id,
      ...(proposal.proposer_persona_id ? { personaId: proposal.proposer_persona_id } : {}),
    };
    const payload = proposal.payload as Record<string, unknown>;
    const current = proposal.target_memory_id
      ? await repository.readEntry({ roomInstanceId: fallbackRoom.roomInstanceId!, scope: 'room' }, proposal.target_memory_id)
        .catch(() => null)
      : null;
    const title = typeof payload.title === 'string' ? payload.title : current?.title ?? proposal.target_memory_id ?? '';
    const room = await getRoom(client, code).catch(() => fallbackRoom);
    return await deliverMemoryReviewOutcomeNotice(
      (roomCode, message) => appendRoomEvent(client, roomCode, message),
      code,
      {
        status: 'rejected',
        proposerName: reviewerNamesFor(room, [proposer])[0] ?? proposer.id,
        reviewerName,
        title,
        reason: result.reason as MemoryReviewRejectionReason,
      },
    );
  } catch {
    return false;
  }
}

/**
 * New pending proposal -> notify all online reviewers (or the owner fallback with
 * reviewCode REVIEWER_UNAVAILABLE). A duplicateOf result re-notifies nobody.
 *
 * The notification objects are the answer to "who may review this"; the room
 * event posted alongside them is what actually reaches that reviewer. Posting
 * it is best-effort by design — the proposal is already committed, so a room
 * that refuses the message must still return a successful write, reported as
 * notificationDelivered: false.
 */
async function withReviewNotifications(
  result: MemoryServiceMutationResult,
  reviews: MemoryReviewService,
  repository: MemoryRepository,
  roomInstanceId: string,
  notice: ReviewNoticeContext,
): Promise<Record<string, unknown>> {
  if (!('code' in result) || result.code !== 'PENDING_REVIEW' || result.duplicateOf) {
    return result as unknown as Record<string, unknown>;
  }
  const jevResult = await tryJevMemoryReview({
    result,
    repository,
    reviews,
    roomInstanceId,
    proposerName: notice.proposerName,
    appendRoomEvent: message => appendRoomEvent(notice.client, notice.code, message),
  });
  if (jevResult) return jevResult;
  try {
    const mention = await reviews.mentionReviewers(roomInstanceId, result.proposalId);
    const room = await getRoom(notice.client, notice.code).catch(() => notice.room);
    const notificationDelivered = await deliverMemoryReviewNotice(
      (code, message) => appendRoomEvent(notice.client, code, message),
      notice.code,
      {
        proposalId: result.proposalId,
        kind: notice.kind,
        recipientNames: reviewerNamesFor(room, mention.notifications.map(entry => entry.recipient)),
        proposerName: notice.proposerName,
        title: notice.title,
        preview: notice.preview,
        ...(mention.mode === 'owner_fallback' ? { ownerFallback: true } : {}),
      },
    );
    return {
      ...result,
      notification: mention.notifications[0],
      notifications: mention.notifications,
      ...(mention.reviewCode ? { reviewCode: mention.reviewCode } : {}),
      notificationDelivered,
    };
  } catch (error) {
    if (error instanceof MemoryServiceError && error.code === 'REVIEW_REQUIRED') {
      return { ...result, reviewCode: 'REVIEW_REQUIRED' };
    }
    throw error;
  }
}

function hasSeatHash(participant: Participant): boolean {
  return typeof participant.seatKeyHash === 'string' && /^[0-9a-f]{64}$/i.test(participant.seatKeyHash);
}

export function reviewerDirectory(client: RemoteRoomClient, code: string) {
  async function latestRoom(roomInstanceId: string): Promise<Room | null> {
    const room = await getRoom(client, code);
    return room.status === 'active' && room.roomInstanceId === roomInstanceId ? room : null;
  }
  return {
    async findReviewerByRole(roomInstanceId: string, role: string): Promise<MemoryIdentity | null> {
      const seats = await this.listReviewersByRole(roomInstanceId, role);
      return seats.find(seat => seat.online)?.identity ?? null;
    },
    /** Every verified seat bound to the reviewer role, with presence (live listen lease or <=120s since last seen). */
    async listReviewersByRole(roomInstanceId: string, role: string): Promise<ReviewerSeat[]> {
      const room = await latestRoom(roomInstanceId);
      if (!room) return [];
      const normalizedRole = role.normalize('NFKC').trim().toLocaleLowerCase();
      const now = Date.now();
      const seats: ReviewerSeat[] = [];
      for (const candidate of room.participants) {
        if (candidate.client !== 'cc' || !hasSeatHash(candidate)) continue;
        if ((candidate.role ?? '').normalize('NFKC').trim().toLocaleLowerCase() !== normalizedRole) continue;
        const identity = identityForSeat(candidate);
        if (identity) seats.push({ identity, online: isMemorySeatOnline(candidate, now) });
      }
      return seats;
    },
    async isAvailable(roomInstanceId: string, identity: MemoryIdentity): Promise<boolean> {
      const room = await latestRoom(roomInstanceId);
      const now = Date.now();
      return Boolean(room?.participants.some(candidate => candidate.client === 'cc'
        && hasSeatHash(candidate)
        && isMemorySeatOnline(candidate, now)
        && sameIdentity(identityForSeat(candidate), identity)));
    },
    async resolveRoomOwner(roomInstanceId: string): Promise<MemoryIdentity | null> {
      const room = await latestRoom(roomInstanceId);
      const owner = room?.participants.find(candidate => candidate.client === 'cc'
        && candidate.memoryIsRoomOwner === true
        && candidate.memoryIdentityType === 'room_owner'
        && hasSeatHash(candidate));
      return owner ? identityForSeat(owner) : null;
    },
  };
}

function sameIdentity(left: MemoryIdentity | null, right: MemoryIdentity): boolean {
  return left?.type === right.type && left.id === right.id;
}

function contentFrom(args: Record<string, unknown>): MemoryContent {
  return {
    title: args.title as string,
    preview: args.preview as string,
    content: args.content as string,
    searchText: args.searchText as string,
    ...(args.sourceMessageId === undefined ? {} : { sourceMessageId: args.sourceMessageId as string | null }),
  };
}

function updateFrom(args: Record<string, unknown>): MemoryUpdate {
  const update: Partial<Record<keyof MemoryUpdate, string | null>> = {};
  for (const key of ['title', 'preview', 'content', 'searchText', 'sourceMessageId']) {
    if (key in args) update[key as keyof MemoryUpdate] = args[key] as string | null;
  }
  return update as MemoryUpdate;
}

function scopeFrom(value: unknown): 'persona' | 'room' | null {
  return value === 'persona' || value === 'room' ? value : null;
}

/** Shared MCP entry path. The only caller identity comes from the hashed Room seat binding. */
export async function dispatchMemoryTool(
  client: RemoteRoomClient,
  name: string,
  rawArgs: unknown,
  dependencies?: MemoryToolDependencies,
): Promise<Record<string, unknown>> {
  if (!isMemoryToolName(name)) return { code: 'INVALID_INPUT' };
  const args = record(rawArgs);
  const resolved = await resolveSeat(client, args.code, args.seatKey);
  if (resolved.error) return { code: resolved.error };
  const seat = resolved.seat!;
  let repository: (MemoryRepository & { close(): Promise<void> }) | undefined;
  try {
    const deps = dependencies ?? productionDependencies();
    repository = await deps.openRepository();
    const service = new MemoryService(repository);
    const search = new MemorySearchService(repository, new RedisSearchSessionStore(deps.redis));
    const brief = new MemoryBriefService(
      service,
      new RedisMemoryBriefSessionStore(deps.redis),
      {
        authorize: async caller => caller.roomInstanceId === seat.caller.roomInstanceId
          && (await resolveSeat(client, args.code, args.seatKey)).seat?.participant.name === seat.participant.name,
      },
      { readRoomTopic: async roomInstanceId => roomInstanceId === seat.caller.roomInstanceId ? seat.room.topic : null },
    );
    const role = process.env.MEMORY_REVIEWER_ROLE?.trim() || 'project-analyst';
    const reviews = new MemoryReviewService(
      repository,
      new ReviewerPolicy(reviewerDirectory(client, String(args.code)), role),
    );
    const requestId = text(args.requestId) ?? '';

    switch (name) {
      case 'memory_search':
        return await search.search(seat.caller, {
          keywords: args.keywords as string[],
          requestId,
          ...(args.searchSessionId === undefined ? {} : { searchSessionId: args.searchSessionId as string }),
        }) as unknown as Record<string, unknown>;
      case 'memory_read':
        return await search.read(seat.caller, {
          id: text(args.id) ?? '',
          ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        }) as unknown as Record<string, unknown>;
      case 'memory_write': {
        const scope = scopeFrom(args.scope);
        if (!scope) return { code: 'INVALID_INPUT' };
        return await withReviewNotifications(
          await service.createEntry(seat.caller, scope, contentFrom(args), requestId),
          reviews, repository, seat.caller.roomInstanceId,
          reviewNoticeContext(client, seat, 'create', args),
        );
      }
      case 'memory_update': {
        const scope = scopeFrom(args.scope);
        if (!scope) return { code: 'INVALID_INPUT' };
        return await withReviewNotifications(
          await service.updateEntry(seat.caller, scope, text(args.id) ?? '', updateFrom(args), requestId),
          reviews, repository, seat.caller.roomInstanceId,
          reviewNoticeContext(client, seat, 'update', args),
        );
      }
      case 'memory_delete': {
        const scope = scopeFrom(args.scope);
        if (!scope) return { code: 'INVALID_INPUT' };
        return await withReviewNotifications(
          await service.deleteEntry(seat.caller, scope, text(args.id) ?? '', requestId),
          reviews, repository, seat.caller.roomInstanceId,
          reviewNoticeContext(client, seat, 'delete', args),
        );
      }
      case 'memory_list': {
        const scope = scopeFrom(args.scope);
        if (!scope) return { code: 'INVALID_INPUT' };
        const items = await service.listEntries(seat.caller, scope, {
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
        });
        return { items };
      }
      case 'memory_review': {
        const action = args.action;
        if (action === 'list') {
          const items = await reviews.listPending(memoryReviewerContext(seat), {
            ...(args.limit === undefined ? {} : { limit: args.limit as number }),
            ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          });
          return { items };
        }
        if (action !== 'approve' && action !== 'reject') return { code: 'INVALID_INPUT' };
        const result = await reviews.review(
          memoryReviewerContext(seat),
          text(args.proposalId) ?? '',
          action,
          requestId,
          action === 'reject' ? args.reason : undefined,
        );
        const rejectionNotificationDelivered = action === 'reject'
          ? await notifyRejectedMemoryProposal(
            client, seat.room.code, seat.room, repository, result, seat.participant.name,
          )
          : undefined;
        const supersededNotificationDelivered = action === 'approve'
          ? await notifySupersededMemoryProposals(
            client, seat.room.code, seat.room, reviews, result.proposalId, result.superseded,
          )
          : undefined;
        return {
          ...result,
          ...(rejectionNotificationDelivered === undefined ? {} : { notificationDelivered: rejectionNotificationDelivered }),
          ...(supersededNotificationDelivered === undefined ? {} : { supersededNotificationDelivered }),
        };
      }
      case 'memory_brief':
        return await brief.loadOnce(seat.caller, String(args.seatKey)) as unknown as Record<string, unknown>;
      default:
        return { code: 'INVALID_INPUT' };
    }
  } catch (error) {
    if (error instanceof MemoryServiceError) return { code: error.code };
    return { code: 'STORAGE_ERROR' };
  } finally {
    await repository?.close().catch(() => {});
  }
}

/** room_join calls this through the same seat resolver and one-time Brief store as memory_brief. */
export async function loadJoinBrief(
  client: RemoteRoomClient,
  code: string,
  seatKey: string,
  dependencies?: MemoryToolDependencies,
): Promise<Record<string, unknown>> {
  return dispatchMemoryTool(client, 'memory_brief', { code, seatKey }, dependencies);
}

export function createMemoryTestDependencies(
  openRepository: MemoryToolDependencies['openRepository'],
  redis: RedisCommandClient,
): MemoryToolDependencies {
  return { openRepository, redis };
}

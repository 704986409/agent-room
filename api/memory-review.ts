import { createHash, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Room } from '@agent-room/shared';
import {
  MemoryReviewService,
  MemoryServiceError,
  PostgresMemoryRepository,
  ReviewerPolicy,
  isMemoryReviewRejectionReason,
  type MemoryReviewResult,
  type TrustedMemoryReviewer,
} from '@agent-room/memory';
import { createRemoteRoomClient, getRoom, RemoteRoomApiError } from './_mcpRoomClient.js';
import { notifyRejectedMemoryProposal, notifySupersededMemoryProposals, reviewerDirectory } from './_memoryTools.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MemoryReviewApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'MemoryReviewApiError';
  }
}

export interface MemoryReviewRoomContext {
  readonly roomInstanceId: string;
  /** Room code, used to resolve live reviewer seats. */
  readonly code?: string;
}

export interface MemoryReviewRuntimeContext {
  readonly service: Pick<MemoryReviewService, 'listPending' | 'review' | 'supersededProposalNotices'>;
  readonly caller: TrustedMemoryReviewer;
  notifySuperseded?(result: MemoryReviewResult): Promise<boolean | undefined>;
  notifyRejected?(result: MemoryReviewResult): Promise<boolean | undefined>;
  close(): Promise<void>;
}

export interface MemoryReviewHttpRuntime {
  resolveRoom(code: string, hostKey: string): Promise<MemoryReviewRoomContext>;
  createContext(room: MemoryReviewRoomContext): Promise<MemoryReviewRuntimeContext>;
}

export interface MemoryReviewRoomOperations {
  getRoom(code: string): Promise<Room>;
}

function hostKeyMatches(room: Room, hostKey: string): boolean {
  const expected = room.hostKeyHash;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const actualBuffer = createHash('sha256').update(hostKey, 'utf8').digest();
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Verify against the same Room snapshot used to obtain its immutable UUID. */
export async function verifyMemoryReviewRoom(
  code: string,
  hostKey: string,
  operations: MemoryReviewRoomOperations,
): Promise<MemoryReviewRoomContext> {
  if (typeof code !== 'string' || !code.trim() || code.length > 64
    || typeof hostKey !== 'string' || !hostKey.trim() || hostKey.length > 256) {
    throw new MemoryReviewApiError('INVALID_INPUT', 400);
  }
  let room: Room;
  try {
    room = await operations.getRoom(code);
  } catch (error) {
    if (error instanceof RemoteRoomApiError && error.status === 404) {
      throw new MemoryReviewApiError('NOT_FOUND', 404);
    }
    throw new MemoryReviewApiError('STORAGE_ERROR', 503);
  }
  if (room.status !== 'active') throw new MemoryReviewApiError('NOT_FOUND', 404);
  // Missing hostKeyHash is a legacy unauthenticated room. P5 does not allow
  // the legacy host-name claim shortcut for memory review.
  if (!hostKeyMatches(room, hostKey)) throw new MemoryReviewApiError('FORBIDDEN', 403);
  if (typeof room.roomInstanceId !== 'string' || !UUID_PATTERN.test(room.roomInstanceId)) {
    throw new MemoryReviewApiError('REVIEW_REQUIRED', 409);
  }
  return { roomInstanceId: room.roomInstanceId };
}

function productionRuntime(): MemoryReviewHttpRuntime {
  return {
    async resolveRoom(code, hostKey) {
      const client = createRemoteRoomClient(undefined);
      const verified = await verifyMemoryReviewRoom(code, hostKey, { getRoom: roomCode => getRoom(client, roomCode) });
      return { ...verified, code };
    },
    async createContext(room) {
      const databaseUrl = process.env.MEMORY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
      if (!databaseUrl) throw new MemoryReviewApiError('STORAGE_ERROR', 503);
      const repository = await PostgresMemoryRepository.connect({ connectionString: databaseUrl });
      const role = process.env.MEMORY_REVIEWER_ROLE?.trim() || 'project-analyst';
      // The hostKey proves the owner; reviewer seats come from live seatKey-bound
      // participants, so the owner may decide only when every reviewer is offline.
      const client = createRemoteRoomClient(undefined);
      const seats = room.code ? reviewerDirectory(client, room.code) : null;
      const policy = new ReviewerPolicy({
        findReviewerByRole: async (id, r) => seats ? seats.findReviewerByRole(id, r) : null,
        isAvailable: async (id, identity) => seats ? seats.isAvailable(id, identity) : false,
        listReviewersByRole: async (id, r) => seats ? seats.listReviewersByRole(id, r) : [],
        resolveRoomOwner: async roomInstanceId => ({ type: 'room_owner', id: roomInstanceId }),
      }, role);
      const caller: TrustedMemoryReviewer = {
        roomInstanceId: room.roomInstanceId,
        identity: { type: 'room_owner', id: room.roomInstanceId },
        verified: true,
      };
      const service = new MemoryReviewService(repository, policy);
      const fallbackRoom = room.code ? await getRoom(client, room.code).catch(() => null) : null;
      return {
        service,
        caller,
        notifySuperseded: room.code && fallbackRoom
          ? result => notifySupersededMemoryProposals(
            client, room.code!, fallbackRoom, service, result.proposalId, result.superseded,
          )
          : undefined,
        notifyRejected: room.code && fallbackRoom
          ? result => notifyRejectedMemoryProposal(
            client, room.code!, fallbackRoom!, repository, result, fallbackRoom!.createdBy,
          )
          : undefined,
        close: () => repository.close(),
      };
    },
  };
}

function bodyOf(req: VercelRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function errorResponse(error: unknown): { status: number; code: string } {
  if (error instanceof MemoryReviewApiError) return { status: error.status, code: error.code };
  if (error instanceof MemoryServiceError) {
    const status: Record<string, number> = {
      NOT_FOUND: 404,
      INVALID_INPUT: 400,
      FORBIDDEN: 403,
      PENDING_REVIEW: 202,
      REVIEW_REQUIRED: 409,
      REVIEWER_UNAVAILABLE: 409,
      CONFLICT: 409,
      STORAGE_ERROR: 503,
    };
    return { status: status[error.code] ?? 500, code: error.code };
  }
  return { status: 503, code: 'STORAGE_ERROR' };
}

export function createMemoryReviewHandler(runtime: MemoryReviewHttpRuntime = productionRuntime()) {
  return async function memoryReviewHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ code: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const body = bodyOf(req);
    const action = body.action;
    const code = body.code;
    const hostKey = body.hostKey;
    if (typeof code !== 'string' || typeof hostKey !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }
    if (action !== 'list' && action !== 'approve' && action !== 'reject') {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }
    if ((action === 'approve' || action === 'reject')
      && (typeof body.proposalId !== 'string' || typeof body.requestId !== 'string')) {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }
    if (action === 'reject' && !isMemoryReviewRejectionReason(body.reason)) {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }

    let context: MemoryReviewRuntimeContext | undefined;
    try {
      const room = await runtime.resolveRoom(code, hostKey);
      context = await runtime.createContext(room);
      if (action === 'list') {
        const items = await context.service.listPending(context.caller, {
          limit: typeof body.limit === 'number' ? body.limit : 50,
          offset: typeof body.offset === 'number' ? body.offset : 0,
        });
        res.status(200).json({ items });
        return;
      }
      if (action === 'approve' || action === 'reject') {
        const result = await context.service.review(
          context.caller,
          body.proposalId as string,
          action,
          body.requestId as string,
          action === 'reject' ? body.reason : undefined,
        );
        const supersededNotificationDelivered = action === 'approve'
          ? await context.notifySuperseded?.(result)
          : undefined;
        const rejectionNotificationDelivered = action === 'reject'
          ? await context.notifyRejected?.(result)
          : undefined;
        res.status(200).json({
          ...result,
          ...(supersededNotificationDelivered === undefined ? {} : { supersededNotificationDelivered }),
          ...(rejectionNotificationDelivered === undefined ? {} : { rejectionNotificationDelivered }),
        });
        return;
      }
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json({ code: response.code });
    } finally {
      await context?.close().catch(() => undefined);
    }
  };
}

export default createMemoryReviewHandler();

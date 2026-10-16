import type { MemoryRepository } from './repository.js';
import {
  MemoryConflictError,
  MemoryForbiddenError,
  type ListMemoryOptions,
  type MemoryIdentity,
  type MemoryMutationResult,
  type MemoryProposal,
  type MemoryReviewDecision,
} from './types.js';
import { MemoryServiceError } from './service.js';
import { isMemoryReviewRejectionReason, type MemoryReviewRejectionReason } from './review-reasons.js';

export interface TrustedMemoryReviewer {
  readonly roomInstanceId: string;
  /** Null unless the server could verify this caller's identity. */
  readonly identity: MemoryIdentity | null;
  readonly verified: boolean;
}

export interface ReviewerDirectory {
  /** Return only a role binding whose participant identity was verified server-side. */
  findReviewerByRole(roomInstanceId: string, role: string): Promise<MemoryIdentity | null>;
  /** Presence/seat availability is determined on the server, never from @ text. */
  isAvailable(roomInstanceId: string, reviewer: MemoryIdentity): Promise<boolean>;
  /** Return a verified room_owner identity, or null when it cannot be verified. */
  resolveRoomOwner(roomInstanceId: string): Promise<MemoryIdentity | null>;
  /**
   * Optional: every verified seat bound to the reviewer role, with server-side presence.
   * When absent, the policy falls back to findReviewerByRole + isAvailable (single reviewer).
   */
  listReviewersByRole?(roomInstanceId: string, role: string): Promise<ReviewerSeat[]>;
}

export interface ReviewerSeat {
  readonly identity: MemoryIdentity;
  readonly online: boolean;
}

export interface ReviewerSet {
  /** reviewers: online role seats; owner_fallback: all role seats offline; none: nobody can review. */
  readonly mode: 'reviewers' | 'owner_fallback' | 'none';
  readonly reviewers: readonly MemoryIdentity[];
  /** Role-bound seats that exist but are offline (excluding the proposer). */
  readonly offlineReviewers: readonly MemoryIdentity[];
}

/** Resolves a configured real reviewer, falling back to a verified room owner. */
export class ReviewerPolicy {
  readonly configuredRole: string;

  constructor(private readonly directory: ReviewerDirectory, configuredRole = 'project-analyst') {
    if (typeof configuredRole !== 'string' || !configuredRole.trim() || configuredRole.length > 100) {
      throw new TypeError('A server-configured reviewer role is required.');
    }
    this.configuredRole = configuredRole.trim();
  }

  private async roleSeats(roomInstanceId: string): Promise<ReviewerSeat[]> {
    if (this.directory.listReviewersByRole) {
      return this.directory.listReviewersByRole(roomInstanceId, this.configuredRole);
    }
    const configured = await this.directory.findReviewerByRole(roomInstanceId, this.configuredRole);
    if (!configured) return [];
    return [{ identity: configured, online: await this.directory.isAvailable(roomInstanceId, configured) }];
  }

  /** All identities allowed to review now. Any online reviewer may review; owner only when none is online. */
  async reviewerSet(roomInstanceId: string, excluded?: MemoryIdentity): Promise<ReviewerSet> {
    const online: MemoryIdentity[] = [];
    const offline: MemoryIdentity[] = [];
    for (const seat of await this.roleSeats(roomInstanceId)) {
      const identity = seat.identity;
      if (!identity || identity.type === 'room_owner' || !isValidIdentity(identity)) continue;
      if (excluded && sameIdentity(identity, excluded)) continue;
      const bucket = seat.online ? online : offline;
      if (!bucket.some(known => sameIdentity(known, identity))) bucket.push(copyIdentity(identity));
    }
    const offlineReviewers = offline.filter(identity => !online.some(known => sameIdentity(known, identity)));
    if (online.length) return { mode: 'reviewers', reviewers: online, offlineReviewers };
    const owner = await this.directory.resolveRoomOwner(roomInstanceId);
    if (owner?.type === 'room_owner' && isValidIdentity(owner) && (!excluded || !sameIdentity(owner, excluded))) {
      return { mode: 'owner_fallback', reviewers: [copyIdentity(owner)], offlineReviewers };
    }
    return { mode: 'none', reviewers: [], offlineReviewers };
  }

  /** Back-compat: the first identity allowed to review. */
  async expectedReviewer(roomInstanceId: string, excluded?: MemoryIdentity): Promise<MemoryIdentity | null> {
    return (await this.reviewerSet(roomInstanceId, excluded)).reviewers[0] ?? null;
  }
}

/** Legacy review-provider seam retained for adapters outside the default Jev path. */
export interface ReviewProvider {
  requestDecision(input: {
    readonly roomInstanceId: string;
    readonly proposalId: string;
  }): Promise<MemoryReviewDecision | null>;
}

/** A mention is a notification request only; dispatchers may deliver it separately. */
export interface MemoryReviewMentionNotification {
  readonly kind: 'mention';
  readonly roomInstanceId: string;
  readonly proposalId: string;
  readonly recipient: MemoryIdentity;
}

export interface MemoryReviewNotificationAdapter {
  createMentionNotification(input: MemoryReviewMentionNotification): MemoryReviewMentionNotification;
}

export const memoryReviewNotificationAdapter: MemoryReviewNotificationAdapter = {
  createMentionNotification: input => ({
    kind: 'mention',
    roomInstanceId: input.roomInstanceId,
    proposalId: input.proposalId,
    recipient: copyIdentity(input.recipient),
  }),
};

export interface MemoryReviewProposalView {
  readonly id: string;
  readonly action: MemoryProposal['action'];
  readonly targetMemoryId: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly current?: { readonly title: string; readonly preview: string; readonly content: string };
  readonly createdAt: string;
  readonly reason?: MemoryReviewRejectionReason;
}

export interface MemoryReviewResult {
  readonly status: 'approved' | 'rejected';
  readonly proposalId: string;
  readonly reason?: MemoryReviewRejectionReason;
  readonly version?: number;
  readonly superseded?: readonly string[];
}

export interface MemorySupersededProposalNotice {
  readonly id: string;
  readonly title: string;
  readonly proposer: MemoryIdentity;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidIdentity(value: MemoryIdentity): boolean {
  if (!value || !['persona', 'room_member', 'room_owner'].includes(value.type)
    || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512) return false;
  if (value.type === 'persona') return value.personaId === value.id;
  return value.personaId === undefined;
}

function copyIdentity(identity: MemoryIdentity): MemoryIdentity {
  return {
    type: identity.type,
    id: identity.id,
    ...(identity.personaId ? { personaId: identity.personaId } : {}),
  };
}

function sameIdentity(left: MemoryIdentity, right: MemoryIdentity): boolean {
  return left.type === right.type && left.id === right.id;
}

function proposerOf(proposal: MemoryProposal): MemoryIdentity {
  return {
    type: proposal.proposer_identity_type,
    id: proposal.proposer_identity_id,
    ...(proposal.proposer_persona_id ? { personaId: proposal.proposer_persona_id } : {}),
  };
}

function validateContext(context: TrustedMemoryReviewer): { roomInstanceId: string; identity: MemoryIdentity } {
  if (!context || !context.verified || !context.identity || !isValidIdentity(context.identity)) {
    throw new MemoryServiceError('REVIEW_REQUIRED');
  }
  if (typeof context.roomInstanceId !== 'string' || !UUID_PATTERN.test(context.roomInstanceId)) {
    throw new MemoryServiceError('REVIEW_REQUIRED');
  }
  return { roomInstanceId: context.roomInstanceId, identity: copyIdentity(context.identity) };
}

function validateProposalId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError('proposal_id must be a UUID.');
  return value;
}

function validateDecision(value: unknown): MemoryReviewDecision {
  if (value !== 'approve' && value !== 'reject') throw new TypeError('decision must be approve or reject.');
  return value;
}

function validateRejectionReason(value: unknown): MemoryReviewRejectionReason {
  if (!isMemoryReviewRejectionReason(value)) throw new TypeError('A valid rejection reason is required.');
  return value;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new TypeError('request_id must contain 1 to 128 characters.');
  }
  return value;
}

function proposalView(proposal: MemoryProposal): MemoryReviewProposalView {
  const raw = proposal.payload as Record<string, unknown>;
  const payload: Record<string, string> = {};
  for (const key of ['title', 'preview', 'content', 'searchText', 'sourceMessageId'] as const) {
    if (typeof raw[key] === 'string') payload[key] = raw[key] as string;
  }
  return {
    id: proposal.id,
    action: proposal.action,
    targetMemoryId: proposal.target_memory_id,
    payload,
    createdAt: proposal.created_at.toISOString(),
    ...(isMemoryReviewRejectionReason(proposal.review_reason) ? { reason: proposal.review_reason } : {}),
  };
}

function resultFromRepository(result: MemoryMutationResult, decision: MemoryReviewDecision): MemoryReviewResult {
  if (result.status === 'not_found') throw new MemoryServiceError('NOT_FOUND');
  if (result.status === 'approved' || result.status === 'rejected') {
    return {
      status: result.status,
      proposalId: result.id,
      ...(result.version === undefined ? {} : { version: result.version }),
      ...(result.superseded === undefined ? {} : { superseded: result.superseded }),
    };
  }
  if (result.status === 'pending_review') throw new MemoryServiceError('PENDING_REVIEW');
  throw new MemoryConflictError(`Unexpected result for ${decision}.`);
}

function withReason(
  result: MemoryReviewResult,
  reason: unknown,
): MemoryReviewResult {
  return isMemoryReviewRejectionReason(reason) ? { ...result, reason } : result;
}

/** One business boundary for reviewer selection, authorization, listing, and transactional decisions. */
export class MemoryReviewService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly reviewerPolicy: ReviewerPolicy,
    private readonly notificationAdapter: MemoryReviewNotificationAdapter = memoryReviewNotificationAdapter,
  ) {}

  async listPending(
    context: TrustedMemoryReviewer,
    options: ListMemoryOptions = {},
  ): Promise<MemoryReviewProposalView[]> {
    return this.execute(async () => {
      const trusted = validateContext(context);
      const proposals = await this.repository.listPendingRoomProposals(trusted.roomInstanceId, options);
      const visible = [];
      let denied: MemoryServiceError | undefined;
      for (const proposal of proposals) {
        try {
          await this.assertExpectedReviewer(trusted.roomInstanceId, trusted.identity, proposerOf(proposal));
          visible.push(proposal);
        } catch (error) {
          if (!(error instanceof MemoryServiceError)
            || !['FORBIDDEN', 'REVIEW_REQUIRED', 'REVIEWER_UNAVAILABLE'].includes(error.code)) throw error;
          denied ??= error;
        }
      }
      if (proposals.length === 0) await this.assertExpectedReviewer(trusted.roomInstanceId, trusted.identity);
      if (proposals.length > 0 && visible.length === 0 && denied) throw denied;
      return Promise.all(visible.map(async proposal => {
        const current = proposal.target_memory_id
          ? await this.repository.readEntry(
            { roomInstanceId: trusted.roomInstanceId, scope: 'room' },
            proposal.target_memory_id,
          )
          : null;
        return {
          ...proposalView(proposal),
          ...(current ? { current: { title: current.title, preview: current.preview, content: current.content } } : {}),
        };
      }));
    });
  }

  async review(
    context: TrustedMemoryReviewer,
    proposalId: string,
    decision: MemoryReviewDecision,
    requestId: string,
    reason?: unknown,
  ): Promise<MemoryReviewResult> {
    return this.execute(async () => {
      const trusted = validateContext(context);
      const id = validateProposalId(proposalId);
      const choice = validateDecision(decision);
      const reviewReason = choice === 'reject'
        ? validateRejectionReason(reason)
        : undefined;
      const idempotencyKey = validateRequestId(requestId);
      const proposal = await this.repository.getRoomProposal(trusted.roomInstanceId, id);
      if (!proposal) throw new MemoryServiceError('NOT_FOUND');
      if (proposal.status === 'superseded') throw new MemoryServiceError('CONFLICT');
      if (proposal.proposer_identity_type === trusted.identity.type
        && proposal.proposer_identity_id === trusted.identity.id) {
        throw new MemoryServiceError('FORBIDDEN');
      }

      const previousReviewer = proposal.reviewer_identity_type && proposal.reviewer_identity_id
        ? { type: proposal.reviewer_identity_type, id: proposal.reviewer_identity_id } as MemoryIdentity
        : null;
      if (proposal.status !== 'pending' && (!previousReviewer || !sameIdentity(previousReviewer, trusted.identity))) {
        // First review wins: an otherwise-authorized later reviewer gets CONFLICT.
        await this.assertExpectedReviewer(trusted.roomInstanceId, trusted.identity, proposerOf(proposal));
        throw new MemoryServiceError('CONFLICT');
      }
      if (proposal.status !== 'pending' && previousReviewer && sameIdentity(previousReviewer, trusted.identity)) {
        if ((proposal.status === 'approved' && choice !== 'approve')
          || (proposal.status === 'rejected' && choice !== 'reject')) {
          throw new MemoryServiceError('CONFLICT');
        }
        return withReason(resultFromRepository(
          await this.repository.reviewRoomProposal(trusted.roomInstanceId, id, trusted.identity, choice, idempotencyKey),
          choice,
        ), proposal.review_reason);
      }

      const proposerIdentity: MemoryIdentity = {
        type: proposal.proposer_identity_type,
        id: proposal.proposer_identity_id,
        ...(proposal.proposer_persona_id ? { personaId: proposal.proposer_persona_id } : {}),
      };
      await this.assertExpectedReviewer(trusted.roomInstanceId, trusted.identity, proposerIdentity);
      return withReason(resultFromRepository(
        await this.repository.reviewRoomProposal(
          trusted.roomInstanceId, id, trusted.identity, choice, idempotencyKey, reviewReason,
        ),
        choice,
      ), reviewReason);
    });
  }

  /** Trusted server-only review path used by Jev; it never consults ReviewerPolicy. */
  async reviewAsSystem(
    roomInstanceId: string,
    proposalId: string,
    decision: MemoryReviewDecision,
    reason: unknown,
    requestId: string,
  ): Promise<MemoryReviewResult> {
    return this.execute(async () => {
      if (typeof roomInstanceId !== 'string' || !UUID_PATTERN.test(roomInstanceId)) {
        throw new TypeError('room_instance_id must be a UUID.');
      }
      const id = validateProposalId(proposalId);
      const choice = validateDecision(decision);
      const reviewReason = choice === 'reject' ? validateRejectionReason(reason) : undefined;
      const idempotencyKey = validateRequestId(requestId);
      const reviewer: MemoryIdentity = { type: 'system', id: 'jev' };
      const proposal = await this.repository.getRoomProposal(roomInstanceId, id);
      if (!proposal) throw new MemoryServiceError('NOT_FOUND');
      if (proposal.status === 'superseded') throw new MemoryServiceError('CONFLICT');

      const targetStatus = choice === 'approve' ? 'approved' : 'rejected';
      if (proposal.status !== 'pending'
        && (proposal.status !== targetStatus
          || proposal.reviewer_identity_type !== reviewer.type
          || proposal.reviewer_identity_id !== reviewer.id)) {
        throw new MemoryServiceError('CONFLICT');
      }

      const mutation = await this.repository.reviewRoomProposal(
        roomInstanceId, id, reviewer, choice, idempotencyKey, reviewReason,
      );
      const result = resultFromRepository(mutation, choice);
      return withReason(result, proposal.review_reason ?? reviewReason);
    });
  }

  /** Reviewer role availability for the proposal, excluding its proposer. */
  async reviewerSetForProposal(roomInstanceId: string, proposalId: string): Promise<ReviewerSet> {
    return this.execute(async () => {
      if (typeof roomInstanceId !== 'string' || !UUID_PATTERN.test(roomInstanceId)) {
        throw new TypeError('room_instance_id must be a UUID.');
      }
      const id = validateProposalId(proposalId);
      const proposal = await this.repository.getRoomProposal(roomInstanceId, id);
      if (!proposal) throw new MemoryServiceError('NOT_FOUND');
      if (proposal.status !== 'pending') throw new MemoryServiceError('CONFLICT');
      return this.reviewerPolicy.reviewerSet(proposal.room_instance_id, proposerOf(proposal));
    });
  }

  async supersededProposalNotices(
    roomInstanceId: string,
    proposalIds: readonly string[],
  ): Promise<MemorySupersededProposalNotice[]> {
    if (typeof roomInstanceId !== 'string' || !UUID_PATTERN.test(roomInstanceId)) {
      throw new TypeError('room_instance_id must be a UUID.');
    }
    const proposals = await this.repository.getRoomProposals(roomInstanceId, proposalIds);
    return Promise.all(proposals.map(async proposal => {
      const payload = proposal.payload as Record<string, unknown>;
      const current = proposal.target_memory_id
        ? await this.repository.readEntry(
          { roomInstanceId, scope: 'room' },
          proposal.target_memory_id,
        ).catch(() => null)
        : null;
      return {
        id: proposal.id,
        title: current?.title || (typeof payload.title === 'string' ? payload.title : '') || 'memory',
        proposer: proposerOf(proposal),
      };
    }));
  }

  /** Notify every reviewer allowed to review the proposal (all online reviewers, else the owner fallback). */
  async mentionReviewers(roomInstanceId: string, proposalId: string): Promise<{
    readonly notifications: readonly MemoryReviewMentionNotification[];
    readonly mode: ReviewerSet['mode'];
    readonly reviewCode?: 'REVIEWER_UNAVAILABLE';
  }> {
    return this.execute(async () => {
      if (typeof roomInstanceId !== 'string' || !UUID_PATTERN.test(roomInstanceId)) {
        throw new TypeError('room_instance_id must be a UUID.');
      }
      const id = validateProposalId(proposalId);
      const proposal = await this.repository.getRoomProposal(roomInstanceId, id);
      if (!proposal) throw new MemoryServiceError('NOT_FOUND');
      if (proposal.status !== 'pending') throw new MemoryServiceError('CONFLICT');
      const set = await this.reviewerPolicy.reviewerSet(proposal.room_instance_id, proposerOf(proposal));
      if (set.mode === 'none') throw new MemoryServiceError('REVIEW_REQUIRED');
      return {
        mode: set.mode,
        ...(set.mode === 'owner_fallback' ? { reviewCode: 'REVIEWER_UNAVAILABLE' as const } : {}),
        notifications: set.reviewers.map(recipient => this.notificationAdapter.createMentionNotification({
          kind: 'mention', roomInstanceId: proposal.room_instance_id, proposalId: proposal.id, recipient,
        })),
      };
    });
  }

  async mentionReviewer(roomInstanceId: string, proposalId: string): Promise<MemoryReviewMentionNotification> {
    return this.execute(async () => {
      if (typeof roomInstanceId !== 'string' || !UUID_PATTERN.test(roomInstanceId)) {
        throw new TypeError('room_instance_id must be a UUID.');
      }
      const id = validateProposalId(proposalId);
      const proposal = await this.repository.getRoomProposal(roomInstanceId, id);
      if (!proposal) throw new MemoryServiceError('NOT_FOUND');
      if (proposal.status !== 'pending') throw new MemoryServiceError('CONFLICT');
      const proposerIdentity: MemoryIdentity = {
        type: proposal.proposer_identity_type,
        id: proposal.proposer_identity_id,
        ...(proposal.proposer_persona_id ? { personaId: proposal.proposer_persona_id } : {}),
      };
      const reviewer = await this.reviewerPolicy.expectedReviewer(proposal.room_instance_id, proposerIdentity);
      if (!reviewer) throw new MemoryServiceError('REVIEW_REQUIRED');
      return this.notificationAdapter.createMentionNotification({
        kind: 'mention',
        roomInstanceId: proposal.room_instance_id,
        proposalId: proposal.id,
        recipient: reviewer,
      });
    });
  }

  private async assertExpectedReviewer(
    roomInstanceId: string,
    caller: MemoryIdentity,
    excluded?: MemoryIdentity,
  ): Promise<void> {
    const set = await this.reviewerPolicy.reviewerSet(roomInstanceId, excluded);
    if (set.reviewers.some(reviewer => sameIdentity(reviewer, caller))) return;
    // A reviewer-role seat that is currently offline gets an explicit, actionable code.
    if (set.offlineReviewers.some(reviewer => sameIdentity(reviewer, caller))) {
      throw new MemoryServiceError('REVIEWER_UNAVAILABLE');
    }
    if (set.mode === 'none') throw new MemoryServiceError('REVIEW_REQUIRED');
    throw new MemoryServiceError('FORBIDDEN');
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      if (error instanceof MemoryForbiddenError) throw new MemoryServiceError('FORBIDDEN');
      if (error instanceof MemoryConflictError) throw new MemoryServiceError('CONFLICT');
      if (error instanceof TypeError) throw new MemoryServiceError('INVALID_INPUT');
      throw new MemoryServiceError('STORAGE_ERROR');
    }
  }
}

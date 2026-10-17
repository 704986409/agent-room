import { redactSecretText, type Message } from '@agent-room/shared';
import {
  keywordSimilarity,
  memoryKeywords,
  resolveJevReviewer,
  type MemoryReviewRejectionReason,
  type MemoryRepository,
  type MemoryReviewService,
  type MemoryServiceMutationResult,
} from '@agent-room/memory';
import { buildMemoryReviewOutcomeNoticeMessage } from './_memoryReviewNotify.js';

type PendingResult = Extract<MemoryServiceMutationResult, { code: 'PENDING_REVIEW' }>;

export interface MemoryJevReviewOptions {
  readonly result: PendingResult;
  readonly repository: Pick<MemoryRepository, 'getRoomProposal' | 'readEntry' | 'findRoomCreateDuplicateCandidates'>;
  readonly reviews: Pick<MemoryReviewService, 'reviewAsSystem' | 'reviewerSetForProposal'>;
  readonly roomInstanceId: string;
  readonly proposerName: string;
  readonly appendRoomEvent: (message: Message) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
}

let warnedAboutJevFailure = false;

function safeText(value: string, max = 120): string {
  return redactSecretText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/@/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function warnJevFailure(): void {
  if (warnedAboutJevFailure) return;
  warnedAboutJevFailure = true;
  console.warn('Jev memory review failed; falling back to the existing review flow.');
}

/** Run Jev before notifying humans; undefined means the existing human flow should run. */
export async function tryJevMemoryReview(options: MemoryJevReviewOptions): Promise<Record<string, unknown> | undefined> {
  try {
    const reviewer = resolveJevReviewer(options.env);
    if (!reviewer) return undefined;
    const reviewerSet = await options.reviews.reviewerSetForProposal(options.roomInstanceId, options.result.proposalId);
    if (reviewerSet.mode === 'reviewers' || reviewerSet.offlineReviewers.length > 0) return undefined;
    const proposal = await options.repository.getRoomProposal(options.roomInstanceId, options.result.proposalId);
    if (!proposal) throw new Error('Pending memory proposal was not found.');
    if (proposal.action === 'delete') return undefined;

    const payload = proposal.payload as Record<string, unknown>;
    const current = proposal.action === 'update' && proposal.target_memory_id
      ? await options.repository.readEntry(
        { roomInstanceId: options.roomInstanceId, scope: 'room' },
        proposal.target_memory_id,
      )
      : null;
    if (proposal.action === 'update' && !current) throw new Error('Memory update target was not found.');

    const title = typeof payload.title === 'string' ? payload.title : current?.title;
    const content = typeof payload.content === 'string' ? payload.content : current?.content;
    if (!title || !content) throw new Error('Memory proposal content is incomplete.');

    // Rank the whole room by keyword overlap so Jev sees the most relevant memories, not just the newest.
    const candidateKeywords = memoryKeywords(`${title} ${content}`);
    const existingMemories = (await options.repository.findRoomCreateDuplicateCandidates(
      { roomInstanceId: options.roomInstanceId, scope: 'room' },
    ))
      .filter(entry => entry.id !== proposal.id && entry.id !== proposal.target_memory_id)
      .map(entry => ({ entry, score: keywordSimilarity(candidateKeywords, memoryKeywords(`${entry.title} ${entry.content}`)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ entry }) => ({ title: entry.title, content: entry.content }));
    const decision = await reviewer.review({
      action: proposal.action,
      title,
      content,
      ...(current ? { previousContent: { title: current.title, content: current.content } } : {}),
      existingMemories,
    });
    if (!decision) {
      warnJevFailure();
      return undefined;
    }

    const reviewed = await options.reviews.reviewAsSystem(
      options.roomInstanceId,
      proposal.id,
      decision.decision,
      decision.reason,
      `jev-review-${proposal.id}`,
    );
    const code = reviewed.status === 'approved' ? 'APPROVED' : 'REJECTED';
    // Approvals are silent (the proposer already gets the APPROVED result); only rejections reach the room.
    if (reviewed.status === 'rejected') {
      await Promise.resolve().then(() => options.appendRoomEvent(buildMemoryReviewOutcomeNoticeMessage({
        status: reviewed.status,
        proposerName: options.proposerName,
        reviewerName: 'Jev',
        title: safeText(title),
        ...(reviewed.reason ? { reason: reviewed.reason as MemoryReviewRejectionReason } : {}),
      }))).catch(() => undefined);
    }
    return {
      ...options.result,
      ...reviewed,
      code,
      reviewer: 'jev',
      ...(reviewed.reason ? { reason: reviewed.reason } : {}),
    };
  } catch {
    warnJevFailure();
    return undefined;
  }
}

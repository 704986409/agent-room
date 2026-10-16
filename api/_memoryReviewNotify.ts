// Delivery of shared-memory review requests into the room itself.
//
// `MemoryReviewService.mentionReviewers` only *builds* notification objects —
// it resolves who may review and returns that, which is all the review service
// should know. Returning those objects in the memory_write tool result told the
// proposer who would review and told the reviewer nothing: an agent parked in
// room_listen never woke, and the proposal was only discoverable by polling
// memory_review({ action: 'list' }).
//
// So the notification becomes a real room event here, on the same message list
// room_send writes to. Reviewers are named with `@Name`, which is the room's
// existing "addressed to you" signal (wakesAgent / wakeOn: 'addressed'), so no
// new wake rule is needed — the sys message simply arrives like any other.
//
// Nothing in the text may be a secret: no seatKey, no hostKey, and no memory
// body beyond the author-written preview. Reviewers read the full content with
// memory_review({ action: 'list' }) once they are awake.

import { redactSecretText } from '@agent-room/shared';
import type { Message } from '@agent-room/shared';

export type MemoryProposalKind = 'create' | 'update' | 'delete';

/** Everything the room message says, already resolved to room participant names. */
export interface MemoryReviewNotice {
  readonly proposalId: string;
  readonly kind: MemoryProposalKind;
  /** Room participant names to address, in notification order. */
  readonly recipientNames: readonly string[];
  readonly proposerName: string;
  readonly title?: string | undefined;
  readonly preview?: string | undefined;
  /** No reviewer seat was online, so the recipient is the host/owner. */
  readonly ownerFallback?: boolean;
}

export interface MemorySupersededNoticeItem {
  readonly proposalId: string;
  readonly title: string;
  readonly proposerName: string;
  readonly winningProposalId: string;
}

/** The room append seam. `_mcpTools.ts` passes `appendRoomEvent` bound to the room client. */
export type MemoryReviewNoticeAppender = (code: string, message: Message) => Promise<unknown>;

const TITLE_MAX_CHARS = 120;
const PREVIEW_MAX_CHARS = 180;
const NAME_MAX_CHARS = 120;

/**
 * One line of room text, safe to interpolate: secrets redacted, control
 * characters and newlines flattened, and `@` dropped so a proposal title
 * cannot smuggle in a mention and widen who this wakes.
 */
function safeText(value: unknown, limit: number): string {
  return redactSecretText(typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/@/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * The reviewer-facing text. Carries the proposalId, what kind of change it is,
 * who proposed it, the title/preview when the author wrote one, and the exact
 * call that decides it.
 */
export function buildMemoryReviewNoticeText(notice: MemoryReviewNotice): string {
  const mentions = notice.recipientNames
    .map(name => safeText(name, NAME_MAX_CHARS))
    .filter(Boolean)
    .map(name => `@${name}`)
    .join(' ');
  const proposer = safeText(notice.proposerName, NAME_MAX_CHARS) || 'An agent';
  const title = safeText(notice.title, TITLE_MAX_CHARS);
  const preview = safeText(notice.preview, PREVIEW_MAX_CHARS);
  return [
    `📝 Memory review needed — ${mentions}:`,
    `${proposer} proposes a shared room memory (${notice.kind}).`,
    `proposalId: ${notice.proposalId}.`,
    ...(title ? [`title: "${title}".`] : []),
    ...(preview ? [`preview: "${preview}".`] : []),
    ...(notice.ownerFallback ? ['No reviewer seat is online, so this is the host\'s call.'] : []),
    `Decide with memory_review({ action: "approve" | "reject", proposalId: "${notice.proposalId}" }).`,
  ].join(' ');
}

/**
 * A server-originated `sys` message, shaped like the task board's events so the
 * room renders it as a system note rather than as someone taking a turn.
 */
export function buildMemoryReviewNoticeMessage(
  notice: MemoryReviewNotice,
  now: number = Date.now(),
): Message {
  return {
    id: now,
    type: 'sys',
    name: 'system',
    initials: 'AR',
    color: '#5B6AFF',
    role: 'System',
    text: buildMemoryReviewNoticeText(notice),
    client: 'cc',
    time: now,
  };
}

export function buildMemorySupersededNoticeMessage(
  items: readonly MemorySupersededNoticeItem[],
  now: number = Date.now(),
): Message {
  const lines = items.map(item => {
    const proposer = safeText(item.proposerName, NAME_MAX_CHARS) || 'the proposer';
    const title = safeText(item.title, TITLE_MAX_CHARS) || 'Untitled memory';
    return `@${proposer} 🗂️ Memory proposal ${item.proposalId} superseded: "${title}" was updated by ${item.winningProposalId}. Re-propose against the latest version if still needed.`;
  });
  return {
    id: now,
    type: 'sys',
    name: 'system',
    initials: 'AR',
    color: '#5B6AFF',
    role: 'System',
    text: lines.join(' '),
    client: 'cc',
    time: now,
  };
}

export async function deliverMemorySupersededNotice(
  append: MemoryReviewNoticeAppender,
  code: string,
  items: readonly MemorySupersededNoticeItem[],
): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    await append(code, buildMemorySupersededNoticeMessage(items));
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    const detail = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? `/${(error as { code: string }).code}`
      : '';
    console.warn(`[room ${code}] superseded memory notice undelivered (${reason}${detail})`);
    return false;
  }
}

/**
 * Post the notice, and never let it break the write it is announcing. The
 * memory proposal is already committed by the time we get here, so a failed
 * append means "nobody was woken", not "nothing happened" — the caller reports
 * that as notificationDelivered: false and the proposal stays in
 * memory_review({ action: 'list' }).
 */
export async function deliverMemoryReviewNotice(
  append: MemoryReviewNoticeAppender,
  code: string,
  notice: MemoryReviewNotice,
): Promise<boolean> {
  if (notice.recipientNames.length === 0) return false;
  try {
    await append(code, buildMemoryReviewNoticeMessage(notice));
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    const detail = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? `/${(error as { code: string }).code}`
      : '';
    console.warn(
      `[room ${code}] memory review notice undelivered for proposal ${notice.proposalId} (${reason}${detail})`,
    );
    return false;
  }
}

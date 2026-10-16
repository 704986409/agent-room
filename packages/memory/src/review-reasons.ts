export const MEMORY_REVIEW_REJECTION_REASONS = [
  '无关记忆',
  '重复记忆',
  '格式不合规',
] as const;

export type MemoryReviewRejectionReason = typeof MEMORY_REVIEW_REJECTION_REASONS[number];

export function isMemoryReviewRejectionReason(value: unknown): value is MemoryReviewRejectionReason {
  return typeof value === 'string'
    && (MEMORY_REVIEW_REJECTION_REASONS as readonly string[]).includes(value);
}

import { createJevClient, type JevNoulAnswer, type JevQuestion } from './jevClient.js';
import type { MemoryProposalAction } from './types.js';
import type { MemoryReviewRejectionReason } from './review-reasons.js';

export const JEV_REVIEW_THRESHOLDS = {
  isChinese: 0.5,
  durable: 0.6,
  concise: 0.5,
  alreadyKnown: 0.6,
} as const;

export interface JevReviewInput {
  readonly action: MemoryProposalAction;
  readonly title: string;
  readonly content: string;
  readonly previousContent?: { readonly title: string; readonly content: string };
  readonly existingMemories: readonly { readonly title: string; readonly content: string }[];
}

export interface JevReviewResult {
  readonly decision: 'approve' | 'reject';
  readonly reason?: MemoryReviewRejectionReason;
}

export interface JevReviewer {
  review(input: JevReviewInput): Promise<JevReviewResult | undefined>;
}

function disabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes(value?.trim().toLowerCase() ?? '');
}

const QUESTIONS: Record<string, JevQuestion> = {
  is_chinese: {
    type: 'noul',
    instructions: '判断记忆的标题和内容是否均为简体中文。',
    criteria: { true: '标题和内容均为简体中文。', false: '标题或内容不是简体中文。' },
  },
  durable: {
    type: 'noul',
    instructions: '判断内容是否是以后任务仍有用的长期规则、事实或踩坑经验，而不是状态进度、一次性细节或闲聊。',
    criteria: {
      true: '以后任务仍可能用到的长期规则、事实或踩坑经验。',
      false: '状态进度、一次性细节、短期信息或闲聊。',
    },
  },
  concise: {
    type: 'noul',
    instructions: '判断记忆是否是简体中文的一句简洁表达，没有臃肿内容、多个事项或明显冗余。',
    criteria: { true: '是一句简洁中文表达，没有多个事项或明显冗余。', false: '不是简体中文，或内容臃肿、包含多个事项、不是一句简洁表达。' },
  },
  already_known: {
    type: 'noul',
    instructions: '判断 existing_memories 中是否已经有一条与这条新记忆意思相同的记忆。',
    criteria: { true: '已有记忆表达相同意思，新记忆不会增加信息。', false: '已有记忆没有表达相同意思。' },
  },
};

export function resolveJevReviewer(env: NodeJS.ProcessEnv = process.env): JevReviewer | undefined {
  const apiKey = env.JEV_API_KEY?.trim();
  if (!apiKey || disabled(env.MEMORY_JEV_REVIEW)) return undefined;
  const client = createJevClient({ apiKey, env });

  return {
    async review(input) {
      if (input.action === 'delete') return undefined;
      const answers = await client.ask({
        action: input.action,
        title: input.title,
        content: input.content,
        ...(input.previousContent ? { previous_content: input.previousContent } : {}),
        existing_memories: input.existingMemories.slice(0, 20),
      }, QUESTIONS);
      const scores = answers as Record<string, JevNoulAnswer>;
      const isChinese = scores.is_chinese!.noul;
      const durable = scores.durable!.noul;
      const concise = scores.concise!.noul;
      const alreadyKnown = scores.already_known!.noul;

      if (isChinese < JEV_REVIEW_THRESHOLDS.isChinese || concise < JEV_REVIEW_THRESHOLDS.concise) {
        return { decision: 'reject', reason: '格式不合规' };
      }
      if (durable < JEV_REVIEW_THRESHOLDS.durable) return { decision: 'reject', reason: '无关记忆' };
      if (alreadyKnown >= JEV_REVIEW_THRESHOLDS.alreadyKnown) {
        return { decision: 'reject', reason: '重复记忆' };
      }
      return { decision: 'approve' };
    },
  };
}

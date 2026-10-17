import { createJevClient, type JevNoulAnswer, type JevQuestion } from './jevClient.js';
import { DEFAULT_DEDUP_CANDIDATE_CAP } from './dedup/nearDuplicate.js';

export interface DuplicateVerifierInput {
  candidate: { title: string; content: string };
  existings: readonly { id: string; kind: 'memory' | 'proposal'; title: string; content: string; score: number }[];
}

/** Indexes into `existings`; null when no candidate passed its threshold. */
export interface DuplicateJudgement {
  duplicate: number | null;
  conflict: number | null;
}

export interface DuplicateVerifier {
  verifyMany(input: DuplicateVerifierInput): Promise<number | null>;
  /**
   * Optional: one call that asks, per candidate, both "same rule/fact (duplicate)?" and
   * "same object and rule but a changed value (conflict)?". Duplicate wins over conflict.
   */
  judgeMany?(input: DuplicateVerifierInput): Promise<DuplicateJudgement>;
}

export const DEFAULT_DEDUP_JEV_MAX_CANDIDATES = DEFAULT_DEDUP_CANDIDATE_CAP;

function disabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes(value?.trim().toLowerCase() ?? '');
}

export const DEFAULT_DEDUP_JEV_THRESHOLD = 0.55;
export const DEFAULT_CONFLICT_JEV_THRESHOLD = 0.7;

function probabilityFrom(configured: string | undefined, fallback: number): number {
  const trimmed = configured?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function thresholdFrom(env: NodeJS.ProcessEnv): number {
  return probabilityFrom(env.MEMORY_DEDUP_JEV_THRESHOLD, DEFAULT_DEDUP_JEV_THRESHOLD);
}

function conflictThresholdFrom(env: NodeJS.ProcessEnv): number {
  return probabilityFrom(env.MEMORY_CONFLICT_JEV_THRESHOLD, DEFAULT_CONFLICT_JEV_THRESHOLD);
}

const DEDUP_STATE = '房间共享记忆去重检查。每个问题比较两条中文记忆。';
const DUPLICATE_QUESTION = '`new_memory` 与 `existing_memory` 表达的是否是同一条规则或事实（即重复，记下 `new_memory` 不会带来新信息）？';
const DUPLICATE_CRITERIA = {
  true: '同一条规则/事实，只是措辞不同',
  false: '不同的规则或事实，或包含实质性的新信息',
};
const CONFLICT_QUESTION = '`new_memory` 是否针对与 `existing_memory` 相同的对象和同一条规则或设置，但给出了不同的值或相反的要求（即改值，两条不能同时成立）？';
const CONFLICT_CRITERIA = {
  true: '同一对象的同一规则或设置，值或要求变了，两条互相矛盾',
  false: '对象不同、规则不同、两条可以同时成立，或只是措辞不同的同一条规则',
};

type Existing = DuplicateVerifierInput['existings'][number];

function pairInstructions(candidate: DuplicateVerifierInput['candidate'], existing: Existing, question: string) {
  return {
    new_memory: { title: candidate.title, content: candidate.content },
    existing_memory: { title: existing.title, content: existing.content },
    question,
  };
}

function bestAbove(
  answers: Record<string, unknown>,
  prefix: string,
  count: number,
  threshold: number,
): { index: number; probability: number } | null {
  let best: { index: number; probability: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const probability = (answers[`${prefix}${index}`] as JevNoulAnswer | undefined)?.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) continue;
    if (probability >= threshold && (best === null || probability > best.probability)) {
      best = { index, probability };
    }
  }
  return best;
}

export function maxJevCandidatesFrom(env: NodeJS.ProcessEnv = process.env): number {
  for (const configured of [env.MEMORY_DEDUP_CANDIDATE_CAP, env.MEMORY_DEDUP_JEV_MAX_CANDIDATES]) {
    const value = Number(configured);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return DEFAULT_DEDUP_JEV_MAX_CANDIDATES;
}

export function resolveDuplicateVerifier(env: NodeJS.ProcessEnv = process.env): DuplicateVerifier | undefined {
  const apiKey = env.JEV_API_KEY?.trim();
  if (!apiKey || disabled(env.MEMORY_DEDUP_VERIFIER)) return undefined;

  const client = createJevClient({
    apiKey,
    env,
    ...(env.MEMORY_DEDUP_VERIFIER_URL?.trim()
      ? { baseUrl: env.MEMORY_DEDUP_VERIFIER_URL.trim() }
      : {}),
  });
  const threshold = thresholdFrom(env);
  const maxCandidates = maxJevCandidatesFrom(env);

  const conflictThreshold = conflictThresholdFrom(env);

  return {
    async verifyMany({ candidate, existings }) {
      const capped = existings.slice(0, maxCandidates);
      if (!capped.length) return null;
      const questions: Record<string, JevQuestion> = {};
      for (const [index, existing] of capped.entries()) {
        questions[`c${index}`] = {
          type: 'noul',
          instructions: pairInstructions(candidate, existing, DUPLICATE_QUESTION),
          criteria: DUPLICATE_CRITERIA,
        };
      }
      const answers = await client.ask(DEDUP_STATE, questions);
      return bestAbove(answers, 'c', capped.length, threshold)?.index ?? null;
    },
    async judgeMany({ candidate, existings }) {
      const capped = existings.slice(0, maxCandidates);
      if (!capped.length) return { duplicate: null, conflict: null };
      const questions: Record<string, JevQuestion> = {};
      for (const [index, existing] of capped.entries()) {
        questions[`c${index}`] = {
          type: 'noul',
          instructions: pairInstructions(candidate, existing, DUPLICATE_QUESTION),
          criteria: DUPLICATE_CRITERIA,
        };
        questions[`x${index}`] = {
          type: 'noul',
          instructions: pairInstructions(candidate, existing, CONFLICT_QUESTION),
          criteria: CONFLICT_CRITERIA,
        };
      }
      const answers = await client.ask(DEDUP_STATE, questions);
      const duplicate = bestAbove(answers, 'c', capped.length, threshold);
      if (duplicate) return { duplicate: duplicate.index, conflict: null };
      const conflict = bestAbove(answers, 'x', capped.length, conflictThreshold);
      return { duplicate: null, conflict: conflict?.index ?? null };
    },
  };
}

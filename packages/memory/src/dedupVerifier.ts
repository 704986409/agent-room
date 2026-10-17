import { createJevClient, type JevNoulAnswer, type JevQuestion } from './jevClient.js';
import { DEFAULT_DEDUP_CANDIDATE_CAP } from './dedup/nearDuplicate.js';

export interface DuplicateVerifier {
  verifyMany(input: {
    candidate: { title: string; content: string };
    existings: readonly { id: string; kind: 'memory' | 'proposal'; title: string; content: string; score: number }[];
  }): Promise<number | null>;
}

export const DEFAULT_DEDUP_JEV_MAX_CANDIDATES = DEFAULT_DEDUP_CANDIDATE_CAP;

function disabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes(value?.trim().toLowerCase() ?? '');
}

function thresholdFrom(env: NodeJS.ProcessEnv): number {
  const configured = env.MEMORY_DEDUP_JEV_THRESHOLD?.trim();
  if (!configured) return 0.7;
  const value = Number(configured);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.7;
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

  return {
    async verifyMany({ candidate, existings }) {
      const capped = existings.slice(0, maxCandidates);
      if (!capped.length) return null;
      const questions: Record<string, JevQuestion> = {};
      for (const [index, existing] of capped.entries()) {
        questions[`c${index}`] = {
          type: 'noul',
          instructions: {
            new_memory: { title: candidate.title, content: candidate.content },
            existing_memory: { title: existing.title, content: existing.content },
            question: '`new_memory` 与 `existing_memory` 表达的是否是同一条规则或事实（即重复，记下 `new_memory` 不会带来新信息）？',
          },
          criteria: {
            true: '同一条规则/事实，只是措辞不同',
            false: '不同的规则或事实，或包含实质性的新信息',
          },
        };
      }
      const answers = await client.ask('房间共享记忆去重检查。每个问题比较两条中文记忆。', questions);
      let bestIndex: number | null = null;
      let bestProbability = threshold;
      for (let index = 0; index < capped.length; index += 1) {
        const answer = answers[`c${index}`] as JevNoulAnswer;
        if (answer.noul >= threshold && (bestIndex === null || answer.noul > bestProbability)) {
          bestIndex = index;
          bestProbability = answer.noul;
        }
      }
      return bestIndex;
    },
  };
}

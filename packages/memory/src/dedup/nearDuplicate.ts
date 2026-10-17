import type { Embedder } from '../embedding/embedder.js';
import type { DuplicateVerifier } from '../dedupVerifier.js';
import { memoryKeywords, keywordSimilarity } from '../keywords.js';
import type { MemoryRepository } from '../repository.js';
import { normalizeForDuplicate } from '../normalize.js';
import type { MemoryContent, MemoryEmbedding, MemoryMutationResult } from '../types.js';

export const DEFAULT_DEDUP_CANDIDATE_CAP = 20;

export interface NearDuplicateCandidate {
  id: string;
  kind: 'memory' | 'proposal';
  title: string;
  content: string;
  embedding?: number[] | null;
}

export type CandidateRanking = 'cosine' | 'keyword';

export interface RankedNearDuplicateCandidate extends NearDuplicateCandidate {
  /** Score used for ordering, supplied to the verifier for context. */
  score: number;
  keywordScore: number;
  cosineScore?: number;
}

export interface CandidateRankingResult {
  candidates: RankedNearDuplicateCandidate[];
  ranking: CandidateRanking;
}

function validVector(vector: number[] | null | undefined): vector is number[] {
  return Array.isArray(vector) && vector.length > 0
    && vector.every(value => Number.isFinite(value));
}

function cosineSimilarity(left: number[], right: number[]): number | undefined {
  if (left.length !== right.length || left.length === 0) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizedCap(cap: number): number {
  return Number.isSafeInteger(cap) && cap > 0 ? cap : DEFAULT_DEDUP_CANDIDATE_CAP;
}

/** Pure, deterministic candidate ranking for live evaluation and service use. */
export function rankNearDuplicateCandidates(
  candidates: readonly NearDuplicateCandidate[],
  queryText: string,
  queryVector?: number[] | null,
  cap = DEFAULT_DEDUP_CANDIDATE_CAP,
): CandidateRankingResult {
  const limit = normalizedCap(cap);
  const queryKeywords = memoryKeywords(queryText);
  const withKeywords = candidates.map(candidate => ({
    ...candidate,
    keywordScore: keywordSimilarity(
      queryKeywords,
      memoryKeywords(`${candidate.title} ${candidate.content}`),
    ),
  }));
  const queryUsable = validVector(queryVector);
  const cosineScores = queryUsable
    ? withKeywords.map(candidate => ({
      candidate,
      cosineScore: validVector(candidate.embedding)
        ? cosineSimilarity(queryVector, candidate.embedding)
        : undefined,
    }))
    : [];
  const usableVectorCount = cosineScores.filter(item => item.cosineScore !== undefined).length;

  if (queryUsable && usableVectorCount * 2 >= candidates.length) {
    const ranked = cosineScores
      .filter((item): item is typeof item & { cosineScore: number } => item.cosineScore !== undefined)
      .sort((a, b) => b.cosineScore - a.cosineScore || a.candidate.id.localeCompare(b.candidate.id))
      .slice(0, limit)
      .map(({ candidate, cosineScore }) => ({
        ...candidate,
        score: cosineScore,
        cosineScore,
      }));
    return { candidates: ranked, ranking: 'cosine' };
  }

  const ranked = withKeywords
    .sort((a, b) => b.keywordScore - a.keywordScore || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(candidate => ({ ...candidate, score: candidate.keywordScore }));
  return { candidates: ranked, ranking: 'keyword' };
}

let warnedAboutVerifierFailure = false;

/** An existing approved memory or pending proposal that the new write would contradict. */
export interface MemoryConflict {
  id: string;
  kind: 'memory' | 'proposal';
  title: string;
  content: string;
}

export interface NearDuplicateOutcome {
  duplicateResult?: MemoryMutationResult;
  conflict?: MemoryConflict;
  embedding?: MemoryEmbedding;
}

async function embedContent(
  content: Pick<MemoryContent, 'title' | 'content'>,
  embedder: Embedder | undefined,
): Promise<number[] | undefined> {
  if (!embedder) return undefined;
  try {
    const vectors = await embedder.embed([`${content.title} ${content.content}`]);
    const vector = vectors?.[0];
    return validVector(vector) ? vector : undefined;
  } catch {
    return undefined;
  }
}

export async function embedRoomContent(
  content: Pick<MemoryContent, 'title' | 'content'>,
  embedder: Embedder | undefined,
  model: string,
): Promise<MemoryEmbedding | undefined> {
  const vector = await embedContent(content, embedder);
  return vector ? { vector, model } : undefined;
}

export async function findNearDuplicate(
  input: {
    repository: MemoryRepository;
    scope: { roomInstanceId: string; scope: 'room' };
    content: MemoryContent;
    verifier: DuplicateVerifier;
    embedder?: Embedder;
    embeddingModel: string;
    cap: number;
  },
): Promise<NearDuplicateOutcome> {
  const rawCandidates = await input.repository.findRoomCreateDuplicateCandidates(input.scope);
  // Same title alone is not a duplicate (e.g. two different facts about data.csv); the body must match.
  const exact = rawCandidates.find(candidate =>
    normalizeForDuplicate(candidate.content) === normalizeForDuplicate(input.content.content));
  if (exact) {
    return {
      duplicateResult: exact.kind === 'proposal'
        ? { status: 'pending_review', id: exact.id, duplicateOf: exact.id }
        : { status: 'duplicate', id: exact.id, duplicateOf: exact.id, duplicateKind: 'memory' },
    };
  }

  const embedding = await embedRoomContent(input.content, input.embedder, input.embeddingModel);
  const queryText = `${input.content.title} ${input.content.content}`;
  const ranked = rankNearDuplicateCandidates(rawCandidates, queryText, embedding?.vector, input.cap);
  if (ranked.candidates.length === 0) return { ...(embedding ? { embedding } : {}) };

  try {
    const verifierInput = {
      candidate: { title: input.content.title, content: input.content.content },
      existings: ranked.candidates.map(({ id, kind, title, content, score }) => ({
        id, kind, title, content, score,
      })),
    };
    const judgement = input.verifier.judgeMany
      ? await input.verifier.judgeMany(verifierInput)
      : { duplicate: await input.verifier.verifyMany(verifierInput), conflict: null };
    const duplicate = judgement.duplicate === null ? undefined : ranked.candidates[judgement.duplicate];
    const duplicateResult = duplicate?.kind === 'proposal'
      ? { status: 'pending_review' as const, id: duplicate.id, duplicateOf: duplicate.id }
      : duplicate?.kind === 'memory'
        ? { status: 'duplicate' as const, id: duplicate.id, duplicateOf: duplicate.id, duplicateKind: 'memory' as const }
        : undefined;
    const conflicting = duplicateResult || judgement.conflict === null
      ? undefined
      : ranked.candidates[judgement.conflict];
    const conflict = conflicting
      ? { id: conflicting.id, kind: conflicting.kind, title: conflicting.title, content: conflicting.content }
      : undefined;
    return {
      ...(duplicateResult ? { duplicateResult } : {}),
      ...(conflict ? { conflict } : {}),
      ...(embedding ? { embedding } : {}),
    };
  } catch {
    if (!warnedAboutVerifierFailure) {
      warnedAboutVerifierFailure = true;
      console.warn('Memory duplicate verifier failed; treating the candidate as not duplicate.');
    }
    return { ...(embedding ? { embedding } : {}) };
  }
}

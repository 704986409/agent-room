export const DEFAULT_JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';
export const DEFAULT_JEV_TIMEOUT_MS = 5000;

export class JevError extends Error {
  constructor(readonly status: number, message = 'Jev request failed.') {
    super(message);
    this.name = 'JevError';
  }
}

export interface JevQuestion {
  readonly type: 'noul' | 'choice';
  readonly instructions: string | Record<string, unknown>;
  readonly criteria: Record<string, string>;
}

export interface JevNoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export interface JevChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;
export type JevFetch = typeof fetch;

export interface JevClientOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: JevFetch;
  readonly baseUrl?: string;
  /** Internal/test configuration source; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

function envTimeout(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.JEV_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_JEV_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validAnswer(value: unknown, question: JevQuestion): value is JevAnswer {
  if (!isRecord(value) || value.type !== question.type) return false;
  if (question.type === 'noul') return isScore(value.noul);
  if (typeof value.choice !== 'string' || !isScore(value.confidence) || !isRecord(value.probabilities)) return false;
  return Object.values(value.probabilities).every(isScore);
}

export function createJevClient(options: JevClientOptions) {
  const env = options.env ?? process.env;
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  const model = options.model?.trim() || env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  const timeoutMs = options.timeoutMs ?? envTimeout(env);
  const baseUrl = options.baseUrl?.trim() || env.JEV_API_URL?.trim() || DEFAULT_JEV_API_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!apiKey) throw new JevError(0, 'Jev API key is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new JevError(0, 'Jev timeout must be positive.');
  if (typeof model !== 'string' || !model.trim()) throw new JevError(0, 'Jev model is required.');

  return {
    async ask<T extends Record<string, JevAnswer> = Record<string, JevAnswer>>(
      state: string | Record<string, unknown>,
      questions: Record<string, JevQuestion>,
    ): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(baseUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: model.trim(), state, questions }),
            signal: controller.signal,
          });
        } catch {
          throw new JevError(0, 'Jev request failed.');
        }

        if (!response.ok) throw new JevError(response.status, 'Jev request failed.');

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new JevError(response.status, 'Jev returned invalid JSON.');
        }
        if (!isRecord(payload) || !isRecord(payload.answers)) {
          throw new JevError(response.status, 'Jev returned an invalid response.');
        }
        for (const [id, question] of Object.entries(questions)) {
          if (!Object.hasOwn(payload.answers, id) || !validAnswer(payload.answers[id], question)) {
            throw new JevError(response.status, 'Jev response is missing a valid answer.');
          }
        }
        return payload.answers as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

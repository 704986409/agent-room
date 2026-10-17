import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface Embedder {
  embed(texts: string[]): Promise<number[][] | null>;
}

type WorkerMessage =
  | { type: 'result'; id: number; vectors: number[][] }
  | { type: 'error'; id: number; fatal: true };

type WorkerConfig = {
  model: string;
  cacheDir: string;
  allowRemoteModels: boolean;
};

interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: WorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  unref(): this;
  terminate(): Promise<number>;
}

export type EmbeddingWorkerFactory = (url: URL, config: WorkerConfig) => WorkerLike;

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_EMBEDDING_CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-room', 'models');
const DEFAULT_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 10 * 60 * 1000;
let warnedAboutEmbeddingFailure = false;

export function embeddingModelFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function embeddingCacheDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORY_EMBEDDING_CACHE_DIR?.trim() || DEFAULT_EMBEDDING_CACHE_DIR;
}

export function embeddingTimeoutFrom(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MEMORY_EMBEDDING_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_TIMEOUT_MS;
}

function disabled(value: string | undefined): boolean {
  return ['0', 'false', 'off'].includes(value?.trim().toLowerCase() ?? '');
}

function enabledByEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.JEV_API_KEY?.trim())
    && !disabled(env.MEMORY_DEDUP_VERIFIER)
    && !disabled(env.MEMORY_EMBEDDING);
}

function validVectors(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row)
    && row.every(item => typeof item === 'number' && Number.isFinite(item)));
}

export class WorkerEmbedder implements Embedder {
  private worker: WorkerLike | undefined;
  private readonly pending = new Map<number, {
    resolve: (vectors: number[][] | null) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private unavailableUntil = 0;
  private closed = false;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly workerFactory: EmbeddingWorkerFactory;
  private readonly now: () => number;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    options: {
      workerFactory?: EmbeddingWorkerFactory;
      now?: () => number;
    } = {},
  ) {
    this.model = embeddingModelFrom(env);
    this.timeoutMs = embeddingTimeoutFrom(env);
    this.now = options.now ?? Date.now;
    this.workerFactory = options.workerFactory ?? ((url, config) => new Worker(url, {
      workerData: config,
    }) as unknown as WorkerLike);
    this.config = {
      model: this.model,
      cacheDir: embeddingCacheDirFrom(env),
      allowRemoteModels: env.MEMORY_EMBEDDING_ALLOW_DOWNLOAD !== 'false',
    };
  }

  private readonly config: WorkerConfig;

  async embed(texts: string[]): Promise<number[][] | null> {
    if (this.closed || texts.length === 0 || this.now() < this.unavailableUntil) return null;
    const worker = this.ensureWorker();
    if (!worker) return null;

    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        worker.postMessage({ type: 'embed', id, texts });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
        this.handleWorkerFailure(worker);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private ensureWorker(): WorkerLike | undefined {
    if (this.worker) return this.worker;
    try {
      const worker = this.workerFactory(new URL('./embedWorker.js', import.meta.url), this.config);
      this.worker = worker;
      worker.unref();
      worker.on('message', message => this.handleMessage(message));
      worker.on('error', () => this.handleWorkerFailure(worker));
      worker.on('exit', () => this.handleWorkerFailure(worker));
      return worker;
    } catch {
      return undefined;
    }
  }

  private handleMessage(message: WorkerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (message.type === 'error' && message.fatal) {
        this.markModelUnavailable();
        const worker = this.worker;
        this.worker = undefined;
        if (worker) void worker.terminate().catch(() => undefined);
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.type === 'result' && validVectors(message.vectors)) {
      pending.resolve(message.vectors);
      return;
    }
    pending.resolve(null);
    this.markModelUnavailable();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private handleWorkerFailure(worker: WorkerLike): void {
    if (this.worker === worker) {
      this.worker = undefined;
      void worker.terminate().catch(() => undefined);
    }
    this.failPending();
  }

  private failPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(null);
    }
  }

  private markModelUnavailable(): void {
    this.unavailableUntil = this.now() + RETRY_DELAY_MS;
    if (!warnedAboutEmbeddingFailure) {
      warnedAboutEmbeddingFailure = true;
      console.warn('Memory embedding model unavailable; semantic retrieval will retry later.');
    }
  }
}

/** Direct construction intentionally bypasses Jev gating for offline scripts and tests. */
export function createEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  options: ConstructorParameters<typeof WorkerEmbedder>[1] = {},
): WorkerEmbedder {
  return new WorkerEmbedder(env, options);
}

let singleton: WorkerEmbedder | undefined;

/** Return the process-wide lazy embedder only while Jev dedup and embeddings are enabled. */
export function resolveEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | undefined {
  if (!enabledByEnvironment(env)) return undefined;
  singleton ??= createEmbedder(env);
  return singleton;
}

export async function closeEmbedder(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.close();
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeEmbedder, resolveEmbedder, WorkerEmbedder, type EmbeddingWorkerFactory } from './embedder.js';

type Request = { type: 'embed'; id: number; texts: string[] };

class FakeWorker {
  private readonly listeners = new Map<string, ((value: never) => void)[]>();
  onPostMessage: ((request: Request, worker: FakeWorker) => void) | undefined;
  unrefCalls = 0;
  terminateCalls = 0;

  postMessage(message: unknown): void {
    this.onPostMessage?.(message as Request, this);
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener(value as never);
  }

  error(value: Error): void {
    for (const listener of this.listeners.get('error') ?? []) listener(value as never);
  }
}

function factoryFor(worker: FakeWorker): EmbeddingWorkerFactory {
  return (() => worker as never) as EmbeddingWorkerFactory;
}

describe('WorkerEmbedder', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('gates resolution on Jev dedup, respects embedding disable, and keeps one process singleton', async () => {
    expect(resolveEmbedder({ JEV_API_KEY: '' })).toBeUndefined();
    expect(resolveEmbedder({ JEV_API_KEY: 'test', MEMORY_DEDUP_VERIFIER: 'off' })).toBeUndefined();
    expect(resolveEmbedder({ JEV_API_KEY: 'test', MEMORY_EMBEDDING: 'false' })).toBeUndefined();

    const first = resolveEmbedder({ JEV_API_KEY: 'test', MEMORY_EMBEDDING_MODEL: 'model-a' });
    const second = resolveEmbedder({ JEV_API_KEY: 'test', MEMORY_EMBEDDING_MODEL: 'model-b' });
    expect(first).toBeDefined();
    expect(second).toBe(first);
    await closeEmbedder();
  });

  it('spawns lazily on the first embed and unrefs the worker', async () => {
    const worker = new FakeWorker();
    worker.onPostMessage = ({ id }) => queueMicrotask(() => worker.message({
      type: 'result', id, vectors: [[1, 0]],
    }));
    const factory = vi.fn(factoryFor(worker));
    const embedder = new WorkerEmbedder({}, { workerFactory: factory });

    expect(factory).not.toHaveBeenCalled();
    const result = await embedder.embed(['中文记忆']);
    expect(result).toEqual([[1, 0]]);
    expect(factory).toHaveBeenCalledOnce();
    expect(String(factory.mock.calls[0]?.[0])).toMatch(/embedWorker\.js$/u);
    expect(worker.unrefCalls).toBe(1);
    await embedder.close();
  });

  it('resolves null when an embedding call times out', async () => {
    const worker = new FakeWorker();
    const embedder = new WorkerEmbedder(
      { MEMORY_EMBEDDING_TIMEOUT_MS: '10' },
      { workerFactory: factoryFor(worker) },
    );

    await expect(embedder.embed(['模型仍在加载'])).resolves.toBeNull();
    await embedder.close();
  });

  it('returns null on worker errors and respawns on the next call', async () => {
    const failedWorker = new FakeWorker();
    failedWorker.onPostMessage = () => queueMicrotask(() => failedWorker.error(new Error('worker failed')));
    const replacementWorker = new FakeWorker();
    replacementWorker.onPostMessage = ({ id }) => queueMicrotask(() => replacementWorker.message({
      type: 'result', id, vectors: [[0, 1]],
    }));
    const workers = [failedWorker, replacementWorker];
    let nextWorker = 0;
    const factory = vi.fn((() => workers[nextWorker++]! as never) as EmbeddingWorkerFactory);
    const embedder = new WorkerEmbedder({}, { workerFactory: factory });

    await expect(embedder.embed(['第一次调用'])).resolves.toBeNull();
    await expect(embedder.embed(['重新生成 worker'])).resolves.toEqual([[0, 1]]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(failedWorker.terminateCalls).toBe(1);
    await embedder.close();
  });

  it('marks a model load failure unavailable and warns once', async () => {
    const worker = new FakeWorker();
    worker.onPostMessage = ({ id }) => queueMicrotask(() => worker.message({
      type: 'error', id, fatal: true,
    }));
    const factory = vi.fn(factoryFor(worker));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const embedder = new WorkerEmbedder({}, { workerFactory: factory });

    await expect(embedder.embed(['加载失败'])).resolves.toBeNull();
    await expect(embedder.embed(['冷却期间'])).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    await embedder.close();
  });
});

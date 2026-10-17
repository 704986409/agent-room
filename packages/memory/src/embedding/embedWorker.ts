import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

type WorkerConfig = {
  model: string;
  cacheDir: string;
  allowRemoteModels: boolean;
};

type EmbedRequest = { type: 'embed'; id: number; texts: string[] };

if (!parentPort) throw new Error('Embedding worker requires a parent port.');

const config = workerData as WorkerConfig;
env.cacheDir = config.cacheDir;
env.allowRemoteModels = config.allowRemoteModels;

let extractor: Promise<((texts: string[], options: { pooling: 'cls'; normalize: true }) => Promise<{
  tolist(): unknown;
}>)> | undefined;

function loadExtractor() {
  extractor ??= pipeline('feature-extraction', config.model, {
    dtype: 'fp32',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  }) as unknown as typeof extractor;
  return extractor;
}

parentPort.on('message', (message: EmbedRequest) => {
  if (message?.type !== 'embed' || !Number.isSafeInteger(message.id) || !Array.isArray(message.texts)) return;
  void (async () => {
    try {
      const model = await loadExtractor();
      const output = await model!(message.texts, { pooling: 'cls', normalize: true });
      const vectors = output.tolist();
      if (!Array.isArray(vectors)) throw new Error('Invalid embedding output.');
      parentPort!.postMessage({ type: 'result', id: message.id, vectors });
    } catch {
      parentPort!.postMessage({ type: 'error', id: message.id, fatal: true });
    }
  })();
});

import os from 'node:os';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

const model = process.env.MEMORY_EMBEDDING_MODEL?.trim() || 'Xenova/bge-small-zh-v1.5';
env.cacheDir = process.env.MEMORY_EMBEDDING_CACHE_DIR?.trim()
  || path.join(os.homedir(), '.cache', 'agent-room', 'models');
env.allowRemoteModels = process.env.MEMORY_EMBEDDING_ALLOW_DOWNLOAD !== 'false';

await pipeline('feature-extraction', model, {
  dtype: 'fp32',
  session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
});
process.stdout.write(`Embedding model ready: ${model}\n`);

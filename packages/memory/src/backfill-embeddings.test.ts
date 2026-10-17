import { describe, expect, it, vi } from 'vitest';
import { backfillEmbeddings } from './backfill-embeddings.js';
import { storedEmbeddingModelFrom } from './embedding/embedder.js';

describe('backfillEmbeddings', () => {
  it('embeds content only (titles ignored) and tags vectors with the content text version', async () => {
    const row = { id: '11111111-1111-4111-8111-111111111111', room_instance_id: '22222222-2222-4222-8222-222222222222', title: '某个标题', content: '订单服务的超时时间统一设为 30 秒。' };
    let selects = 0;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.trim().startsWith('SELECT')) {
        selects += 1;
        return { rows: selects === 1 ? [row] : [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
    const result = await backfillEmbeddings({ pool: { query } as never, embedder: { embed } });
    expect(embed).toHaveBeenCalledWith([row.content]);
    expect(result.entriesUpdated).toBe(1);
    const tag = storedEmbeddingModelFrom({});
    expect(tag).toBe('Xenova/bge-small-zh-v1.5#content-v1');
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(tag);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE agent_memory_entries'));
    expect(update?.[1]?.[2]).toBe(tag);
  });
});

import { useEffect, useState } from 'react';

interface MemoryReviewItem {
  id: string;
  action: 'create' | 'update' | 'delete';
  targetMemoryId: string | null;
  payload: { title?: string; preview?: string; content?: string; searchText?: string; sourceMessageId?: string };
  current?: { title: string; preview: string; content: string };
  createdAt: string;
}

interface MemoryReviewPanelProps {
  roomCode: string;
  isHost: boolean;
  ended: boolean;
}

function storedHostKey(roomCode: string): string | null {
  try {
    return localStorage.getItem(`room:${roomCode}:hostKey`);
  } catch {
    return null;
  }
}

export function MemoryReviewPanel({ roomCode, isHost, ended }: MemoryReviewPanelProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MemoryReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function callApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const hostKey = storedHostKey(roomCode);
    if (!hostKey) throw new Error('Host key is unavailable in this browser.');
    const response = await fetch('/api/memory-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, code: roomCode, hostKey }),
    });
    const result: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof result === 'object' && result !== null && 'code' in result
        ? String((result as { code: unknown }).code)
        : 'STORAGE_ERROR';
      throw new Error(code);
    }
    return typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const result = await callApi({ action: 'list', limit: 50, offset: 0 });
      setItems(Array.isArray(result.items) ? result.items as MemoryReviewItem[] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'STORAGE_ERROR');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open, roomCode]);

  async function decide(item: MemoryReviewItem, action: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await callApi({
        action,
        proposalId: item.id,
        requestId: globalThis.crypto.randomUUID(),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'STORAGE_ERROR');
      setBusy(false);
    }
  }

  if (!isHost) return null;
  return (
    <>
      <button
        type="button"
        disabled={ended}
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-1.5 text-[10px] font-semibold text-ink-muted hover:bg-surface-softer disabled:opacity-50"
        aria-label="Open shared memory reviews"
      >
        Memory review{items.length ? ` · ${items.length}` : ''}
      </button>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-3" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-review-title"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border-faint px-4 py-3">
              <div>
                <h2 id="memory-review-title" className="text-sm font-semibold text-ink">Shared memory proposals</h2>
                <p className="mt-0.5 text-[11px] text-ink-soft">The server verifies the reviewer; the Room owner confirms when no reviewer is available.</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void refresh()} disabled={busy} className="text-xs font-semibold text-accent disabled:opacity-50">Refresh</button>
                <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-softer" aria-label="Close memory reviews">×</button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {error && (
                <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Review API state: {error}. Proposals remain pending until a verified reviewer completes the decision.
                </div>
              )}
              {busy && <div className="py-4 text-center text-xs text-ink-soft">Loading…</div>}
              {!busy && !error && items.length === 0 && <div className="py-4 text-center text-xs text-ink-soft">No pending proposals.</div>}
              <div className="space-y-3">
                {items.map(item => (
                  <article key={item.id} className="rounded-lg border border-border-faint bg-surface-softer p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-ink">{item.action.toUpperCase()} · {item.payload.title || item.current?.title || item.targetMemoryId || 'Shared memory'}</div>
                        {item.current && <p className="mt-1 text-[11px] text-ink-soft">Current: {item.current.preview}</p>}
                        {item.payload.preview && <p className="mt-1 text-[11px] text-ink-soft">Proposed preview: {item.payload.preview}</p>}
                        {item.current && <details className="mt-2 rounded bg-white p-2 text-[11px]"><summary className="cursor-pointer font-semibold">Current content</summary><pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">{item.current.content}</pre></details>}
                        {item.payload.content && <details className="mt-2 rounded bg-white p-2 text-[11px]" open><summary className="cursor-pointer font-semibold">Proposed content</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink-muted">{item.payload.content}</pre></details>}
                        {item.payload.searchText && <p className="mt-2 break-words text-[10px] text-ink-faint">Search terms: {item.payload.searchText}</p>}
                        <div className="mt-2 text-[9px] text-ink-faint">Proposal {item.id} · {new Date(item.createdAt).toLocaleString()}</div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button type="button" disabled={busy} onClick={() => void decide(item, 'approve')} className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">Approve</button>
                        <button type="button" disabled={busy} onClick={() => void decide(item, 'reject')} className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-red-700 disabled:opacity-50">Reject</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

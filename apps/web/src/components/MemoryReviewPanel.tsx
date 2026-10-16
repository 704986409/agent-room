import { useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import type { MessageKey } from '../i18n/messages.js';

interface MemoryReviewItem {
  id: string;
  action: 'create' | 'update' | 'delete';
  targetMemoryId: string | null;
  payload: { title?: string; preview?: string; content?: string; searchText?: string; sourceMessageId?: string };
  current?: { title: string; preview: string; content: string };
  createdAt: string;
  reason?: MemoryReviewRejectionReason;
}

type MemoryReviewRejectionReason = '无关记忆' | '重复记忆' | '格式不合规';

const REJECTION_REASONS: readonly MemoryReviewRejectionReason[] = ['无关记忆', '重复记忆', '格式不合规'];

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

// The API contract keeps raw error codes; only the rendering layer maps them
// to a localized explanation, and unknown codes fall back to a generic one.
const HOST_KEY_MISSING_MESSAGE = 'Host key is unavailable in this browser.';

const ERROR_KEYS: Record<string, MessageKey> = {
  REVIEWER_UNAVAILABLE: 'memoryReview.error.REVIEWER_UNAVAILABLE',
  CONFLICT: 'memoryReview.error.CONFLICT',
  FORBIDDEN: 'memoryReview.error.FORBIDDEN',
  SEAT_IN_USE: 'memoryReview.error.SEAT_IN_USE',
  NOT_FOUND: 'memoryReview.error.NOT_FOUND',
  STORAGE_ERROR: 'memoryReview.error.STORAGE_ERROR',
  HOST_KEY_MISSING: 'memoryReview.error.HOST_KEY_MISSING',
};

export function MemoryReviewPanel({ roomCode, isHost, ended }: MemoryReviewPanelProps) {
  const { t, formatDateTime } = useLocale();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MemoryReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, MemoryReviewRejectionReason | ''>>({});
  const [lastRejection, setLastRejection] = useState<{ title: string; reason: MemoryReviewRejectionReason } | null>(null);

  async function callApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const hostKey = storedHostKey(roomCode);
    if (!hostKey) throw new Error(HOST_KEY_MISSING_MESSAGE);
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
    const reason = reasons[item.id];
    if (action === 'reject' && !reason) return;
    setBusy(true);
    setError(null);
    try {
      const result = await callApi({
        action,
        proposalId: item.id,
        requestId: globalThis.crypto.randomUUID(),
        ...(action === 'reject' ? { reason } : {}),
      });
      if (action === 'reject' && reason) {
        const confirmedReason = REJECTION_REASONS.includes(result.reason as MemoryReviewRejectionReason)
          ? result.reason as MemoryReviewRejectionReason
          : reason;
        setLastRejection({ title: item.payload.title || item.current?.title || item.targetMemoryId || t('memoryReview.untitled'), reason: confirmedReason });
      } else {
        setLastRejection(null);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'STORAGE_ERROR');
      setBusy(false);
    }
  }

  function errorText(raw: string): string {
    const code = raw === HOST_KEY_MISSING_MESSAGE ? 'HOST_KEY_MISSING' : raw;
    const reason = t(ERROR_KEYS[code] ?? 'memoryReview.error.unknown');
    return t('memoryReview.apiState', { error: t('memoryReview.errorDetail', { reason, code }) });
  }

  if (!isHost) return null;
  return (
    <>
      <button
        type="button"
        disabled={ended}
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-1.5 text-[10px] font-semibold text-ink-muted hover:bg-surface-softer disabled:opacity-50"
        aria-label={t('memoryReview.openAria')}
      >
        {items.length ? t('memoryReview.buttonCount', { count: items.length }) : t('memoryReview.button')}
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
                <h2 id="memory-review-title" className="text-sm font-semibold text-ink">{t('memoryReview.title')}</h2>
                <p className="mt-0.5 text-[11px] text-ink-soft">{t('memoryReview.description')}</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void refresh()} disabled={busy} className="text-xs font-semibold text-accent disabled:opacity-50">{t('memoryReview.refresh')}</button>
                <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-softer" aria-label={t('memoryReview.closeAria')}>×</button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {error && (
                <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {errorText(error)}
                </div>
              )}
              {lastRejection && (
                <div role="status" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  {t('memoryReview.rejectionNotice', { title: lastRejection.title, reason: lastRejection.reason })}
                </div>
              )}
              {busy && <div className="py-4 text-center text-xs text-ink-soft">{t('memoryReview.loading')}</div>}
              {!busy && !error && items.length === 0 && <div className="py-4 text-center text-xs text-ink-soft">{t('memoryReview.empty')}</div>}
              <div className="space-y-3">
                {items.map(item => (
                  <article key={item.id} className="rounded-lg border border-border-faint bg-surface-softer p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-ink">{t('memoryReview.itemTitle', {
                          action: t(`memoryReview.action.${item.action}` as MessageKey),
                          title: item.payload.title || item.current?.title || item.targetMemoryId || t('memoryReview.untitled'),
                        })}</div>
                        {item.current && <p className="mt-1 text-[11px] text-ink-soft">{t('memoryReview.currentPreview', { preview: item.current.preview })}</p>}
                        {item.payload.preview && <p className="mt-1 text-[11px] text-ink-soft">{t('memoryReview.proposedPreview', { preview: item.payload.preview })}</p>}
                        {item.current && <details className="mt-2 rounded bg-white p-2 text-[11px]"><summary className="cursor-pointer font-semibold">{t('memoryReview.currentContent')}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-ink-muted">{item.current.content}</pre></details>}
                        {item.payload.content && <details className="mt-2 rounded bg-white p-2 text-[11px]" open><summary className="cursor-pointer font-semibold">{t('memoryReview.proposedContent')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink-muted">{item.payload.content}</pre></details>}
                        {item.payload.searchText && <p className="mt-2 break-words text-[10px] text-ink-faint">{t('memoryReview.searchTerms', { terms: item.payload.searchText })}</p>}
                        {item.reason && <p className="mt-2 text-[11px] font-semibold text-red-700">{t('memoryReview.reviewReason', { reason: item.reason })}</p>}
                        <div className="mt-2 text-[9px] text-ink-faint">{t('memoryReview.proposalMeta', { id: item.id, time: formatDateTime(new Date(item.createdAt)) })}</div>
                      </div>
                      <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                        <button type="button" disabled={busy} onClick={() => void decide(item, 'approve')} className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">{t('memoryReview.approve')}</button>
                        <label className="text-[10px] text-ink-soft">
                          {t('memoryReview.rejectReason')}
                          <select
                            aria-label={t('memoryReview.rejectReasonFor', { title: item.payload.title || item.current?.title || item.targetMemoryId || t('memoryReview.untitled') })}
                            required
                            value={reasons[item.id] ?? ''}
                            disabled={busy}
                            onChange={event => setReasons(current => ({ ...current, [item.id]: event.target.value as MemoryReviewRejectionReason | '' }))}
                            className="mt-0.5 block w-36 rounded border border-border bg-white px-1.5 py-1 text-[10px] text-ink"
                          >
                            <option value="">{t('memoryReview.selectRejectReason')}</option>
                            {REJECTION_REASONS.map(reason => <option key={reason} value={reason}>{reason}</option>)}
                          </select>
                        </label>
                        <button
                          type="button"
                          aria-label={t('memoryReview.rejectFor', { title: item.payload.title || item.current?.title || item.targetMemoryId || t('memoryReview.untitled') })}
                          disabled={busy || !reasons[item.id]}
                          onClick={() => void decide(item, 'reject')}
                          className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-red-700 disabled:opacity-50"
                        >{t('memoryReview.reject')}</button>
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

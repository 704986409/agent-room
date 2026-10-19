import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { copyText } from '../lib/copy.js';
import { showToast } from './Toast.js';

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done' } | { kind: 'manual'; text: string };

/**
 * "Copy invite link" button with inline feedback: shows a busy label while the
 * invite is minted, "已复制 ✓" for a couple of seconds on success, and a
 * select-all text box for manual copy when every clipboard path fails.
 */
export function CopyInviteButton({ label, successMsg, getText, className, onError }: {
  label: string;
  successMsg: string;
  getText: () => Promise<string | null>;
  className?: string;
  onError?: (e: unknown) => void;
}) {
  const { t } = useLocale();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function run() {
    if (state.kind === 'busy') return;
    setState({ kind: 'busy' });
    let text: string | null;
    try {
      text = await getText();
    } catch (e) {
      setState({ kind: 'idle' });
      if (onError) onError(e);
      else showToast(e instanceof Error ? e.message : t('common.unknownError'), 'error');
      return;
    }
    if (text == null) { setState({ kind: 'idle' }); return; }
    const ok = await copyText(text, successMsg, { quietFailure: true });
    if (ok) {
      setState({ kind: 'done' });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState({ kind: 'idle' }), 2200);
    } else {
      setState({ kind: 'manual', text });
      showToast(t('common.copyManual'), 'info');
    }
  }

  return (
    <>
      <button type="button" onClick={() => { void run(); }} disabled={state.kind === 'busy'} aria-live="polite" className={className}>
        {state.kind === 'busy' ? t('common.copying') : state.kind === 'done' ? `${t('common.copied')} ✓` : label}
      </button>
      {state.kind === 'manual' && (
        <div className="mt-2 text-left">
          <p className="mb-1 text-[11px] text-ink-soft">{t('common.copyManual')}</p>
          <textarea
            readOnly
            autoFocus
            value={state.text}
            onFocus={e => e.currentTarget.select()}
            rows={3}
            className="w-full rounded-md border border-border bg-surface-soft p-2 font-mono text-[11px]"
          />
        </div>
      )}
    </>
  );
}

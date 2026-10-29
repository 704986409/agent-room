import { useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.js';
import { isDesktopShell, type DesktopHostResult } from '../lib/desktopHost.js';
import { HostLocalDialog } from './HostLocalDialog.js';

/** Host-only, desktop-webview-only. Opens the host dialog; it does not start a seat by itself. */
export function HostLocalButton({ roomCode, isHost, ended, onHosted }: {
  roomCode: string;
  isHost: boolean;
  ended: boolean;
  onHosted?: (seat: DesktopHostResult['seat']) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!isHost || !isDesktopShell()) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={ended || hosting || open}
        onClick={() => { if (hosting || open) return; setDone(null); setOpen(true); }}
        aria-label={t('desktopHost.openAria')}
        className="w-full min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-white bg-emerald-700 px-3 rounded-lg transition active:scale-[0.98] hover:opacity-90 disabled:opacity-50"
      >
        {hosting ? <span role="status" className="inline-flex items-center gap-2"><span aria-hidden="true" className="inline-block size-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />{t('desktopHost.starting')}</span> : t('desktopHost.button')}
      </button>
      {done && <p className="mt-1 text-[11px] text-emerald-700">{done}</p>}
      {open && (
        <HostLocalDialog
          roomCode={roomCode}
          ended={ended}
          onBusyChange={setHosting}
          onClose={() => { if (!hosting) setOpen(false); }}
          onHosted={seat => {
            setDone(t('desktopHost.started', { name: seat.name || '' }));
            setOpen(false);
            onHosted?.(seat);
          }}
        />
      )}
    </div>
  );
}

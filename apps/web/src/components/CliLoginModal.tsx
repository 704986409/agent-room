import { useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useLocale } from '../i18n/LocaleProvider.js';
import {
  refreshDesktopCliLoginAuth,
  startDesktopCliLogin,
} from '../lib/desktopHost.js';
import { desktopTerminalWsUrl, stopDesktopTerminal } from '../lib/desktopTerminal.js';
import { isOscColorReport } from './DesktopSeatTerminal.js';

/**
 * MCP-approval-style modal: embedded virtual terminal for CLI login.
 * On loggedIn === true, calls onLoggedIn so HostLocal can continue hosting.
 */
export function CliLoginModal({
  adapterId,
  adapterLabel,
  onClose,
  onLoggedIn,
}: {
  adapterId: string;
  adapterLabel: string;
  onClose: () => void;
  onLoggedIn: () => void;
}) {
  const { t } = useLocale();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const seatIdRef = useRef<string | null>(null);
  const finishedRef = useRef(false);
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;
  const tStable = useRef(t);
  tStable.current = t;
  const [seatId, setSeatId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (hostRef.current) {
      term.open(hostRef.current);
      try { fit.fit(); } catch { /* ignore */ }
    }
    const onResize = () => {
      try { fit.fit(); } catch { /* ignore */ }
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && term.cols && term.rows) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    void (async () => {
      try {
        const started = await startDesktopCliLogin(adapterId);
        if (cancelled) {
          await stopDesktopTerminal(started.seatId).catch(() => { /* ignore */ });
          return;
        }
        seatIdRef.current = started.seatId;
        setSeatId(started.seatId);
        setStarting(false);
        setStatus(tStable.current('desktopHost.loginModalHint', { cli: adapterLabel }));
        const ws = new WebSocket(desktopTerminalWsUrl(started.seatId));
        socketRef.current = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          try { fit.fit(); } catch { /* ignore */ }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        };
        ws.onmessage = event => {
          const data = typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          term.write(data);
        };
        ws.onclose = () => {
          if (!cancelled && !finishedRef.current) {
            setStatus(tStable.current('desktopHost.loginModalWaiting'));
          }
        };
        term.onData(data => {
          if (isOscColorReport(data)) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stdin', data }));
          }
        });
      } catch (e) {
        if (cancelled) return;
        setStarting(false);
        setError(e instanceof Error ? e.message : tStable.current('common.unknownError'));
      }
    })();

    const poll = window.setInterval(() => {
      if (cancelled || finishedRef.current) return;
      void refreshDesktopCliLoginAuth(adapterId)
        .then(result => {
          if (cancelled || finishedRef.current) return;
          if (result.loggedIn === true) {
            finishedRef.current = true;
            setStatus(tStable.current('desktopHost.loginModalSuccess'));
            window.clearInterval(poll);
            void (async () => {
              const id = seatIdRef.current;
              if (id) await stopDesktopTerminal(id).catch(() => { /* ignore */ });
              onLoggedInRef.current();
            })();
          }
        })
        .catch(() => { /* keep polling */ });
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener('resize', onResize);
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try { ws.close(); } catch { /* ignore */ }
      }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
      const id = seatIdRef.current;
      seatIdRef.current = null;
      if (id && !finishedRef.current) {
        void stopDesktopTerminal(id).catch(() => { /* ignore */ });
      }
    };
  }, [adapterId, adapterLabel]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-3" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-login-title"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border-faint px-4 py-3">
          <div>
            <h2 id="cli-login-title" className="text-sm font-semibold text-ink">
              {t('desktopHost.loginModalTitle', { cli: adapterLabel })}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-soft">
              {status || t('desktopHost.loginModalStarting')}
              {seatId ? ` · ${seatId}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-softer"
            aria-label={t('desktopHost.loginModalCloseAria')}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 bg-[#1e1e1e] p-2">
          <div
            ref={hostRef}
            className="h-[min(52vh,420px)] w-full overflow-hidden rounded-md [&_.xterm]:h-full [&_.xterm]:w-full"
          />
        </div>
        {(starting || error) && (
          <div className="border-t border-border-faint px-4 py-2 text-xs">
            {starting && !error && <p className="text-ink-soft">{t('desktopHost.loginModalStarting')}</p>}
            {error && <p role="alert" className="text-rose-700">{error}</p>}
          </div>
        )}
        <footer className="flex justify-end gap-2 border-t border-border-faint px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-9 rounded-lg border border-border bg-white px-4 text-xs font-semibold text-ink transition hover:bg-surface-softer"
          >
            {t('desktopHost.loginModalCancel')}
          </button>
        </footer>
      </section>
    </div>
  );
}

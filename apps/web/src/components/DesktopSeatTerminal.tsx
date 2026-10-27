import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useLocale } from '../i18n/LocaleProvider.js';
import { isDesktopShell, listenDesktopEvent, revealManagedTerminal } from '../lib/desktopHost.js';
import {
  desktopTerminalWsUrl,
  listDesktopTerminals,
  terminalsForRoom,
  type DesktopTerminalRow,
} from '../lib/desktopTerminal.js';

const DOCK_CHANNEL = 'agent-room-terminal-dock';
const DOCK_EVENT = 'managed-terminal-docked';

function resetTerm(term: Terminal | null | undefined) {
  term?.reset();
}

function detachSocket(ws: WebSocket | null) {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try { ws.close(); } catch { /* ignore */ }
}

/**
 * Docked xterm for this machine's embedded PTY. Rendered only inside the desktop shell.
 * Pop-out uses the shell command so the control token stays in Rust. Closing that window
 * emits `managed-terminal-docked` and this panel attaches to the same PTY again.
 */
export function DesktopSeatTerminal({
  roomCode,
  preferredSeatId,
  focusToken = 0,
  expanded = false,
  onToggleExpand,
  onTerminals,
}: {
  roomCode: string;
  preferredSeatId?: string;
  /** Bumps when the member list asks for this seat again, so the same id reconnects. */
  focusToken?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onTerminals?: (rows: DesktopTerminalRow[]) => void;
}) {
  const { t } = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const desktop = isDesktopShell();
  const [rows, setRows] = useState<DesktopTerminalRow[]>([]);
  const [seatId, setSeatId] = useState('');
  const [connected, setConnected] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [noteErr, setNoteErr] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const poppedRef = useRef<string | null>(null);
  const seatRef = useRef('');
  const channelRef = useRef<BroadcastChannel | null>(null);
  const connectRef = useRef<(id: string) => void>(() => {});
  const disconnectRef = useRef<(silent?: boolean) => void>(() => {});
  const generationRef = useRef(0);
  const onTerminalsRef = useRef(onTerminals);
  onTerminalsRef.current = onTerminals;
  seatRef.current = seatId;

  function sendStdinText(text: string) {
    if (!text) return;
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stdin', data: text }));
    }
  }

  function pasteFromEvent(event: ClipboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) {
      sendStdinText(text);
      return;
    }
    // Fallback only when the paste event carried no text (some webviews).
    void (async () => {
      let fallback = '';
      try {
        fallback = await navigator.clipboard.readText();
      } catch {
        setNoteErr(true);
        setNote(tRef.current('desktopTerminal.pasteFailed'));
        return;
      }
      if (!fallback) {
        setNoteErr(true);
        setNote(tRef.current('desktopTerminal.pasteFailed'));
        return;
      }
      sendStdinText(fallback);
    })();
  }

  const visible = terminalsForRoom(rows, roomCode);
  const options = seatId && !visible.some(row => row.seatId === seatId)
    ? [...visible, { seatId, pid: 0, cols: 0, rows: 0 }]
    : visible;
  const popped = poppedRef.current === seatId && seatId !== '';

  disconnectRef.current = (silent = false) => {
    generationRef.current += 1;
    const ws = socketRef.current;
    socketRef.current = null;
    detachSocket(ws);
    setConnected(false);
    if (!silent) {
      setNoteErr(false);
      setNote(tRef.current('desktopTerminal.disconnected'));
    }
  };

  function ensureTerm(): Terminal | null {
    const host = hostRef.current;
    if (!host) return null;
    if (termRef.current) {
      fitRef.current?.fit();
      return termRef.current;
    }
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Do not intercept Ctrl/Cmd+V on keydown: preventDefault kills the paste
    // event (clipboardData) in Tauri webviews. Capture paste on the host so we
    // read text/plain before xterm handles it.
    if (typeof host.addEventListener === 'function') {
      host.addEventListener('paste', (event: Event) => {
        pasteFromEvent(event as ClipboardEvent);
      }, true);
    }
    term.onData(data => {
      // Ctrl+V is 0x16. Codex treats that byte as image paste.
      if (data === '\x16') return;
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }));
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        const current = termRef.current;
        const ws = socketRef.current;
        if (!current) return;
        fit.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: current.cols, rows: current.rows }));
        }
      });
      observer.observe(host);
    }
    termRef.current = term;
    fitRef.current = fit;
    return term;
  }

  connectRef.current = (id: string) => {
    const next = id.trim();
    if (!next) {
      setNoteErr(true);
      setNote(tRef.current('desktopTerminal.pickSeat'));
      return;
    }
    if (poppedRef.current === next) {
      setNoteErr(false);
      setNote(tRef.current('desktopTerminal.popped'));
      return;
    }
    disconnectRef.current(true);
    const generation = ++generationRef.current;
    setSeatId(next);
    const term = ensureTerm();
    resetTerm(term);
    const ws = new WebSocket(desktopTerminalWsUrl(next));
    socketRef.current = ws;
    ws.binaryType = 'arraybuffer';
    const current = () => generationRef.current === generation && socketRef.current === ws;
    ws.onopen = () => {
      if (!current()) return;
      setConnected(true);
      setNoteErr(false);
      setNote(tRef.current('desktopTerminal.connected', { seat: next }));
      fitRef.current?.fit();
      if (term && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    ws.onmessage = event => {
      if (!current()) return;
      const data = typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      term?.write(data);
    };
    ws.onclose = () => {
      if (!current()) return;
      socketRef.current = null;
      setConnected(false);
      setNoteErr(false);
      setNote(poppedRef.current ? tRef.current('desktopTerminal.popped') : tRef.current('desktopTerminal.disconnected'));
    };
    ws.onerror = () => {
      if (!current()) return;
      setNoteErr(true);
      setNote(tRef.current('desktopTerminal.wsError'));
    };
  };

  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    async function refresh() {
      try {
        const payload = await listDesktopTerminals();
        if (stopped) return;
        setRows(payload.terminals);
        onTerminalsRef.current?.(payload.terminals);
        setSeatId(current => {
          if (current && payload.terminals.some(row => row.seatId === current)) return current;
          const roomRows = terminalsForRoom(payload.terminals, roomCode);
          if (preferredSeatId && payload.terminals.some(row => row.seatId === preferredSeatId)) return preferredSeatId;
          if (roomRows.length === 1) return roomRows[0]!.seatId;
          return current;
        });
      } catch {
        if (!stopped) {
          setNoteErr(true);
          setNote(tRef.current('desktopTerminal.listFailed'));
        }
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [desktop, preferredSeatId, roomCode]);

  useEffect(() => {
    if (!desktop || !preferredSeatId) return;
    let cancelled = false;
    setSeatId(preferredSeatId);
    // Drop the previous socket before the list round-trip. connect() resets again.
    disconnectRef.current(true);
    resetTerm(termRef.current);
    void (async () => {
      for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
        try {
          const payload = await listDesktopTerminals();
          if (cancelled) return;
          setRows(payload.terminals);
          onTerminalsRef.current?.(payload.terminals);
          if (payload.terminals.some(row => row.seatId === preferredSeatId)) {
            connectRef.current(preferredSeatId);
            return;
          }
        } catch {
          if (!cancelled) {
            setNoteErr(true);
            setNote(tRef.current('desktopTerminal.listFailed'));
          }
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!cancelled) connectRef.current(preferredSeatId);
    })();
    return () => { cancelled = true; };
  }, [desktop, preferredSeatId, focusToken]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | null = null;
    let closed = false;
    const onDock = (id: string) => {
      if (poppedRef.current === id) poppedRef.current = null;
      setSeatId(id);
      connectRef.current(id);
    };
    const onPopout = (id: string) => {
      poppedRef.current = id;
      if (seatRef.current === id) disconnectRef.current(true);
      setNoteErr(false);
      setNote(tRef.current('desktopTerminal.popped'));
    };
    try {
      const channel = new BroadcastChannel(DOCK_CHANNEL);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<{ type?: string; seatId?: string }>) => {
        const msg = event.data;
        if (!msg?.seatId) return;
        if (msg.type === 'dock') onDock(msg.seatId);
        if (msg.type === 'popout') onPopout(msg.seatId);
      };
    } catch { /* BroadcastChannel unavailable */ }
    void listenDesktopEvent(DOCK_EVENT, payload => {
      if (closed) return;
      const id = typeof payload === 'string' ? payload.trim() : '';
      if (id) onDock(id);
    }).then(stop => {
      if (closed) stop?.();
      else unlisten = stop;
    });
    return () => {
      closed = true;
      channelRef.current?.close();
      channelRef.current = null;
      unlisten?.();
      generationRef.current += 1;
      const ws = socketRef.current;
      socketRef.current = null;
      detachSocket(ws);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [desktop]);

  async function popout() {
    const id = seatId.trim();
    if (!id) {
      setNoteErr(true);
      setNote(tRef.current('desktopTerminal.pickSeat'));
      return;
    }
    disconnectRef.current(true);
    poppedRef.current = id;
    try { channelRef.current?.postMessage({ type: 'popout', seatId: id }); } catch { /* ignore */ }
    setNoteErr(false);
    setNote(tRef.current('desktopTerminal.popped'));
    const error = await revealManagedTerminal(id);
    if (poppedRef.current !== id) return;
    if (error) {
      poppedRef.current = null;
      setNoteErr(true);
      setNote(tRef.current('desktopTerminal.popoutFailed'));
      connectRef.current(id);
    }
  }

  if (!desktop) return null;

  function selectSeat(id: string) {
    if (seatRef.current === id && socketRef.current?.readyState === WebSocket.OPEN) return;
    connectRef.current(id);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('desktopTerminal.title')}>
      <h3 className="sr-only">{t('desktopTerminal.title')}</h3>
      <div role="tablist" aria-label={t('desktopTerminal.seatLabel')} className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-2">
        {options.length === 0 ? (
          <p className="text-[12px] text-ink-soft">{t('desktopTerminal.noSeats')}</p>
        ) : options.map(row => {
          const active = row.seatId === seatId;
          const label = row.name?.trim() || row.seatId;
          return (
            <button
              key={row.seatId}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => { selectSeat(row.seatId); }}
              className={`shrink-0 min-h-8 rounded-md px-2.5 text-[12px] font-semibold ${
                active ? 'bg-accent text-white' : 'bg-surface-softer text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 grid shrink-0 grid-cols-4 gap-1 px-3">
        <button
          type="button"
          disabled={!seatId || connected || popped}
          onClick={() => { connectRef.current(seatId); }}
          className="min-h-8 rounded-md bg-accent px-1 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {t('desktopTerminal.connect')}
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() => { disconnectRef.current(false); }}
          className="min-h-8 rounded-md border border-border bg-white px-1 text-[11px] font-semibold text-ink disabled:opacity-50"
        >
          {t('desktopTerminal.disconnect')}
        </button>
        <button
          type="button"
          disabled={!seatId || popped}
          onClick={() => { void popout(); }}
          className="min-h-8 rounded-md border border-border bg-white px-1 text-[11px] font-semibold text-ink disabled:opacity-50"
        >
          {t('desktopTerminal.popout')}
        </button>
        <button
          type="button"
          onClick={() => { onToggleExpand?.(); }}
          className="min-h-8 rounded-md border border-border bg-white px-1 text-[11px] font-semibold text-ink"
        >
          {expanded ? t('desktopTerminal.collapse') : t('desktopTerminal.expand')}
        </button>
      </div>
      {note && (
        <p className={`mt-1 shrink-0 px-3 text-[11px] ${noteErr ? 'text-red-700' : 'text-ink-muted'}`}>{note}</p>
      )}
      <div
        ref={hostRef}
        className="mx-3 mb-3 mt-2 min-h-[180px] flex-1 overflow-hidden rounded-md bg-[#1e1e1e]"
        onPaste={event => { pasteFromEvent(event.nativeEvent); }}
      />
    </section>
  );
}

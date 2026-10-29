import { DESKTOP_CONTROL_ORIGIN } from './desktopHost.js';

export interface DesktopTerminalRow {
  seatId: string;
  pid: number;
  cols: number;
  rows: number;
  name?: string;
  code?: string;
}

/** Seats whose daemon record matches this room. If none are tagged, show every live PTY. */
export function terminalsForRoom(rows: readonly DesktopTerminalRow[], roomCode: string): DesktopTerminalRow[] {
  const code = roomCode.trim();
  if (!code) return [...rows];
  const matched = rows.filter(row => row.code === code);
  return matched.length > 0 ? matched : [...rows];
}

/**
 * WebSocket for the desktop-auth PTY attach.
 * `desktop=1` is the mark: a browser WebSocket cannot send `x-agent-room-desktop`.
 * The control token is never placed in this URL.
 */
export function desktopTerminalWsUrl(seatId: string, origin = DESKTOP_CONTROL_ORIGIN): string {
  const wsOrigin = origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/$/, '');
  return `${wsOrigin}/api/desktop/terminals/${encodeURIComponent(seatId.trim())}/ws?desktop=1`;
}

export interface LocalSeatStop {
  code: string;
  name: string;
  seatId?: string;
}

/**
 * Stop every local managed seat that matches this room member.
 * A missing daemon is ignored: the server remove still proceeds.
 */
export async function stopLocalManagedSeats(
  input: LocalSeatStop,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await fetchImpl(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/seats/stop`, {
      method: 'POST',
      headers: { 'x-agent-room-desktop': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        name: input.name,
        ...(input.seatId ? { seatId: input.seatId } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network';
    throw new Error(`本机后台没有响应（${detail}）。请确认桌面端已打开。`);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({})) as { error?: string; stopped?: unknown };
  if (!response.ok) {
    throw new Error(body.error || `无法停止本机席位（HTTP ${response.status}）`);
  }
  return Array.isArray(body.stopped) ? body.stopped.filter((id): id is string => typeof id === 'string') : [];
}

/** Kill the managed PTY / seat process. Disconnect only closes the view. */
export async function stopDesktopTerminal(
  seatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const id = seatId.trim();
  let response: Response;
  try {
    response = await fetchImpl(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/terminals/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      headers: { 'x-agent-room-desktop': '1', 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network';
    throw new Error(`本机后台没有响应（${detail}）。请确认桌面端已打开。`);
  }
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `无法关闭进程（HTTP ${response.status}）`);
  }
}

export async function listDesktopTerminals(
  fetchImpl: typeof fetch = fetch,
): Promise<{ terminals: DesktopTerminalRow[]; mode: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/terminals`, {
      headers: { 'x-agent-room-desktop': '1' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network';
    throw new Error(`本机后台没有响应（${detail}）。请确认桌面端已打开。`);
  }
  const body = await response.json().catch(() => ({})) as {
    terminals?: DesktopTerminalRow[];
    mode?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || `无法读取本机终端（HTTP ${response.status}）`);
  }
  return { terminals: body.terminals ?? [], mode: body.mode ?? 'embedded' };
}

/** OS clipboard via the paired daemon. WebKitGTK does not deliver a paste event for Ctrl+V. */
export async function readDesktopClipboardText(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${DESKTOP_CONTROL_ORIGIN}/api/desktop/clipboard`, {
      headers: { 'x-agent-room-desktop': '1' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network';
    throw new Error(`本机后台没有响应（${detail}）。请确认桌面端已打开。`);
  }
  const body = await response.json().catch(() => ({})) as { text?: unknown; error?: string };
  if (!response.ok) {
    throw new Error(body.error || `无法读取剪贴板（HTTP ${response.status}）`);
  }
  return typeof body.text === 'string' ? body.text : '';
}

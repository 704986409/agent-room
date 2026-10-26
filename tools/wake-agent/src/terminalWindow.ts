/**
 * Helpers for Agent Room terminal pop-out (P1).
 * Label rules mirror desktop/src-tauri `terminal_window_label`.
 */

/** Tauri WebviewWindow label for a seat's pop-out (`terminal-<safeSeatId>`). */
export function terminalWindowLabel(seatId: string): string {
  const trimmed = seatId.trim();
  const safe = trimmed
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 96);
  return `terminal-${safe || 'seat'}`;
}

/** Relative control URL that mounts only the terminal for one seat. */
export function buildPopoutControlPath(seatId: string, token: string): string {
  const q = new URLSearchParams();
  q.set('t', token);
  q.set('terminal', seatId);
  q.set('popout', '1');
  return `/?${q.toString()}`;
}

/** Absolute pop-out URL from the current control origin. */
export function buildPopoutControlUrl(origin: string, seatId: string, token: string): string {
  const base = origin.replace(/\/$/, '');
  return `${base}${buildPopoutControlPath(seatId, token)}`;
}

export const TERMINAL_DOCK_CHANNEL = 'agent-room-terminal-dock';

export type TerminalDockMessage =
  | { type: 'popout'; seatId: string }
  | { type: 'dock'; seatId: string };

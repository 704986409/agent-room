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

/** localStorage key prefix on the control origin (`agent-room-term-geom:<seatId>`). */
export const TERMINAL_GEOM_PREFIX = 'agent-room-term-geom:';

export const TERMINAL_MIN_WIDTH = 480;
export const TERMINAL_MIN_HEIGHT = 320;
export const TERMINAL_DEFAULT_WIDTH = 960;
export const TERMINAL_DEFAULT_HEIGHT = 640;
export const TERMINAL_MAX_WIDTH = 3840;
export const TERMINAL_MAX_HEIGHT = 2160;
/** Pointer travel past this (px) undocks the docked terminal. Mirrors settings.html. */
export const TERMINAL_UNDOCK_THRESHOLD_PX = 48;

const POS_MIN = -8000;
const POS_MAX = 16000;

export type TerminalGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TerminalGeometryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function terminalGeometryKey(seatId: string): string {
  return `${TERMINAL_GEOM_PREFIX}${seatId.trim()}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize a geometry object. Returns null when any of x/y/width/height is missing
 * or non-finite. Width/height are clamped to ≥480×320 (max 3840×2160).
 */
export function clampTerminalGeometry(input: unknown): TerminalGeometry | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<Record<keyof TerminalGeometry, unknown>>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(n => Number.isFinite(n))) return null;
  return {
    x: Math.round(clampNumber(x, POS_MIN, POS_MAX)),
    y: Math.round(clampNumber(y, POS_MIN, POS_MAX)),
    width: Math.round(clampNumber(width, TERMINAL_MIN_WIDTH, TERMINAL_MAX_WIDTH)),
    height: Math.round(clampNumber(height, TERMINAL_MIN_HEIGHT, TERMINAL_MAX_HEIGHT)),
  };
}

export function serializeTerminalGeometry(geom: TerminalGeometry): string {
  const clamped = clampTerminalGeometry(geom);
  if (!clamped) throw new Error('invalid terminal geometry');
  return JSON.stringify(clamped);
}

export function parseTerminalGeometry(raw: string | null | undefined): TerminalGeometry | null {
  if (!raw) return null;
  try {
    return clampTerminalGeometry(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function loadTerminalGeometry(
  storage: Pick<TerminalGeometryStorage, 'getItem'>,
  seatId: string,
): TerminalGeometry | null {
  return parseTerminalGeometry(storage.getItem(terminalGeometryKey(seatId)));
}

export function saveTerminalGeometry(
  storage: TerminalGeometryStorage,
  seatId: string,
  geom: TerminalGeometry,
): TerminalGeometry | null {
  const clamped = clampTerminalGeometry(geom);
  if (!clamped || !seatId.trim()) return null;
  storage.setItem(terminalGeometryKey(seatId), JSON.stringify(clamped));
  return clamped;
}

/** True once pointer travel from the drag origin exceeds the undock threshold. */
export function undockDragExceeded(
  dx: number,
  dy: number,
  threshold = TERMINAL_UNDOCK_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(threshold)) return false;
  return Math.hypot(dx, dy) >= threshold;
}

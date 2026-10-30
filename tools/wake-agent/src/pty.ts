import { appendFileSync, closeSync, mkdirSync, openSync, chmodSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createRequire } from 'node:module';

export interface PtySession {
  seatId: string;
  pid: number;
  cols: number;
  rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** UTF-8 output retained for a later attach. Capped at ~256 KiB. */
  scrollback(): string;
  onData(listener: (data: string) => void): () => void;
  kill(): void;
  readonly exited: Promise<number>;
}

export interface SpawnPtyInput {
  seatId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  logFile?: string;
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConptyDll?: boolean;
    },
  ) => {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  };
};

const registry = new Map<string, PtySession>();
let ptyModule: PtyModule | null | undefined;

/** Bytes of UTF-8 PTY output kept so a docked terminal can replay after idle. */
const SCROLLBACK_MAX_BYTES = 256 * 1024;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Keep the tail of `value` whose UTF-8 size is at most `maxBytes`, on a code-point boundary. */
function trimUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let bytes = 0;
  let index = value.length;
  while (index > 0) {
    let prev = index - 1;
    const code = value.charCodeAt(prev);
    if (code >= 0xDC00 && code <= 0xDFFF && prev > 0) {
      const lead = value.charCodeAt(prev - 1);
      if (lead >= 0xD800 && lead <= 0xDBFF) prev -= 1;
    }
    const size = utf8Bytes(value.slice(prev, index));
    if (bytes + size > maxBytes) break;
    bytes += size;
    index = prev;
  }
  return value.slice(index);
}

function createScrollback(maxBytes = SCROLLBACK_MAX_BYTES) {
  const chunks: string[] = [];
  let bytes = 0;
  return {
    append(data: string) {
      if (!data) return;
      chunks.push(data);
      bytes += utf8Bytes(data);
      while (bytes > maxBytes && chunks.length > 0) {
        const head = chunks[0]!;
        const headBytes = utf8Bytes(head);
        const overflow = bytes - maxBytes;
        if (headBytes <= overflow) {
          chunks.shift();
          bytes -= headBytes;
          continue;
        }
        const trimmed = trimUtf8Tail(head, headBytes - overflow);
        if (!trimmed) {
          chunks.shift();
          bytes -= headBytes;
          continue;
        }
        chunks[0] = trimmed;
        bytes -= headBytes - utf8Bytes(trimmed);
        break;
      }
    },
    text() {
      return chunks.join('');
    },
  };
}

export function ptyAvailable(): boolean {
  return loadPty() !== null;
}

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  const require = createRequire(import.meta.url);
  const candidates = [
    '@homebridge/node-pty-prebuilt-multiarch',
    'node-pty',
  ];
  for (const name of candidates) {
    try {
      ptyModule = require(name) as PtyModule;
      return ptyModule;
    } catch {
      /* try next */
    }
  }
  ptyModule = null;
  return null;
}

export function listPtySessions(): Array<{ seatId: string; pid: number; cols: number; rows: number }> {
  return [...registry.values()].map(session => ({
    seatId: session.seatId,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
  }));
}

export function getPtySession(seatId: string): PtySession | undefined {
  return registry.get(seatId);
}

export function unregisterPtySession(seatId: string): void {
  registry.delete(seatId);
}

/** Derive seat id from a managed log path (`…/logs/<seatId>.log`). */
export function seatIdFromLogFile(logFile: string | undefined): string | undefined {
  if (!logFile) return undefined;
  const base = basename(logFile);
  const match = /^(.*)\.log$/i.exec(base);
  return match?.[1] || undefined;
}

export function spawnPtySession(input: SpawnPtyInput): PtySession {
  const pty = loadPty();
  if (!pty) throw new Error('pty_unavailable');

  const existing = registry.get(input.seatId);
  if (existing) {
    try { existing.kill(); } catch { /* replace */ }
    registry.delete(input.seatId);
  }

  const cols = input.cols ?? 80;
  const rows = input.rows ?? 24;
  let logFd: number | undefined;
  if (input.logFile) {
    try {
      mkdirSync(dirname(input.logFile), { recursive: true, mode: 0o700 });
      logFd = openSync(input.logFile, 'a', 0o600);
      chmodSync(input.logFile, 0o600);
      appendFileSync(input.logFile, `# pty ${input.command} ${JSON.stringify(input.args)}\n`, { mode: 0o600 });
    } catch {
      logFd = undefined;
    }
  }

  const term = pty.spawn(input.command, [...input.args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: input.cwd,
    env: { ...process.env, ...input.env, TERM: 'xterm-256color' } as Record<string, string>,
    // conpty.dll skips the helper that calls AttachConsole and fails when the
    // daemon was started with CREATE_NO_WINDOW.
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  });

  const listeners = new Set<(data: string) => void>();
  const scrollback = createScrollback();
  let exitCode: number | undefined;
  // Mark dead immediately on kill/exit so late resize/write cannot throw
  // (Windows node-pty: "Cannot resize a pty that has already exited").
  let dead = false;
  const markDead = () => { dead = true; };
  const exited = new Promise<number>(resolve => {
    term.onExit(({ exitCode: code }) => {
      markDead();
      exitCode = code ?? 1;
      if (logFd !== undefined) {
        try { closeSync(logFd); } catch { /* ignore */ }
        logFd = undefined;
      }
      if (registry.get(input.seatId) === session) registry.delete(input.seatId);
      resolve(exitCode);
    });
  });

  term.onData(data => {
    scrollback.append(data);
    if (logFd !== undefined) {
      try { appendFileSync(logFd, data); } catch { /* best-effort */ }
    }
    for (const listener of listeners) {
      try { listener(data); } catch { /* isolate */ }
    }
  });

  const session: PtySession = {
    seatId: input.seatId,
    pid: term.pid,
    cols,
    rows,
    write(data: string) {
      if (dead || exitCode !== undefined) return;
      try {
        term.write(data);
      } catch {
        markDead();
      }
    },
    resize(nextCols: number, nextRows: number) {
      if (dead || exitCode !== undefined) return;
      const c = Math.max(2, Math.floor(nextCols));
      const r = Math.max(1, Math.floor(nextRows));
      try {
        term.resize(c, r);
        session.cols = c;
        session.rows = r;
      } catch {
        // Already exited under ConPTY before onExit set exitCode — no-op.
        markDead();
      }
    },
    scrollback() {
      return scrollback.text();
    },
    onData(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    kill() {
      markDead();
      try { term.kill(); } catch { /* already dead */ }
    },
    exited,
  };

  registry.set(input.seatId, session);
  return session;
}

/** Test helper: clear registry without killing (tests that already killed). */
export function clearPtyRegistryForTests(): void {
  for (const session of registry.values()) {
    try { session.kill(); } catch { /* ignore */ }
  }
  registry.clear();
}

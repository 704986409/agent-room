import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LauncherAdapter } from './adapter.js';
import type { CredentialStore, CommandRunner } from './credstore.js';
import type { WakeDaemon } from './daemon.js';
import type { DaemonLog } from './log.js';
import { adapterIdForMcp, cliRequiredHint, installAdapterCli } from './cliinstall.js';
import { installMcp, mcpStatus, pairedServerUrl } from './mcpconfig.js';
import { deviceCredentialKey, pairComplete, pairWithLogin, restoreDeviceFromCredential, serverOrigin, unpair, whoami, type PairingDeps } from './pairing.js';
import type { SecretRegistry } from './redact.js';
import { writeState, type DaemonState } from './state.js';
import { readOsClipboardText } from './clipboard.js';
import { modelsForAdapter } from './modelsList.js';
import { getPtySession, listPtySessions, ptyAvailable, spawnPtySession, unregisterPtySession } from './pty.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';

/** Stable loopback port so the desktop webview can call the daemon without a Tauri rebuild. */
export const DESKTOP_CONTROL_PORT = 17421;

const DESKTOP_PATHS = new Set([
  '/api/desktop/ping',
  '/api/desktop/rooms',
  '/api/desktop/host',
  '/api/desktop/seats/stop',
  '/api/desktop/terminals',
  '/api/desktop/clipboard',
  '/api/status',
]);

export interface RecentRoom {
  code: string;
  names: string[];
  inviteCode?: string;
  at?: string;
}

/** Static pages must never stop the daemon from starting; fall back to a stub page. */
async function loadStaticPage(name: string): Promise<string> {
  try {
    return await readFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
  } catch (err) {
    console.error(`[agent-room] static page ${name} unavailable (${(err as Error).message}); serving fallback`);
    return `<!doctype html><meta charset="utf-8"><title>Agent Room</title><p>${name} is missing from this install. Please reinstall Agent Room.</p>`;
  }
}
const settingsHtml = await loadStaticPage('settings.html');
const installHtml = await loadStaticPage('install.html');

/** Same-origin xterm builds. Pop-out must not block on a CDN (blank window, close stalls). */
const VENDOR_ASSETS: Record<string, { type: string; files: string[] }> = {
  '/vendor/xterm.js': {
    type: 'text/javascript; charset=utf-8',
    files: ['./vendor/xterm.js', '../../../node_modules/@xterm/xterm/lib/xterm.js'],
  },
  '/vendor/xterm.css': {
    type: 'text/css; charset=utf-8',
    files: ['./vendor/xterm.css', '../../../node_modules/@xterm/xterm/css/xterm.css'],
  },
  '/vendor/xterm-addon-fit.js': {
    type: 'text/javascript; charset=utf-8',
    files: ['./vendor/xterm-addon-fit.js', '../../../node_modules/@xterm/addon-fit/lib/addon-fit.js'],
  },
};

const vendorBodyCache = new Map<string, string>();

function readVendorAsset(urlPath: string): { body: string; type: string } | null {
  const spec = VENDOR_ASSETS[urlPath];
  if (!spec) return null;
  const cached = vendorBodyCache.get(urlPath);
  if (cached !== undefined) return { body: cached, type: spec.type };
  for (const rel of spec.files) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(path)) continue;
    const body = readFileSync(path, 'utf8');
    vendorBodyCache.set(urlPath, body);
    return { body, type: spec.type };
  }
  return null;
}

export interface ControlServerOptions {
  daemon: WakeDaemon;
  credentials: CredentialStore;
  statePath: string;
  stateDir: string;
  server?: string;
  adapters: ReadonlyMap<string, LauncherAdapter>;
  secrets: SecretRegistry;
  log: DaemonLog;
  home?: string;
  run?: CommandRunner;
  /** Overrides process env for install recipes (tests). */
  env?: NodeJS.ProcessEnv;
  /** Forwarded to installMcp so tests can point at a fake bundle. */
  mcpEntry?: string;
  nodePath?: string;
  port?: number;
  token?: string;
  /** Test hook. Production reads the OS clipboard. */
  readClipboard?: () => Promise<string>;
  getToken: () => Promise<string | undefined>;
  setToken: (token: string) => void;
  pairComplete?: typeof pairComplete;
  pairWithLogin?: typeof pairWithLogin;
  unpair?: typeof unpair;
  whoami?: typeof whoami;
}

export interface RunningControl {
  port: number;
  token: string;
  close: () => Promise<void>;
}

function tokenMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/json; charset=utf-8',
  extra?: Record<string, string>,
): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(payload);
}

function corsHeaders(allowOrigin: string | undefined): Record<string, string> {
  if (!allowOrigin) return {};
  return {
    'access-control-allow-origin': allowOrigin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-agent-room-control, x-agent-room-desktop',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
  };
}

export async function startControlServer(options: ControlServerOptions): Promise<RunningControl> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const pairingDeps = (): PairingDeps => ({
    credentials: options.credentials,
    readState: async () => options.daemon.state,
    writeState: async (state: DaemonState) => {
      options.daemon.state.device = state.device;
      options.daemon.state.seats = state.seats;
      await writeState(options.statePath, options.daemon.state);
    },
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      const message = error instanceof Error ? error.message : 'control_error';
      if (!res.headersSent) send(res, 500, { error: message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('control_bind_failed');
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  const notedRooms: { code: string; inviteCode: string; name: string; at: string }[] = [];

  const terminalsWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket as Duplex, head).catch(() => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  function headerOne(req: IncomingMessage, name: string): string {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value) || '';
  }

  /** Browser WebSocket cannot set headers, so `?desktop=1` is the same mark as `x-agent-room-desktop: 1`. */
  function desktopMarkPresent(req: IncomingMessage, url: URL): boolean {
    return headerOne(req, 'x-agent-room-desktop') === '1' || url.searchParams.get('desktop') === '1';
  }

  function describeTerminals(): Array<{ seatId: string; pid: number; cols: number; rows: number; name?: string; code?: string }> {
    return listPtySessions().map(row => {
      const seat = options.daemon.seats.find(item => item.seatId === row.seatId);
      if (!seat) return row;
      return { ...row, name: seat.name, code: seat.code };
    });
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const tokenMatch = /^\/api\/terminals\/([^/]+)\/ws$/.exec(url.pathname);
    const desktopMatch = /^\/api\/desktop\/terminals\/([^/]+)\/ws$/.exec(url.pathname);
    const match = tokenMatch ?? desktopMatch;
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (tokenMatch) {
      const presented = headerOne(req, 'x-agent-room-control') || url.searchParams.get('t') || '';
      if (!presented || !tokenMatches(presented, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    } else {
      const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const paired = pairedOrigin();
      const allowed = desktopMarkPresent(req, url) && !!paired && requestOrigin === paired;
      if (!allowed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const seatId = decodeURIComponent(match[1]!);
    const session = getPtySession(seatId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const killOnClose = url.searchParams.get('kill') === '1';
    terminalsWss.handleUpgrade(req, socket, head, ws => {
      terminalsWss.emit('connection', ws, req);
      attachTerminalSocket(ws, session.seatId, killOnClose);
    });
  }

  function attachTerminalSocket(ws: WebSocket, seatId: string, killOnClose: boolean): void {
    const session = getPtySession(seatId);
    if (!session) {
      ws.close(1011, 'no_session');
      return;
    }
    // Snapshot first, then subscribe. Live chunks already in the ring are not
    // emitted again; bytes that arrive after this point go only through onData.
    const prior = session.scrollback();
    if (prior && ws.readyState === ws.OPEN) ws.send(prior);
    const unsub = session.onData(data => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    ws.on('message', raw => {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(text) as typeof msg; }
      catch {
        // Treat non-JSON as raw stdin (paste-friendly).
        session.write(text);
        return;
      }
      if (msg.type === 'stdin' && typeof msg.data === 'string') session.write(msg.data);
      else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        session.resize(msg.cols, msg.rows);
      }
    });
    ws.on('close', () => {
      unsub();
      if (killOnClose) {
        try { getPtySession(seatId)?.kill(); } catch { /* ignore */ }
      }
    });
  }


  function configuredServer(): string {
    return pairedServerUrl({ server: options.server ?? options.daemon.state.device?.server });
  }

  function pairedOrigin(): string | undefined {
    try { return serverOrigin(configuredServer()); } catch { return undefined; }
  }

  function allowOrigin(requestOrigin: string | undefined): string | undefined {
    if (!requestOrigin) return undefined;
    if (requestOrigin === origin) return requestOrigin;
    const paired = pairedOrigin();
    if (paired && requestOrigin === paired) return requestOrigin;
    return undefined;
  }

  function noteRoom(code: string, inviteCode: string, name: string): void {
    const at = new Date().toISOString();
    const existing = notedRooms.find(room => room.code === code);
    if (existing) {
      existing.inviteCode = inviteCode;
      existing.name = name;
      existing.at = at;
      return;
    }
    notedRooms.unshift({ code, inviteCode, name, at });
    if (notedRooms.length > 20) notedRooms.pop();
  }

  function recentRooms(): RecentRoom[] {
    const byCode = new Map<string, RecentRoom>();
    for (const seat of options.daemon.seats) {
      const row = byCode.get(seat.code) ?? { code: seat.code, names: [] };
      if (seat.name && !row.names.includes(seat.name)) row.names.push(seat.name);
      if (seat.startedAt && (!row.at || seat.startedAt > row.at)) row.at = seat.startedAt;
      byCode.set(seat.code, row);
    }
    for (const noted of notedRooms) {
      const row = byCode.get(noted.code) ?? { code: noted.code, names: [] };
      row.inviteCode = noted.inviteCode;
      if (noted.name && !row.names.includes(noted.name)) row.names.push(noted.name);
      row.at = noted.at;
      byCode.set(noted.code, row);
    }
    return [...byCode.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  }

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  try { await chmod(options.stateDir, 0o700); } catch { /* Windows may ignore mode */ }
  try {
    const restored = await restoreDeviceFromCredential(configuredServer(), {
      ...pairingDeps(),
      identify: (server, token) => (options.whoami ?? whoami)(server, token),
    });
    if (restored) {
      const tokenValue = await options.credentials.get(deviceCredentialKey(configuredServer()));
      if (tokenValue) {
        options.secrets.add(tokenValue);
        options.setToken(tokenValue);
      }
      options.log.write(`[pair] restored device record server=${configuredServer()}`);
    }
  } catch (error) {
    options.log.write(`[pair] restore skipped reason=${error instanceof Error ? error.message : 'unknown'}`);
  }
  const controlPath = join(options.stateDir, 'control.json');
  await writeFile(controlPath, JSON.stringify({ port, token }, null, 2), { mode: 0o600 });
  try { await chmod(controlPath, 0o600); } catch { /* Windows may ignore mode */ }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allow = allowOrigin(requestOrigin);
    const cors = corsHeaders(allow);
    if (req.method === 'OPTIONS') {
      send(res, allow ? 204 : 403, allow ? '' : { error: 'origin_rejected' }, 'text/plain; charset=utf-8', cors);
      return;
    }
    const paired = pairedOrigin();
    if (requestOrigin && requestOrigin !== origin && requestOrigin !== paired) {
      send(res, 403, { error: 'origin_rejected' }, undefined, cors);
      return;
    }
    const header = req.headers['x-agent-room-control'];
    const presented = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('t') || '';
    const tokenOk = !!presented && tokenMatches(presented, token);
    const desktopHeader = req.headers['x-agent-room-desktop'];
    const desktopMark = desktopHeader === '1' || (Array.isArray(desktopHeader) && desktopHeader[0] === '1');
    const desktopStop = /^\/api\/desktop\/terminals\/([^/]+)\/stop$/.test(url.pathname);
    const desktopOk = (DESKTOP_PATHS.has(url.pathname) || desktopStop) && desktopMark && !!paired && requestOrigin === paired;
    if (req.method === 'GET' && VENDOR_ASSETS[url.pathname]) {
      const asset = readVendorAsset(url.pathname);
      if (!asset) {
        send(res, 404, { error: 'vendor_missing' }, 'application/json; charset=utf-8', cors);
        return;
      }
      send(res, 200, asset.body, asset.type, cors);
      return;
    }
    if (!tokenOk && !desktopOk) {
      send(res, 401, { error: 'control_unauthorized' }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(res, 200, settingsHtml, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/install') {
      send(res, 200, installHtml, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(res, 200, await statusPayload(), 'application/json; charset=utf-8', cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      send(res, 200, { lines: await options.log.tail(100) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/mcp') {
      send(res, 200, { tools: await mcpStatus({ home: options.home, run: options.run }) }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop/ping') {
      send(res, 200, { ok: true, paired: !!options.daemon.state.device }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop/rooms') {
      send(res, 200, { rooms: recentRooms() }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/api/terminals' || url.pathname === '/api/desktop/terminals')) {
      send(res, 200, { terminals: describeTerminals(), mode: process.env.AGENT_ROOM_TERMINAL ?? 'embedded' }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/desktop/clipboard') {
      let text = '';
      try {
        const read = options.readClipboard ?? readOsClipboardText;
        const value = await read();
        text = typeof value === 'string' ? value : '';
      } catch {
        text = '';
      }
      send(res, 200, { text }, undefined, cors);
      return;
    }
    {
      const termMatch = /^\/api\/terminals\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && termMatch) {
        const seatId = decodeURIComponent(termMatch[1]!);
        const session = getPtySession(seatId);
        if (!session) {
          send(res, 404, { error: 'terminal_not_found' }, undefined, cors);
          return;
        }
        send(res, 200, { seatId: session.seatId, pid: session.pid, cols: session.cols, rows: session.rows }, undefined, cors);
        return;
      }
    }
    if (req.method === 'POST') {
      const desktopStopMatch = /^\/api\/desktop\/terminals\/([^/]+)\/stop$/.exec(url.pathname);
      const tokenStopMatch = /^\/api\/terminals\/([^/]+)\/stop$/.exec(url.pathname);
      const stopMatch = desktopStopMatch ?? tokenStopMatch;
      if (stopMatch) {
        const stopped = await stopTerminal(decodeURIComponent(stopMatch[1]!));
        send(res, stopped.status, stopped.body, undefined, cors);
        return;
      }
    }
    if (req.method !== 'POST') {
      send(res, 404, { error: 'not_found' }, undefined, cors);
      return;
    }
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    if (url.pathname === '/api/pair') {
      const pairingCode = typeof body.pairingCode === 'string' ? body.pairingCode : '';
      const serverUrl = options.server ?? options.daemon.state.device?.server;
      if (!serverUrl || !pairingCode) {
        send(res, 400, { error: 'pair_input' });
        return;
      }
      const paired = await (options.pairComplete ?? pairComplete)(serverUrl, pairingCode, pairingDeps());
      await rememberCredential(serverUrl, paired.deviceCredential);
      options.daemon.resumeAfterPair();
      send(res, 200, { ok: true, deviceId: paired.deviceId });
      return;
    }
    if (url.pathname === '/api/pair-login') {
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const serverUrl = options.server ?? options.daemon.state.device?.server;
      if (!serverUrl || !username || !password) {
        send(res, 400, { error: 'pair_input' });
        return;
      }
      const paired = await (options.pairWithLogin ?? pairWithLogin)(serverUrl, username, password, pairingDeps());
      const credential = await options.credentials.get(deviceCredentialKey(serverUrl));
      if (credential) await rememberCredential(serverUrl, credential);
      options.daemon.resumeAfterPair();
      send(res, 200, { ok: true, deviceId: paired.deviceId });
      return;
    }
    if (url.pathname === '/api/unpair') {
      const serverUrl = options.server ?? options.daemon.state.device?.server;
      await (options.unpair ?? unpair)(serverUrl, pairingDeps());
      options.setToken('');
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/agents') {
      const serverUrl = options.server ?? options.daemon.state.device?.server;
      if (!serverUrl) {
        send(res, 400, { error: 'no_server' });
        return;
      }
      const code = String(body.code ?? '');
      const inviteCode = String(body.inviteCode ?? '');
      const name = String(body.name ?? '');
      const seat = await options.daemon.startAgent({
        server: serverUrl,
        code,
        inviteCode,
        name,
        adapterId: String(body.adapterId ?? ''),
        model: String(body.model ?? ''),
        cwd: String(body.cwd ?? ''),
      });
      if (code && inviteCode) noteRoom(code, inviteCode, name);
      send(res, 200, { ok: true, seat }, undefined, cors);
      return;
    }
    if (url.pathname === '/api/desktop/host') {
      const hosted = await hostFromRoom(body);
      send(res, hosted.status, hosted.body, undefined, cors);
      return;
    }
    if (url.pathname === '/api/desktop/seats/stop') {
      const stopped = await stopMatchingSeats(body);
      send(res, 200, stopped, undefined, cors);
      return;
    }
    if (url.pathname === '/api/mcp/install') {
      const target = typeof body.target === 'string' ? body.target : '';
      const adapterId = adapterIdForMcp(target);
      if (adapterId) {
        const detected = await options.adapters.get(adapterId)?.detect() ?? { installed: false };
        if (!detected.installed) {
          send(res, 400, { error: 'cli_not_installed', hint: cliRequiredHint(adapterId) });
          return;
        }
      }
      const result = await installMcp(target, {
        home: options.home,
        run: options.run,
        mcpEntry: options.mcpEntry,
        nodePath: options.nodePath,
        env: options.env,
        server: options.server ?? options.daemon.state.device?.server,
      });
      send(res, 'error' in result ? 400 : 200, result);
      return;
    }
    if (url.pathname === '/api/adapters/install') {
      const id = typeof body.id === 'string' ? body.id : '';
      const runId = typeof body.runId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.runId) ? body.runId : undefined;
      const result = await installAdapterCli(id, {
        adapters: options.adapters,
        run: options.run,
        log: options.log,
        env: options.env,
        nodePath: options.nodePath,
        runId,
      });
      send(res, 'error' in result ? 400 : 200, result);
      return;
    }

    if (url.pathname === '/api/debug/pty-spawn') {
      // QA / box-only hatch. Never enable AGENT_ROOM_DEBUG_PTY in product defaults.
      if (process.env.AGENT_ROOM_DEBUG_PTY !== '1') {
        send(res, 404, { error: 'not_found' }, undefined, cors);
        return;
      }
      if (!ptyAvailable()) {
        send(res, 503, { error: 'pty_unavailable' }, undefined, cors);
        return;
      }
      const rawSeat = typeof body.seatId === 'string' ? body.seatId.trim() : '';
      const seatId = (rawSeat || 'qa-popout').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 96) || 'qa-popout';
      const cwd = options.stateDir;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
      }
      // Long-lived interactive bash so settings xterm + 弹出/收回 can share one PTY.
      const session = spawnPtySession({
        seatId,
        command: 'bash',
        args: [],
        cwd,
        env,
        cols: 100,
        rows: 28,
      });
      send(res, 200, { ok: true, seatId: session.seatId, pid: session.pid, cols: session.cols, rows: session.rows }, undefined, cors);
      return;
    }
    send(res, 404, { error: 'not_found' });
  }

  async function stopTerminal(seatId: string): Promise<{ status: number; body: unknown }> {
    const id = seatId.trim();
    if (!id || id.length > 128 || id.includes('/') || id.includes('\\')) {
      return { status: 400, body: { error: 'seat_id' } };
    }
    const session = getPtySession(id);
    options.log.write(`[leave] terminal stop roomCode=${options.daemon.seats.find(seat => seat.seatId === id)?.code ?? 'unknown'} seatId=${id}`);
    if (session) {
      try { session.kill(); } catch { /* already dead */ }
      // Drop from the rail list immediately; onExit may lag after kill.
      unregisterPtySession(id);
    }
    const hadSeat = await options.daemon.stopManagedSeat(id);
    if (!session && !hadSeat) return { status: 404, body: { error: 'terminal_not_found' } };
    return { status: 200, body: { ok: true, stopped: true, seatId: id } };
  }

  async function hostFromRoom(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const serverUrl = configuredServer();
    if (!serverUrl) return { status: 400, body: { error: 'no_server' } };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!code || !inviteCode) return { status: 400, body: { error: 'host_input' } };
    const requestedId = typeof body.adapterId === 'string' ? body.adapterId : '';
    let chosen = requestedId ? options.adapters.get(requestedId) : undefined;
    if (!chosen) {
      const ready = [];
      for (const adapter of options.adapters.values()) {
        const detected = await adapter.detect();
        if (detected.installed && modelsForAdapter(adapter).length > 0) ready.push(adapter);
      }
      chosen = ready.find(adapter => adapter.id === 'codex') ?? ready[0];
    }
    if (!chosen) return { status: 400, body: { error: 'launcher_unavailable' } };
    const chosenModels = modelsForAdapter(chosen);
    if (chosenModels.length === 0) return { status: 400, body: { error: 'launcher_unavailable' } };
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    const model = chosenModels.includes(requestedModel) ? requestedModel : chosenModels[0]!;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : chosen.id;
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : (options.home ?? homedir());
    options.log.write(`[host] HostLocal start roomCode=${code} adapter=${chosen.id}`);
    try {
      const seat = await options.daemon.startAgent({
        server: serverUrl, code, inviteCode, name, adapterId: chosen.id, model, cwd,
      });
      options.log.write(`[host] HostLocal success roomCode=${code} seatId=${seat.seatId} adapter=${chosen.id}`);
      noteRoom(code, inviteCode, name);
      return { status: 200, body: { ok: true, seat } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'host_failed';
      options.log.write(`[host] HostLocal failed roomCode=${code} adapter=${chosen.id} reason=${message}`);
      const hint = message === 'unpaired' || message === 'register_timeout'
        ? '本机托管没有完成。请打开桌面端主窗口菜单「本机设置」登录后再试。'
        : message === 'join_timeout'
          ? '加入房间超时，请检查网络后重试。'
          : message;
      return { status: 400, body: { error: message, hint } };
    }
  }

  async function stopMatchingSeats(body: Record<string, unknown>): Promise<{ ok: true; stopped: string[] }> {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const seatId = typeof body.seatId === 'string' ? body.seatId.trim() : '';
    const ids = new Set<string>();
    for (const seat of options.daemon.seats) {
      if (seatId && seat.seatId === seatId) ids.add(seat.seatId);
      if (code && name && seat.code === code && seat.name === name) ids.add(seat.seatId);
    }
    if (seatId && getPtySession(seatId)) ids.add(seatId);
    const stopped: string[] = [];
    for (const id of ids) {
      const session = getPtySession(id);
      if (session) {
        try { session.kill(); } catch { /* already dead */ }
        unregisterPtySession(id);
      }
      if (await options.daemon.stopManagedSeat(id)) stopped.push(id);
    }
    options.log.write(`[leave] desktop seats stop roomCode=${code || 'unknown'} name=${name || 'unknown'} stopped=${stopped.join(',') || 'none'}`);
    return { ok: true, stopped };
  }

  async function rememberCredential(serverUrl: string, credential: string): Promise<void> {
    options.secrets.add(credential);
    await options.credentials.set(deviceCredentialKey(serverUrl), credential);
    options.setToken(credential);
  }

  async function statusPayload(): Promise<unknown> {
    const device = options.daemon.state.device;
    const serverUrl = device?.server ?? configuredServer();
    const tokenValue = await options.getToken();
    let user: { username?: string; userId?: string; deviceId?: string } | null = null;
    if (device && tokenValue && serverUrl) {
      try {
        user = await (options.whoami ?? whoami)(serverUrl, tokenValue);
      } catch {
        user = null;
      }
    }
    const adapters = [];
    for (const adapter of options.adapters.values()) {
      const detected = await adapter.detect();
      adapters.push({ id: adapter.id, command: adapter.command, models: [...modelsForAdapter(adapter)], ...detected });
    }
    return {
      paired: !!device,
      server: serverUrl,
      deviceId: device?.deviceId,
      pairedAt: device?.pairedAt,
      user,
      auth: options.daemon.authState === 'unauthorized' ? 'unauthorized' : device ? 'ok' : 'unpaired',
      seats: options.daemon.seats.map(seat => ({
        seatId: seat.seatId,
        roomInstanceId: seat.roomInstanceId,
        code: seat.code,
        name: seat.name,
        adapterId: seat.adapterId,
        model: seat.model,
        status: seat.status,
        sessionId: seat.sessionId,
        pid: seat.pid,
        cwd: seat.cwd,
        startedAt: seat.startedAt,
      })),
      adapters,
    };
  }

  return {
    port,
    token,
    close: () => new Promise(resolve => {
      terminalsWss.close();
      server.close(() => resolve());
    }),
  };
}

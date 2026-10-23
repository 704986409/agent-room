import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { installMcp, mcpStatus } from './mcpconfig.js';
import { deviceCredentialKey, pairComplete, pairWithLogin, serverOrigin, unpair, whoami, type PairingDeps } from './pairing.js';
import type { SecretRegistry } from './redact.js';
import { writeState, type DaemonState } from './state.js';

/** Stable loopback port so the desktop webview can call the daemon without a Tauri rebuild. */
export const DESKTOP_CONTROL_PORT = 17421;

const DESKTOP_PATHS = new Set(['/api/desktop/ping', '/api/desktop/rooms', '/api/desktop/host']);

export interface RecentRoom {
  code: string;
  names: string[];
  inviteCode?: string;
  at?: string;
}

const settingsHtml = await readFile(fileURLToPath(new URL('./settings.html', import.meta.url)), 'utf8');

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

  function pairedOrigin(): string | undefined {
    const serverUrl = options.server ?? options.daemon.state.device?.server;
    if (!serverUrl) return undefined;
    try { return serverOrigin(serverUrl); } catch { return undefined; }
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
    const desktopOk = DESKTOP_PATHS.has(url.pathname) && desktopMark && !!paired && requestOrigin === paired;
    if (!tokenOk && !desktopOk) {
      send(res, 401, { error: 'control_unauthorized' }, undefined, cors);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(res, 200, settingsHtml, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(res, 200, await statusPayload());
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
      const result = await installAdapterCli(id, {
        adapters: options.adapters,
        run: options.run,
        log: options.log,
        env: options.env,
        nodePath: options.nodePath,
      });
      send(res, 'error' in result ? 400 : 200, result);
      return;
    }
    send(res, 404, { error: 'not_found' });
  }

  async function hostFromRoom(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const serverUrl = options.server ?? options.daemon.state.device?.server;
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
        if (detected.installed && adapter.models.length > 0) ready.push(adapter);
      }
      chosen = ready.find(adapter => adapter.id === 'codex') ?? ready[0];
    }
    if (!chosen || chosen.models.length === 0) return { status: 400, body: { error: 'launcher_unavailable' } };
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    const model = chosen.models.includes(requestedModel) ? requestedModel : chosen.models[0]!;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : chosen.id;
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : (options.home ?? homedir());
    const seat = await options.daemon.startAgent({
      server: serverUrl, code, inviteCode, name, adapterId: chosen.id, model, cwd,
    });
    noteRoom(code, inviteCode, name);
    return { status: 200, body: { ok: true, seat } };
  }

  async function rememberCredential(serverUrl: string, credential: string): Promise<void> {
    options.secrets.add(credential);
    await options.credentials.set(deviceCredentialKey(serverUrl), credential);
    options.setToken(credential);
  }

  async function statusPayload(): Promise<unknown> {
    const device = options.daemon.state.device;
    const serverUrl = device?.server ?? options.server;
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
      adapters.push({ id: adapter.id, command: adapter.command, models: [...adapter.models], ...detected });
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
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

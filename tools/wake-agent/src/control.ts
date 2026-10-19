import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LauncherAdapter } from './adapter.js';
import type { CredentialStore, CommandRunner } from './credstore.js';
import type { WakeDaemon } from './daemon.js';
import type { DaemonLog } from './log.js';
import { installMcp, mcpStatus } from './mcpconfig.js';
import { deviceCredentialKey, pairComplete, pairWithLogin, unpair, whoami, type PairingDeps } from './pairing.js';
import type { SecretRegistry } from './redact.js';
import { writeState, type DaemonState } from './state.js';

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

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
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

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const controlPath = join(options.stateDir, 'control.json');
  await writeFile(controlPath, JSON.stringify({ port, token }, null, 2), { mode: 0o600 });
  await chmod(controlPath, 0o600);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const header = req.headers['x-agent-room-control'];
    const presented = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('t') || '';
    if (!presented || !tokenMatches(presented, token)) {
      send(res, 401, { error: 'control_unauthorized' });
      return;
    }
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin) {
      send(res, 403, { error: 'origin_rejected' });
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
      send(res, 200, { tools: await mcpStatus({ home: options.home, run: options.run }) });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 404, { error: 'not_found' });
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
      const seat = await options.daemon.startAgent({
        server: serverUrl,
        code: String(body.code ?? ''),
        inviteCode: String(body.inviteCode ?? ''),
        name: String(body.name ?? ''),
        adapterId: String(body.adapterId ?? ''),
        model: String(body.model ?? ''),
        cwd: String(body.cwd ?? ''),
      });
      send(res, 200, { ok: true, seat });
      return;
    }
    if (url.pathname === '/api/mcp/install') {
      const target = typeof body.target === 'string' ? body.target : '';
      const result = await installMcp(target, { home: options.home, run: options.run });
      send(res, 'error' in result ? 400 : 200, result);
      return;
    }
    send(res, 404, { error: 'not_found' });
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

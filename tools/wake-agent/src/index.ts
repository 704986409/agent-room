import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDefaultAdapters, nodeSpawner } from './adapter.js';
import { startControlServer } from './control.js';
import { openCredentialStore, processRunner } from './credstore.js';
import { FileRunLock, WakeDaemon } from './daemon.js';
import { createHttpWakeApi } from './http.js';
import { DaemonLog } from './log.js';
import { pairComplete, pairWithLogin, serverOrigin, unpair, deviceCredentialKey } from './pairing.js';
import { SecretRegistry } from './redact.js';
import { inspectProcess, readState, writeState } from './state.js';

const HELP = `agent-room-wake-agent

Local wake daemon and desktop control page. Outbound HTTPS only.
The control server binds 127.0.0.1 and is not reachable from other machines.

  pair --server URL --code CODE
  pair --server URL --login USER     password: $AGENT_ROOM_PASSWORD or stdin
  unpair [--server URL] [--state path]
  status [--state path]
  start-agent --code CODE --invite CODE --name NAME --adapter ID --model MODEL --cwd PATH
              [--server URL] [--state path]
  serve [--state path] [--server URL] [--control-port N] [--no-control]
        Token: $AGENT_ROOM_DEVICE_TOKEN, otherwise the credential store.
        Prints: control: http://127.0.0.1:<port>/?t=<token>

Secrets (device token, seatKey, password) stay out of the state file and out of logs.
`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function defaultStatePath(): string {
  return join(homedir(), '.local/state/agent-room/daemon.json');
}

function defaultConfigDir(): string {
  return join(homedir(), '.config/agent-room');
}

async function readPassword(): Promise<string> {
  if (process.env.AGENT_ROOM_PASSWORD) return process.env.AGENT_ROOM_PASSWORD;
  if (process.stdin.isTTY) process.stderr.write('password: ');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function openStores(statePath: string) {
  const secrets = new SecretRegistry();
  const state = await readState(statePath);
  const credentials = await openCredentialStore({
    dir: defaultConfigDir(),
    log: line => process.stderr.write(`${secrets.redact(line)}\n`),
  });
  return { secrets, state, credentials, statePath };
}

function requireServer(explicit: string | undefined, stateServer: string | undefined): string {
  const server = explicit ?? process.env.AGENT_ROOM_SERVER ?? stateServer;
  if (!server) {
    process.stderr.write('Need --server, AGENT_ROOM_SERVER, or a paired device.server.\n');
    process.exitCode = 1;
    return '';
  }
  return server;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const statePath = flag('--state') ?? defaultStatePath();
  if (command === 'pair') {
    const { secrets, state, credentials } = await openStores(statePath);
    const server = requireServer(flag('--server'), state.device?.server);
    if (!server) return;
    const deps = {
      credentials,
      readState: async () => state,
      writeState: async (next: typeof state) => { await writeState(statePath, next); },
    };
    if (flag('--login')) {
      const username = flag('--login') ?? '';
      const password = await readPassword();
      secrets.add(password);
      const paired = await pairWithLogin(server, username, password, deps);
      process.stdout.write(`paired ${paired.deviceId}\n`);
      return;
    }
    const code = flag('--code');
    if (!code) {
      process.stderr.write('pair needs --code or --login.\n');
      process.exitCode = 1;
      return;
    }
    const paired = await pairComplete(server, code, deps);
    secrets.add(paired.deviceCredential);
    process.stdout.write(`paired ${paired.deviceId}\n`);
    return;
  }
  if (command === 'unpair') {
    const { state, credentials } = await openStores(statePath);
    await unpair(flag('--server') ?? state.device?.server, {
      credentials,
      readState: async () => state,
      writeState: next => writeState(statePath, next),
    });
    process.stdout.write('unpaired\n');
    return;
  }
  if (command === 'status') {
    const { state } = await openStores(statePath);
    const seats = state.seats.map(seat => ({
      seatId: seat.seatId, code: seat.code, name: seat.name, adapterId: seat.adapterId,
      model: seat.model, status: seat.status, sessionId: seat.sessionId, pid: seat.pid,
    }));
    process.stdout.write(`${JSON.stringify({
      server: state.device?.server, deviceId: state.device?.deviceId, pairedAt: state.device?.pairedAt, seats,
    }, null, 2)}\n`);
    return;
  }
  if (command === 'start-agent') {
    const code = flag('--code');
    const inviteCode = flag('--invite');
    const name = flag('--name');
    const adapterId = flag('--adapter');
    const model = flag('--model');
    const cwd = flag('--cwd');
    if (!code || !inviteCode || !name || !adapterId || !model || !cwd) {
      process.stderr.write('start-agent needs --code, --invite, --name, --adapter, --model, and --cwd.\n');
      process.exitCode = 1;
      return;
    }
    const started = await runDaemon(statePath, { once: { code, inviteCode, name, adapterId, model, cwd } });
    if (started) process.stdout.write(`seat ${started}\n`);
    return;
  }
  if (command === 'serve') {
    await runDaemon(statePath, { serve: true });
    return;
  }
  process.stderr.write(HELP);
  process.exitCode = 1;
}

async function runDaemon(statePath: string, mode: {
  serve?: boolean;
  once?: { code: string; inviteCode: string; name: string; adapterId: string; model: string; cwd: string };
}): Promise<string | undefined> {
  const stateDir = dirname(statePath);
  const { secrets, state, credentials } = await openStores(statePath);
  const server = requireServer(flag('--server'), state.device?.server);
  if (!server) return undefined;
  const origin = serverOrigin(server);
  const envToken = process.env.AGENT_ROOM_DEVICE_TOKEN;
  if (envToken) secrets.add(envToken);
  let holder = envToken ?? await credentials.get(deviceCredentialKey(server)) ?? '';
  if (holder) secrets.add(holder);
  const tokenOf = async () => holder;
  const log = new DaemonLog(secrets, join(stateDir, 'daemon.log'));
  const adapters = createDefaultAdapters(nodeSpawner());
  const daemon = new WakeDaemon({
    api: createHttpWakeApi(server, tokenOf),
    adapters,
    state,
    lock: new FileRunLock(stateDir),
    inspect: inspectProcess,
    persist: next => writeState(statePath, next),
    log: line => log.write(line),
    env: { AGENT_ROOM_MANAGED: '1' },
    server,
    credentials,
    stateDir,
    secrets,
  });
  if (mode.once) {
    const seat = await daemon.startAgent({ server, ...mode.once });
    return seat.seatId;
  }
  let control: { close: () => Promise<void> } | undefined;
  if (!hasFlag('--no-control')) {
    const portText = flag('--control-port');
    const started = await startControlServer({
      daemon,
      credentials,
      statePath,
      stateDir,
      server,
      adapters,
      secrets,
      log,
      run: processRunner(),
      port: portText ? Number(portText) : undefined,
      getToken: tokenOf,
      setToken: value => {
        if (!envToken) holder = value;
        if (value) secrets.add(value);
      },
    });
    control = started;
    process.stdout.write(`control: http://127.0.0.1:${started.port}/?t=${started.token}\n`);
  }
  const shutdown = () => {
    daemon.stop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await daemon.run();
  await control?.close();
  return undefined;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  void main();
}

export { HELP };

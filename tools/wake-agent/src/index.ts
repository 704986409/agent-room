import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CodexCliAdapter, nodeSpawner } from './adapter.js';
import { FileRunLock, WakeDaemon } from './daemon.js';
import { createHttpWakeApi } from './http.js';
import { inspectProcess, readState, writeState } from './state.js';

const HELP = `agent-room-wake-agent

Local wake daemon. Outbound HTTPS only; this process does not listen on a public port.

  serve --state <path> --server <url>
        Poll /api/wake. Authorization: Bearer $AGENT_ROOM_DEVICE_TOKEN.
        Codex CLI parameters are provisional until M0 verification.
        Do not point --server at production unless you intend to wake real seats.

Secrets (device token, seatKey) stay out of the state file and out of logs.
`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.argv.includes('serve')) {
    process.stdout.write(HELP);
    return;
  }
  const statePath = flag('--state');
  const server = flag('--server');
  const token = process.env.AGENT_ROOM_DEVICE_TOKEN ?? '';
  if (!statePath || !server || !token) {
    process.stderr.write('serve needs --state, --server, and AGENT_ROOM_DEVICE_TOKEN.\n');
    process.exitCode = 1;
    return;
  }
  const daemon = new WakeDaemon({
    api: createHttpWakeApi(server, token),
    adapters: new Map([['codex', new CodexCliAdapter(nodeSpawner())]]),
    state: await readState(statePath),
    lock: new FileRunLock(dirname(statePath)),
    inspect: inspectProcess,
    persist: state => writeState(statePath, state),
    log: line => process.stderr.write(`${line}\n`),
    env: {},
  });
  process.once('SIGTERM', () => daemon.stop());
  process.once('SIGINT', () => daemon.stop());
  await daemon.run();
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  void main();
}

export { HELP };

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HELP = `agent-room-wake-agent

Local wake daemon. Outbound HTTPS only; this process does not listen on a public port.

  serve --state <path> --server <url>
        Poll /api/wake with Authorization: Bearer taken from AGENT_ROOM_DEVICE_TOKEN.
        Codex CLI parameters are provisional until M0 verification.
        Do not point --server at production unless you intend to wake real seats.

Secrets (device token, seatKey) stay out of the state file and out of logs.
`;

function main(): void {
  const serve = process.argv.includes('serve');
  if (!serve) {
    process.stdout.write(HELP);
    return;
  }
  process.stderr.write('serve is wired by the desktop shell; run the unit tests with a mock server.\n');
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) main();

export { HELP };

// VPS bootstrap: create the first admin account.
//
//   node deploy/vps/scripts/create-admin.mjs --username <name>
//
// The .mjs launcher runs this file with tsx. Password comes from a hidden
// TTY prompt, or from stdin when the process is not a terminal. Do not pass
// the password as an argument.

import { runCreateAdmin } from '../../../api/_createAdmin.js';

const code = await runCreateAdmin({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.exit(code);

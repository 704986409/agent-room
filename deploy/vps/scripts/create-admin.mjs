#!/usr/bin/env node
// Create the first admin (design §4.1). Password is prompted with no echo,
// or read from stdin. It is never accepted as a flag and never logged.
//
//   node deploy/vps/scripts/create-admin.mjs --username <name>
//   node deploy/vps/scripts/create-admin.mjs --username <name> --add
//
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
// See NOTES-accounts-writes.md.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const script = resolve(here, 'create-admin.ts');
const require = createRequire(resolve(root, 'package.json'));
// tsx does not export ./dist/cli.mjs; resolve its package.json instead.
const tsx = resolve(dirname(require.resolve('tsx/package.json')), 'dist/cli.mjs');

const child = spawn(process.execPath, [tsx, script, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

// First-admin bootstrap. The password is read from a hidden TTY prompt or
// from stdin. It is never written to stdout, stderr, or a log line.

import { createClient, type UpstashClient } from '@agent-room/upstash-client';
import { AccountError, createUser, hasAdmin } from './_accounts.js';

export interface CreateAdminIo {
  argv: string[];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  client?: UpstashClient;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function readPassword(stdin: NodeJS.ReadableStream, stderr: NodeJS.WritableStream): Promise<string> {
  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY && typeof tty.setRawMode === 'function') {
    stderr.write('Password: ');
    tty.setRawMode(true);
    tty.resume();
    let password = '';
    try {
      password = await new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer | string) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          for (const char of text) {
            if (char === '\r' || char === '\n' || char === '\u0004') {
              tty.off('data', onData);
              resolve(password);
              return;
            }
            if (char === '\u0003') {
              tty.off('data', onData);
              reject(new Error('interrupted'));
              return;
            }
            if (char === '\u007f' || char === '\b') {
              password = password.slice(0, -1);
              continue;
            }
            password += char;
          }
        };
        tty.on('data', onData);
      });
    } finally {
      tty.setRawMode(false);
      tty.pause();
      stderr.write('\n');
    }
    return password;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function clientFromEnv(env: NodeJS.ProcessEnv): UpstashClient {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new AccountError('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.', 503, 'not_configured');
  }
  return createClient({ url, token });
}

export async function runCreateAdmin(io: CreateAdminIo): Promise<number> {
  const username = flag(io.argv, '--username')?.trim();
  if (!username || hasFlag(io.argv, '--help')) {
    io.stderr.write('Usage: node deploy/vps/scripts/create-admin.mjs --username <name> [--add]\n');
    io.stderr.write('Password is read from a hidden prompt, or from stdin when not a TTY. It is not logged.\n');
    return 1;
  }
  let password = '';
  try {
    password = await readPassword(io.stdin, io.stderr);
    const client = io.client ?? clientFromEnv(io.env);
    const add = hasFlag(io.argv, '--add');
    if (!add && await hasAdmin(client)) {
      io.stderr.write('An admin already exists. Refusing to continue without --add.\n');
      return 1;
    }
    const user = await createUser(client, { username, password, role: 'admin' });
    io.stdout.write(`Created admin ${user.username}.\n`);
    return 0;
  } catch (error) {
    if ((error as Error).message === 'interrupted') {
      io.stderr.write('Aborted.\n');
      return 1;
    }
    const message = error instanceof AccountError ? error.message : 'Could not create the admin.';
    io.stderr.write(`${message}\n`);
    return 1;
  } finally {
    password = '';
  }
}

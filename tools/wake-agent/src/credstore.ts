import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveCommand } from './adapter.js';

export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

export function processRunner(): CommandRunner {
  return (command, args, input, timeoutMs = 5_000) => new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 1, stdout, stderr: stderr || 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => finish({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** libsecret via `secret-tool`. The secret is written to stdin and never to argv. */
export class LinuxSecretStore implements CredentialStore {
  constructor(private readonly run: CommandRunner = processRunner()) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.run('secret-tool', ['lookup', 'service', 'agent-room', 'key', key]);
    if (result.code !== 0) return undefined;
    return result.stdout.replace(/\n$/, '');
  }

  async set(key: string, value: string): Promise<void> {
    const result = await this.run(
      'secret-tool',
      ['store', '--label', `Agent Room ${key}`, 'service', 'agent-room', 'key', key],
      value,
    );
    if (result.code !== 0) throw new Error('secret_store_failed');
  }

  async delete(key: string): Promise<void> {
    await this.run('secret-tool', ['clear', 'service', 'agent-room', 'key', key]);
  }
}

export class FileStore implements CredentialStore {
  constructor(private readonly path: string) {}

  get filePath(): string { return this.path; }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(values: Record<string, string>): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(values, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const values = await this.read();
    values[key] = value;
    await this.write(values);
  }

  async delete(key: string): Promise<void> {
    const values = await this.read();
    delete values[key];
    await this.write(values);
  }
}

let warnedFallback = false;

export function resetCredentialStoreWarning(): void { warnedFallback = false; }

async function secretServiceWorks(run: CommandRunner): Promise<boolean> {
  const key = `probe:${randomBytes(8).toString('hex')}`;
  const value = randomBytes(8).toString('hex');
  try {
    const stored = await run(
      'secret-tool',
      ['store', '--label', `Agent Room ${key}`, 'service', 'agent-room', 'key', key],
      value,
    );
    if (stored.code !== 0) return false;
    const looked = await run('secret-tool', ['lookup', 'service', 'agent-room', 'key', key]);
    return looked.code === 0 && looked.stdout.replace(/\n$/, '') === value;
  } catch {
    return false;
  } finally {
    await run('secret-tool', ['clear', 'service', 'agent-room', 'key', key]).catch(() => undefined);
  }
}

export async function openCredentialStore(options: {
  dir: string;
  prefer?: 'file' | 'secret-tool';
  run?: CommandRunner;
  log?: (line: string) => void;
  commandExists?: (command: string) => boolean;
}): Promise<CredentialStore> {
  const path = join(options.dir, 'credentials.json');
  const file = new FileStore(path);
  if (options.prefer === 'file') return file;
  const exists = options.commandExists ?? (command => resolveCommand(command) !== undefined);
  const run = options.run ?? processRunner();
  const available = exists('secret-tool') && await secretServiceWorks(run);
  if (available) return new LinuxSecretStore(run);
  if (!warnedFallback) {
    warnedFallback = true;
    options.log?.(`secret service unavailable; credentials stored in 0600 file ${path}`);
  }
  return file;
}

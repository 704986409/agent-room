import { spawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** Launcher adapter. Arguments below are the M0-verified CLI contracts. */
export interface LaunchOptions {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  model: string;
  logFile?: string;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface LauncherAdapter {
  readonly id: string;
  readonly command: string;
  readonly models: readonly string[];
  detect(): Promise<DetectResult>;
  launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string; exited: Promise<number> }>;
  resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number; exited: Promise<number> }>;
  parseSessionId(stdoutChunk: string): string | undefined;
  launchArgv(model: string, prompt: string): readonly string[];
  resumeArgv(sessionId: string, model: string, prompt: string): readonly string[];
}

export interface SpawnedProcess {
  pid: number;
  stdout: AsyncIterable<string>;
  exited: Promise<number>;
}

export interface ProcessSpawner {
  spawn(command: string, args: readonly string[], opts: { cwd: string; env: Record<string, string>; logFile?: string }): SpawnedProcess;
}

export type VersionProbe = (command: string) => Promise<DetectResult>;

/** Resolve a command via PATH. Absolute paths are returned when they are executable. */
export function resolveCommand(command: string, pathEnv: string = process.env.PATH ?? ''): string | undefined {
  const candidates = command.includes('/')
    ? [command]
    : pathEnv.split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

export function rejectUnsafe(args: readonly string[]): void {
  const unsafe = args.some(arg => arg === '--force'
    || arg === '--yolo'
    || arg === '--full-auto'
    || arg.startsWith('--dangerously')
    || /dangerously|full-auto|--yolo/i.test(arg));
  if (unsafe) throw new Error('launcher_unavailable');
}

export function sessionIdFromLines(buffer: string, pick: (value: unknown) => string | undefined): string | undefined {
  for (const part of buffer.split(/\r?\n/)) {
    const line = part.trim();
    if (!line) continue;
    try {
      const id = pick(JSON.parse(line) as unknown);
      if (id) return id;
    } catch { /* partial chunk or non-json noise */ }
  }
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function pickCodex(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== 'thread.started') return undefined;
  return stringField(value, 'thread_id');
}

function pickInitSession(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') return undefined;
  return stringField(value, 'session_id');
}

function pickAgy(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.event !== 'init') return undefined;
  return stringField(value, 'conversation_id');
}

async function readSession(child: SpawnedProcess, parse: (chunk: string) => string | undefined): Promise<string> {
  let combined = '';
  for await (const chunk of child.stdout) {
    combined += chunk;
    const sessionId = parse(combined);
    if (sessionId) return sessionId;
  }
  throw new Error('launcher_unavailable');
}

interface AdapterDefinition {
  id: string;
  command: string;
  models: readonly string[];
  launchArgs(model: string, prompt: string): string[];
  resumeArgs(sessionId: string, model: string, prompt: string): string[];
  pick(value: unknown): string | undefined;
}

export interface AdapterOptions {
  command?: string;
  probe?: VersionProbe;
  detectTimeoutMs?: number;
}

export class CliAdapter implements LauncherAdapter {
  readonly id: string;
  readonly command: string;
  readonly models: readonly string[];
  private readonly probe?: VersionProbe;
  private readonly detectTimeoutMs: number;

  constructor(
    private readonly spawner: ProcessSpawner,
    private readonly definition: AdapterDefinition,
    options: AdapterOptions = {},
  ) {
    this.id = definition.id;
    this.command = options.command ?? definition.command;
    this.models = definition.models;
    this.probe = options.probe;
    this.detectTimeoutMs = options.detectTimeoutMs ?? 5_000;
  }

  launchArgv(model: string, prompt: string): readonly string[] {
    return this.definition.launchArgs(model, prompt);
  }

  resumeArgv(sessionId: string, model: string, prompt: string): readonly string[] {
    return this.definition.resumeArgs(sessionId, model, prompt);
  }

  parseSessionId(stdoutChunk: string): string | undefined {
    return sessionIdFromLines(stdoutChunk, value => this.definition.pick(value));
  }

  async detect(): Promise<DetectResult> {
    if (this.probe) return this.probe(this.command);
    return probeVersion(this.command, this.detectTimeoutMs);
  }

  async launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string; exited: Promise<number> }> {
    this.assertModel(opts.model);
    const args = this.launchArgv(opts.model, opts.prompt);
    rejectUnsafe(args);
    const child = this.spawner.spawn(this.command, args, opts);
    const sessionId = await readSession(child, chunk => this.parseSessionId(chunk));
    return { pid: child.pid, sessionId, exited: child.exited };
  }

  async resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number; exited: Promise<number> }> {
    this.assertModel(opts.model);
    const args = this.resumeArgv(opts.sessionId, opts.model, opts.prompt);
    rejectUnsafe(args);
    const child = this.spawner.spawn(this.command, args, opts);
    await readSession(child, chunk => this.parseSessionId(chunk));
    return { pid: child.pid, exited: child.exited };
  }

  private assertModel(model: string): void {
    if (!this.models.includes(model)) throw new Error('model_not_allowed');
  }
}

const CODEX: AdapterDefinition = {
  id: 'codex',
  command: 'codex',
  models: ['gpt-6.1-sol', 'gpt-6-luna'],
  launchArgs: (model, prompt) => ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', model, prompt],
  resumeArgs: (sessionId, model, prompt) => ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '-m', model, prompt],
  pick: pickCodex,
};

const CURSOR: AdapterDefinition = {
  id: 'cursor-agent',
  command: 'cursor-agent',
  models: ['grok-4.7-high', 'grok-4.7'],
  launchArgs: (model, prompt) => ['-p', '--output-format', 'stream-json', '--trust', '--model', model, prompt],
  resumeArgs: (sessionId, model, prompt) => ['-p', '--output-format', 'stream-json', '--trust', '--resume', sessionId, '--model', model, prompt],
  pick: pickInitSession,
};

const AGY: AdapterDefinition = {
  id: 'agy',
  command: 'agy',
  models: ['gemini-3.8-flash-high'],
  launchArgs: (model, prompt) => ['-p', prompt, '--model', model, '--output-format', 'stream-json'],
  resumeArgs: (sessionId, model, prompt) => ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--conversation', sessionId],
  pick: pickAgy,
};

const CLAUDE: AdapterDefinition = {
  id: 'claude',
  command: 'claude',
  models: [],
  launchArgs: (model, prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, prompt],
  resumeArgs: (sessionId, model, prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--resume', sessionId, '--model', model, prompt],
  pick: pickInitSession,
};

export class CodexCliAdapter extends CliAdapter {
  constructor(spawner: ProcessSpawner, options: AdapterOptions = {}) {
    super(spawner, CODEX, options);
  }
}

export function createCursorAdapter(spawner: ProcessSpawner, options: AdapterOptions = {}): CliAdapter {
  return new CliAdapter(spawner, CURSOR, options);
}

export function createAgyAdapter(spawner: ProcessSpawner, options: AdapterOptions = {}): CliAdapter {
  return new CliAdapter(spawner, AGY, options);
}

export function createClaudeAdapter(spawner: ProcessSpawner, options: AdapterOptions = {}): CliAdapter {
  return new CliAdapter(spawner, CLAUDE, options);
}

export function createDefaultAdapters(spawner: ProcessSpawner = nodeSpawner()): Map<string, LauncherAdapter> {
  return new Map<string, LauncherAdapter>([
    ['codex', new CodexCliAdapter(spawner)],
    ['cursor-agent', createCursorAdapter(spawner)],
    ['agy', createAgyAdapter(spawner)],
    ['claude', createClaudeAdapter(spawner)],
  ]);
}

/** `<cmd> --version` with a timeout. No model flag is passed. */
export function probeVersion(command: string, timeoutMs = 5_000, pathEnv?: string): Promise<DetectResult> {
  const resolved = resolveCommand(command, pathEnv);
  if (!resolved) return Promise.resolve({ installed: false });
  return new Promise(resolve => {
    const child = spawn(resolved, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (result: DetectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ installed: false, path: resolved });
    }, timeoutMs);
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.on('error', () => finish({ installed: false, path: resolved }));
    child.on('exit', code => {
      if (code === 0) {
        const version = output.trim().split('\n')[0]?.trim();
        finish({ installed: true, version: version || undefined, path: resolved });
      } else {
        finish({ installed: false, path: resolved });
      }
    });
  });
}

function tailLog(path: string, stopped: () => boolean): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const handle = await open(path, 'r');
      let position = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (;;) {
          const stat = await handle.stat();
          if (stat.size > position) {
            const length = Number(stat.size - position);
            const buffer = Buffer.alloc(length);
            const read = await handle.read(buffer, 0, length, position);
            position += read.bytesRead;
            if (read.bytesRead > 0) yield buffer.subarray(0, read.bytesRead).toString('utf8');
          } else if (stopped()) {
            return;
          } else {
            await new Promise<void>(resolve => { timer = setTimeout(resolve, 40); });
            if (timer) clearTimeout(timer);
            timer = undefined;
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        await handle.close();
      }
    },
  };
}

/** Detached child in its own process group. stdout and stderr append to a 0600 log file. */
export function nodeSpawner(): ProcessSpawner {
  return {
    spawn(command, args, opts) {
      const logFile = opts.logFile ?? join(tmpdir(), `agent-room-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
      const logDir = dirname(logFile);
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      if (opts.logFile) chmodSync(logDir, 0o700);
      const fd = openSync(logFile, 'a', 0o600);
      chmodSync(logFile, 0o600);
      const child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      closeSync(fd);
      child.unref();
      let exited = false;
      const exitedPromise = new Promise<number>(resolve => {
        child.on('exit', code => { exited = true; resolve(code ?? 1); });
        child.on('error', () => { exited = true; resolve(1); });
      });
      return {
        pid: child.pid ?? 0,
        stdout: tailLog(logFile, () => exited),
        exited: exitedPromise,
      };
    },
  };
}

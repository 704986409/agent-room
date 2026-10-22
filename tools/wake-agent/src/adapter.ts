import { spawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** Launcher adapter. Arguments below are the interactive CLI contracts (2026-10-21). */
export interface LaunchOptions {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  model: string;
  logFile?: string;
  /** Window title for the terminal emulator (interactive spawn). */
  title?: string;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  path?: string;
  /** stderr/stdout when the binary exists but `--version` failed. */
  detail?: string;
}

export interface LauncherAdapter {
  readonly id: string;
  readonly command: string;
  readonly models: readonly string[];
  detect(): Promise<DetectResult>;
  launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string; exited: Promise<number> }>;
  resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number; exited: Promise<number> }>;
  /** Parse a session id from stdout (kept for tests / legacy headless probes). */
  parseSessionId(stdoutChunk: string): string | undefined;
  launchArgv(model: string, prompt: string, sessionId?: string): readonly string[];
  resumeArgv(sessionId: string, model: string, prompt: string): readonly string[];
}

export interface SpawnedProcess {
  pid: number;
  stdout: AsyncIterable<string>;
  exited: Promise<number>;
}

export interface ProcessSpawner {
  spawn(command: string, args: readonly string[], opts: {
    cwd: string;
    env: Record<string, string>;
    logFile?: string;
    /** When set, open the CLI inside a visible terminal emulator (interactive). */
    terminalTitle?: string;
  }): SpawnedProcess;
}

export type VersionProbe = (command: string) => Promise<DetectResult>;

function isCommandPath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command);
}

/** Resolve a command via PATH. Absolute paths are returned when they are executable. */
export function resolveCommand(command: string, pathEnv: string = process.env.PATH ?? ''): string | undefined {
  const candidates = isCommandPath(command)
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
  args.forEach((arg, index) => {
    const isPromptArg = index === args.length - 1;
    // Adapter may insert this before the prompt (interactive TUI + auto-approve). Never as the prompt.
    if (arg === '--dangerously-skip-permissions' && !isPromptArg) return;
    if (arg === '--force' || arg === '--yolo' || arg === '--full-auto') throw new Error('launcher_unavailable');
    if (arg.startsWith('--dangerously')) throw new Error('launcher_unavailable');
    if (/(?:^|\s)(--yolo|--force|--full-auto|--dangerously[\w-]*)(?:\s|$)/i.test(arg)) {
      throw new Error('launcher_unavailable');
    }
  });
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

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape for cmd.exe when building a single command line after `cmd /k` or `cmd /c`. */
export function windowsCmdEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export interface CommandSpawn {
  command: string;
  args: string[];
  windowsHide: boolean;
  /** Args are already a cmd.exe command line; Node must not quote them again. */
  windowsVerbatimArguments?: boolean;
}

/**
 * One command line for `cmd.exe /d /s /c`.
 * `/s` strips the first and last quote, so the extra pair keeps quotes around
 * paths that contain spaces (`D:\Agent Room\...`).
 */
export function winCmdLine(command: string, args: readonly string[]): string {
  const inner = [windowsCmdEscape(command), ...args.map(windowsCmdEscape)].join(' ');
  return `"${inner}"`;
}

/**
 * File and argv for `child_process.spawn`.
 * Windows `.cmd`/`.bat` must go through `cmd.exe`; a direct spawn returns EINVAL.
 */
export function spawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandSpawn {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: env.ComSpec || env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', winCmdLine(command, args)],
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
  }
  return {
    command,
    args: [...args],
    windowsHide: platform === 'win32',
  };
}

/**
 * Open the CLI in a visible terminal so the user can approve tools.
 * - Linux: xfce4-terminal / x-terminal-emulator when DISPLAY is set
 * - Windows: Windows Terminal (`wt`) if on PATH, otherwise `cmd /c start … cmd /k`
 * - Otherwise: spawn the CLI directly (tests / no display)
 */
export function wrapInTerminal(command: string, args: readonly string[], title: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const wt = resolveCommand('wt.exe') ?? resolveCommand('wt');
    if (wt) {
      return { command: wt, args: ['-d', '.', '--title', title, command, ...args] };
    }
    const line = [command, ...args.map(windowsCmdEscape)].join(' ');
    // `start "title" cmd /k …` opens a new console and keeps it open.
    return { command: 'cmd.exe', args: ['/c', 'start', title, 'cmd.exe', '/k', line] };
  }

  const line = [command, ...args.map(shellEscape)].join(' ');
  const xfce = resolveCommand('xfce4-terminal');
  if (xfce && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    return { command: xfce, args: ['--title', title, '--disable-server', '-e', line] };
  }
  const xterm = resolveCommand('x-terminal-emulator');
  if (xterm && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    return { command: xterm, args: ['-T', title, '-e', 'bash', '-lc', line] };
  }
  return { command, args: [...args] };
}

export interface SessionWaiter {
  (input: { cwd: string; sinceMs: number; timeoutMs?: number }): Promise<string>;
}

export function waitForCodexSession(input: { cwd: string; sinceMs: number; timeoutMs?: number; home?: string }): Promise<string> {
  const home = input.home ?? homedir();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const sessionsRoot = join(home, '.codex', 'sessions');
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const found = newestCodexSessionId(sessionsRoot, input.sinceMs);
        if (found) { resolve(found); return; }
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) {
        reject(new Error('launcher_unavailable'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Newest rollout-* file whose mtime is >= sinceMs. Filename embeds the session id. */
export function newestCodexSessionId(sessionsRoot: string, sinceMs: number): string | undefined {
  let best: { id: string; mtime: number } | undefined;
  const years = safeList(sessionsRoot);
  for (const year of years) {
    const yearDir = join(sessionsRoot, year);
    for (const month of safeList(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of safeList(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const name of safeList(dayDir)) {
          const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
          if (!match) continue;
          const path = join(dayDir, name);
          let mtime = 0;
          try { mtime = statSync(path).mtimeMs; } catch { continue; }
          if (mtime + 1000 < sinceMs) continue;
          if (!best || mtime > best.mtime) best = { id: match[1]!, mtime };
        }
      }
    }
  }
  return best?.id;
}

export function waitForAgyConversation(input: { cwd: string; sinceMs: number; timeoutMs?: number; home?: string }): Promise<string> {
  const home = input.home ?? homedir();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const cache = join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
  const dir = join(home, '.gemini', 'antigravity-cli', 'conversations');
  const cwdKey = input.cwd.replace(/\/$/, '') || input.cwd;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const raw = readFileSync(cache, 'utf8');
        const map = JSON.parse(raw) as Record<string, string>;
        const id = map[cwdKey] ?? map[input.cwd];
        if (id && /^[0-9a-f-]{36}$/i.test(id)) {
          // Prefer ids whose db appeared after sinceMs; fall back to map entry.
          try {
            const mtime = statSync(join(dir, `${id}.db`)).mtimeMs;
            if (mtime + 1000 >= input.sinceMs) { resolve(id); return; }
          } catch {
            resolve(id);
            return;
          }
        }
        const newest = newestAgyConversationId(dir, input.sinceMs);
        if (newest) { resolve(newest); return; }
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) {
        reject(new Error('launcher_unavailable'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function newestAgyConversationId(dir: string, sinceMs: number): string | undefined {
  let best: { id: string; mtime: number } | undefined;
  for (const name of safeList(dir)) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i.exec(name);
    if (!match) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (mtime + 1000 < sinceMs) continue;
    if (!best || mtime > best.mtime) best = { id: match[1]!, mtime };
  }
  return best?.id;
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export type CreateChat = () => Promise<string>;

/** `cursor-agent create-chat` prints a UUID and exits. Used so interactive launch already has a session id. */
export function cursorCreateChat(command = 'cursor-agent', timeoutMs = 15_000): Promise<string> {
  const resolved = resolveCommand(command) ?? command;
  return new Promise((resolve, reject) => {
    const child = spawn(resolved, ['create-chat'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('launcher_unavailable')); }, timeoutMs);
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output);
      if (code === 0 && match) resolve(match[1]!);
      else reject(new Error('launcher_unavailable'));
    });
  });
}

interface AdapterDefinition {
  id: string;
  command: string;
  models: readonly string[];
  /** Interactive launch argv. sessionId is set when the adapter pre-allocates one (Cursor). */
  launchArgs(model: string, prompt: string, sessionId?: string): string[];
  resumeArgs(sessionId: string, model: string, prompt: string): string[];
  pick(value: unknown): string | undefined;
}

export interface AdapterOptions {
  command?: string;
  probe?: VersionProbe;
  detectTimeoutMs?: number;
  createChat?: CreateChat;
  waitCodexSession?: SessionWaiter;
  waitAgyConversation?: SessionWaiter;
  /** Skip terminal wrapping (unit tests that assert agent argv directly). Default false. */
  directSpawn?: boolean;
}

export class CliAdapter implements LauncherAdapter {
  readonly id: string;
  readonly command: string;
  readonly models: readonly string[];
  private readonly probe?: VersionProbe;
  private readonly detectTimeoutMs: number;
  private readonly createChat?: CreateChat;
  private readonly waitCodexSession: SessionWaiter;
  private readonly waitAgyConversation: SessionWaiter;
  private readonly directSpawn: boolean;
  /** Absolute path from the last successful detect (installers often land outside PATH). */
  private resolvedCommand?: string;

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
    this.createChat = options.createChat;
    this.waitCodexSession = options.waitCodexSession ?? (input => waitForCodexSession(input));
    this.waitAgyConversation = options.waitAgyConversation ?? (input => waitForAgyConversation(input));
    this.directSpawn = options.directSpawn ?? false;
  }

  launchArgv(model: string, prompt: string, sessionId?: string): readonly string[] {
    return this.definition.launchArgs(model, prompt, sessionId);
  }

  resumeArgv(sessionId: string, model: string, prompt: string): readonly string[] {
    return this.definition.resumeArgs(sessionId, model, prompt);
  }

  parseSessionId(stdoutChunk: string): string | undefined {
    return sessionIdFromLines(stdoutChunk, value => this.definition.pick(value));
  }

  async detect(): Promise<DetectResult> {
    if (this.probe) return this.probe(this.command);
    const result = await detectCli({
      id: this.id,
      command: this.definition.command,
      timeoutMs: this.detectTimeoutMs,
    });
    this.resolvedCommand = result.installed && result.path ? result.path : undefined;
    return result;
  }

  private executable(): string {
    return this.resolvedCommand ?? this.command;
  }

  async launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string; exited: Promise<number> }> {
    this.assertModel(opts.model);
    let sessionId: string | undefined;
    if (this.id === 'cursor-agent') {
      sessionId = await (this.createChat ?? (() => cursorCreateChat(this.executable())))();
    }
    const args = this.launchArgv(opts.model, opts.prompt, sessionId);
    rejectUnsafe(args);
    const sinceMs = Date.now();
    const child = this.spawnInteractive(args, opts);
    if (!sessionId) {
      if (this.id === 'codex') sessionId = await this.waitCodexSession({ cwd: opts.cwd, sinceMs });
      else if (this.id === 'agy') sessionId = await this.waitAgyConversation({ cwd: opts.cwd, sinceMs });
      else {
        // Headless-style parse kept as last resort for adapters that still emit JSON.
        sessionId = await readSession(child, chunk => this.parseSessionId(chunk));
      }
    }
    return { pid: child.pid, sessionId, exited: child.exited };
  }

  async resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number; exited: Promise<number> }> {
    this.assertModel(opts.model);
    const args = this.resumeArgv(opts.sessionId, opts.model, opts.prompt);
    rejectUnsafe(args);
    const child = this.spawnInteractive(args, opts);
    return { pid: child.pid, exited: child.exited };
  }

  private spawnInteractive(args: readonly string[], opts: LaunchOptions): SpawnedProcess {
    const title = opts.title ?? `Agent Room · ${this.id}`;
    const command = this.executable();
    if (this.directSpawn) {
      return this.spawner.spawn(command, args, { ...opts, terminalTitle: undefined });
    }
    return this.spawner.spawn(command, args, { ...opts, terminalTitle: title });
  }

  private assertModel(model: string): void {
    if (!this.models.includes(model)) throw new Error('model_not_allowed');
  }
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

/** Interactive Codex TUI (no `exec`, no `--json`). */
const CODEX: AdapterDefinition = {
  id: 'codex',
  command: 'codex',
  models: ['gpt-6.1-sol', 'gpt-6-luna'],
  launchArgs: (model, prompt) => ['-m', model, '--skip-git-repo-check', prompt],
  resumeArgs: (sessionId, model, prompt) => ['resume', sessionId, '-m', model, '--skip-git-repo-check', prompt],
  pick: pickCodex,
};

/** Interactive Cursor agent. Session id comes from `create-chat` before spawn. */
const CURSOR: AdapterDefinition = {
  id: 'cursor-agent',
  command: 'cursor-agent',
  models: ['grok-4.7-high', 'grok-4.7'],
  launchArgs: (model, prompt, sessionId) => {
    if (!sessionId) throw new Error('launcher_unavailable');
    return ['--resume', sessionId, '--model', model, '--trust', prompt];
  },
  resumeArgs: (sessionId, model, prompt) => ['--resume', sessionId, '--model', model, '--trust', prompt],
  pick: pickInitSession,
};

/** Interactive Antigravity (`-i` / --prompt-interactive). */
const AGY: AdapterDefinition = {
  id: 'agy',
  command: 'agy',
  models: ['gemini-3.8-flash-high'],
  // Optional AGENT_ROOM_AGY_MODE=accept-edits|auto keeps the interactive TUI but
  // auto-approves tool calls (needed on headless DISPLAY / Xvfb probes).
  launchArgs: (model, prompt) => {
    const mode = process.env.AGENT_ROOM_AGY_MODE;
    const args = ['-i', prompt, '--model', model];
    if (mode === 'accept-edits' || mode === 'auto') args.push('--mode', mode);
    // `auto` on Xvfb/desktop probes: keep TUI, skip permission prompts (RunCommand etc.).
    if (mode === 'auto') args.push('--dangerously-skip-permissions');
    return args;
  },
  resumeArgs: (sessionId, model, prompt) => {
    const mode = process.env.AGENT_ROOM_AGY_MODE;
    const args = ['-i', prompt, '--model', model, '--conversation', sessionId];
    if (mode === 'accept-edits' || mode === 'auto') args.push('--mode', mode);
    if (mode === 'auto') args.push('--dangerously-skip-permissions');
    return args;
  },
  pick: pickAgy,
};

/** Claude interactive form kept for completeness; allowlist empty → launch refused. */
const CLAUDE: AdapterDefinition = {
  id: 'claude',
  command: 'claude',
  models: [],
  launchArgs: (model, prompt) => ['--model', model, prompt],
  resumeArgs: (sessionId, model, prompt) => ['--resume', sessionId, '--model', model, prompt],
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

export function createDefaultAdapters(spawner: ProcessSpawner = nodeSpawner(), options: AdapterOptions = {}): Map<string, LauncherAdapter> {
  return new Map<string, LauncherAdapter>([
    ['codex', new CodexCliAdapter(spawner, options)],
    ['cursor-agent', createCursorAdapter(spawner, options)],
    ['agy', createAgyAdapter(spawner, options)],
    ['claude', createClaudeAdapter(spawner, options)],
  ]);
}

/** Directories installers use when they do not update the daemon PATH. */
export function extraCliBinDirs(home = homedir(), platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(home, '.local', 'bin')];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(local, 'cursor-agent'), join(roaming, 'npm'));
  }
  return dirs;
}

/** PATH names first, then absolute install locations. `cursor-agent` also tries `agent`. */
export function commandCandidates(
  id: string,
  command: string,
  home = homedir(),
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const bases = [command];
  if (id === 'cursor-agent' && command !== 'agent') bases.push('agent');
  const names: string[] = [];
  for (const name of bases) {
    names.push(name);
    if (platform === 'win32' && !/\.(cmd|exe|bat)$/i.test(name)) {
      names.push(`${name}.cmd`, `${name}.exe`);
    }
  }
  const absolute: string[] = [];
  for (const name of names) {
    if (isCommandPath(name)) continue;
    for (const dir of extraCliBinDirs(home, platform, env)) absolute.push(join(dir, name));
  }
  return [...names, ...absolute];
}

/**
 * `--version` probe that also sees installer paths (`~/.local/bin`, Windows cursor-agent / npm).
 * A broken binary on PATH does not hide a working copy in those directories.
 */
export async function detectCli(options: {
  id: string;
  command: string;
  timeoutMs?: number;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
}): Promise<DetectResult> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const basePath = options.pathEnv ?? env.PATH ?? '';
  const extra = extraCliBinDirs(home, platform, env).filter(Boolean).join(delimiter);
  const pathEnv = [extra, basePath].filter(Boolean).join(delimiter);
  let broken: DetectResult | undefined;
  const seen = new Set<string>();
  for (const candidate of commandCandidates(options.id, options.command, home, platform, env)) {
    const result = await probeVersion(candidate, timeoutMs, isCommandPath(candidate) ? undefined : pathEnv);
    if (result.path) {
      if (seen.has(result.path)) continue;
      seen.add(result.path);
    }
    if (result.installed) return result;
    if (result.path && !broken) broken = result;
  }
  return broken ?? { installed: false };
}

function clipProbe(text: string): string {
  const clean = text.trim();
  if (clean.length <= 500) return clean;
  return `${clean.slice(0, 500)}…`;
}

/** Windows `.cmd` shims need cmd.exe; `spawn` without a shell returns EINVAL. */
function spawnVersionProbe(resolved: string) {
  const spec = spawnCommand(resolved, ['--version']);
  return spawn(spec.command, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: spec.windowsHide,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

/** `<cmd> --version` with a timeout. No model flag is passed. */
export function probeVersion(command: string, timeoutMs = 5_000, pathEnv?: string): Promise<DetectResult> {
  const resolved = resolveCommand(command, pathEnv);
  if (!resolved) return Promise.resolve({ installed: false });
  return new Promise(resolve => {
    const child = spawnVersionProbe(resolved);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: DetectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ installed: false, path: resolved, detail: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      finish({ installed: false, path: resolved, detail: clipProbe(error instanceof Error ? error.message : 'spawn_failed') });
    });
    child.on('exit', code => {
      const combined = stdout.trim() || stderr.trim();
      if (code === 0) {
        const version = combined.split('\n')[0]?.trim();
        finish({ installed: true, version: version || undefined, path: resolved });
      } else {
        finish({ installed: false, path: resolved, detail: clipProbe(stderr.trim() || stdout.trim() || `exit ${code ?? 1}`) });
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

/**
 * Spawns an interactive CLI. When `terminalTitle` is set and a terminal emulator
 * is available, opens a visible window so the user can approve tool permissions.
 * stdout/stderr of the terminal (or CLI) still append to a 0600 log file.
 */
export function nodeSpawner(): ProcessSpawner {
  return {
    spawn(command, args, opts) {
      const logFile = opts.logFile ?? join(tmpdir(), `agent-room-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
      const logDir = dirname(logFile);
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      if (opts.logFile) chmodSync(logDir, 0o700);
      const fd = openSync(logFile, 'a', 0o600);
      chmodSync(logFile, 0o600);
      const wrapped = opts.terminalTitle
        ? wrapInTerminal(command, args, opts.terminalTitle)
        : { command, args: [...args] };
      // Record the intended agent argv for diagnostics (never secrets).
      try {
        writeFileSync(logFile, `# spawn ${wrapped.command} ${JSON.stringify(wrapped.args)}\n`, { flag: 'a', mode: 0o600 });
      } catch { /* log best-effort */ }
      const child = spawn(wrapped.command, wrapped.args, {
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

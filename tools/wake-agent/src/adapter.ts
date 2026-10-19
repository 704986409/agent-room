/** Launcher adapter. V1 implements Codex CLI; parameters stay in config until M0 verifies them. */
export interface LaunchOptions {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
}

export interface LauncherAdapter {
  id: string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string }>;
  resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number }>;
  parseSessionId(stdoutChunk: string): string | undefined;
}

export interface SpawnedProcess {
  pid: number;
  stdout: AsyncIterable<string>;
  exited: Promise<number>;
}

export interface ProcessSpawner {
  spawn(command: string, args: readonly string[], opts: { cwd: string; env: Record<string, string> }): SpawnedProcess;
}

export interface CodexCliConfig {
  /** Executable name or path. M0 may replace the argument lists below. */
  command?: string;
  launchArgs?: readonly string[];
  resumeArgs?: (sessionId: string) => readonly string[];
  sessionPattern?: RegExp;
}

const DEFAULT_SESSION = /(?:"thread_id"\s*:\s*"([^"]+)")|(?:thread[_ ]?id[:\s]+)([A-Za-z0-9_-]+)/i;

function rejectUnsafe(args: readonly string[]): void {
  if (args.some(arg => /dangerously|full-auto|--yolo/i.test(arg))) {
    throw new Error('launcher_unavailable');
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

export class CodexCliAdapter implements LauncherAdapter {
  readonly id = 'codex';
  private readonly command: string;
  private readonly launchArgs: readonly string[];
  private readonly resumeArgs: (sessionId: string) => readonly string[];
  private readonly sessionPattern: RegExp;

  constructor(private readonly spawner: ProcessSpawner, config: CodexCliConfig = {}) {
    this.command = config.command ?? 'codex';
    this.launchArgs = config.launchArgs ?? ['exec'];
    this.resumeArgs = config.resumeArgs ?? (sessionId => ['exec', 'resume', sessionId]);
    this.sessionPattern = config.sessionPattern ?? DEFAULT_SESSION;
    rejectUnsafe(this.launchArgs);
  }

  parseSessionId(stdoutChunk: string): string | undefined {
    const match = this.sessionPattern.exec(stdoutChunk);
    return match?.[1] ?? match?.[2];
  }

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    return { installed: true, path: this.command };
  }

  async launch(opts: LaunchOptions): Promise<{ pid: number; sessionId: string }> {
    rejectUnsafe(this.launchArgs);
    const args = [...this.launchArgs, opts.prompt];
    rejectUnsafe(args);
    const child = this.spawner.spawn(this.command, args, opts);
    const sessionId = await readSession(child, chunk => this.parseSessionId(chunk));
    return { pid: child.pid, sessionId };
  }

  async resume(opts: LaunchOptions & { sessionId: string }): Promise<{ pid: number }> {
    const args = [...this.resumeArgs(opts.sessionId), opts.prompt];
    rejectUnsafe(args);
    const child = this.spawner.spawn(this.command, args, opts);
    return { pid: child.pid };
  }
}

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ConPTY rejects a missing cwd with ERROR_BAD_NETPATH (找不到网络路径). */
export function existingDirectory(cwd: string | undefined, fallback = homedir()): string {
  const candidate = cwd?.trim() ?? '';
  if (candidate) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch { /* missing, not a directory, or a dead junction */ }
  }
  return fallback;
}

/**
 * Visible console for one seat launcher. `/s` strips the outer quotes, so the
 * launcher path stays quoted when it contains spaces. The prompt is not here.
 * Success closes the window; a non-zero exit leaves it open (`/k`).
 */
export function windowsConsoleArg(launcherPath: string): string {
  const quoted = `"${launcherPath.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  return `"${quoted} & if not errorlevel 1 exit"`;
}

export function windowsConsoleSpawn(launcherPath: string, comspec = 'cmd.exe'): {
  command: string;
  args: string[];
  windowsHide: false;
  windowsVerbatimArguments: true;
} {
  return {
    command: comspec,
    args: ['/d', '/s', '/k', windowsConsoleArg(launcherPath)],
    windowsHide: false,
    windowsVerbatimArguments: true,
  };
}

/** Drop the prompt out of argv. It is spliced back from the prompt file at launch. */
export function splitPromptArg(args: readonly string[], prompt: string): { args: string[]; promptIndex: number } {
  const index = prompt ? args.lastIndexOf(prompt) : -1;
  if (index < 0) return { args: [...args], promptIndex: args.length };
  return {
    args: [...args.slice(0, index), ...args.slice(index + 1)],
    promptIndex: index,
  };
}

function seatLaunchSource(): string {
  return readFileSync(fileURLToPath(new URL('./seat-launch.mjs', import.meta.url)), 'utf8');
}

function asciiTitle(title: string): string {
  return title.replace(/[^\x20-\x7E]/g, '-').replace(/["&<>^|%]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** cmd `set` only when the value cannot break the batch file. Other values stay in the UTF-8 spec. */
function cmdSetLine(name: string, value: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  if (!/^[\x20-\x7E]*$/.test(value) || /[%!"&<>^|]/.test(value)) return undefined;
  return `set "${name}=${value}"`;
}

function quoteBatch(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '')}"`;
}

export interface WindowsSeatLaunchInput {
  directory: string;
  seatId: string;
  command: string;
  /** CLI args without the prompt. */
  args: readonly string[];
  promptIndex: number;
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  nodePath: string;
  title?: string;
  comspec?: string;
}

export interface WindowsSeatLaunch {
  promptPath: string;
  specPath: string;
  scriptPath: string;
  launcherPath: string;
  /** Real node.exe + seat-launch.mjs. ConPTY must not execute nvm `*.cmd` shims. */
  node: { command: string; args: string[] };
  spawn: ReturnType<typeof windowsConsoleSpawn>;
}

function safeId(seatId: string): string {
  const clean = seatId.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean || 'seat';
}

/**
 * Prompt file + ASCII launcher + UTF-8 spec. The launcher starts bundled node,
 * which reads the prompt and spawns the CLI with an argv array (no shell).
 */
export function prepareWindowsSeatLaunch(input: WindowsSeatLaunchInput): WindowsSeatLaunch {
  const id = safeId(input.seatId);
  mkdirSync(input.directory, { recursive: true });
  const promptPath = join(input.directory, `${id}.prompt.txt`);
  const specPath = join(input.directory, `${id}.launch.json`);
  const scriptPath = join(input.directory, 'seat-launch.mjs');
  const launcherPath = join(input.directory, `${id}.cmd`);
  writeText(promptPath, input.prompt, 0o600);
  const spec = {
    command: input.command,
    args: [...input.args],
    promptIndex: input.promptIndex,
    promptFile: promptPath,
    cwd: existingDirectory(input.cwd),
    env: input.env,
  };
  writeText(specPath, JSON.stringify(spec), 0o600);
  writeText(scriptPath, seatLaunchSource(), 0o700);
  writeText(launcherPath, renderLauncherCmd({
    nodePath: input.nodePath,
    scriptPath,
    specPath,
    env: input.env,
    title: input.title,
  }), 0o700);
  return {
    promptPath,
    specPath,
    scriptPath,
    launcherPath,
    node: { command: input.nodePath, args: [scriptPath, specPath] },
    spawn: windowsConsoleSpawn(launcherPath, input.comspec || 'cmd.exe'),
  };
}

function writeText(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { encoding: 'utf8', mode });
  try { chmodSync(path, mode); } catch { /* Windows may ignore POSIX modes */ }
}

function renderLauncherCmd(input: {
  nodePath: string;
  scriptPath: string;
  specPath: string;
  env: Record<string, string>;
  title?: string;
}): string {
  const lines = ['@echo off', 'chcp 65001>nul'];
  const title = asciiTitle(input.title ?? 'Agent Room');
  if (title) lines.push(`title ${title}`);
  for (const [key, value] of Object.entries(input.env)) {
    const line = cmdSetLine(key, value);
    if (line) lines.push(line);
  }
  lines.push(`${quoteBatch(input.nodePath)} ${quoteBatch(input.scriptPath)} ${quoteBatch(input.specPath)}`);
  lines.push('exit /b');
  return `${lines.join('\r\n')}\r\n`;
}

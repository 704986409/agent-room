import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, windowsCmdEscape } from './adapter.js';
import type { CommandResult, CommandRunner } from './credstore.js';

export interface McpToolStatus {
  id: string;
  target: string;
  configured: boolean;
  detail?: string;
}

const INIT_TARGET: Record<string, string> = {
  codex: 'codex',
  claude: 'claude',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  agy: 'antigravity',
  antigravity: 'antigravity',
};

function configCandidates(home: string, target: string): string[] {
  switch (INIT_TARGET[target] ?? target) {
    case 'codex':
      return [join(home, '.codex/config.toml')];
    case 'cursor':
      return [join(home, '.cursor/mcp.json')];
    case 'claude':
      return [join(home, '.claude.json')];
    case 'antigravity':
      return [
        join(home, '.gemini/antigravity/mcp_config.json'),
        join(home, '.gemini/antigravity/config.json'),
        join(home, '.config/antigravity/mcp.json'),
      ];
    default:
      return [];
  }
}

function cursorConfigured(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return !!parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'agent-room');
  } catch {
    return text.includes('"agent-room"');
  }
}

function claudeConfigured(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return !!parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'agent-room');
  } catch {
    return false;
  }
}

export async function mcpStatus(options: {
  home?: string;
  run?: CommandRunner;
}): Promise<McpToolStatus[]> {
  const home = options.home ?? homedir();
  const run = options.run;
  const codexPath = join(home, '.codex/config.toml');
  const codexText = await readFile(codexPath, 'utf8').catch(() => '');
  const cursorText = await readFile(join(home, '.cursor/mcp.json'), 'utf8').catch(() => '');
  const claudeText = await readFile(join(home, '.claude.json'), 'utf8').catch(() => '');
  let agyConfigured = false;
  let agyDetail: string | undefined;
  if (run) {
    try {
      const listed = await run('agy', ['mcp', 'list'], undefined, 5_000);
      agyConfigured = listed.stdout.includes('agent-room') || listed.stderr.includes('agent-room');
      if (listed.code !== 0 && !agyConfigured) agyDetail = 'agy mcp list failed';
    } catch {
      agyDetail = 'agy mcp list failed';
    }
  }
  return [
    {
      id: 'codex',
      target: 'codex',
      configured: codexText.includes('[mcp_servers.agent-room') || codexText.includes('agent-room'),
    },
    { id: 'cursor-agent', target: 'cursor', configured: cursorText.length > 0 && cursorConfigured(cursorText) },
    { id: 'agy', target: 'antigravity', configured: agyConfigured, detail: agyDetail },
    {
      id: 'claude',
      target: 'claude',
      configured: claudeText.length > 0 && claudeConfigured(claudeText),
    },
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const REINSTALL_HINT = '未找到安装包内的 MCP 运行时。请重新安装 Agent Room 桌面端。';

/** Desktop shell default. Same host as `desktop/src-tauri/src/main.rs` `server_url()`. */
export const DEFAULT_PAIRED_SERVER = 'https://ai-room.pupgo.top';

export function pairedServerUrl(options: { server?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const raw = (options.server || env.AGENT_ROOM_BASE_URL || env.AGENT_ROOM_SERVER || DEFAULT_PAIRED_SERVER).trim();
  return raw.replace(/\/$/, '');
}

/**
 * Tauri `resource_dir()` can be a Win32 extended path (`\\?\D:\Agent Room\...`).
 * Node then fails `realpath` when the directory contains spaces. Strip `\\?\`
 * (and map `\\?\UNC\server\share` → `\\server\share`) before argv or client config.
 */
export function forNodeArgv(path: string): string {
  if (!path.startsWith('\\\\?\\')) return path;
  const rest = path.slice(4);
  if (!rest) return path;
  if (rest.toUpperCase().startsWith('UNC\\')) {
    const unc = rest.slice(4);
    return unc ? `\\\\${unc}` : path;
  }
  return rest;
}

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Packaged: `resources/daemon` → `resources/mcp`. Dev bundle: `daemon-dist` → `mcp-runtime`. */
export function bundledMcpEntryCandidates(dir = scriptDir()): string[] {
  return [
    join(dir, '..', 'mcp', 'dist', 'index.js'),
    join(dir, '..', 'mcp-runtime', 'dist', 'index.js'),
  ];
}

function nodeFileNames(): string[] {
  return process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
}

export function bundledNodeCandidates(dir = scriptDir()): string[] {
  const names = nodeFileNames();
  const roots = [
    join(dir, '..', 'node'),
    join(dir, '..', 'node-runtime'),
    join(dir, '..', 'node', 'bin'),
  ];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

function looksLikeNode(path: string): boolean {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return base === 'node' || base === 'node.exe';
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    const path = forNodeArgv(candidate);
    if (await exists(path)) return path;
  }
  return undefined;
}

export async function resolveBundledMcpEntry(options: {
  mcpEntry?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (options.mcpEntry) return firstExisting([options.mcpEntry]);
  const fromEnv = env.AGENT_ROOM_MCP_ENTRY?.trim();
  if (fromEnv) {
    const found = await firstExisting([fromEnv]);
    if (found) return found;
  }
  const dir = env.AGENT_ROOM_MCP_DIR?.trim();
  if (dir) {
    const found = await firstExisting([join(dir, 'dist', 'index.js')]);
    if (found) return found;
  }
  return firstExisting(bundledMcpEntryCandidates());
}

export async function resolveNodeBinary(options: {
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (options.nodePath) return firstExisting([options.nodePath]);
  const fromEnv = env.AGENT_ROOM_NODE?.trim();
  if (fromEnv) {
    if (!fromEnv.includes('/') && !fromEnv.includes('\\')) {
      const found = resolveCommand(fromEnv);
      if (found) return forNodeArgv(found);
    } else {
      const found = await firstExisting([fromEnv]);
      if (found) return found;
    }
  }
  const bundled = await firstExisting(bundledNodeCandidates());
  if (bundled) return bundled;
  if (looksLikeNode(process.execPath) && await exists(process.execPath)) {
    return forNodeArgv(process.execPath);
  }
  const onPath = resolveCommand(process.platform === 'win32' ? 'node.exe' : 'node')
    ?? (process.platform === 'win32' ? resolveCommand('node') : undefined);
  return onPath ? forNodeArgv(onPath) : undefined;
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index >= 0 ? path.slice(0, index) : path;
}

/** Launcher next to `mcp/dist/index.js`. Fallback when no space-free directory exists. */
export function windowsHookLauncherPath(mcpEntry: string): string {
  const entryDir = parentDir(mcpEntry);
  const leaf = entryDir.split(/[\\/]/).pop()?.toLowerCase();
  const mcpDir = leaf === 'dist' ? parentDir(entryDir) : entryDir;
  const sep = mcpEntry.includes('\\') ? '\\' : '/';
  return `${mcpDir}${sep}hook.cmd`;
}

/**
 * Directories whose `hook.cmd` path contains no spaces.
 * `%ProgramData%\AgentRoom` first. A path with a space is skipped: Codex runs
 * hook commands through PowerShell, where `call` and a quoted path both exit 1.
 */
function hookChild(root: string, leaf: string): string {
  // Tests on Linux pass ProgramData as a real `/tmp/...` directory.
  if (root.includes('/') && !root.includes('\\')) return `${root.replace(/\/+$/, '')}/${leaf}`;
  return win32.join(root, leaf);
}

export function spaceFreeHookDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (root: string | undefined) => {
    const trimmed = root?.trim();
    if (!trimmed || /\s/.test(trimmed)) return;
    const dir = hookChild(trimmed, 'AgentRoom');
    if (/\s/.test(dir) || out.includes(dir)) return;
    out.push(dir);
  };
  add(env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData');
  if (env.ALLUSERSPROFILE) add(env.ALLUSERSPROFILE);
  add(env.LOCALAPPDATA);
  add(env.TEMP || env.TMP);
  add('C:\\');
  return out;
}

/** Absolute quoted node + index.js. The launcher may live far from the install. */
export function hookLauncherBat(nodePath: string, mcpEntry: string, baseUrl: string): string {
  const nodeCmd = `"${nodePath.replace(/"/g, '')}"`;
  const entryCmd = `"${mcpEntry.replace(/"/g, '')}"`;
  const base = baseUrl.replace(/["%\r\n]/g, '').trim();
  return [
    '@echo off',
    'setlocal',
    `if not defined AGENT_ROOM_BASE_URL set "AGENT_ROOM_BASE_URL=${base}"`,
    `${nodeCmd} ${entryCmd} hook`,
    '',
  ].join('\r\n');
}

/**
 * Bare space-free path. PowerShell does not understand `call`, and a leading
 * quote (or `& "..."`) makes the hook exit 1. A spaced path is the last resort.
 */
export function windowsHookInvocation(launcherPath: string): string {
  if (!launcherPath || launcherPath.startsWith('.\\') || launcherPath.startsWith('./') || launcherPath.includes('\\.\\.agent-room')) {
    throw new Error('hook_path_not_absolute');
  }
  if (!/[\s"&|<>^%]/.test(launcherPath)) return launcherPath;
  return `call ${windowsCmdEscape(launcherPath)}`;
}

function hookDirWritable(dir: string): boolean {
  if (/\s/.test(dir)) return false;
  if (process.platform === 'win32') return win32.isAbsolute(dir);
  // Tests pass ProgramData as a real temp directory on Linux CI.
  return isAbsolute(dir);
}

function tomlQuoteHook(value: string): string {
  if (!value.includes("'") && /[\\"\n\r\t]/.test(value)) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function rewriteHookCommandsInToml(toml: string, invocation: string): string {
  const quoted = tomlQuoteHook(invocation);
  return toml.split('\n').map(line => {
    if (!/^\s*command(?:_windows)?\s*=/.test(line)) return line;
    if (!/(?:agent-room-mcp|mcp[\\/]+dist[\\/]+index\.js|hook\.cmd)\b/.test(line) || !/\bhook\b/.test(line)) return line;
    return line.replace(/=\s*(?:"(?:\\.|[^"\n])*"|'(?:[^'\n])*')/, `= ${quoted}`);
  }).join('\n');
}

export function rewriteCursorStopHook(jsonText: string, invocation: string): string {
  const data = JSON.parse(jsonText) as { hooks?: { stop?: Array<{ command?: string }> } };
  const stop = data.hooks?.stop;
  if (!Array.isArray(stop)) return jsonText;
  let changed = false;
  for (const hook of stop) {
    if (!hook || typeof hook.command !== 'string') continue;
    if (!/(?:agent-room-mcp|mcp[\\/]+dist[\\/]+index\.js|hook\.cmd)/.test(hook.command)) continue;
    if (hook.command === invocation) continue;
    hook.command = invocation;
    changed = true;
  }
  return changed ? `${JSON.stringify(data, null, 2)}\n` : jsonText;
}

const CODEX_HOOK_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'] as const;
const CODEX_HOOK_EVENT_KEY = { Stop: 'stop', UserPromptSubmit: 'user_prompt_submit', SessionStart: 'session_start' } as const;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortJson(source[key]);
    return sorted;
  }
  return value;
}

/** Same bytes as agent-room-mcp init `codexHookTrustHash`. A mismatch makes Codex skip the hook. */
export function codexHookTrustHash(event: (typeof CODEX_HOOK_EVENTS)[number], command: string): string {
  const identity: Record<string, unknown> = {
    event_name: CODEX_HOOK_EVENT_KEY[event],
    hooks: [{ async: false, command, timeout: 600, type: 'command' }],
  };
  if (event === 'SessionStart') identity.matcher = '';
  return `sha256:${createHash('sha256').update(JSON.stringify(sortJson(identity))).digest('hex')}`;
}

function unquoteTomlValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

function effectiveHookCommand(toml: string, event: (typeof CODEX_HOOK_EVENTS)[number], platform: NodeJS.Platform): string | undefined {
  const lines = toml.split('\n');
  const start = lines.findIndex(line => line.trim() === `[[hooks.${event}]]`);
  if (start < 0) return undefined;
  let command: string | undefined;
  let windows: string | undefined;
  const ours = (value: string) => /(?:agent-room-mcp|mcp[\\/]+dist[\\/]+index\.js|hook\.cmd)\b/.test(value) && /\bhook\b/.test(value);
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[[hooks.') && !trimmed.startsWith(`[[hooks.${event}.`)) break;
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) break;
    const windowsMatch = trimmed.match(/^command_windows\s*=\s*(.+)$/);
    const commandMatch = trimmed.match(/^command\s*=\s*(.+)$/);
    if (windowsMatch) windows = unquoteTomlValue(windowsMatch[1]!);
    else if (commandMatch) {
      const parsed = unquoteTomlValue(commandMatch[1]!);
      if (ours(parsed)) command = parsed;
    }
  }
  if (platform === 'win32' && windows && ours(windows)) return windows;
  return command;
}

function enableHooksFeature(toml: string): string {
  let next = toml.replace(/^[ \t]*codex_hooks[ \t]*=[ \t]*\S+[ \t]*\r?\n?/gm, '');
  if (/^[ \t]*hooks[ \t]*=[ \t]*true[ \t]*$/m.test(next)) return next;
  if (/^\[features\]/m.test(next)) return next.replace(/^(\[features\][^\n]*\n)/m, '$1hooks = true\n');
  return `${next.endsWith('\n') ? next : `${next}\n`}\n[features]\nhooks = true\n`;
}

/** After the hook command is rewritten, replace a stale trusted_hash so Codex does not skip it. */
export function syncCodexHookTrust(toml: string, configPath: string, platform: NodeJS.Platform): string {
  let next = enableHooksFeature(toml);
  for (const event of CODEX_HOOK_EVENTS) {
    const command = effectiveHookCommand(next, event, platform);
    if (!command) continue;
    const key = `${configPath}:${CODEX_HOOK_EVENT_KEY[event]}:0:0`;
    const header = `[hooks.state.${tomlQuoteHook(key)}]`;
    const hashLine = `trusted_hash = ${tomlQuoteHook(codexHookTrustHash(event, command))}`;
    const lines = next.split('\n');
    const index = lines.findIndex(line => line.trim() === header);
    if (index < 0) {
      next = `${next.endsWith('\n') ? next : `${next}\n`}\n${header}\n${hashLine}\n`;
      continue;
    }
    let replaced = false;
    for (let i = index + 1; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith('[')) break;
      if (/^trusted_hash\s*=/.test(trimmed)) {
        lines[i] = hashLine;
        replaced = true;
        break;
      }
    }
    if (!replaced) lines.splice(index + 1, 0, hashLine);
    next = lines.join('\n');
  }
  return next;
}

async function installWindowsStopHook(input: {
  home: string;
  nodePath: string;
  mcpEntry: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const body = hookLauncherBat(input.nodePath, input.mcpEntry, input.baseUrl);
  let launcher: string | undefined;
  for (const dir of spaceFreeHookDirs(input.env)) {
    if (!hookDirWritable(dir)) continue;
    const candidate = hookChild(dir, 'hook.cmd');
    if (/\s/.test(candidate)) continue;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(candidate, body);
      launcher = candidate;
      break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'write failed';
      console.warn(`[agent-room] could not write ${candidate}: ${detail}`);
    }
  }
  if (!launcher) {
    launcher = windowsHookLauncherPath(input.mcpEntry);
    console.warn(`[agent-room] no space-free directory for hook.cmd; falling back to call "${launcher}". Codex runs hooks through PowerShell, where call and a quoted path exit 1.`);
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, body);
  }
  const invocation = windowsHookInvocation(launcher);
  const tomlPath = join(input.home, '.codex', 'config.toml');
  const toml = await readFile(tomlPath, 'utf8').catch(() => '');
  if (toml) {
    const next = syncCodexHookTrust(rewriteHookCommandsInToml(toml, invocation), tomlPath, 'win32');
    if (next !== toml) await writeFile(tomlPath, next);
  }
  const hooksPath = join(input.home, '.cursor', 'hooks.json');
  const hooks = await readFile(hooksPath, 'utf8').catch(() => '');
  if (hooks) {
    const next = rewriteCursorStopHook(hooks, invocation);
    if (next !== hooks) await writeFile(hooksPath, next);
  }
}

export async function installMcp(target: string, options: {
  home?: string;
  run?: CommandRunner;
  commandExists?: (command: string) => boolean;
  now?: number;
  mcpEntry?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Paired room server. Written into client config as AGENT_ROOM_BASE_URL / HTTP MCP url. */
  server?: string;
  /** Tests pass `win32` on Linux CI. Production uses `process.platform`. */
  platform?: NodeJS.Platform;
}): Promise<{ ok: true; backup?: string } | { error: string; hint?: string }> {
  const initTarget = INIT_TARGET[target];
  if (!initTarget) return { error: 'unknown_target' };
  const mcpEntry = await resolveBundledMcpEntry(options);
  const nodePath = mcpEntry ? await resolveNodeBinary(options) : undefined;
  if (mcpEntry && !nodePath) {
    return { error: 'agent_room_node_not_found', hint: '未找到可用于启动内置 MCP 的 Node.js。请重新安装 Agent Room 桌面端。' };
  }
  if (!mcpEntry) {
    const existsCommand = options.commandExists ?? (command => resolveCommand(command) !== undefined);
    if (!existsCommand('agent-room-mcp')) {
      return { error: 'agent_room_mcp_not_installed', hint: REINSTALL_HINT };
    }
  }
  const home = options.home ?? homedir();
  const run = options.run;
  if (!run) return { error: 'runner_unavailable' };
  const stamp = options.now ?? Date.now();
  const backups: { file: string; backup: string }[] = [];
  const absent: string[] = [];
  for (const file of configCandidates(home, target)) {
    if (!(await exists(file))) {
      absent.push(file);
      continue;
    }
    const backup = `${file}.bak-${stamp}`;
    await copyFile(file, backup);
    backups.push({ file, backup });
  }
  const childEnv: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  childEnv.AGENT_ROOM_BASE_URL = pairedServerUrl({ server: options.server, env: options.env });
  let result: CommandResult;
  try {
    if (mcpEntry && nodePath) {
      childEnv.AGENT_ROOM_MCP_COMMAND = nodePath;
      childEnv.AGENT_ROOM_MCP_ARGS = JSON.stringify([mcpEntry]);
      result = await run(nodePath, [mcpEntry, 'init', initTarget], undefined, 60_000, childEnv);
    } else {
      result = await run('agent-room-mcp', ['init', initTarget], undefined, 60_000, childEnv);
    }
  } catch {
    result = { code: 1, stdout: '', stderr: 'spawn_failed' };
  }
  if (result.code !== 0) {
    for (const item of backups) await copyFile(item.backup, item.file);
    for (const file of absent) await rm(file, { force: true });
    return { error: 'mcp_init_failed', hint: result.stderr.trim() || result.stdout.trim() || 'init failed' };
  }
  if ((options.platform ?? process.platform) === 'win32' && mcpEntry && nodePath) {
    try {
      await installWindowsStopHook({
        home,
        nodePath,
        mcpEntry,
        baseUrl: childEnv.AGENT_ROOM_BASE_URL ?? '',
        env: options.env,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'hook_launcher_failed';
      return { error: 'hook_launcher_failed', hint: detail };
    }
  }
  return { ok: true, backup: backups[0]?.backup };
}

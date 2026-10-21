import { copyFile, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from './adapter.js';
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

export async function installMcp(target: string, options: {
  home?: string;
  run?: CommandRunner;
  commandExists?: (command: string) => boolean;
  now?: number;
  mcpEntry?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
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
  return { ok: true, backup: backups[0]?.backup };
}

import { copyFile, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export async function installMcp(target: string, options: {
  home?: string;
  run?: CommandRunner;
  commandExists?: (command: string) => boolean;
  now?: number;
}): Promise<{ ok: true; backup?: string } | { error: string; hint?: string }> {
  const initTarget = INIT_TARGET[target];
  if (!initTarget) return { error: 'unknown_target' };
  const existsCommand = options.commandExists ?? (command => resolveCommand(command) !== undefined);
  if (!existsCommand('agent-room-mcp')) {
    return { error: 'agent_room_mcp_not_installed', hint: 'npm i -g agent-room-mcp' };
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
  let result: CommandResult;
  try {
    result = await run('agent-room-mcp', ['init', initTarget], undefined, 60_000);
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

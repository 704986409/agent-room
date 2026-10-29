import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { DetectResult, LauncherAdapter } from './adapter.js';
import { resolveCommand } from './adapter.js';
import type { CommandResult, CommandRunner } from './credstore.js';
import { resolveNodeBinary } from './mcpconfig.js';

/** MCP tool id and launcher adapter id are the same for the four supported CLIs. */
const MCP_ADAPTER_IDS = new Set(['codex', 'cursor-agent', 'agy', 'claude']);

export function adapterIdForMcp(target: string): string | undefined {
  return MCP_ADAPTER_IDS.has(target) ? target : undefined;
}

export function cliRequiredHint(adapterId: string): string {
  return `请先在上方「本机 Agent」安装 ${adapterId} CLI，再配置 MCP。`;
}

export interface InstallInvocation {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /** Documented command line, used in logs and error hints. */
  display: string;
  env?: NodeJS.ProcessEnv;
}

const INSTALL_TIMEOUT_MS = 300_000;

export type AdapterInstallResult =
  | { ok: true; installed: true; version?: string; path?: string }
  | { error: string; hint?: string };

export interface AdapterInstallOptions {
  adapters: ReadonlyMap<string, LauncherAdapter>;
  run?: CommandRunner;
  log?: { write(line: string): void };
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  runId?: string;
}

/** Official one-liners (2026-10). Returned text is what the user can paste. */
export function officialInstallScript(id: string, platform: NodeJS.Platform): string | undefined {
  if (id === 'cursor-agent') {
    return platform === 'win32'
      ? "irm 'https://cursor.com/install?win32=true' | iex"
      : 'curl https://cursor.com/install -fsS | bash';
  }
  if (id === 'claude') {
    return platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash';
  }
  if (id === 'agy') {
    return platform === 'win32'
      ? 'irm https://antigravity.google/cli/install.ps1 | iex'
      : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  }
  return undefined;
}

export function shellInstall(script: string, platform: NodeJS.Platform): InstallInvocation {
  if (platform === 'win32') {
    // Stop on irm/iex failures. `display` stays the documented one-liner.
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${script}`],
      timeoutMs: INSTALL_TIMEOUT_MS,
      display: script,
    };
  }
  return {
    command: 'bash',
    args: ['-lc', `set -o pipefail; ${script}`],
    timeoutMs: INSTALL_TIMEOUT_MS,
    display: script,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function firstOnPath(names: readonly string[], pathEnv: string): string | undefined {
  for (const name of names) {
    const found = resolveCommand(name, pathEnv);
    if (found) return found;
  }
  return undefined;
}

/** `npm-cli.js` shipped beside a Node install (Windows zip or Unix `lib/` layout). */
async function npmCliBeside(node: string): Promise<string | undefined> {
  const dir = dirname(node);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function nodePlusNpmCli(node: string | undefined): Promise<{ command: string; prefix: string[] } | undefined> {
  if (!node || !(await fileExists(node))) return undefined;
  const cli = await npmCliBeside(node);
  if (!cli) return undefined;
  return { command: node, prefix: [cli] };
}

/**
 * On Windows, `spawn` of `npm.cmd` returns EINVAL. Prefer `node` + `npm-cli.js`
 * next to nodePath, the bundled runtime, or a PATH / nvm Node when that script exists.
 */
async function winNodeNpmCli(options: {
  nodePath?: string;
  env: NodeJS.ProcessEnv;
  pathEnv: string;
  npmOnPath?: string;
}): Promise<{ command: string; prefix: string[] } | undefined> {
  const nodes: string[] = [];
  const push = (candidate?: string) => {
    if (candidate && !nodes.includes(candidate)) nodes.push(candidate);
  };
  push(await resolveNodeBinary({ nodePath: options.nodePath, env: options.env }));
  push(firstOnPath(['node.exe', 'node'], options.pathEnv));
  if (options.npmOnPath) {
    const dir = dirname(options.npmOnPath);
    push(join(dir, 'node.exe'));
    push(join(dir, 'node'));
  }
  for (const node of nodes) {
    const found = await nodePlusNpmCli(node);
    if (found) return found;
  }
  return undefined;
}

/** PATH `npm`, else `npm` / `npm-cli.js` next to the bundled or configured Node. */
export async function resolveNpmInvocation(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
} = {}): Promise<{ command: string; prefix: string[] } | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathEnv = env.PATH ?? '';
  const npmNames = platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  const npmOnPath = firstOnPath(npmNames, pathEnv);

  if (platform === 'win32') {
    const viaNode = await winNodeNpmCli({ nodePath: options.nodePath, env, pathEnv, npmOnPath });
    if (viaNode) return viaNode;
    if (npmOnPath) return { command: npmOnPath, prefix: [] };
  } else if (npmOnPath) {
    return { command: npmOnPath, prefix: [] };
  }

  const node = await resolveNodeBinary({ nodePath: options.nodePath, env });
  if (!node) return undefined;
  const dir = dirname(node);
  for (const name of npmNames) {
    const sibling = join(dir, name);
    if (await fileExists(sibling)) return { command: sibling, prefix: [] };
  }
  return nodePlusNpmCli(node);
}

async function npmGlobal(pkg: string, options: AdapterInstallOptions): Promise<InstallInvocation | { error: string; hint: string }> {
  const npm = await resolveNpmInvocation({
    platform: options.platform,
    env: options.env,
    nodePath: options.nodePath,
  });
  if (!npm) {
    return {
      error: 'npm_not_found',
      hint: `未找到 npm。请先安装 Node.js（含 npm），然后执行：npm i -g ${pkg}`,
    };
  }
  return {
    command: npm.command,
    args: [...npm.prefix, 'i', '-g', pkg],
    timeoutMs: INSTALL_TIMEOUT_MS,
    display: `npm i -g ${pkg}`,
    env: { npm_config_fund: 'false', npm_config_audit: 'false', CI: 'true' },
  };
}

function logChunks(log: AdapterInstallOptions['log'], text: string, id: string, runId = 'legacy'): void {
  if (!log || !text) return;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed) log.write(`[install] output adapter=${id} run=${runId} ${trimmed}`);
  }
}

function clip(text: string): string {
  const clean = text.trim();
  if (clean.length <= 1500) return clean;
  return `${clean.slice(0, 1500)}…`;
}

async function runStep(
  step: InstallInvocation,
  id: string,
  options: AdapterInstallOptions & { run: CommandRunner },
): Promise<CommandResult> {
  options.log?.write(`[install] start adapter=${id} run=${options.runId ?? 'legacy'} command=${step.display} timeoutMs=${step.timeoutMs}`);
  try {
    let streamed = false;
    const result = await options.run(step.command, step.args, undefined, step.timeoutMs, step.env, (_stream, chunk) => {
      streamed = true;
      logChunks(options.log, chunk, id, options.runId);
    });
    if (!streamed) {
      logChunks(options.log, result.stdout, id, options.runId);
      logChunks(options.log, result.stderr, id, options.runId);
    }
    if (result.code !== 0) options.log?.write(`[install] failed adapter=${id} run=${options.runId ?? 'legacy'} exitCode=${result.code}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'spawn_failed';
    options.log?.write(`[install] failed adapter=${id} run=${options.runId ?? 'legacy'} reason=${message}`);
    return { code: 1, stdout: '', stderr: message };
  }
}

function installFailed(step: InstallInvocation, result: CommandResult): AdapterInstallResult {
  const detail = clip(result.stderr || result.stdout || 'install failed');
  return { error: 'cli_install_failed', hint: `${detail}\n请手动执行：${step.display}` };
}

async function rememberNpmBin(
  step: InstallInvocation,
  options: AdapterInstallOptions & { run: CommandRunner },
): Promise<void> {
  if (!step.display.startsWith('npm i -g ')) return;
  const npmArgs = step.args.slice(0, Math.max(0, step.args.length - 3));
  let listed: CommandResult;
  try {
    listed = await options.run(step.command, [...npmArgs, 'prefix', '-g'], undefined, 20_000, step.env);
  } catch {
    return;
  }
  if (listed.code !== 0) return;
  const prefix = listed.stdout.trim().split(/\r?\n/).pop()?.trim();
  if (!prefix) return;
  const platform = options.platform ?? process.platform;
  const bin = platform === 'win32' ? prefix : join(prefix, 'bin');
  if (!(await fileExists(bin))) return;
  const env = options.env ?? process.env;
  const current = env.PATH ?? '';
  if (current.split(delimiter).includes(bin)) return;
  env.PATH = current ? `${bin}${delimiter}${current}` : bin;
  if (env !== process.env && !(process.env.PATH ?? '').split(delimiter).includes(bin)) {
    process.env.PATH = [bin, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  }
}

function probeFailure(id: string, detected: DetectResult): AdapterInstallResult {
  const lines = [
    `已执行安装，但 ${id} 仍未通过版本检测。`,
    detected.path ? `路径：${detected.path}` : '',
    detected.detail ? detected.detail : '',
    '若安装程序要求把目录加入 PATH，请重启 Agent Room 后再试。',
  ].filter(Boolean);
  return { error: 'cli_probe_failed', hint: lines.join('\n') };
}

/**
 * Runs the official installer for an adapter id, logs output, then re-detects.
 * A non-zero installer exit or a failed version probe is an error (never a fake success).
 */
export async function installAdapterCli(id: string, options: AdapterInstallOptions): Promise<AdapterInstallResult> {
  if (!MCP_ADAPTER_IDS.has(id)) return { error: 'unknown_adapter', hint: '不支持的适配器。' };
  const adapter = options.adapters.get(id);
  if (!adapter) return { error: 'unknown_adapter', hint: '不支持的适配器。' };
  if (!options.run) return { error: 'runner_unavailable', hint: '无法执行安装命令。' };
  const platform = options.platform ?? process.platform;
  const runOptions = { ...options, run: options.run, platform };

  let step: InstallInvocation;
  if (id === 'codex') {
    const resolved = await npmGlobal('@openai/codex', runOptions);
    if ('error' in resolved) return resolved;
    step = resolved;
  } else {
    const script = officialInstallScript(id, platform);
    if (!script) return { error: 'unknown_adapter', hint: '不支持的适配器。' };
    step = shellInstall(script, platform);
  }

  let result = await runStep(step, id, runOptions);
  if (result.code !== 0 && id === 'claude') {
    options.log?.write('官方安装脚本失败，改用 npm i -g @anthropic-ai/claude-code');
    const fallback = await npmGlobal('@anthropic-ai/claude-code', runOptions);
    if (!('error' in fallback)) {
      step = fallback;
      result = await runStep(step, id, runOptions);
    }
  }
  if (result.code !== 0) return installFailed(step, result);

  let detected = await adapter.detect();
  if (!detected.installed) {
    await rememberNpmBin(step, runOptions);
    detected = await adapter.detect();
  }
  if (!detected.installed) {
    options.log?.write(`[install] probe failed adapter=${id} run=${options.runId ?? 'legacy'}`);
    return probeFailure(id, detected);
  }
  options.log?.write(`[install] success adapter=${id} run=${options.runId ?? 'legacy'} version=${detected.version ?? 'unknown'}`);
  return { ok: true, installed: true, version: detected.version, path: detected.path };
}

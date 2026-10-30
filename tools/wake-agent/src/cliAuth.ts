import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetectResult } from './adapter.js';

/** Auth-only probe result. Never starts a chat turn. */
export interface CliAuthStatus {
  /** true / false when known; null when the probe could not decide. */
  loggedIn: boolean | null;
  detail?: string;
}

type AuthProbe = (command: string, env?: NodeJS.ProcessEnv) => Promise<CliAuthStatus>;

const authCache = new Map<string, CliAuthStatus>();
let authInflight: Promise<void> | null = null;
let authLastRefreshAt = 0;

export function getCachedAuth(adapterId: string): CliAuthStatus | undefined {
  return authCache.get(adapterId);
}

export function setCachedAuth(adapterId: string, status: CliAuthStatus): void {
  authCache.set(adapterId, status);
  if (authLastRefreshAt === 0) authLastRefreshAt = Date.now();
}

export function clearAuthCache(): void {
  authCache.clear();
  authLastRefreshAt = 0;
  authInflight = null;
}

export function authCacheSize(): number {
  return authCache.size;
}

export function authCacheAgeMs(now = Date.now()): number {
  return authLastRefreshAt > 0 ? now - authLastRefreshAt : Number.POSITIVE_INFINITY;
}

function runCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(command, [...args], {
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (!settled) {
        settled = true;
        resolve({ code: null, stdout, stderr: stderr || 'timeout' });
      }
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: null, stdout, stderr: error.message });
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function looksLoggedIn(text: string): boolean {
  return /logged\s*in|signed\s*in|authenticated|已登录/i.test(text)
    && !/not\s+logged\s*in|not\s+signed\s*in|logged\s*out|未登录/i.test(text);
}

function looksLoggedOut(text: string): boolean {
  return /not\s+logged\s*in|not\s+signed\s*in|logged\s*out|please\s+log\s*in|未登录|需要登录/i.test(text);
}

async function probeCodex(command: string, env?: NodeJS.ProcessEnv): Promise<CliAuthStatus> {
  const result = await runCapture(command, ['login', 'status'], 8_000, env);
  const text = `${result.stdout}\n${result.stderr}`;
  if (looksLoggedIn(text)) return { loggedIn: true, detail: text.trim().slice(0, 200) };
  if (looksLoggedOut(text) || result.code === 1) return { loggedIn: false, detail: text.trim().slice(0, 200) };
  if (result.code === 0 && /chatgpt|api\s*key/i.test(text)) return { loggedIn: true, detail: text.trim().slice(0, 200) };
  return { loggedIn: null, detail: text.trim().slice(0, 200) || 'codex login status unknown' };
}

async function probeCursor(command: string, env?: NodeJS.ProcessEnv): Promise<CliAuthStatus> {
  const result = await runCapture(command, ['status'], 8_000, env);
  const text = `${result.stdout}\n${result.stderr}`;
  if (looksLoggedIn(text)) return { loggedIn: true, detail: text.trim().slice(0, 200) };
  if (looksLoggedOut(text)) return { loggedIn: false, detail: text.trim().slice(0, 200) };
  if (result.code === 0 && /@|email/i.test(text)) return { loggedIn: true, detail: text.trim().slice(0, 200) };
  if (result.code === 1) return { loggedIn: false, detail: text.trim().slice(0, 200) };
  return { loggedIn: null, detail: text.trim().slice(0, 200) || 'agent status unknown' };
}

function agyTokenPath(home = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

async function probeAgy(_command: string, env: NodeJS.ProcessEnv = process.env): Promise<CliAuthStatus> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = agyTokenPath(home);
  if (!existsSync(path)) {
    return { loggedIn: false, detail: `missing ${path}` };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { access_token?: unknown; token?: unknown; refresh_token?: unknown };
    const has = [json.access_token, json.token, json.refresh_token]
      .some(value => typeof value === 'string' && value.length > 0);
    if (has || (typeof raw === 'string' && raw.trim().length > 20 && raw.trim()[0] !== '{')) {
      return { loggedIn: true, detail: path };
    }
    // Non-empty file often means a logged-in session even without known keys.
    if (raw.trim().length > 0) return { loggedIn: true, detail: path };
    return { loggedIn: false, detail: `empty ${path}` };
  } catch (error) {
    return { loggedIn: null, detail: error instanceof Error ? error.message : 'agy token unreadable' };
  }
}

async function probeClaude(command: string, env?: NodeJS.ProcessEnv): Promise<CliAuthStatus> {
  const result = await runCapture(command, ['auth', 'status'], 8_000, env);
  const text = `${result.stdout}\n${result.stderr}`.trim();
  try {
    const json = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (typeof json.loggedIn === 'boolean') {
      return { loggedIn: json.loggedIn, detail: text.slice(0, 200) };
    }
  } catch { /* plain text */ }
  if (looksLoggedIn(text)) return { loggedIn: true, detail: text.slice(0, 200) };
  if (looksLoggedOut(text)) return { loggedIn: false, detail: text.slice(0, 200) };
  return { loggedIn: null, detail: text.slice(0, 200) || 'claude auth unknown' };
}

const PROBES: Record<string, AuthProbe> = {
  codex: probeCodex,
  'cursor-agent': probeCursor,
  agy: probeAgy,
  claude: probeClaude,
};

function commandExists(command: string): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return existsSync(command);
    }
  }
  return true; // PATH name — let the probe spawn fail if missing
}

/** Probe one adapter's login state without starting a conversation. */
export async function probeCliAuth(
  adapterId: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliAuthStatus> {
  const probe = PROBES[adapterId];
  if (!probe) return { loggedIn: null, detail: `no auth probe for ${adapterId}` };
  if (!commandExists(command)) return { loggedIn: false, detail: `command missing: ${command}` };
  try {
    return await probe(command, env);
  } catch (error) {
    return { loggedIn: null, detail: error instanceof Error ? error.message : 'auth probe failed' };
  }
}

export interface AuthRefreshTarget {
  id: string;
  command: string;
  detect?: DetectResult;
}

/**
 * Refresh auth cache for installed adapters only. Concurrent callers share one run.
 */
export function beginAuthRefresh(
  targets: Iterable<AuthRefreshTarget>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (authInflight) return authInflight;
  const list = [...targets].filter(item => item.detect?.installed !== false);
  authInflight = (async () => {
    for (const target of list) {
      const command = target.detect?.path || target.command;
      const status = await probeCliAuth(target.id, command, env);
      setCachedAuth(target.id, status);
    }
    authLastRefreshAt = Date.now();
  })().finally(() => {
    authInflight = null;
  });
  return authInflight;
}

/** Login hint shown in the HostLocal dialog / host error. */
export function loginHintFor(adapterId: string): string {
  switch (adapterId) {
    case 'codex':
      return '请先在本机终端运行：codex login';
    case 'cursor-agent':
      return '请先在本机终端运行：agent login（或 cursor-agent login）';
    case 'agy':
      return '请先在本机终端运行：agy，按提示完成 Google 登录';
    case 'claude':
      return '请先在本机终端运行：claude auth login';
    default:
      return '请先登录该 CLI 后再托管';
  }
}

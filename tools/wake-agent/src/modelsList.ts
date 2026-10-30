import { spawn } from 'node:child_process';
import type { LauncherAdapter } from './adapter.js';
import { resolveCommand, spawnCommand } from './adapter.js';
import { getCachedDetect, setCachedDetect } from './detectCache.js';

/**
 * Process-only model cache. Filled asynchronously at daemon start; cleared on exit.
 * Never persisted across restarts.
 */
const liveModels = new Map<string, readonly string[]>();

export function getLiveModels(adapterId: string): readonly string[] | undefined {
  return liveModels.get(adapterId);
}

export function setLiveModels(adapterId: string, models: readonly string[]): void {
  const clean = models.map(m => m.trim()).filter(Boolean);
  if (clean.length) liveModels.set(adapterId, clean);
}

export function clearLiveModels(): void {
  liveModels.clear();
}

export function modelsForAdapter(adapter: LauncherAdapter): readonly string[] {
  return getLiveModels(adapter.id) ?? adapter.models;
}

/** `agent --list-models` / `cursor-agent --list-models`: `slug - Label`. */
export function parseCursorListModels(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available models$/i.test(line)) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._+-]*)\s+-\s+/.exec(line);
    if (match) out.push(match[1]!);
  }
  return unique(out);
}

/** `agy models`: `slug\\tLabel` or `slug  Label`. */
export function parseAgyModels(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /fetching/i.test(line)) continue;
    const tab = line.split(/\t/);
    if (tab.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tab[0]!.trim())) {
      out.push(tab[0]!.trim());
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9._+-]*)\s{2,}/.exec(line);
    if (match) out.push(match[1]!);
  }
  return unique(out);
}

/** `codex debug models` JSON: prefer `models[].slug`. */
export function parseCodexDebugModels(stdout: string): string[] {
  const start = stdout.indexOf('{');
  if (start < 0) return [];
  try {
    const json = JSON.parse(stdout.slice(start)) as { models?: unknown };
    if (!Array.isArray(json.models)) return [];
    const out: string[] = [];
    for (const row of json.models) {
      if (!row || typeof row !== 'object') continue;
      const slug = (row as { slug?: unknown }).slug;
      if (typeof slug === 'string' && slug.trim()) out.push(slug.trim());
    }
    return unique(out);
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function runCapture(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const resolved = resolveCommand(command) ?? command;
  const spec = spawnCommand(resolved, args);
  return new Promise(resolve => {
    const child = spawn(spec.command, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: spec.windowsHide,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(stdout || stderr);
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(stdout || stderr);
    });
  });
}

export interface ListModelsRunner {
  (adapterId: string, command: string): Promise<string[]>;
}

const defaultRunner: ListModelsRunner = async (adapterId, command) => {
  if (adapterId === 'cursor-agent') {
    // Prefer `agent` when that is what detect resolved; still try --list-models.
    const text = await runCapture(command, ['--list-models'], 12_000);
    return parseCursorListModels(text);
  }
  if (adapterId === 'codex') {
    const text = await runCapture(command, ['debug', 'models'], 20_000);
    const live = parseCodexDebugModels(text);
    // Keep synthetic `default` (no -m) ahead of live slugs when present in the fallback.
    return live.length ? unique(['default', ...live.filter(m => m !== 'default')]) : [];
  }
  if (adapterId === 'agy') {
    const text = await runCapture(command, ['models'], 12_000);
    return parseAgyModels(text);
  }
  return [];
};

/**
 * Refresh the process cache for every adapter. Failures leave the hardcoded
 * fallback on the adapter untouched. Safe to call fire-and-forget at boot.
 */
export async function refreshAdapterModels(
  adapters: Iterable<LauncherAdapter>,
  runner: ListModelsRunner = defaultRunner,
): Promise<void> {
  for (const adapter of adapters) {
    try {
      let exe = adapter.command;
      let detected = getCachedDetect(adapter.id);
      if (!detected) {
        try {
          detected = await adapter.detect();
          setCachedDetect(adapter.id, detected);
        } catch {
          detected = { installed: false };
          setCachedDetect(adapter.id, detected);
        }
      }
      if (!detected.installed) continue;
      if (detected.path) exe = detected.path;
      const models = await runner(adapter.id, exe);
      if (models.length) {
        setLiveModels(adapter.id, models);
        adapter.setModels?.(models);
      }
    } catch {
      /* keep hardcoded fallback */
    }
  }
}

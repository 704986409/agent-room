// Reads a UTF-8 prompt file and starts the CLI with stdio inherited.
// The prompt is one argv element. Never pass it through cmd.exe: a newline
// ends the command, so the rest of the room prompt never reaches the CLI.
// Interactive Codex (0.156 TUI) takes that prompt as a positional argument.
// `codex exec -` reads stdin, but that is non-interactive and would take the console.
// cursor-agent and agy also take the prompt on argv (`--trust <prompt>`, `-i <prompt>`).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Expand %VAR% using env (case-insensitive on Windows). Leaves %~dp0-style for expandDp0. */
export function expandEnvVars(value, env = process.env) {
  return value.replace(/%([^%]+)%/gi, (match, name) => {
    if (typeof name !== 'string' || !name || name.startsWith('~') || /^dp0$/i.test(name)) {
      return match;
    }
    const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase());
    if (key === undefined || env[key] == null || env[key] === '') return match;
    return String(env[key]);
  });
}

export function expandDp0(value, cmdPath) {
  const dir = dirname(cmdPath).replace(/[\\/]+$/g, '');
  const slash = `${dir}/`;
  return value
    .replace(/%~dp0%/gi, slash)
    .replace(/%dp0%/gi, slash)
    .replace(/%~dp0/gi, slash)
    .replace(/[\\/]+/g, sep);
}

export function tokensOf(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match = re.exec(text);
  while (match) {
    out.push(match[1] ?? match[2] ?? '');
    match = re.exec(text);
  }
  return out.filter(Boolean);
}

function nodeForShim(dir) {
  const nodeExe = join(dir, 'node.exe');
  return existsSync(nodeExe) ? nodeExe : process.execPath;
}

function concreteTokens(rawTokens, cmdPath, env) {
  return rawTokens
    .map(token => expandDp0(expandEnvVars(token, env), cmdPath))
    .filter(token => !/%/.test(token));
}

/**
 * Resolve a Windows .cmd/.bat shim to a real executable + args.
 * Expands %SystemRoot% / %~dp0 before dropping unresolved % tokens so
 * PowerShell-based Cursor shims do not leave `-NoProfile` as the command.
 * Store / WindowsApps shims that only `call` another `.cmd` are unwrapped
 * recursively (nvm npm shims) so the prompt never passes through cmd.exe.
 */
export function resolveCli(command, env = process.env, seen = new Set()) {
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args: [] };
  const key = command.replace(/\\/g, '/').toLowerCase();
  if (seen.has(key)) {
    throw new Error(`seat-launch: ${command} shim cycle`);
  }
  if (seen.size >= 8) {
    throw new Error(`seat-launch: ${command} shim chain too deep`);
  }
  seen.add(key);
  let text = '';
  try {
    text = readFileSync(command, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable';
    throw new Error(`seat-launch: cannot read ${command}: ${message}`);
  }
  const dir = dirname(command);
  const nodeBin = nodeForShim(dir);
  const npm = text.match(/"%_prog%"\s+([\s\S]*?)%\*/);
  if (npm) {
    const args = concreteTokens(tokensOf(npm[1]), command, env);
    if (!args.length) {
      throw new Error(`seat-launch: ${command} shim has no script to run`);
    }
    return { command: nodeBin, args };
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => {
    if (!line || line.startsWith(':') || line.startsWith('::')) return false;
    if (/^@?echo\b/i.test(line) || /^rem\b/i.test(line)) return false;
    return /%\*/.test(line);
  });
  const execLine = lines.length ? lines[lines.length - 1] : '';
  const body = execLine.replace(/%\*\s*$/, '').replace(/^\s*call\s+/i, '');
  const concrete = concreteTokens(tokensOf(body), command, env);
  if (!concrete.length) {
    throw new Error(`seat-launch: ${command} is a cmd shim; refusing to pass the prompt through cmd.exe`);
  }
  const [file, ...rest] = concrete;
  if (/\.(mjs|cjs|js)$/i.test(file)) return { command: nodeBin, args: [file, ...rest] };
  if (/node\.exe$/i.test(file)) {
    const script = rest.find(arg => /\.(mjs|cjs|js)$/i.test(arg));
    if (script && !existsSync(file)) {
      return { command: nodeBin, args: [script, ...rest.filter(arg => arg !== script)] };
    }
  }
  if (/\.(cmd|bat)$/i.test(file)) {
    const nested = resolveCli(file, env, seen);
    return { command: nested.command, args: [...nested.args, ...rest] };
  }
  return { command: file, args: rest };
}

function launchCwd(value) {
  if (typeof value === 'string' && value) {
    try {
      if (statSync(value).isDirectory()) return value;
    } catch { /* missing cwd or a dead nvm junction */ }
  }
  return homedir();
}

export function main(argv = process.argv, env = process.env) {
  const specPath = argv[2];
  if (!specPath) {
    process.stderr.write('seat-launch: missing spec path\n');
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid';
    process.stderr.write(`seat-launch: cannot read spec: ${message}\n`);
    process.exit(1);
  }

  let prompt = '';
  try {
    prompt = readFileSync(spec.promptFile, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable';
    process.stderr.write(`seat-launch: cannot read prompt: ${message}\n`);
    process.exit(1);
  }

  const cliArgs = Array.isArray(spec.args) ? spec.args.slice() : [];
  const index = Number.isInteger(spec.promptIndex) ? spec.promptIndex : cliArgs.length;
  cliArgs.splice(Math.max(0, index), 0, prompt);
  let resolved;
  try {
    resolved = resolveCli(String(spec.command ?? ''), env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'resolve failed'}\n`);
    process.exit(1);
  }
  if (/\.(cmd|bat)$/i.test(resolved.command)) {
    process.stderr.write('seat-launch: refusing to pass the prompt through cmd.exe\n');
    process.exit(1);
  }
  const childEnv = { ...env };
  if (spec.env && typeof spec.env === 'object') {
    for (const [key, value] of Object.entries(spec.env)) {
      if (typeof value === 'string') childEnv[key] = value;
    }
  }

  const child = spawn(resolved.command, [...resolved.args, ...cliArgs], {
    cwd: launchCwd(spec.cwd),
    env: childEnv,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  child.on('error', error => {
    process.stderr.write(`seat-launch: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code == null ? 1 : code);
  });
}

const runningAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (runningAsScript) main();

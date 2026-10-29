// Reads a UTF-8 prompt file and starts the CLI with stdio inherited.
// The prompt is one argv element. Never pass it through cmd.exe: a newline
// ends the command, so the rest of the room prompt never reaches the CLI.
// Interactive Codex (0.156 TUI) takes that prompt as a positional argument.
// `codex exec -` reads stdin, but that is non-interactive and would take the console.
// cursor-agent and agy also take the prompt on argv (`--trust <prompt>`, `-i <prompt>`).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

const specPath = process.argv[2];
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

function expandDp0(value, cmdPath) {
  const dir = dirname(cmdPath).replace(/[\\/]+$/g, '');
  const slash = `${dir}/`;
  return value
    .replace(/%~dp0%/gi, slash)
    .replace(/%dp0%/gi, slash)
    .replace(/%~dp0/gi, slash)
    .replace(/[\\/]+/g, sep);
}

function tokensOf(text) {
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

function resolveCli(command) {
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args: [] };
  let text = '';
  try {
    text = readFileSync(command, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable';
    process.stderr.write(`seat-launch: cannot read ${command}: ${message}\n`);
    process.exit(1);
  }
  const dir = dirname(command);
  const nodeBin = nodeForShim(dir);
  const npm = text.match(/"%_prog%"\s+([\s\S]*?)%\*/);
  if (npm) {
    const args = tokensOf(npm[1])
      .map(token => expandDp0(token, command))
      .filter(token => !/%/.test(token));
    if (!args.length) {
      process.stderr.write(`seat-launch: ${command} shim has no script to run\n`);
      process.exit(1);
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
  const concrete = tokensOf(body)
    .map(token => expandDp0(token, command))
    .filter(token => !/%/.test(token));
  if (!concrete.length) {
    process.stderr.write(`seat-launch: ${command} is a cmd shim; refusing to pass the prompt through cmd.exe\n`);
    process.exit(1);
  }
  const [file, ...rest] = concrete;
  if (/\.(mjs|cjs|js)$/i.test(file)) return { command: nodeBin, args: [file, ...rest] };
  if (/node\.exe$/i.test(file)) {
    const script = rest.find(arg => /\.(mjs|cjs|js)$/i.test(arg));
    if (script && !existsSync(file)) {
      return { command: nodeBin, args: [script, ...rest.filter(arg => arg !== script)] };
    }
  }
  return { command: file, args: rest };
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
const resolved = resolveCli(String(spec.command ?? ''));
if (/\.(cmd|bat)$/i.test(resolved.command)) {
  process.stderr.write('seat-launch: refusing to pass the prompt through cmd.exe\n');
  process.exit(1);
}
const env = { ...process.env };
if (spec.env && typeof spec.env === 'object') {
  for (const [key, value] of Object.entries(spec.env)) {
    if (typeof value === 'string') env[key] = value;
  }
}
function launchCwd(value) {
  if (typeof value === 'string' && value) {
    try {
      if (statSync(value).isDirectory()) return value;
    } catch { /* missing cwd or a dead nvm junction */ }
  }
  return homedir();
}

const child = spawn(resolved.command, [...resolved.args, ...cliArgs], {
  cwd: launchCwd(spec.cwd),
  env,
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

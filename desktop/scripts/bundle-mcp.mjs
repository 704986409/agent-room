// Stage the forked agent-room-mcp into desktop/mcp-runtime/ (gitignored).
// Tauri maps that tree to resources/mcp/ (`../mcp-runtime/` → `mcp/`).
// Clients then run: node <resources>/mcp/dist/index.js
//
// Source repo, first match:
//   1. AGENT_ROOM_MCP_SRC
//   2. sibling checkout, e.g. /home/box/MERYANG/agent-room-mcp
//      (../../agent-room-mcp from desktop/)
//   3. CI: $GITHUB_WORKSPACE/agent-room-mcp
//      (AGENT_ROOM_MCP_SRC=$GITHUB_WORKSPACE/agent-room-mcp)
//
// Expected branch: feat/stop-hook-one-round. Detached HEAD (actions/checkout) is allowed.
// tsup leaves @modelcontextprotocol/sdk, mammoth, unpdf, and zod external, so the
// staged tree is dist/ plus a production node_modules for those packages.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const cacheDir = join(desktop, '.cache', 'mcp-runtime');
const stageDir = join(cacheDir, 'stage');
const outDir = join(desktop, 'mcp-runtime');
const EXPECTED_BRANCH = 'feat/stop-hook-one-round';
const MARKERS = ['AGENT_ROOM_MANAGED', 'performHandoff'];

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${result.status})`);
  }
}

function gitOut(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function resolveMcpSrc() {
  const candidates = [
    process.env.AGENT_ROOM_MCP_SRC,
    join(desktop, '..', '..', 'agent-room-mcp'),
    process.env.GITHUB_WORKSPACE ? join(process.env.GITHUB_WORKSPACE, 'agent-room-mcp') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'apps', 'mcp', 'package.json'))) return candidate;
  }
  throw new Error(
    'agent-room-mcp source not found. Set AGENT_ROOM_MCP_SRC to the repo root ' +
    '(CI: AGENT_ROOM_MCP_SRC=$GITHUB_WORKSPACE/agent-room-mcp). Looked in:\n' +
    candidates.join('\n'),
  );
}

function distHasMarkers(dir) {
  const pending = [dir];
  const hits = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = readFileSync(path, 'utf8');
      for (const marker of MARKERS) {
        if (text.includes(marker)) hits.add(marker);
      }
    }
  }
  return MARKERS.filter((marker) => !hits.has(marker));
}

const src = resolveMcpSrc();
const branch = gitOut(['branch', '--show-current'], src) || '(detached)';
const head = gitOut(['rev-parse', 'HEAD'], src) || 'unknown';
console.log(`agent-room-mcp ${branch} ${head} (${src})`);
if (branch !== '(detached)' && branch !== EXPECTED_BRANCH) {
  throw new Error(
    `agent-room-mcp is on ${branch}, expected ${EXPECTED_BRANCH} ` +
    '(detached HEAD is accepted for CI checkouts of that ref)',
  );
}

const pkgPath = join(src, 'apps', 'mcp', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const deps = pkg.dependencies ?? {};
for (const name of ['@modelcontextprotocol/sdk', 'mammoth', 'unpdf', 'zod']) {
  if (!deps[name]) throw new Error(`apps/mcp/package.json is missing production dependency ${name}`);
}

if (!existsSync(join(src, 'node_modules'))) {
  console.log('npm ci (agent-room-mcp)');
  run(npmBin(), ['ci'], src);
}
run(npmBin(), ['run', 'build', '-w', 'packages/shared'], src);
run(npmBin(), ['run', 'build', '-w', 'packages/upstash-client'], src);
run(npmBin(), ['run', 'build', '-w', 'apps/mcp'], src);

const builtIndex = join(src, 'apps', 'mcp', 'dist', 'index.js');
if (!existsSync(builtIndex)) throw new Error(`MCP build did not produce ${builtIndex}`);
const missingMarkers = distHasMarkers(join(src, 'apps', 'mcp', 'dist'));
if (missingMarkers.length > 0) {
  throw new Error(`built MCP dist is missing fork markers: ${missingMarkers.join(', ')}`);
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  main: './dist/index.js',
  dependencies: deps,
};
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
cpSync(join(src, 'apps', 'mcp', 'dist'), join(stageDir, 'dist'), { recursive: true });
console.log('npm install --omit=dev (staged MCP runtime)');
run(npmBin(), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stageDir);

if (!existsSync(join(stageDir, 'dist', 'index.js'))) {
  throw new Error('staged dist/index.js missing');
}
for (const name of Object.keys(deps)) {
  if (!existsSync(join(stageDir, 'node_modules', name, 'package.json'))) {
    throw new Error(`production dependency missing after install: ${name}`);
  }
}

const probe = spawnSync(process.execPath, [join(stageDir, 'dist', 'index.js'), 'init', 'print'], {
  cwd: stageDir,
  encoding: 'utf8',
  env: { ...process.env, HOME: cacheDir, USERPROFILE: cacheDir },
});
if (probe.status !== 0) {
  throw new Error(
    `bundled MCP entry failed to run (exit ${probe.status})\n${probe.stderr || probe.stdout || probe.error || ''}`,
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(dirname(outDir), { recursive: true });
cpSync(stageDir, outDir, { recursive: true });
if (!existsSync(join(outDir, 'dist', 'index.js'))) {
  throw new Error(`failed to stage ${join(outDir, 'dist', 'index.js')}`);
}
console.log(`staged MCP ${pkg.version} in ${outDir}`);
console.log('entrypoint: node <resources>/mcp/dist/index.js');

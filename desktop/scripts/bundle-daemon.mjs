// Bundle tools/wake-agent into one ESM file the shell runs with system Node.
// node-pty stays external: the daemon does createRequire(import.meta.url), so the
// prebuilt package must sit in daemon-dist/node_modules next to the .mjs.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'daemon-dist');
const ptyName = '@homebridge/node-pty-prebuilt-multiarch';
mkdirSync(out, { recursive: true });

function findPtyPackage() {
  const candidates = [
    join(root, 'tools/wake-agent/node_modules', ptyName),
    join(root, 'node_modules', ptyName),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'prebuilds'))) return dir;
  }
  return null;
}

function hasNodeBinary(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (hasNodeBinary(path)) return true;
    } else if (name.endsWith('.node')) {
      return true;
    }
  }
  return false;
}

/** Host arch dir name under prebuilds/ (e.g. linux-x64, win32-x64). */
function hostPrebuildDir() {
  return `${process.platform}-${process.arch}`;
}

/**
 * Keep only the pack-host glibc (non-musl) prebuild tree so linuxdeploy does
 * not scan arm/musl binaries and demand libc.musl-*.so.1.
 */
function pruneHostPrebuilds(prebuildsRoot) {
  const keep = hostPrebuildDir();
  for (const name of readdirSync(prebuildsRoot)) {
    const path = join(prebuildsRoot, name);
    if (!statSync(path).isDirectory()) continue;
    if (name !== keep) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  const keptDir = join(prebuildsRoot, keep);
  if (existsSync(keptDir) && statSync(keptDir).isDirectory()) {
    for (const name of readdirSync(keptDir)) {
      if (name.includes('musl') || name.endsWith('.musl.node')) {
        unlinkSync(join(keptDir, name));
      }
    }
  }
  const remaining = existsSync(prebuildsRoot)
    ? readdirSync(prebuildsRoot).filter((n) => statSync(join(prebuildsRoot, n)).isDirectory())
    : [];
  console.log(`node-pty prebuilds kept: ${remaining.length ? remaining.join(', ') : '(none)'}`);
  return remaining;
}

const ptySrc = findPtyPackage();
if (!ptySrc) {
  console.error(`missing ${ptyName} (looked in tools/wake-agent/node_modules then node_modules). Install wake-agent deps.`);
  process.exit(1);
}

await build({
  entryPoints: [join(root, 'tools/wake-agent/src/index.ts')],
  outfile: join(out, 'agent-room-daemon.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: [ptyName, 'node-pty'],
  nodePaths: [join(root, 'node_modules')],
  logLevel: 'info',
});
const html = join(root, 'tools/wake-agent/src/settings.html');
if (existsSync(html)) cpSync(html, join(out, 'settings.html'));
const winCred = join(root, 'tools/wake-agent/scripts/win-cred.ps1');
if (existsSync(winCred)) cpSync(winCred, join(out, 'win-cred.ps1'));
const seatLaunch = join(root, 'tools/wake-agent/src/seat-launch.mjs');
if (existsSync(seatLaunch)) cpSync(seatLaunch, join(out, 'seat-launch.mjs'));

const ptyDest = join(out, 'node_modules', ptyName);
rmSync(ptyDest, { recursive: true, force: true });
mkdirSync(dirname(ptyDest), { recursive: true });
cpSync(ptySrc, ptyDest, { recursive: true, dereference: true });
const ptyPkg = join(ptyDest, 'package.json');
const ptyPrebuilds = join(ptyDest, 'prebuilds');
if (!existsSync(ptyPkg) || !existsSync(ptyPrebuilds) || !hasNodeBinary(ptyPrebuilds)) {
  console.error(`node-pty prebuilds missing after copy (${ptyPrebuilds}). Refusing to package daemon-dist.`);
  process.exit(1);
}
pruneHostPrebuilds(ptyPrebuilds);
if (!existsSync(ptyPrebuilds) || !hasNodeBinary(ptyPrebuilds)) {
  console.error(`node-pty prebuilds missing after host prune (${ptyPrebuilds}). Refusing to package daemon-dist.`);
  process.exit(1);
}
console.log(`node-pty bundled: ${ptyDest}`);

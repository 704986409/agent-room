// Bundle tools/wake-agent into one ESM file the shell runs with system Node.
// node-pty stays external: the daemon does createRequire(import.meta.url), so the
// prebuilt package must sit in daemon-dist/node_modules next to the .mjs.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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
console.log(`node-pty bundled: ${ptyDest}`);

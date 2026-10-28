// Bundle tools/wake-agent into one ESM file the shell runs with system Node.
// node-pty stays external: the daemon does createRequire(import.meta.url), so the
// prebuilt package must sit in daemon-dist/node_modules next to the .mjs.
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, readFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import https from 'node:https';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'daemon-dist');
const ptyName = '@homebridge/node-pty-prebuilt-multiarch';
const DEFAULT_NODE_DIST = '22.23.4';
mkdirSync(out, { recursive: true });

function findPtyPackage() {
  const candidates = [
    join(root, 'tools/wake-agent/node_modules', ptyName),
    join(root, 'node_modules', ptyName),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'prebuilds'))) return dir;
  }
  // Windows may ship without prebuilds/ until install; package.json is enough to start.
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

function hasNodeBinary(dir) {
  if (!existsSync(dir)) return false;
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

function hostNativeOk(ptyPackageDir) {
  const pre = join(ptyPackageDir, 'prebuilds', hostPrebuildDir());
  if (hasNodeBinary(pre)) return true;
  // Windows (and fallback): node-gyp / prebuild-install layout
  if (existsSync(join(ptyPackageDir, 'build', 'Release', 'pty.node'))) return true;
  return false;
}

function bundledNodeAbi() {
  const version = process.env.NODE_DIST_VERSION || DEFAULT_NODE_DIST;
  const cached = join(here, '..', '.cache', 'node-runtime', `v${version}`, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeBin = existsSync(cached) ? cached : process.execPath;
  try {
    const out = execFileSync(nodeBin, ['-e', 'process.stdout.write(process.versions.modules)'], { encoding: 'utf8' });
    return { version, abi: out.trim(), nodeBin };
  } catch {
    // Node 22 → 127 is the known mapping for our pinned runtime.
    return { version, abi: '127', nodeBin };
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error(`too many redirects for ${u}`));
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${u} → ${res.statusCode}`));
        }
        const file = createWriteStream(dest);
        pipeline(res, file).then(resolve).catch(reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true });
  // Prefer system tar (Windows GitHub runners + Linux both have it).
  const r = spawnSync('tar', ['-xzf', archive, '-C', destDir], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`tar extract failed: ${r.stderr || r.stdout || r.status}`);
  }
}

/**
 * npm tarball only embeds linux prebuilds. On Windows/macOS, fetch the
 * GitHub release asset for the *bundled* Node ABI (not the packager's Node).
 */
async function ensureHostNative(ptyPackageDir) {
  if (hostNativeOk(ptyPackageDir)) return;
  if (process.platform === 'linux') {
    // Linux abis ship inside the npm package; missing host dir is fatal.
    return;
  }
  const pkg = JSON.parse(readFileSync(join(ptyPackageDir, 'package.json'), 'utf8'));
  const ver = pkg.version;
  const { abi } = bundledNodeAbi();
  const asset = `node-pty-prebuilt-multiarch-v${ver}-node-v${abi}-${process.platform}-${process.arch}.tar.gz`;
  const url = `https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${ver}/${asset}`;
  const tmp = join(tmpdir(), asset);
  console.log(`fetching host node-pty prebuild: ${asset}`);
  await downloadFile(url, tmp);
  extractTarGz(tmp, ptyPackageDir);
  try { unlinkSync(tmp); } catch { /* ignore */ }
  if (!hostNativeOk(ptyPackageDir)) {
    throw new Error(`host node-pty still missing after fetching ${asset}`);
  }
  console.log(`host node-pty ready (${hostPrebuildDir()} or build/Release)`);
}

/**
 * Keep only the pack-host glibc (non-musl) prebuild tree so linuxdeploy does
 * not scan arm/musl binaries and demand libc.musl-*.so.1.
 * On Windows/macOS, drop linux prebuild dirs; native bits live in build/Release.
 */
function pruneHostPrebuilds(prebuildsRoot) {
  if (!existsSync(prebuildsRoot)) return [];
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
    ? readdirSync(prebuildsRoot).filter((n) => {
        try { return statSync(join(prebuildsRoot, n)).isDirectory(); } catch { return false; }
      })
    : [];
  console.log(`node-pty prebuilds kept: ${remaining.length ? remaining.join(', ') : '(none)'}`);
  return remaining;
}

const ptySrc = findPtyPackage();
if (!ptySrc) {
  console.error(`missing ${ptyName} (looked in tools/wake-agent/node_modules then node_modules). Install wake-agent deps.`);
  process.exit(1);
}

await build_esbuild();

async function build_esbuild() {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(root, 'tools/wake-agent/src/index.ts')],
    outfile: join(out, 'agent-room-daemon.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    external: [ptyName, 'node-pty'],
    nodePaths: [join(root, 'node_modules')],
    logLevel: 'info',
  });
}

const html = join(root, 'tools/wake-agent/src/settings.html');
if (existsSync(html)) cpSync(html, join(out, 'settings.html'));
const vendorOut = join(out, 'vendor');
mkdirSync(vendorOut, { recursive: true });
const vendorAssets = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'xterm-addon-fit.js'],
];
for (const [rel, name] of vendorAssets) {
  const src = join(root, rel);
  if (!existsSync(src)) {
    console.error(`missing xterm asset ${src}`);
    process.exit(1);
  }
  cpSync(src, join(vendorOut, name));
}
const winCred = join(root, 'tools/wake-agent/scripts/win-cred.ps1');
if (existsSync(winCred)) cpSync(winCred, join(out, 'win-cred.ps1'));
const seatLaunch = join(root, 'tools/wake-agent/src/seat-launch.mjs');
if (existsSync(seatLaunch)) cpSync(seatLaunch, join(out, 'seat-launch.mjs'));

const ptyDest = join(out, 'node_modules', ptyName);
rmSync(ptyDest, { recursive: true, force: true });
mkdirSync(dirname(ptyDest), { recursive: true });
cpSync(ptySrc, ptyDest, { recursive: true, dereference: true });
const ptyPkg = join(ptyDest, 'package.json');
if (!existsSync(ptyPkg)) {
  console.error(`node-pty package.json missing after copy (${ptyPkg}). Refusing to package daemon-dist.`);
  process.exit(1);
}

try {
  await ensureHostNative(ptyDest);
} catch (e) {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
}

const ptyPrebuilds = join(ptyDest, 'prebuilds');
if (existsSync(ptyPrebuilds)) pruneHostPrebuilds(ptyPrebuilds);

if (!hostNativeOk(ptyDest)) {
  console.error(`node-pty host native missing after prune (${ptyDest}). Refusing to package daemon-dist.`);
  process.exit(1);
}
console.log(`node-pty bundled: ${ptyDest}`);

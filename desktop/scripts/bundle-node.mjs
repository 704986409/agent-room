// Download a portable Node.js LTS and stage it for Tauri resources.
// Archives land in desktop/.cache/node-runtime/ (gitignored). The staged
// tree is desktop/node-runtime/ (gitignored) and is mapped to resources/node/.
//
//   node scripts/bundle-node.mjs --platform win|linux
//   NODE_DIST_VERSION=22.23.4 node scripts/bundle-node.mjs
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const cacheDir = join(desktop, '.cache', 'node-runtime');
const outDir = join(desktop, 'node-runtime');
const DEFAULT_VERSION = '22.23.4';

function parsePlatform(argv) {
  let platform = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') {
      platform = argv[++i];
      if (!platform) throw new Error('--platform requires win or linux');
    } else if (arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!platform) {
    if (process.platform === 'win32') platform = 'win';
    else if (process.platform === 'linux') platform = 'linux';
    else throw new Error(`pass --platform win|linux (host is ${process.platform})`);
  }
  if (platform !== 'win' && platform !== 'linux') {
    throw new Error(`--platform must be win or linux, got ${platform}`);
  }
  return platform;
}

function versionFromEnv() {
  const version = process.env.NODE_DIST_VERSION || DEFAULT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`NODE_DIST_VERSION must look like 22.23.4, got ${version}`);
  }
  return version;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function expectedSha256(sumsText, fileName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1];
  }
  return null;
}

async function downloadTo(url, dest) {
  const tmp = `${dest}.partial`;
  rmSync(tmp, { force: true });
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`download ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  return !result.error && result.status === 0;
}

function extractArchive(archivePath, dest) {
  const reset = () => {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
  };
  reset();
  if (archivePath.endsWith('.zip')) {
    // Windows CI ships bsdtar, which extracts zip. GNU tar does not.
    if (process.platform === 'win32' && run('tar', ['-xf', archivePath, '-C', dest])) return;
    reset();
    if (run('unzip', ['-q', archivePath, '-d', dest])) return;
    reset();
    const code = 'import zipfile, sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])';
    if (run('python3', ['-c', code, archivePath, dest])) return;
    throw new Error(`failed to extract ${archivePath} (need tar on Windows, or unzip/python3)`);
  }
  if (run('tar', ['-xf', archivePath, '-C', dest])) return;
  throw new Error(`failed to extract ${archivePath} (need tar, and xz-utils for .tar.xz)`);
}

function stageRuntime(extractedRoot, platform) {
  const entries = readdirSync(extractedRoot, { withFileTypes: true }).filter((ent) => ent.isDirectory());
  const top = entries.length === 1 ? join(extractedRoot, entries[0].name) : extractedRoot;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const license = join(top, 'LICENSE');
  if (existsSync(license)) copyFileSync(license, join(outDir, 'LICENSE'));

  if (platform === 'win') {
    const exe = join(top, 'node.exe');
    if (!existsSync(exe)) throw new Error(`node.exe not found in ${top}`);
    copyFileSync(exe, join(outDir, 'node.exe'));
    for (const name of readdirSync(top)) {
      if (name.toLowerCase().endsWith('.dll')) {
        copyFileSync(join(top, name), join(outDir, name));
      }
    }
    return;
  }

  const bin = join(top, 'bin', 'node');
  if (!existsSync(bin)) throw new Error(`bin/node not found in ${top}`);
  const dest = join(outDir, 'node');
  copyFileSync(bin, dest);
  chmodSync(dest, 0o755);
}

const platform = parsePlatform(process.argv.slice(2));
const version = versionFromEnv();
const archiveName = platform === 'win'
  ? `node-v${version}-win-x64.zip`
  : `node-v${version}-linux-x64.tar.xz`;
const base = `https://nodejs.org/dist/v${version}`;
const archivePath = join(cacheDir, archiveName);
const sumsPath = join(cacheDir, `SHASUMS256-${version}.txt`);

mkdirSync(cacheDir, { recursive: true });
if (!existsSync(sumsPath)) {
  await downloadTo(`${base}/SHASUMS256.txt`, sumsPath);
}
const expected = expectedSha256(readFileSync(sumsPath, 'utf8'), archiveName);
if (!expected) {
  throw new Error(`SHASUMS256.txt has no entry for ${archiveName}`);
}

let cachedOk = false;
if (existsSync(archivePath)) {
  const got = await sha256File(archivePath);
  cachedOk = got === expected;
  if (!cachedOk) {
    console.log(`cached ${archiveName} checksum mismatch; re-downloading`);
    rmSync(archivePath, { force: true });
  }
}
if (!cachedOk) {
  await downloadTo(`${base}/${archiveName}`, archivePath);
  const got = await sha256File(archivePath);
  if (got !== expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`checksum mismatch for ${archiveName}: got ${got}, expected ${expected}`);
  }
} else {
  console.log(`using cached ${archivePath}`);
}

const extractDir = join(cacheDir, 'extract', `${platform}-${version}`);
extractArchive(archivePath, extractDir);
stageRuntime(extractDir, platform);
console.log(`staged Node ${version} (${platform}-x64) in ${outDir}`);
console.log(readdirSync(outDir).join('\n'));

// Package scripts call this after bundle-mcp. Deleting mcp-runtime must fail the build.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(desktop, 'mcp-runtime', 'dist', 'index.js');
const pkg = join(desktop, 'mcp-runtime', 'package.json');
if (!existsSync(entry) || !existsSync(pkg)) {
  console.error(`mcp-runtime missing or incomplete (${entry}). Run: node scripts/bundle-mcp.mjs`);
  process.exit(1);
}
console.log(`mcp-runtime ok: ${entry}`);

const ptyPkg = join(desktop, 'daemon-dist/node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json');
const ptyPrebuilds = join(desktop, 'daemon-dist/node_modules/@homebridge/node-pty-prebuilt-multiarch/prebuilds');
if (!existsSync(ptyPkg) || !existsSync(ptyPrebuilds)) {
  console.error(`node-pty prebuilds missing (${ptyPkg}). Run: node scripts/bundle-daemon.mjs`);
  process.exit(1);
}

// bundle-daemon prunes to host glibc only; musl leftovers break linuxdeploy AppImage.
function listMusl(dir) {
  const hits = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...listMusl(path));
    else if (name.includes('musl')) hits.push(path);
  }
  return hits;
}
const musl = listMusl(ptyPrebuilds);
if (musl.length) {
  console.error(`node-pty musl prebuilds still present (re-run bundle-daemon.mjs): ${musl[0]}`);
  process.exit(1);
}
const kept = readdirSync(ptyPrebuilds).filter((n) => statSync(join(ptyPrebuilds, n)).isDirectory());
console.log(`node-pty ok: ${ptyPkg} (prebuilds: ${kept.join(', ') || '(none)'})`);

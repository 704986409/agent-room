// Package scripts call this after bundle-mcp. Deleting mcp-runtime must fail the build.
import { existsSync } from 'node:fs';
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

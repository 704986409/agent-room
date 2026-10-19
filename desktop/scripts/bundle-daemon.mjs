// Bundle tools/wake-agent into one ESM file the shell runs with system Node.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'daemon-dist');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'tools/wake-agent/src/index.ts')],
  outfile: join(out, 'agent-room-daemon.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
const html = join(root, 'tools/wake-agent/src/settings.html');
if (existsSync(html)) cpSync(html, join(out, 'settings.html'));

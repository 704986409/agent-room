// Portable tarball: release binary + bundled daemon + run script.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'agent-room-desktop-0.1.0-linux-x86_64';
const stage = join(here, 'dist-pkg', name);
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
cpSync(join(here, 'src-tauri/target/release/agent-room-desktop'), join(stage, 'agent-room-desktop'));
cpSync(join(here, 'daemon-dist'), join(stage, 'daemon'), { recursive: true });
const nodeRuntime = join(here, 'node-runtime');
if (!existsSync(nodeRuntime)) {
  throw new Error('node-runtime/ missing; run node scripts/bundle-node.mjs --platform linux first');
}
cpSync(nodeRuntime, join(stage, 'node'), { recursive: true });
const stagedNode = join(stage, 'node', 'node');
if (existsSync(stagedNode)) chmodSync(stagedNode, 0o755);
writeFileSync(join(stage, 'run.sh'), `#!/bin/sh\n# Bundled Node is ./node/node. Needs webkit2gtk-4.1 and libayatana-appindicator3.\n# AGENT_ROOM_SERVER=http://127.0.0.1:3300 ./run.sh   (default: ~/.config/agent-room/desktop.json or production)\nhere=$(dirname "$(readlink -f "$0")")\nexec "$here/agent-room-desktop" "$@"\n`);
chmodSync(join(stage, 'run.sh'), 0o755);
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: join(here, 'dist-pkg') });
console.log(join(here, 'dist-pkg', `${name}.tar.gz`));

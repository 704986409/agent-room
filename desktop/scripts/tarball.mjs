// Portable tarball: release binary + bundled daemon + run script.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'agent-room-desktop-0.1.0-linux-x86_64';
const stage = join(here, 'dist-pkg', name);
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
cpSync(join(here, 'src-tauri/target/release/agent-room-desktop'), join(stage, 'agent-room-desktop'));
cpSync(join(here, 'daemon-dist'), join(stage, 'daemon'), { recursive: true });
writeFileSync(join(stage, 'run.sh'), `#!/bin/sh\n# Needs: Node.js >= 20 on PATH, webkit2gtk-4.1, libayatana-appindicator3.\n# AGENT_ROOM_SERVER=http://127.0.0.1:3300 ./run.sh   (default: ~/.config/agent-room/desktop.json or production)\nhere=$(dirname "$(readlink -f "$0")")\nexec "$here/agent-room-desktop" "$@"\n`);
chmodSync(join(stage, 'run.sh'), 0o755);
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: join(here, 'dist-pkg') });
console.log(join(here, 'dist-pkg', `${name}.tar.gz`));

# Desktop Agent-Room-0.1.26-v5

Pack label for test issues 1–6 fixes on branch `dev-grok-0.1.26` (tip includes `ff87406` and earlier packs).

## Naming choice
- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v5` → `Agent-Room-0.1.26-v5_*` so successive fix packs on the same semver stay distinguishable.

## Included in this pack (vs v4)
1. **HostLocal window cache / near-zero wait:** besides daemon detect cache, the webview keeps a process/window adapter list cache and prefetches when the host room mounts; opening the dialog with a warm cache skips the “正在读取已安装的 CLI…” loading flash.
2. **Wake after `room_sleep`:** if the managed seat has no `wakeRunId`, resume grace is skipped so an `@` wakes immediately; Windows stop uses `taskkill /T /F`.
3. **Right-rail terminal:** removed the unused「断开」button (connect / stop / pop-out / expand remain).
4. **Cursor HostLocal:** `seat-launch` expands `%SystemRoot%` (and similar) before dropping `%` tokens, so PowerShell-based `agent.cmd` no longer tries to `spawn -NoProfile` (ENOENT).
5. **Auth-only login precheck:** for installed supported CLIs (Codex / Cursor / Antigravity / Claude), probe login without starting a chat; unsigned-in → Host disabled +「请先登录」CTA and hint; API returns `cli_not_logged_in` instead of a vague `launcher_unavailable`.
6. **Failed host rollback:** if join/register/launch fails after a cloud join, daemon unregister + room leave so the room does not keep a ghost seat or a premature Hi from a half-hosted agent.

## Not in this pack
- No Tauri semver bump; same-semver pack rebuild.
- Deferred cloud seat visibility (join still happens before local launch; failures roll back). Cold-start HostLocal may still briefly wait if caches are empty.

## Install
- Prefer Windows **NSIS** `Agent-Room-0.1.26-v5_x64-setup.exe` (has force-kill upgrade hooks).
- Linux: AppImage or deb with the same pack prefix.
- Quit Agent Room completely (tray → 退出) before upgrading; re-pair only if the device binding is lost.

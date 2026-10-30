# Desktop Agent-Room-0.1.26-v7

Same app semver **0.1.26**; pack/tag label **Agent-Room-0.1.26-v7** / `desktop-v0.1.26-v7`.

## Naming

- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v7` → `Agent-Room-0.1.26-v7_*` so successive fix packs on the same semver stay distinguishable.

## What’s in this pack (vs v6)

1. **Wake after `@` (cloud):** `CREATE_EVENT` uses Redis `TTL` instead of ACL-denied `PTTL`, so pending wake events are created and the daemon can claim them (`361665a`). Poll seat isolation from `c68d9d7` kept.
2. **Pop-out not black:** Windows pop-out uses `External` URL + deferred create off the IPC stack (`c68d9d7` / `d64202c` / hotpopout2 Rust) so WebView2 actually paints (same URL works in a browser).
3. **HostLocal Codex on Windows:** unwrap `WindowsApps\codex.cmd` to real `codex.exe` / node entry so multi-line prompts are not rejected as `launcher_unavailable` (`69fb0f5`).
4. **Right-rail after wake:** reconnect docked terminal when resume swaps PTY / WS dies; keep preferred seat across the gap (`6cfe624`).
5. **Pop-out OSC junk:** strip OSC 10/11/12 color reports in pop-out path (shared filter + settings.html + scrollback) so `]10;rgb:…` does not land in the CLI prompt (`6cfe624`).
6. **Pop-out does not interrupt listen:** skip no-op PTY resize when cols/rows unchanged; avoids `room_listen` / Conversation interrupted on pop-out (`6cfe624`).

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.26-v7_x64-setup.exe` (has force-kill upgrade hooks).
- Quit Agent Room completely (tray → 退出) before upgrading.
- Hard-refresh / reopen the room page after install so the deployed web rail/OSC fixes load (VPS tip includes `6cfe624`).

## Branch

- Built from `dev-grok-0.1.26` tip (includes `361665a` … `6cfe624`; not merged to `dev-grok` / `main`).

# Desktop Agent-Room-0.1.26-v8

Same app semver **0.1.26**; pack/tag label **Agent-Room-0.1.26-v8** / `desktop-v0.1.26-v8`.

## Naming

- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v8` → `Agent-Room-0.1.26-v8_*` so successive fix packs on the same semver stay distinguishable.

## What’s in this pack (vs v7)

1. **Managed Quiet → sleep:** after one Quiet round, MCP returns `listenStatus=sleep` and tool/server copy tell the seat to call `room_sleep` once and stop re-listening (`83719c6`). Cloud tip must include this; installer also ships the forked MCP used for HostLocal.
2. **Daemon crash harden:** catch wake progress / lock / persist rejections; seat run-loop guards; process-level `unhandledRejection` / `uncaughtException` safety net so a timed-out fetch no longer kills the whole Node daemon (`16dcef5`).
3. **Network offline frosted overlay (web):** full-page gray frosted-glass overlay when offline; shows instantly on browser `offline` or failed app fetch; clears after a successful health probe when the network returns (`20a4da0` / `7541c8b` / `2fb3cdf` / `1501cbd`). Overlay is served from the web app — hard-refresh after install if the desktop shell still has an old page cached.

Also includes all v7 pack fixes (wake TTL, pop-out External, Codex WindowsApps unwrap, rail/OSC/no-op resize).

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.26-v8_x64-setup.exe` (has force-kill upgrade hooks).
- Quit Agent Room completely (tray → 退出) before upgrading.
- After install: reopen desktop; hard-refresh the room page so Quiet→sleep MCP + offline overlay load from the deployed web tip.

## Branch

- Built from `dev-grok-0.1.26` tip (includes `83719c6` … `1501cbd` + this notes commit; **not** merged to `dev-grok` / `main`).

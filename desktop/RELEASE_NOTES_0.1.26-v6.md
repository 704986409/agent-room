# Desktop Agent-Room-0.1.26-v6

Same app semver **0.1.26**; pack/tag label **Agent-Room-0.1.26-v6** / `desktop-v0.1.26-v6`.

## Naming

- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v6` → `Agent-Room-0.1.26-v6_*` so successive fix packs on the same semver stay distinguishable.

## What’s in this pack (vs v5) — retest issues 1–4

1. **Codex OSC junk in prompt (best-effort):** docked xterm no longer forwards OSC 10/11/12 color reports into PTY stdin (the usual source of `]10;rgb:…` in the Codex input box). Deep ConPTY edge cases may still exist.
2. **Codex MCP tool approve:** managed startup `-c` now covers MCP server keys `agent-room`, `airoom-e2e`, and `airoom` (approval + paired URL override). Still no `--yolo` / `--force`.
3. **Close clears seat + keeps daemon alive:** PTY `resize`/`write` after kill is a no-op (try/catch + immediate dead flag); terminal WS handler cannot crash the process. Frontend disconnects the socket **before** stop so ResizeObserver cannot race. `stopManagedSeat` can finish `room_leave` / unregister; right-rail clears after 「关闭」.
4. **Same chain as #3:** HostLocal `Failed to fetch` after close was the daemon dying on late resize — fixed by #3.

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.26-v6_x64-setup.exe` (has force-kill upgrade hooks).
- Quit Agent Room completely (tray → 退出) before upgrading.
- Hard-refresh / reopen the room page after install so the deployed web OSC + close-order fixes load.

## Branch

- Built from `dev-grok-0.1.26` (not merged to `dev-grok` / `main`).

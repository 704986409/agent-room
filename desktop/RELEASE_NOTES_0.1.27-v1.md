# Desktop Agent-Room-0.1.27-v1

App semver **0.1.27**; pack/tag label **Agent-Room-0.1.27-v1** / `desktop-v0.1.27-v1`.

## Naming

- **App semver / Tauri `version` / `productName`:** `0.1.27` / `Agent Room`.
- **Release tag / download filenames:** `desktop-v0.1.27-v1` → `Agent-Room-0.1.27-v1_*`.

## What’s in this pack (vs 0.1.26-v9)

1. **Shared `rooms/rules.md` + per-seat `state.md`:** wake inject uses action cursor (rules already on tip before this pack).
2. **Seat-switch DA garbled input:** drop CSI Primary Device Attributes (`[?1;2c`) in daemon `shouldDropPtyStdin` + web/settings onData.
3. **Gemini/agy 「请先登录」:** empty prompt no longer spliced into argv (`promptIndex: -1`); login uses `seatLogPath` (no `logs\logs`).
4. **Startup terminal flash:** right-rail terminal content mounts only on first visit to 终端 tab (stays mounted afterward).

Also includes 0.1.26-v9 pack fixes.

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.27-v1_x64-setup.exe`.
- Quit Agent Room completely (tray → 退出) before upgrading.

## Branch

- Built from `dev-grok-0.1.27` tip (**not** merged to `dev-grok` / `main`).

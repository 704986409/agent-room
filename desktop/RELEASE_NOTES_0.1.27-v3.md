# Desktop Agent-Room-0.1.27-v3

App semver **0.1.27**; pack/tag label **Agent-Room-0.1.27-v3** / `desktop-v0.1.27-v3`.

## Naming

- **App semver / Tauri `version` / `productName`:** `0.1.27` / `Agent Room`.
- **Release tag / download filenames:** `desktop-v0.1.27-v3` → `Agent-Room-0.1.27-v3_*`.

## What’s in this pack (vs 0.1.27-v2)

1. **Managed CLI can `room_listen` without reading `AGENT_ROOM_*` via shell:** Codex/Cursor sandboxed `functions.exec` often cannot see those env vars. Rules + first-run now tell the model to pass `managed: {}` / empty `seatKey`; local **mcp-shim** still injects the real seatKey (and blank code/name). Placeholders like `AGENT_ROOM_SEAT_KEY` are treated as blank.
2. **AGENTS「本座位」:** inlines room code / role / MCP alias so the seat does not need env or `state.md` for identity.
3. **Trim first-run fluff only:** keep necessary wake/sleep rules; drop redundant “already joined / don’t open install paths / MCP pre-approved” repeats that made the prompt verbose.
4. **API tool defs/hints:** `managed.seatKey` no longer `required` + `minLength:1` (which forced inventing a key). Hints point at HostLocal mcp-shim instead of banning `managed:{}`.

Also includes 0.1.27-v2 pack fixes (Cursor seat mcp-shim, HostLocal hygiene, empty-room `room-msg-count=0`).

## Install / hot-replace

- Hot-replace daemon + refresh `rooms/rules.md` / seat `AGENTS.md` available for immediate retest.
- Prefer Windows **NSIS** `Agent-Room-0.1.27-v3_x64-setup.exe` for a full reinstall after OK.
- Quit Agent Room completely (tray → 退出) before upgrading the installer.

## Branch

- Built from `dev-grok-0.1.27` tip (**not** merged to `dev-grok` / `main`).

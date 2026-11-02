# Desktop Agent-Room-0.1.27-v2

App semver **0.1.27**; pack/tag label **Agent-Room-0.1.27-v2** / `desktop-v0.1.27-v2`.

## Naming

- **App semver / Tauri `version` / `productName`:** `0.1.27` / `Agent Room`.
- **Release tag / download filenames:** `desktop-v0.1.27-v2` → `Agent-Room-0.1.27-v2_*`.

## What’s in this pack (vs 0.1.27-v1)

1. **Cursor HostLocal MCP → local mcp-shim:** write seatDir `.cursor/mcp.json` (HTTP + Bearer `${env:AGENT_ROOM_SEAT_KEY}`) so project config overrides `~/.cursor/mcp.json` pointing at www.agent-room.com. Codex keeps `-c` approve + loopback URL; shared `resolveMcpShimUrl`.
2. **Rules / first-run hygiene:** forbid printenv / shell / state.md probes; start with `room_listen`; forbid proactive「已上线」/join greetings.
3. **room_join greeting skip:** HostLocal (`machineId` present) no longer posts English “Hi all — … listening.”
4. **UI:** remove right-rail「连接」; disable HostLocal role/CLI/model/profile/login while「正在本机启动…」.

MCP pre-approve stays `--approve-mcps` (no YOLO). @ wake path unchanged.

Also includes 0.1.27-v1 pack fixes.

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.27-v2_x64-setup.exe`.
- Quit Agent Room completely (tray → 退出) before upgrading.
- Hot-replace **skipped** — full reinstall for this pack.

## Branch

- Built from `dev-grok-0.1.27` tip (**not** merged to `dev-grok` / `main`).

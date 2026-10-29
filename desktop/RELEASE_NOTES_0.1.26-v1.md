# Desktop Agent-Room-0.1.26-v1

Pack label for the first fix round on branch `dev-grok-0.1.26` (tip includes `828e5b3` and earlier fix commits).

## Naming choice
- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with the previous 0.1.26 install).
- **Release tag / download filenames:** `desktop-v0.1.26-v1` → `Agent-Room-0.1.26-v1_*` so successive fix packs on the same semver are distinguishable (`-v2`, `-v3`, …).

## Included fixes (vs installed 0.1.26)
1. Cursor / Codex listen+wake on Windows ConPTY (managed MCP argv / `--approve-mcps` preserved via UTF-8 prompt-file launcher).
2. Listen WAITING_ACK no longer force-kills a live `room_listen` (prior `12508f8`).
3. Close rail + `room_leave` hardened (prior leave fix + selection/`closedByUserRef` gap).
4. Windows pop-out black screen: shared WebView2 Environment (Plan A).
5. Tray quit: no deferred cmd/`ping` flash.
6. HostLocal: spinner + disable while hosting.
7. CLI install: live pop-out terminal with streamed logs; success only after version probe.
8. Extra structured logs on API wake/listen/leave and local daemon (debug for residual issues).

## Not in this pack
- Room vanish after repeated close/rejoin (parked).
- Invite / `room_join`+seatKey discussion (deferred).
- Web-only close/leave bits still need **server deploy** of this branch tip for full effect; desktop-only install covers daemon/shell pieces.

## Install
- Prefer Windows **NSIS** `Agent-Room-0.1.26-v1_x64-setup.exe` (has force-kill upgrade hooks).
- Linux: AppImage or deb with the same pack prefix.
- Quit Agent Room before upgrading; re-pair only if the device binding is lost.

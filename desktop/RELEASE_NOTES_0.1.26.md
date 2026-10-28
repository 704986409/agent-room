# Desktop 0.1.26

## Fixes
- **Pop-out WebView2 / black screen:** boot from a `data:` URL and give each seat its own WebView profile (no shared-profile races).
- **Room `@` Cursor never wakes:** past wake grace, stop+resume so the prompt actually reaches the CLI when inFlight never ACKs.
- **「关闭」left rail + seat:** clear the right-rail tab immediately and `room_leave` / kick the hosted seat.
- **Tray 退出 cmd flash:** Windows deferred self-kill uses silent `ping` delay (no `timeout` console flash).
- **HostLocal models:** daemon async-refreshes live CLI model lists into a process cache (cleared on exit).
- **NSIS upgrade lock:** preinstall + preuninstall force-kill `Agent Room.exe` and any process whose path/CommandLine is under the install dir or runs `agent-room-daemon` (releases `conpty.node` / `conpty.dll` / bundled `OpenConsole.exe`).

## Retest
1. Install from `desktop-v0.1.26` (Windows preferred for items below).
2. Host Cursor → room `@` after first turn → seat should re-resume and answer.
3. 「关闭」→ rail tab gone; member list loses the seat.
4. Tray → 退出 → no cmd flash; icons clear.
5. HostLocal model dropdown shows live CLI models after a short warm-up.
6. Upgrade over a running 0.1.25 with a hosted seat open → installer should not fail on locked `conpty.node`.
7. Pop-out terminal paints (not pure black) and X returns to the docked rail.

## Residual
- WebView2 pop-out still needs Windows QA (Linux WebKit pass only proves no data:-URL fallback).
- MSI path does not run these NSIS hooks — prefer the NSIS `.exe` for upgrades while Agent Room is running.

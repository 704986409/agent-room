# Desktop 0.1.25

## Fixes
- **Expand → 任务 wide rail:** switching the right rail from 终端 to 任务 clears `terminalExpanded`, so the grid returns to the normal 340px task column.
- **Tray 退出 zombie icons:** quit removes the tray icon, stops the daemon/seat process tree immediately, hides windows (no blocking `destroy`), calls `app.exit(0)`, then a 2s in-process `process::exit` watchdog; on Windows a detached `taskkill /F /T` of this pid runs after 3s if still alive.

## Retest
1. Install from `desktop-v0.1.25`.
2. Docked terminal → 展开 → click 任务 → rail should shrink to normal task width.
3. Tray → 退出 → tray and taskbar Agent Room icons should disappear within a few seconds; Task Manager should show no Agent Room / leftover seat CLI.

# Desktop 0.1.24

## Fixes
- **Pop-out black screen (Windows WebView2):** all `terminal-*` windows share the `local-control` WebView profile with settings (no per-seat cold-start Environment). Pop-out paints `#term-boot` via `html.popout` / early `body.popout` before deferred `/vendor/xterm*.js`.
- **Pop-out X stuck:** `CloseRequested` on `terminal-*` calls `force_close_terminal` and destroys the event window handle synchronously (hide + main-thread retry as backup), then docks the seat back into the room page.

## Retest
1. Install Windows NSIS/MSI from the `desktop-v0.1.24` release (or Linux AppImage).
2. Host a seat → **弹出** → expect dark terminal chrome with “正在连接终端…” then PTY text (not a solid empty black frame).
3. Click window **X** → window closes and the seat docks back in the right rail.

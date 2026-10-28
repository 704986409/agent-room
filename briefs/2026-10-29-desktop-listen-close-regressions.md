# Desktop 0.1.26 regressions — listen removed + close rail/kick (2026-10-29 Asia/Shanghai)

Branch: `feat/desktop-v1-integration` · **no** version bump / package / tag / push.

User confirmed on Windows 0.1.26: (1) after wake/@, 「监听直接被移除」; (2) 「关闭」still leaves right-rail tab + room seat. Screenshot of (2): attachment `01M62D2G374N8GT8TF319WRMND.png` (also `/tmp/01M62D2G374N8GT8TF319WRMND.png`). Mojibake dialog noted separately (not fixed this turn).

## Commits (this turn)

| SHA | Summary |
|-----|---------|
| `12508f8` | wake: inFlight-only must not kill live listen |
| `ba387f8` | close: clear preferredSeatId ghost + harden room_leave + brief |

## Problem 1 — listen removed immediately after @

**Root cause:** `478cfe1` treated **WAITING_ACK / inFlight age** as the grace timer by synthesizing `pending` from `inFlight` when pending was empty. After ~`resumeGraceMs` (8s), a healthy `room_listen` that had claimed but not yet finished ACK was force-stopped and resumed → 「监听直接被移除」.

**Fix:** Grace applies only to **real pending** (new @). `inFlight` alone → renew + continue (do not stop). Pending within grace → merge. Pending past grace under live inFlight → fail stale claims + stop+resume (keeps the intentional Cursor mid-turn recovery).

**Files:** `tools/wake-agent/src/daemon.ts`, `daemon.test.ts`  
**Ships in:** desktop **daemon** package (next build). Already on branch for local daemon runs.  
**Verify:** `npx vitest run tools/wake-agent/daemon.test.ts` — *keeps a healthy live listen…* and *re-resumes after grace when pending @ never acks…*. Windows: @ a listening Cursor seat; listen must stay; only a new @ that never acks past grace should stop+resume.

## Problem 2 — 「关闭」leaves rail tab + room seat

**Root causes (layered):**

1. **UI ghost tab:** `ff15f3e` cleared rows/`seatId` on stop, but Room still held `hostedSeatId` as `preferredSeatId`. Effect re-set `seatId` and the preferred stub recreated a rail tab. Fix: `closedByUserRef` blocks stub after close; `onStopped` clears `hostedSeatId` + `refreshRoom()`.
2. **Kick path:** daemon `stopManagedSeat` already unregister + `leaveRoomOverMcp` (in 0.1.26). Hardened: leave **requires** MCP `initialize` (was `.catch`’d away); `room_leave` passes explicit `targetClient: 'cc'` and skips empty name.
3. **Web vs daemon shipping:** Main window is `WebviewUrl::External(server_url())` → default `https://ai-room.pupgo.top`. Embedded `desktop/ui` is only a boot stub. **Room.tsx / DesktopSeatTerminal changes need production web deploy**; daemon/leave changes need a new desktop package (or local daemon). 0.1.26 daemon alone cannot fix the rail ghost if the server still serves the old web bundle.

**Files:** `DesktopSeatTerminal.tsx` (+test), `Room.tsx`, `mcpJoin.ts`, `machineId.test.ts`, `api/_mcpTools.ts`  
**Verify:** `npx vitest run apps/web/src/components/DesktopSeatTerminal.test.tsx tools/wake-agent/machineId.test.ts tools/wake-agent/terminalControl.test.ts`. After **web deploy** + daemon with this commit: 「关闭」→ rail tab gone, roster seat gone.

## Mojibake (noted, not fixed)

Small ~405×150 Windows dialog with garbled Chinese (`/tmp/mojibake.png`, attachment `01M62DBG1F6S2F5E4PWGBQQ9QV.png`). Rust `alert()` already uses `MessageBoxW` + `OsStr::encode_wide` (correct UTF-16). NSIS hooks are English-only. No obvious ANSI/MessageBoxA bug spotted while in desktop Rust/NSIS — likely needs clearer OCR of the garbled title/body (tray vs alert vs installer) in a follow-up.

## Residual risks

- **Web deploy required** for close rail UI; until then Windows 0.1.26 still shows ghost tab against production web.
- **New desktop package** required for daemon listen fix + leave initialize harden on end-user installs.
- Force-resume past grace on pending @ can still interrupt a mid-turn CLI (intentional tradeoff).
- `room_leave` / wake unregister remain best-effort; refresh may race before server presence updates.
- Mojibake unresolved.

## Not done

- No package / tag / push / version bump  
- No web production deploy  
- Mojibake not fixed  

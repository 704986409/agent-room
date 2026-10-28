# Desktop four bugfixes — result (2026-10-29 Asia/Shanghai)

Branch: `feat/desktop-v1-integration` · version still **0.1.25** (no bump / package / tag / push).

Pop-out black-screen left untouched.

## Commits (this turn)

| SHA | Summary |
|-----|---------|
| `478cfe1` | wake-cursor: re-resume after grace when inFlight never acks (+ stopManagedSeat unregister/leave) |
| `ff15f3e` | close-clear-kick: unregisterPty + UI clear + leaveRoom MCP + status modelsForAdapter wiring |
| `58fff9f` | tray-silent: ping delay + null stdio |
| `497b1ed` | models-live: modelsList cache + HostLocal via adapters.models + this brief |

HEAD: `497b1ed` · ahead of origin by 6 (prior 2 + these 4). Version still 0.1.25.

## 1) wake-cursor — room `@` never reached Cursor CLI

**Root cause:** With `status=running` + `wakeRunId` + `inFlight`, `WakeDaemon.tick()` always `merge()`’d and `continue`’d. Cursor mid-turn / not in `room_listen` never ACKed; renew kept WAITING_ACK forever; no second resume injected the wake prompt.

**Fix:** Within `resumeGraceMs` (default 8s) still merge. Past grace: `progress(resume_failed)` on stale in-flight, stop the live process, resume with wake prompt (pending ∪ former inFlight). Also handle inFlight-only seats (no longer `continue` when pending empty).

**Files:** `tools/wake-agent/src/daemon.ts`, `daemon.test.ts`  
**Verify:** `npx vitest run tools/wake-agent/daemon.test.ts` — cases *merges a running seat* (within grace) and *re-resumes after grace when inFlight never acks*. On Windows: `@` Cursor in room after first turn; seat log should show a new wake/`resume` prompt within ~grace+poll.

**Residual:** Grace is time-based, not “listen confirmed”. A slow ACK inside grace still merges (good); a hung mid-turn past grace force-resumes (may interrupt an active Cursor turn).

## 2) close-clear-kick — 「关闭」left rail tab + room seat

**Root cause:** `stopTerminal` killed PTY but registry clear waited on `onExit`; `stopManagedSeat` only marked idle/`stoppedByUser` (no wake unregister, no `room_leave`, seat stayed in state). UI kept `seatId` and stubbed a ghost tab when the PTY list no longer contained it.

**Fix:** Unregister PTY immediately after kill; `stopManagedSeat` unregister wake + MCP `room_leave` + delete seat credential + remove from `state.seats`; UI clears rows/`seatId` on stop and drops ghost stub unless `preferredSeatId` is still spinning up.

**Files:** `daemon.ts`, `http.ts`, `mcpJoin.ts`, `control.ts`, `DesktopSeatTerminal.tsx`, tests  
**Verify:** Host a seat → 「关闭」→ rail tab gone immediately; room member list loses the seat; wake poll no longer lists that seatId. `npx vitest run tools/wake-agent/terminalControl.test.ts tools/wake-agent/daemon.test.ts`

**Residual:** `room_leave` is best-effort (room already ended / network). Wake unregister failure leaves a remote binding until TTL/patrol.

## 3) tray-silent — tray quit flashed ~2s cmd

**Root cause:** Watchdog used `cmd /C timeout /T N`, which still flashes a console on some Windows builds despite `CREATE_NO_WINDOW`.

**Fix:** `ping 127.0.0.1 -n N+1 >nul` delay; `/d /c`; null stdin/stdout/stderr on the spawn. Unit test updated.

**Files:** `desktop/src-tauri/src/main.rs`  
**Verify:** `cargo test quit_watchdog_is_bounded` (Linux). On Windows install (no new package this turn): tray 退出 — no visible cmd window.

**Residual:** External taskkill is still a belt-and-suspenders path; in-process watchdog remains primary.

## 4) models-live — HostLocal hardcoded models

**Root cause:** Adapter allowlists were static in `adapter.ts`; `/api/status` (and thus HostLocal) never asked the CLIs.

**Fix:** Process-only cache (`modelsList.ts`): at daemon boot `refreshAdapterModels` runs async (`agent`/`cursor-agent --list-models`, `codex debug models`, `agy models`). `CliAdapter.setModels` / `modelsForAdapter` feed status + host. Cache cleared on SIGINT/SIGTERM. No disk persistence.

**Files:** `modelsList.ts`, `adapter.ts`, `control.ts`, `index.ts`, `modelsList.test.ts`  
**Verify:** Start daemon → open HostLocal → model dropdown matches live CLI lists (not only hardcoded fallbacks). `npx vitest run tools/wake-agent/modelsList.test.ts`

**Residual:** Until the async list finishes, UI may briefly show hardcoded fallbacks. List failures keep fallbacks. Codex prepends synthetic `default`.

## Not done (per hard rules)

- No Windows installer / AppImage / tag / push / 0.1.26 bump  
- PC swap deferred  
- No CloudAgent  

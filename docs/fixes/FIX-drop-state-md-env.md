# FIX: drop runtime state.md — seat fields via AGENT_ROOM_* only

**Commit:** `326de42` on `dev-grok-0.1.27`  
**Date:** 2026-11-02 (Asia/Shanghai)  
**Hot-replace:** `D:\Agent Room\daemon\agent-room-daemon.mjs` → bak-326de42  
**Pupgo:** deploy tip `326de42`

## Problem
Codex/hosted seats repeatedly `Get-Content`/`Read` per-seat `state.md` on every wake and around Quiet, even though seatKey / room code / role / MCP alias were already injected as `AGENT_ROOM_*` env at CLI launch. Extra shell reads slowed wake and confused the model.

## Change
1. **Stop writing** `state.md` from `ensureSeatFiles` / host path.
2. **Stop injecting** `AGENT_ROOM_STATE_FILE` into the hosted process env.
3. **Expand env** at launch: `AGENT_ROOM_SEAT_KEY`, `AGENT_ROOM_ROOM_CODE`, `AGENT_ROOM_ROLE`, `AGENT_ROOM_MCP_ALIAS`, `AGENT_ROOM_ADAPTER`, plus existing seat/cwd helpers.
4. **Rewrite shared `rooms/rules.md` + seat `AGENTS.md`/`GEMINI.md`**: prefer env; ban reading/writing `state.md`; do not instruct `Get-Content state.md`.
5. **Delete leftover** `state.md` under seat dirs on ensure/refresh.
6. Keep: seatDir cwd, mcp-shim seatKey inject, Quiet→sleep, listen hold, wake grace skip.

## Retest
1. Stop any old Codex seat (esc / close).
2. Host a **new** Codex seat on this PC.
3. Confirm seat folder has **no** `state.md` (or it was deleted on refresh).
4. Confirm first wake does **not** shell-read `state.md`; rules/AGENTS say use env.
5. Quiet → should `room_sleep` (seatKey still auto-injected).
6. After sleep, @ again → inject without 8–12s grace empty wait.
7. `room_listen` should hold ~30–40s, not spam with `timeoutMs: 0`.

## Package
Deferred until user OK after retest.

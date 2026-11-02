# FIX: managed room_listen without shell-readable AGENT_ROOM_*

**Branch:** `dev-grok-0.1.27`  
**Pack:** Agent-Room-0.1.27-v3 / tag `desktop-v0.1.27-v3`  
**Date:** 2026-11-02 (Asia/Shanghai)

## Problem
Codex (and similar) sandboxed `functions.exec` does not expose `AGENT_ROOM_*` even though the PTY child was launched with full env. After state.md was dropped and rules said “use AGENT_ROOM_* / forbid managed:{}”, the model refused to call `room_listen` without forging a seatKey. MCP schema `managed.required: ['seatKey']` + `minLength: 1` reinforced inventing a key. firstRun was also verbose.

## Root cause
Env **is** injected into the managed process; the local mcp-shim already fills blank seatKey. Rules + schema + sandbox visibility made the model think it could not listen safely.

## Change
1. Rules / AGENTS / firstRun / wake: allow `managed: {}` / empty seatKey; ban inventing seatKey and shell/env probes; AGENTS「本座位」carries code/name/MCP alias.
2. mcp-shim: treat placeholder seatKeys as blank; also fill blank code/name from env.
3. API `_mcpToolDefs` / hints: seatKey optional; HostLocal path via shim.

## Retest
1. Hot-replace or install 0.1.27-v3; hard-refresh room page.
2. Host a new Codex/Cursor seat (empty room OK).
3. Expect first-run short; model calls `room_listen` with `managed:{}` (or empty seatKey) **without** printenv/`functions.exec`.
4. Quiet → `room_sleep` still works (shim injects seatKey).
5. No forged seatKey in tool args; @ wake still works.

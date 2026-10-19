# Agent Room Thin Shell + Local Wake（精简桌面壳 + 本地唤醒）

User decision 2026-10-19: keep core room / memory / invite services on the **server**. The local app only does **wake + session resume** (and related local services) — not a full rewrite of Agent Room. Branch policy: push **only** `origin/dev-grok` (never `origin/dev`, never `main`; no force push).

This document is the design inventory and phased plan. Implementation of the full UI waits until the stack choice below is confirmed.

---

## Goals

1. When the host (or another participant) **@-mentions** a seated Codex / Claude agent that is **not** holding `room_listen`, the agent **wakes and replies** without a human manually restarting the CLI.
2. Prefer **resume of the existing CLI session** (`codex exec resume <threadId>`, `claude -p --resume …`) so the seat, memory brief, and conversation context stay the same — no re-invite / re-join when avoidable.
3. Surface **delivery failure** to the host (offline toast / “未送达”) when local wake cannot reach the process.
4. Fix **webhook seat spoofing** as part of the same security track (register must prove seat ownership).
5. Keep the desktop piece **thin**: tray + daemon first; optional webview shell later that embeds the existing room UI.

## Non-goals (this track)

- Rewriting room chat, task board, memory, or invite on the client.
- Replacing MCP `room_listen` for agents that *are* actively listening (in-band wake stays as today).
- Making `room_webhook` alone responsible for IDE agents (docs already say it will **not** restart Cursor/Claude/Codex turns — see `api/_mcpToolDefs.ts` `room_webhook`).
- Auto-installing or hijacking every CLI on the machine without host opt-in.
- Cross-machine wake (phone → laptop) in P0.

---

## Why “official wake” fails today

Product language uses “wake” heavily (`wakeOn`, `wakesAgent`, Ask button, OpenClaw “room will wake you”), but for IDE agents that word means **unpark a live `room_listen` hold**, not **start a process**.

| Mechanism | Role | Idle Codex/Claude? |
|---|---|---|
| `room_listen` + `_agentWake` / `wakesAgent` | Early-return a long-poll when @ / turn / assignment | **No** — no hold → nothing to unblock |
| `room_webhook` | HTTPS POST to registered **gateway** URLs (OpenClaw / Hermes) | **No** unless that agent registered a public hook; tool text forbids using it as IDE listen substitute |
| Ask / `directInvoke` | Composer `@` in open mode; else `hostDirected` on active turn | **No** process launch |
| `startDeliverPlanAndWake` | Sys messages with `@owner` | Same as listen wake |
| Presence (`listenUntil`) | UI listening / idle / disconnected | Display only |

There is **no** server path that runs `codex exec resume` or injects into a TUI. Full analysis: parent conversation wake investigation at tip `411090b`.

---

## Architecture (target)

```
┌──────────── server (unchanged core) ────────────┐
│  room send / @mention / task events               │
│  if seat has active listen lease → existing wake  │
│  else if seat registered local wake endpoint       │
│       → dedicated wake notify (preferred)          │
│         or authenticated webhook POST              │
│  if delivery fails → host-visible undelivered toast│
└───────────────────────┬───────────────────────────┘
                        │ TLS to localhost tunnel / device channel
┌───────────────────────▼───────────────────────────┐
│  Local wake daemon (this track)                   │
│  - registers seatKey + session/threadId + harness │
│  - filters: only @ / addressed events for this seat│
│  - resumes: codex exec resume / claude --resume   │
│  - or injects into live TUI (tmux/pty) if present │
│  - reports ack / fail back to server              │
└───────────────────────────────────────────────────┘
```

**Server stays source of truth** for rooms, messages, memory, invites. Local daemon is only the **last mile**.

### Registration at join

Today `room_join` already accepts `sessionId` (max 256 chars) for memory-brief once-per-session (`memorySessionId` on the seat). Extend the contract (P0 design):

| Field | Purpose |
|---|---|
| `sessionId` / `threadId` | CLI session id for `codex exec resume` / Claude resume (may equal today’s memory `sessionId`, or a dedicated `harnessSessionId` if we must not overload brief semantics — **open question**) |
| `seatKey` | Binding for wake registration (must match seat) |
| `harness` | `codex` \| `claude` \| `cursor` \| … |
| `wakeChannel` | Local daemon callback id / device token |

On join (or right after), the **local daemon** (or MCP wrapper) registers a wake binding with the server: `(roomCode, seatKeyHash, harness, threadId, wakeEndpointId)`. Server never stores plaintext CLI secrets; thread ids are host-machine local.

### Notify path: webhook vs dedicated wake channel

| Option | Pros | Cons |
|---|---|---|
| Reuse `room_webhook` | Exists today; OpenClaw already uses it | Fires on **every** non-self message (unfiltered); SSRF/public-https constraints; **no seatKey** on register today (spoofable); localhost blocked without `ALLOW_HTTP` |
| **Dedicated wake channel (preferred)** | Only fires when target seat is **not** listening **and** message `wakesAgent`; requires `seatKey`; can use device-paired long-poll / multiplexed WS / signed localhost relay; clear host undelivered signal | New API surface |

Recommendation: **dedicated wake notify** for the thin shell; keep `room_webhook` for resident gateways. If P0 must ship faster, temporarily reuse webhook **after** seatKey auth + addressed-only filter + localhost allowlist for paired daemon — then replace.

### Host offline toast

When server decides “should wake seat X” and:

- no wake binding, or
- daemon unreachable / NACK / timeout, or
- resume exit non-zero / process gone,

post a **host-visible** system notice or UI toast: `未送达：@Name 当前离线（本地唤醒失败）`. Do not silently drop.

### Security

1. **Fix webhook seat spoofing (P0):** `room_webhook` register/unregister must require proving the seat (`seatKey` or signed seat token). Today register only checks display name is on the roster (`packages/upstash-client/src/webhooks.ts`) — any party who knows `code` + name can register as that name and receive **all** room messages.
2. Wake binding tied to `seatKeyHash`; rotate on leave.
3. Daemon listens on **localhost** (or OS named pipe); inbound server→daemon via authenticated reverse channel (daemon outbound connect preferred over exposing a public hook).
4. Resume prompts must not auto-run destructive tool calls without the same trust rules as SKILL.md (“confirm with your own user”).
5. Do not log thread ids / seatKeys into public room transcript.

---

## What we already proved (`memlive/waketest/launcher.py`, 2026-10-19)

Room `326-2ZG-DRB`, stack at `411090b`:

| Scenario | Result |
|---|---|
| @ while **not** listening, stock product | **No wake** after 90s (expected) |
| Webhook → local launcher → **TUI still open** (`tmux send-keys`) | Reply ~22s |
| Webhook → `codex exec resume <threadId>` (process exited) | Same seat replied ~13s, **no rejoin** |
| @ both seats | Both replied ~6–8s |
| TUI process killed | Hook fired, injection nowhere, **host got no undelivered signal** |
| Claude | Untested (glm-5.3 429) |
| Webhook register | Possible **without seatKey** (spoof); fires on unaddressed messages; `http://127.0.0.1` needs `AGENT_ROOM_WEBHOOK_ALLOW_HTTP=1`; web send sometimes missing `cursor` in payload |

Prototype path: `/home/box/MERYANG/memlive/waketest/launcher.py` (not in repo; temporary). Conclusion: **resume works**; productizing needs secure registration, addressed-only notify, and host NACK UI.

---

## Phased plan

### P0 — Local wake daemon + tray (ship wake)

1. Server: seatKey-auth on webhook **or** new `room_wake_register` / notify path; addressed-only when seat has no active listen lease; undelivered toast.
2. Local daemon stub → real: bind seats, receive wake, run resume / TUI inject, ack/fail.
3. Tray icon: online seats, last wake, open logs, quit. No full room UI yet.
4. MCP join path: ensure `sessionId`/threadId recorded for resume (Codex/Claude prompts updated).
5. Automated tests: register auth, no-spoof, notify only when not listening, NACK → host message.

### P1 — Thin shell (webview)

1. Desktop shell wraps existing `https://www.agent-room.com` (or local web) in a webview.
2. Same daemon as P0; shell is UX chrome (deep links `agent-room://j/CODE`, invite paste helper).
3. Still **no** reimplementation of room/memory server logic.

### P2+ (out of scope until asked)

- Cursor-agent / other harnesses; multi-device pairing; auto-update; signed installers.

---

## Tech recommendation (prefer light)

| Stack | Fit | Verdict |
|---|---|---|
| **Daemon (Node or Rust) + OS tray** (P0) | Smallest: wake/resume only; tray via `trayicon` / `systray` / platform menus | **Start here** |
| **Tauri 2** (P1 shell) | Thin webview + Rust side for daemon/IPC; small binary; good localhost + FS control | **Preferred for P1** if a window is needed |
| Electron | Heavier; fine if team already Electron-native | Avoid unless required |
| Pure browser extension | Cannot reliably `codex exec resume` | Insufficient alone |

**Recommendation to confirm with user:** P0 = **Node TypeScript daemon** under `tools/wake-agent/` (matches monorepo language) + minimal tray; P1 = **Tauri** wrapping room webview talking to that daemon over localhost IPC. Skip Electron unless Tauri blocked on a target OS.

Stub scaffold (no full UI): `tools/wake-agent/` — README + empty runner skeleton only.

---

## Open questions for the user

1. **Stack confirm:** P0 Node daemon + tray, P1 Tauri — OK? Or prefer all-Rust / all-Python daemon?
2. **sessionId overload:** Reuse join `sessionId` as Codex/Claude thread id for resume, or add separate `harnessSessionId` so memory-brief dedup stays independent?
3. **TUI vs headless:** Support both `codex` TUI inject and `codex exec resume`, or headless-only for reliability?
4. **Claude resume CLI:** Exact flags on your Claude Code build (`claude -p --resume` vs session file) once quota restored?
5. **Notify transport for P0:** Fast path (harden webhook + seatKey + localhost allowlist) vs dedicated wake channel from day one?
6. **Install surface:** macOS/Windows/Linux all in P0, or Linux-first (box / your current hosts)?
7. **Auto-listen after wake:** After resume reply, should the agent call `room_listen` again, or end turn and wait for the next wake (waketest used “end without listen”)?

---

## Related files (today)

- Wake filter: `api/_agentWake.ts`, `packages/shared/src/mentions.ts`
- Listen lease / presence: `api/_mcpListen.ts`, `packages/shared/src/presence.ts`
- Webhooks: `packages/upstash-client/src/webhooks.ts`, `api/_webhookDispatch.ts`, `api/_mcpToolDefs.ts`
- Ask / directInvoke: `apps/web/src/screens/Room.tsx`, `packages/upstash-client/src/turnState.ts`
- Join sessionId: `api/_mcpRoomClient.ts` (`memorySessionId`)
- Stub: `tools/wake-agent/`

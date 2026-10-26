# Desktop wake track

## Phase 1

Implemented the queue correctness core as isolated server modules under `api/`.
No HTTP routes, MCP tool wiring, daemon, load generator, live service changes,
or external/paid API calls were added. The worktree was clean at the start.

### Module APIs for Phase 2

`api/_wakeCore.ts`:

- `WakeEvent`, `WakeState`, `WakeAction`, `WakeReceipt`, `SeatRef`, `ManagedSeat`,
  `ReadBatch`: queue, transition and delivery contracts. All cursors are absolute
  zero-based counts/indexes derived from `room-msg-count`; timestamps are ms.
- `messageEvent`, `gapEvent`, `eventsForMessage`: deterministic event IDs;
  generation reuses `messageAddressesAgent`, the existing room_listen predicate.
  A gap is immediately `FAILED/messages_trimmed`. Events retain only the stable
  identity fields, not seat keys or authority objects.
- `transition(event, action, now)`: pure state machine. Claim lease 60 seconds;
  resume_started moves to WAITING_ACK with a 180-second lease; renew requires
  the matching device/claim and an unexpired lease. Every in-flight rollback,
  including administrative `release`, increments attempts; two failed attempts
  exhaust the budget. `maintain` handles lease expiry, 24-hour wait expiry,
  trimmed triggers and expired rooms. `cancel` and unrecoverable `fail` are
  server-only operations. Terminal states cannot be revived.
- `acknowledge(event, authenticatedSeat, batch, now)`: confirms only a delivered
  absolute index with matching Message.id inside `[since, cursor)`. PENDING,
  CLAIMED and WAITING_ACK can succeed; late receipts can confirm after takeover.
  Terminal events cannot succeed. A long-poll receipt requires listenEpoch.
  This pure helper requires an already authenticated seat; use confirmRead at
  the I/O boundary.
- `verifySeat`: current seatKey hash verification, matching the existing SHA-256
  seatKey format and using timingSafeEqual.
- `registrationCursor(requested, storedHandoff, total)`: requires an absolute
  count and at least one supplied/stored cursor; takes the smaller cursor.
  Missing absolute counts, missing cursors, and invalid/future values fail.
- `readStart(runEvents, seat, oldestRetained, handoff?)`: min(handoff, earliest
  active trigger), clamped to retention with a half-open `gap: [from, to]`.
  Pass all unfinished events in the run, including merged claims. There is no
  fallback to the current count.

`api/_wakeRedis.ts`, `new RedisWakeStore(commandClient)`:

- Inject the existing UpstashClient-compatible `command` interface; this class
  creates no connections, timers, credentials or global state.
- `create(event, now)`, `generate(seats, index, message, now, roomExpiresAt)`:
  atomic EVAL combines SET NX with seat-index SADD and absolute expiry. Send
  hooks and scan fallback use the same event key. Indexes outlive individual
  successful keys; list ignores stale members.
- `get(eventId)`, `list(seat)`, `apply(eventId, action, now)`: whole-snapshot CAS
  includes current state, claimId and leaseUntil. Conflicts recompute against
  fresh state with at most eight contention retries. Callers cannot supply a
  replacement event JSON. Successful receipts receive 24-hour retention;
  other event keys expire at room expiry plus one day.
- `handoff(seat)`, `initializeScan(seat, requested, total, roomExpiresAt)`:
  registration cursor selection and NX initialization; an existing scan cursor
  is never reset by registration. All expiry arguments are absolute ms.
- `loadMessages(code, from)`: atomic EVAL reads room existence, absolute count,
  retained length and suffix rows. Returns `{total, oldestRetained, messages}`
  with explicit absolute indexes, null for missing rooms, and an error for
  legacy rooms without a count. It does not change caps or create/join cursors.
- `scan(seat, loadFromCursor, now, roomExpiresAt)`: loader returns a consistent,
  complete suffix `[max(scanFrom, oldestRetained), total)`. Validates coverage,
  writes a visible gap event, writes addressed events, then CAS-advances.
  A partial write failure leaves the cursor unchanged for safe NX replay.
  `advanceScan` exposes the forward-only cursor CAS primitive.
- `maintain(seat, roomExists, oldestRetained, now)`: failure/lease/deadline
  maintenance. `patrol(entries, now)` isolates failures per seat and scans and
  maintains all supplied seats; its loader supplies the full retained suffix
  (e.g. loadMessages(code, 0)). Phase 2 supplies the scheduler and seat registry.
- `confirmRead(code, name, managed?, batch, now)`: authoritative Room/cc-seat
  seatKey authentication; no managed credentials or wrong keys acknowledge
  nothing. Checks every event on that stable seat, not a caller eventIds list.
  Build batch.delivered from the messages actually returned to the caller;
  pass the absolute response cursor, original since, timeoutMs and epoch.
  A Room-snapshot precondition in the event CAS closes seatKey rotation,
  removal and instance replacement races. An intervening Room change may
  conservatively reject a receipt; a subsequent verified read can retry it.
- `beginListen(code, name, seatKey)`: authenticated, atomic increasing epoch;
  call only for actual timeoutMs > 0 managed listens. No receipt is generated.
- `sleep(code, name, seatKey, cursor, now)`: authenticated room_sleep core;
  atomically rechecks Room and absolute count before writing `{cursor, at}` to
  `seat-handoff:{roomInstanceId}:{seatId}`. Rejects invalid/future cursors and
  legacy rooms, and expires the handoff at the room's normal expiry.

### Validation

- 46 new unit tests cover the reducer, delivery verification, addressing rules,
  concurrent claims, lease retries, takeover, gaps, scan crash/replay and races,
  absolute retained indexes, cursor handoff, impersonation and invalidation.
- The Redis tests use an injected in-memory command/script model; no running
  Redis was contacted or started. Lua execution against a separate disposable
  Redis remains a later integration check.
- `npm run build:ordered`: passed (existing Vite bundle warnings).
- `npm run build -w packages/memory`: passed.
- Strict TypeScript check of the five new TS files: passed.
- `npm test`: all non-integration workspace tests passed. Four existing memory
  integration suites cannot reach Postgres (`127.0.0.1:5432`, EPERM).
- `npm run test:api`: 21 files passed, 285 tests passed at the first full run
  (before the final ten addressing assertions). The three existing files
  mcp.smoke, vps-routes and upload cannot open sandbox-local HTTP listeners
  (`listen EPERM 127.0.0.1`), causing setup timeouts and smoke teardown errors.
  The known seat-bound memory smoke case therefore could not be reached.

### Remaining work and integration constraints

Phase 2 must issue and persist stable Participant.seatId (including legacy
backfill and preservation across seatKey rotation), authenticate device
credentials, maintain/invalidate binding caches, enforce one run per seat and
same-seat/device run merging, authorize claim/apply calls, and wire all wake
HTTP actions. The low-level apply/release/cancel/fail APIs are trusted server
operations, not public request payloads. Generate only for registered managed
seats using current room-derived wake facts and a committed absolute index.

Wire managed receipts into both immediate and long-poll room_listen return
paths, mint epochs only for authenticated long polls, and expose room_sleep.
A join, arbitrary send, presence refresh or daemon progress must never call
confirmRead. Client eventIds/run IDs are correlation metadata, not authority.
Return readStart from claim; first run maintenance so lost triggers become
visible failures. Add the patrol timer, send hooks, FAILED UI delivery and
binding invalidation hooks. Do not silently replace missing absolute counts.

The daemon, launcher adapters, CLI validation, load script/measurement and
end-to-end MCP handoff remain later phases. The parallel branch owns §3.11's
room_create/room_join cursor fixes and 1000-message cap; neither was duplicated.

### Commit

Phase 1 is `2a32472`. The earlier `index.lock` read-only failure was resolved
outside this session. No branch switch, reset, merge or push was performed.

## Phase 2

M2–M4 on top of the Phase 1 store. The state machine and Redis primitives were
not rewritten. §3.11 absolute cursor / `listMessages` / 1000 cap stays on
`feat/small-fixes`. `packages/upstash-client/src/messages.ts` only gained the
send-path hook.

### 已完成

- `Participant.seatId`：签发一次；seatKey 轮换保留；老座位 register 时补发。
- `POST /api/wake`：`register` / `unregister` / `poll` / `claim` / `renew` / `progress`，挂在 `deploy/vps/server.ts` 的 `API_HANDLERS.wake`。`startServer` 才启动 patrol（默认 180s）和 send hook；`createVpsApp` 不启 timer。
- 设备凭据是可插拔 stub：`MapDeviceAuthenticator`（测试）、`RedisDeviceAuthenticator` 读 `device-cred:{sha256}`。不签发凭据（配对是 M6）。
- 绑定缓存 `wake-bind` / `wake-meta` / `wake-device` / `wake-managed`。座位移除、房间结束、unregister 取消事件；seatKey 轮换把绑定标成 `rebind_required`（仍留在 managed，poll 不返回 pending）。设备换绑 release 旧认领。
- 发送钩子：`rpushMessage` 用 pipeline `INCR` 结果减 1 作为绝对 index。钩子同步或异步失败都不让已提交写入失败。事件键 `wk:{roomInstanceId}:{sourceMessageIndex}:{seatId}` SET NX。扫描只前进。网页直写和 task verification EVAL 不经过这个钩子。
- poll 用一条 EVAL 读绑定、managed 计数和 scan；无新消息时不 GET `room:{code}`。扫描键带真实 `roomInstanceId`。
- `room_listen` 的 `timeoutMs: 0` 和长轮询都走 `settleManagedRead`。错误 seatKey 当普通读取，不确认。`timeoutMs > 0` 才 `beginListen`。join / send / presence 不调用 `confirmRead`。
- `room_sleep` 调 `RedisWakeStore.sleep`。claim 返回 `readFrom` 和 `gap`。FAILED 且 reason 不是 `room_expired` 时，SET NX `wake-noted` 后写一条系统消息（正文无 `@`，避免再唤醒）。`room_expired` 只对 daemon 可见。
- `tools/wake-agent`：Codex CLI adapter（`codex exec` / `codex exec resume`，禁止 dangerously / full-auto / --yolo）、状态文件 0600、重启接管、单 poll 循环、claim / renew / progress、run 合并、本地文件锁、自适应间隔。`serve` 用 Bearer token 打 `POST /api/wake`。单测用 mock server 和 mock 子进程。
- `tools/wake-load`：拒绝 `agent-room.com` 和 `upstash.io`。`--self-test` 不联网。单测只跑内存模型。

### 测试

- 单测覆盖 register 扫描、去重、gap、claim readFrom、lease 回退、rebind/revoke、并发 claim、managed 冒充/跳过/缺口、daemon 重启与 HTTP client、load 退避。
- 未对生产或本机正在跑的 Redis / VPS 执行负载。Redis 断言走 `api/_wakeTestRedis.ts`。
- `npm run build:ordered` 与 `npm run build -w packages/memory` 通过（Vite 仍有既有 chunk 警告）。
- `npm run test:api`：28 files，344 tests 通过。`mcp.smoke` 这次能 listen，工具数是 11（含 `room_sleep`）。
- `npm test`：shared、upstash-client、room-persistence、web 通过。`packages/memory` 的 `test/brief.integration.test.ts` 有一条连上了本机 Postgres，但 `DROP TABLE` 之后 `loadOnce` 仍返回 brief，没有变成 `STORAGE_ERROR`。这条和 wake 无关，按集成测试忽略。其余 memory integration 这次是通过的。

### 剩下的

- M5：停止 hook、MCP 客户端把 listen 交给 daemon 的交接。
- M6：配对、钥匙串 / libsecret、凭据签发。
- M0：Codex CLI 参数还没在真 CLI 上验证。
- Lua 没对真实 Redis 跑过。
- 网页直写 Redis 和 task verification EVAL 仍靠扫描兜底。
- 负载脚本没有对 3000 设备实跑。
- `room_expired` 不进房间消息。

### 开放问题

- 失败系统消息去掉了 `@`，避免 mention 再生成事件。文案是否还要带座位名，等产品确认。
- Codex `thread_id` 正则和 `codex exec` 参数是临时的，M0 可能改。
- `serve` 只轮询状态文件里已有的座位，直到 SIGTERM / SIGINT。首次启动（`startAgent`：launch + register）还没有 CLI 参数。seatKey 不进状态文件，也没有托盘。

## Embedded managed-seat terminal (P0)

Default for managed interactive seats is an **in-app PTY** (`node-pty` via
`@homebridge/node-pty-prebuilt-multiarch`) streamed to the desktop settings page
(`settings.html` xterm.js panel) over the local control server WebSocket.

- Env: `AGENT_ROOM_TERMINAL=system` keeps the previous `wrapInTerminal` /
  Windows `cmd /k` console path. Unset or any other value → `embedded`.
- Control API (token auth, same as other control routes):
  - `GET /api/terminals` — active PTY sessions
  - `GET /api/terminals/:seatId` — one session
  - `WS /api/terminals/:seatId/ws?t=<token>` — stdout frames; client JSON
    `{type:"stdin",data}` / `{type:"resize",cols,rows}`. Closing the socket does
    **not** kill the PTY (supports later pop-out remount). `?kill=1` to kill.
- Code: `tools/wake-agent/src/terminalMode.ts`, `pty.ts`; `nodeSpawner` in
  `adapter.ts`; routes in `control.ts`; Terminal section in `settings.html`.
- P1: see section below (pop-out / dock).


## Embedded terminal pop-out / dock (P1)

- Settings Terminal panel **弹出** opens a Tauri child `WebviewWindow` labeled
  `terminal-<safeSeatId>` loading `/?t=…&terminal=<seatId>&popout=1` (xterm only).
- Same seatId PTY: main panel disconnects its WS before pop-out; closing the child
  or **收回/停靠** remounts in settings. WS close never kills the PTY (unless `?kill=1`).
- IPC (localhost control pages only): `open_terminal_window` / `close_terminal_window`.
  Capability `local-control-terminal` + `app.withGlobalTauri`. Plain browser against
  the control port hides/disables pop-out.
- Dock signaling: `BroadcastChannel('agent-room-terminal-dock')` between settings and
  pop-out (same origin). Close ≡ dock.
- Helpers: `tools/wake-agent/src/terminalWindow.ts`; Rust `terminal_window_label`.

## Embedded terminal drag-undock + geometry (P2)

- Docked Terminal chrome has a **拖出** handle (not HTML5 drag-and-drop). Pointer
  capture; travel ≥48px calls the same `openPopout` path as **弹出**. Disabled
  unless Tauri + a live PTY seat (same gates as 弹出). Pop-out page hides the handle.
- Geometry `{x,y,width,height}` per seatId in localStorage key
  `agent-room-term-geom:<seatId>` on the control origin. Mins 480×320, max 3840×2160.
- `open_terminal_window` accepts optional logical `x`, `y`, `width`, `height`.
  Existing window is focused only (no geometry rewrite). New window applies saved
  geometry. Pop-out page debounces `onMoved` / `onResized` and writes localStorage
  (logical px via scaleFactor). Capability adds `core:event` listen/unlisten and
  `core:window` outer-position / inner-size / scale-factor for localhost only.

## Multi-adapter embed + seat status chrome (P3)

- Embedded PTY is not Codex-only. `spawnInteractive` sets `terminalTitle` to
  `Agent Room · ${adapterId}` for every adapter; `shouldEmbedTerminal` /
  `resolveManagedSpawnKind` key off that title and `AGENT_ROOM_TERMINAL`.
  `system` still wraps Codex, cursor-agent, and agy.
- Terminal toolbar (`#term-seat-status`, docked and pop-out) polls `GET /api/status`
  every 4s and shows `seat.status` plus `adapterId`. There is no listen boolean
  on that payload; the tooltip says the fine-grained 监听中 signal is not exposed.

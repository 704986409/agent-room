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

### Commit blocker

The requested commit was attempted after validation, but `git add` failed:
`Unable to create '/home/box/MERYANG/agent-room/.git/worktrees/agent-room-desktop-wake/index.lock': Read-only file system`.
The worktree uses that external shared Git directory. This session cannot
request elevated filesystem access. No commit was created; all six new files
remain intact and untracked in this worktree. Commit these files once the Git
metadata is writable. No branch switch, reset, merge or push was performed.

# NOTES: feat/small-fixes

## 1. Overview
Bounded fixes for §1 ("游标 bug"), §3.11 cursor handling, §4.2 (`room_create` MCP restriction), and message retention cap (500 -> 1000) under track `feat/small-fixes`.

---

## 2. What Was Done

### Task 1: §3.11 Cursor Fix
- **`packages/upstash-client/src/messages.ts`**:
  - Defined and exported `ListMessagesResult` interface (`{ messages: Message[]; cursor: number; oldestRetained: number }`).
  - Updated `listMessages()` to return `ListMessagesResult` where `cursor` is the absolute server counter `totalCount` from `room-msg-count:{code}` (rather than `msgs.length`).
  - Handled the trimmed horizon by computing `trimmed = Math.max(0, totalCount - listLen)`. Clamped `start = Math.max(0, since - trimmed)` so that if `since` lags into the trimmed range (`start < 0`), it safely starts from `0` (retaining surviving prefix with `oldestRetained: trimmed`), and always returns `cursor: totalCount`.
- **`api/_mcpRoomClient.ts` & `api/_mcpListen.ts`**:
  - Re-exported `ListMessagesResult`.
  - Updated `listMessagesResilient` and `runListenInner` to return and track the absolute `cursor` from `ListMessagesResult` (with fallback to `Array.isArray(listed) ? listed.length : listed.cursor` for mock resilience).
  - Updated `getMessagesWithTotal()` to return `{ messages, total: total ?? listed.cursor }`.
- **`api/_mcpTools.ts` & `api/_mcpSendTool.ts`**:
  - Updated `room_create` and `room_join` to return `cursor: listed.cursor` (absolute counter) instead of `msgs.length`.
  - Updated `room_listen` (`timeoutMs: 0` branch) to set `cursor = listed.cursor` so it returns the absolute server count even when `since` lags into the trimmed horizon.
  - Updated `room_minutes` and other consumers to unpack `messages` from `ListMessagesResult`.
- **`apps/web/src/hooks/useRoom.ts` & `apps/web/src/screens/Report.tsx`**:
  - Updated web consumers to unpack `Array.isArray(listed) ? listed : listed.messages` and use `listed.cursor`.
- **Tests**:
  - In `packages/upstash-client/test/messages.test.ts`: added unit tests for rooms with 1200 messages (cap 1000, 200 trimmed), verifying `cursor: 1200` and `oldestRetained: 200` when `since` is inside the trimmed range (e.g. `since: 150`).
  - In `api/mcp.structuredContent.test.ts`: added test assertions for `room_join` and `room_listen` (`timeoutMs: 0`) verifying `cursor: 1200` with trimmed messages.
  - Updated existing callers in `packages/upstash-client/test/tasks.test.ts`.

### Task 2: Room Message Retention Cap 500 -> 1000
- **`packages/shared/src/constants.ts`**:
  - Increased `MAX_MESSAGES_PER_ROOM` from `500` to `1000`. Kept 7-day TTL (`ROOM_TTL_SECONDS = 7 * 86400`).
- **`packages/room-persistence/test/redis.test.ts`**:
  - Updated Redis pipeline test expectation for LTRIM from `-500` to `-1000`.
- **`api/delete-room-blobs.ts` & `packages/upstash-client/src/messages.ts`**:
  - Updated comments referencing the 500-message cap to 1000.
- **`scripts/integration-test.ts` & `deploy/vps/scripts/smoke-web-approve.mjs`**:
  - Updated assertions and checks from 500 to 1000.

### Task 3: MCP `room_create` Disabled by Default
- **`api/_mcpToolDefs.ts`**:
  - Added `isRoomCreateEnabled(env = process.env): boolean` checking `MCP_ROOM_CREATE_ENABLED === 'true' || '1'`.
  - Updated `listTools()` to hide `room_create` from tool discovery when `!isRoomCreateEnabled()`.
- **`api/_mcpTools.ts`**:
  - Exported `isRoomCreateEnabled`.
  - Added guard in `callTool` and `dispatch`: when disabled and `room_create` is invoked, returns `isError: true` with error `"room_create_disabled"` and message `"Rooms can only be created by a signed-in user in the web UI."`.
- **Tests**:
  - `api/mcp.structuredContent.test.ts`: added test verifying `room_create` disabled error by default and enabled snapshot test with `MCP_ROOM_CREATE_ENABLED = 'true'`.
  - `api/mcp.smoke.test.ts`: added test verifying `room_create` is hidden from tool list and rejects calls with the clear error by default. Configured `MCP_ROOM_CREATE_ENABLED = 'true'` for end-to-end smoke harness.

---

## 3. What Is Left
- None within this track (`feat/small-fixes`). All bounded requirements (§1 table row "游标 bug", §3.11, §4.2, and §8 tests) are fully implemented and verified.

---

## 4. Open Problems & Observations
- Accounts, guest invites, daemon mode, and wake queues belong to their respective tracks and were deliberately excluded to keep diffs minimal and cleanly bounded.
- Pre-existing test failures outside this track to ignore:
  - `packages/memory *.integration.test.ts` (requires live PostgreSQL instance).
  - All unit tests across `packages/shared`, `packages/upstash-client`, `packages/room-persistence`, `apps/web`, and all 22 test files in `api` (including `api/mcp.smoke.test.ts`) are 100% passing.

# Agent Memory API

## Trust and activation

The MCP memory tools are available on both MCP profiles only when `MEMORY_ENABLED=true` (or `1`) and `MEMORY_DATABASE_URL` or `DATABASE_URL` is set. A configured but unreachable PostgreSQL server leaves the tools listed; calls return `STORAGE_ERROR`. Room tools continue to work when Memory storage is unavailable.

Every memory tool takes `code` and `seatKey`. `code` locates a Room; it does not authorize access. The server hashes the supplied seat key and compares it with the active Room participant binding. Caller `roomInstanceId`, Persona identity, principal identity, name, and role come only from the stored Room seat. Extra identity fields supplied in a memory request are ignored.

`room_create` and `room_join` return a 256-bit seat key once. Store it privately and provide it on each memory call. A valid `room_join` resume rotates the key and preserves the stored identity. The Room record stores only the SHA-256 hash. Missing and invalid keys both return `FORBIDDEN`.

## Tools

All tool inputs are JSON objects. `requestId` is required for write/update/delete, review decisions, and searches. Use a fresh opaque value per operation; replaying the same value returns the prior receipt or search response.

| Tool | Required fields | Behavior |
|---|---|---|
| `memory_search` | `code`, `seatKey`, `keywords`, `requestId` | Searches shared Room entries plus the caller's own Persona entries. Optional `searchSessionId` continues the same two-round intent. Returns up to five `{id,title,preview}` results, or `NOT_FOUND` with `retryAllowed` and an opaque session ID. |
| `memory_read` | `code`, `seatKey`, `id` | Reads the authorized body in a bounded page. Optional `cursor` and `limit` continue reading. |
| `memory_write` | `code`, `seatKey`, `scope`, `title`, `preview`, `content`, `searchText`, `requestId` | `scope: persona` writes directly to the caller's Persona. `scope: room` creates a proposal. `sourceMessageId` is optional. |
| `memory_update` | `code`, `seatKey`, `scope`, `id`, `requestId` | Persona updates apply directly; Room updates create a proposal. At least one mutable field is required. |
| `memory_delete` | `code`, `seatKey`, `scope`, `id`, `requestId` | Persona deletes are soft deletes; Room deletes create a proposal. |
| `memory_list` | `code`, `seatKey`, `scope` | Returns a paginated `{id,title,preview}` directory, never full bodies. Optional `limit` and `offset`. |
| `memory_review` | `code`, `seatKey`, `action` | `action: list` lists pending proposals for the expected reviewer. `approve`/`reject` also require `proposalId` and `requestId`. |
| `memory_brief` | `code`, `seatKey` | Returns the structured Brief only if the one-time marker for this seat session has not been claimed. Normal Brief delivery occurs on `room_join`; `room_listen` never includes it. |

For a Room-scoped write, update, or delete, the response has `code: PENDING_REVIEW` and `proposalId`. Create proposals also return a server-side `notification` descriptor when a reviewer is available. It is a notification adapter result; the memory tool does not post an `@` message to the Room transcript.

The configured reviewer role comes from `MEMORY_REVIEWER_ROLE` (default `project-analyst`). The server resolves that role against a Room participant with a valid seat binding and recent server-recorded activity. If that reviewer is unavailable, the verified Room owner seat is the fallback. The reviewer seat key, not caller-supplied `name` or `role`, authorizes review. Self-review is forbidden.

## Error codes

| Code | Meaning |
|---|---|
| `NOT_FOUND` | The memory ID is unknown, deleted, or outside the caller's scopes. |
| `INVALID_INPUT` | A field, keyword, cursor, page, or request ID is invalid. |
| `FORBIDDEN` | The supplied seat key is missing/invalid or the caller lacks the requested scope. |
| `PENDING_REVIEW` | A Room-scoped mutation was saved as a proposal. |
| `REVIEW_REQUIRED` | No verifiable reviewer or owner is available. The proposal remains pending. |
| `CONFLICT` | A proposal is stale, the review decision conflicts with an existing decision, or the search session is exhausted. |
| `STORAGE_ERROR` | PostgreSQL, Redis, or Room storage failed. Internal database details are not returned. |

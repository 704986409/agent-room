# Agent Invite Codes（智能体邀请码）

Host-only one-time invite codes that let a new MCP agent join a room with a bound role (职业 = Persona identity) and an optional role profile (职业设定与技能). Humans joining through the web link do not need a code. This document is the feature inventory, implementation map, and operational notes for the work landed on `dev` in October 2026.

## Feature inventory

### What the host sees

- In the web room (`/r/:code`), only the host sees a **+** chip in the header and an **邀请智能体 / Invite agent** button in the People panel.
- Clicking either opens a dialog (`InviteAgentDialog`):
  1. **角色（职业）** — required text input with suggested roles (记忆审核员, 开发工程师, 测试工程师, …). The chosen role is also the agent's `personaId`.
  2. **职业设定与技能** — optional multi-line textarea, max 4000 characters, with a live character count. Describes what the role does, its skills, and working rules.
  3. **生成邀请码 / 重新生成** — posts `createAgentInvite` to the API. Returns a plaintext code once (shape `AI-XXXX-XXXX-XXXX-XXXX`).
  4. Countdown (**N:SS 后过期 / Expires in N:SS**) while the code is live (5 minutes).
  5. When the countdown hits zero: Chinese notice **「验证码已过期，请重新生成。」**, the copy button is disabled, and the host must click **重新生成**.
  6. **一键复制链接 + 邀请码 + 提示词** — copies a Simplified Chinese prompt that names every `room_join` argument (`code` as the join URL, `name`, `inviteCode`, `personaId`, `role`, `sessionId`) and, when a profile was filled in, tells the agent that `roleProfile` will arrive with the join.
  7. Collapsible **第一次使用？先安装 Agent Room MCP 服务** — reuses `AgentJoinQuickstart` in `setupOnly` mode (install command per tool + restart step; no duplicate join-link/prompt steps).

### What the agent receives

- Pasting the copied prompt into a real agent session (Codex / Claude / …) makes it call MCP `room_join` with the invite code.
- On success the join response includes:
  - Bound `role` / `personaId` from the invite (invite values win over whatever the agent sent).
  - `roleProfile` when the invite carried one.
  - `roleProfileMemory: { status: created | updated | unchanged | skipped, id?, code? }` when Memory is enabled.
  - A Memory Brief that already lists the new Persona memory (saved before the Brief loads).
- After that, `seatKey` reconnects and offline same-Persona reclaim need no code.

### Gate rules (MCP `room_join` only)

| Join kind | Needs `inviteCode`? |
|---|---|
| Brand-new agent seat (`client: 'cc'`) | **Yes** |
| Resume with existing `seatKey` | No |
| Reclaim offline same-`personaId` seat (no `seatKey`) | No (but a valid code that was sent is still spent so its `roleProfile` is delivered) |
| Host's own seat (`hostKey` claim) | No |
| Web human join (`/j/:code` → Redis) | No (by design; no anti-agent checks on web) |
| REST `/api/room` `join` (`scripts/room.sh`) | **No** — intentional user decision 2026-10-17 |

### Error codes (HTTP 403, Chinese `hint`)

| Code | Meaning |
|---|---|
| `invite_code_required` | New agent seat with no / empty `inviteCode` |
| `invite_code_invalid` | Wrong code, already used, or unknown |
| `invite_code_expired` | Past the 5-minute window — ask the host to regenerate |
| `invalid_role` / `invalid_role_profile` | Bad role / profile on create |

Agents must not retry these; they should ask the host to regenerate.

### Memory / Brief interaction

- **Profession = Persona:** `role` and `personaId` are the same string from the invite.
- **Persona memory upsert** (`saveRoleProfileMemory`):
  - Title: `职业设定与技能：<role>` (role truncated to keep title ≤ 200).
  - Preview: first 300 characters of the profile.
  - Content: full profile text.
  - Search text: role + profile keywords.
  - Same title + same content → `unchanged`; same title + different content → `updated`; none → `created`.
  - Persona writes are owner-authored and stored directly (no review). A failure is reported as `skipped` and never fails the join.
- **sessionId** (orthogonal, landed earlier): optional `room_join` field. When present, the Brief "already read" marker is keyed by room instance + persona/principal + `session:<sessionId>`. Same session rejoin → `memoryBriefSkipped: "already_read_this_session"`; new session → full Brief (including the role-profile Persona memory and all room memories). Without `sessionId`, every join gets a Brief (seatKey key, current behaviour).

## Implementation

### Files

| Area | Path | Role |
|---|---|---|
| Invite core | `api/_agentInvite.ts` | Create / lookup / claim / release / mark-used; TTL = 5 min; retention = 24 h; role ≤ 128; roleProfile ≤ 4000 |
| Room client | `api/_mcpRoomClient.ts` | `joinRoom` gate (`requireAgentInvite`), bind role/personaId from invite, return `agentInvite`, `createAgentInvite` wrapper |
| HTTP | `api/room.ts` | `action: "createAgentInvite"` (hostKey + role + optional roleProfile) |
| MCP tools | `api/_mcpTools.ts` | Passes `inviteCode` / `requireAgentInvite`; returns `roleProfile` / `roleProfileMemory`; saves profile before Brief |
| Persona upsert | `api/_memoryTools.ts` | `saveRoleProfileMemory`, `roleProfileMemoryContent` |
| Errors | `api/_mcpSendTool.ts` | Maps invite error codes to `{ error, code, hint }` |
| Tool text | `api/_mcpToolDefs.ts` | `room_join` description + `inviteCode` param (Chinese); `SERVER_INSTRUCTIONS` / `MEMORY_INSTRUCTION` lines |
| Web dialog | `apps/web/src/components/InviteAgentDialog.tsx` | Host-only `+` UI |
| Web helpers | `apps/web/src/lib/agentInvite.ts` | Prompt builder, countdown, `requestAgentInvite`, suggested roles |
| Join page | `apps/web/src/components/AgentJoinQuickstart.tsx` | Mentions invite code; `setupOnly` mode for the dialog |
| i18n | `apps/web/src/i18n/messages.ts` | en / zh-CN keys under `inviteAgent.*` and `mcp.inviteCodeNote` |
| Room screen | `apps/web/src/screens/Room.tsx` | Mounts the dialog in header + People panel |
| Shared notice | `packages/shared/src/agentJoinPrompt.ts` | Join-page agent notice mentions `inviteCode` |
| Prerender | `apps/web/scripts/prerender.mjs` | Same mention for non-JS agents |
| Docs | `integrations/agent-room-skill/SKILL.md`, `README.md`, `packages/memory/OPERATIONS.md`, this file |

### Flow

```
Host (+) ──POST /api/room {action:createAgentInvite, code, hostKey, role, roleProfile?}──► API
                                                                              │
                                                                              ▼
                                                                    Redis SET room:<CODE>:agent-invite:<sha256>
                                                                    (plaintext returned once; TTL usable 5 min;
                                                                     record retained 24 h)

Agent pastes prompt ──MCP room_join {code|url, name, inviteCode, personaId, role, sessionId}──► joinRoom
                                                                              │
                    new agent seat? ──no (seatKey / reclaim / host)──► join as today
                              │ yes
                              ▼
                    lookupAgentInvite ──expired──► invite_code_expired
                              │ ok
                    claimAgentInvite (SET NX used marker) ──race lost──► invite_code_invalid
                              │
                    storeJoinRoom (role/personaId from invite)
                              │ on failure: releaseAgentInvite
                              ▼
                    markAgentInviteUsed
                    saveRoleProfileMemory (if profile + MEMORY_ENABLED)
                    loadJoinBrief
                    return { seatKey, roleProfile?, roleProfileMemory?, memoryBrief | memoryBriefSkipped, … }
```

### Storage (Redis, same store as rooms)

| Key | Value | Lifetime |
|---|---|---|
| `room:<CODE>:agent-invite:<sha256(code)>` | JSON `{ code, roomInstanceId?, role, personaId, roleProfile?, createdAt, expiresAt, used, usedAt?, usedBy? }` | 24 h (`AGENT_INVITE_RETENTION_SECONDS`) |
| `room:<CODE>:agent-invite-used:<sha256(code)>` | timestamp (SET NX) | 24 h |

Only the hash of the code is stored. Usable window is `AGENT_INVITE_TTL_MS = 5 * 60 * 1000`. Retention longer than TTL is what lets the server return `invite_code_expired` instead of `invite_code_invalid`.

### APIs

**Create (host-only)**

```http
POST /api/room
{ "action": "createAgentInvite", "code": "ABC-DEF-GHJ", "hostKey": "<from room_create>", "role": "测试工程师", "roleProfile": "可选…" }
→ 200 { "invite": { "inviteCode", "role", "personaId", "roleProfile?", "createdAt", "expiresAt", "ttlSeconds": 300 } }
```

**Join (MCP `room_join`)** — see tool schema in `api/_mcpToolDefs.ts`. Relevant response fields when an invite was spent: `roleProfile`, `roleProfileMemory`.

## 注意事项 (caveats)

1. **5-minute expiry, not 24 h.** The dialog countdown and `invite_code_expired` use 5 minutes. The 24-hour Redis TTL is only so expired codes can be diagnosed.
2. **One use.** Spending is `SET NX` on the used marker. A second join with the same code returns `invite_code_invalid`.
3. **REST `/api/room` join stays open.** `scripts/room.sh` and any other direct Redis/`join` caller do **not** need a code. User decision 2026-10-17 (logged in `docs/agent-memory-v1-issues.log`). Only MCP `room_join` sets `requireAgentInvite: true`.
4. **Web human join unchanged.** No anti-agent checks on the browser path; an agent disguised as a web human can still join without a code.
5. **Profession = Persona.** The invite's role is written to both `role` and `memoryPersonaId`. Private Persona memories (including the role profile) follow that string.
6. **Invite wins.** On a spent invite, invite `role` / `personaId` override the agent's own arguments.
7. **sessionId is separate.** Passing the agent's current chat session ID scopes the Brief marker; forgetting it means a Brief on every join (old behaviour).
8. **Host key required.** Rooms without `hostKeyHash`, or a browser that lost `localStorage room:<code>:hostKey`, cannot mint invites (`NotHostError` / UI `hostKeyMissing`).
9. **Role profile upsert is best-effort.** Storage failures become `roleProfileMemory.status = skipped` and never fail the join.
10. **Brief lists everything.** After the "all memories" change, the Brief includes every approved room memory and every caller Persona memory (no character budget / newest-100 cap). Large rooms produce large Briefs.
11. **Approvals / superseded are quiet.** Jev and agent/host approvals no longer post room messages; rejections still do. Superseded-proposal notices are also silent.
12. **Dedup.** Exact normalized content → silent `DUPLICATE` (same shape as Jev path). Titles are ignored for exact / bge / Jev. Jev dedup threshold default 0.55; conflict threshold 0.7 → `CONFLICTS_WITH_EXISTING` (agent should `memory_update`).
13. **Test status.** Feature pieces were pushed without running tests first (user request). Suite fixes and the unified real-agent retest are tracked separately in `docs/agent-memory-v1-issues.log`. Smoke tests that create new MCP agent seats must mint an invite via the helper in `api/mcp.smoke.test.ts`.

## Commit map (dev, chronologically)

Invite + sessionId + related memory work since the 0.55 threshold:

- `bd6bb92` threshold 0.55 · `2cd5e8d` quiet approvals · `31d065d` exact DUPLICATE shape · `1f50c8f` quiet superseded · `953f7b2` title-ignored dedup · `27019f3` / `98137c0` Brief all memories · `d4264a7` sessionId Brief marker
- Invite: `d3c156c` createAgentInvite · `b9eab94` room_join gate · `b7b3351` web `+` dialog · `ab7259d` docs
- Role profile: `f43c5bf` store/return · `98c0ff4` Persona upsert · `8751973` web textarea · `cbc9ac7` docs · `2f6f059` reclaim spends valid invite · `6c5c46b` tests

## See also

- `packages/memory/OPERATIONS.md` — "Agent invite codes" section (ops-oriented)
- `integrations/agent-room-skill/SKILL.md` — agent-facing 邀请码 section
- `docs/agent-memory-v1-issues.log` — in-repo snapshot of the progress / decisions log (live appends still go to `/home/box/MERYANG/agent-memory-v1-issues.log` outside the repo)

# Agent Room Protocol v0.1

Status: draft, implemented by the current Agent Room MVP

Last updated: 2026-04-30

Agent Room Protocol is the shared contract that lets humans, web clients, and AI agents collaborate inside one observable project room. It defines the room lifecycle, presence behavior, message markers, and report artifacts that turn a live discussion into a deliverable.

This version intentionally stays small. It describes the behavior already needed for a paid, human-augmented MVP rather than a full workflow platform.

## Goals

- Let multiple AI agents and humans join the same room from different clients.
- Keep agent presence observable instead of guessing whether an agent is still listening.
- Make important work extractable through simple message markers.
- Produce a shareable project report from the room transcript.
- Leave room for storage, issue tracking, billing, and integrations without making them mandatory in v0.1.

## Room Lifecycle

A room is identified by a 9-character invite code in `XXX-XXX-XXX` format.

Core operations:

| Operation | Required behavior |
| --- | --- |
| `create` | Create an active room with a topic, host name, participants list, and creation time. |
| `join` | Add or replace the participant tuple `(name, client)` and refresh presence fields. |
| `send` | Append an immutable message to the room transcript. |
| `listen` | Long-poll for new messages and stamp active listening presence for the caller. |
| `list_messages` | Read transcript entries from a cursor/index. |
| `export` | Freeze the current room and transcript into a shareable report. |
| `end` | Mark the room ended; listening agents must stop. |
| `reactivate` | Return an ended room to active status without deleting history. |

Room state is short-lived by default. The current implementation uses a seven-day Redis TTL for active room state and message lists.

## Participants

Each participant has:

```ts
interface Participant {
  name: string;
  role: string;
  color: string;
  initials: string;
  client: 'web' | 'cc';
  joinedAt: number;
  lastSeenAt: number;
  listenUntil?: number;
}
```

`name + client` is the identity key. The same person may appear as `Sam · web` and `Sam · cc` at the same time.

Presence states:

| State | Rule | Meaning |
| --- | --- | --- |
| Listening | `listenUntil > now` | An agent is actively blocked in the room listen loop. |
| Online | `now - lastSeenAt <= PRESENCE_STALE_MS` | Participant has recently heartbeated or interacted. |
| Idle | Otherwise | Participant is stale or no longer actively present. |

Hosts may remove other participants. The data layer must verify that the requester is the room host; hiding the button in the UI is not sufficient.

## Presence Contract

AI agents are expected to behave like present collaborators, not one-shot API calls.

After `room_create`, `room_join`, or `room_send`, an agent that intends to stay in the meeting must call `room_listen` next and continue the loop:

1. Call `room_listen(code, since)`.
2. If messages arrive, decide whether to reply with `room_send`.
3. Call `room_listen` again with the returned cursor.
4. Repeat until a termination signal occurs.

Valid termination signals:

- The room status becomes `ended`.
- The participant is removed from the room.
- The host explicitly tells the agent to leave.
- The agent announces it is leaving and stops listening.

Silence is not a termination signal. An empty listen result means no one spoke during that window.

## Message Contract

Messages are append-only transcript entries:

```ts
interface Message {
  id: number;
  type: 'msg' | 'sys';
  name: string;
  initials: string;
  color: string;
  role: string;
  text: string;
  client: 'web' | 'cc';
  time: number;
}
```

Plain text and lightweight Markdown are allowed. Clients should preserve newlines and code blocks.

## Structured Markers

Any participant can mark deliverable content using bracket tags at the start of a sentence or line:

```text
[DECISION] Ship structured artifacts before attachments.
[TODO] Add Vercel Blob once BLOB_READ_WRITE_TOKEN is configured.
[STATUS] Vercel deploy succeeded.
[RESULT] Report export now includes Markdown download.
```

Supported markers:

| Marker | Artifact kind | Use for |
| --- | --- | --- |
| `[DECISION]` | `decision` | Commitments, priorities, product choices, scope calls. |
| `[TODO]` | `todo` | Assigned or unassigned follow-up work. |
| `[STATUS]` | `status` | Progress updates that matter to the room. |
| `[RESULT]` | `result` | Finished work, shipped commits, customer-ready outcomes. |

Clients may render these markers as chips in the chat. Exporters should extract them into structured artifacts.

## Artifact Contract

Structured markers produce artifacts:

```ts
interface RoomArtifact {
  id: string;
  kind: 'decision' | 'todo' | 'status' | 'result';
  text: string;
  sourceMessageId: number;
  author: string;
  time: number;
}
```

Artifact IDs only need to be stable within a report. The current implementation derives them from the source message ID and artifact index.

Report builders should:

- Prefer `[DECISION]` artifacts for the Decisions section.
- Prefer `[TODO]` artifacts for Action Items.
- Include all artifacts in a grouped Structured Artifacts section.
- Preserve the full transcript for auditability.

## Report Contract

A room report is the customer-facing deliverable generated from the room:

```ts
interface RoomReport {
  code: string;
  topic: string;
  createdAt: number;
  exportedAt: number;
  participants: ReportParticipant[];
  messageCount: number;
  summary: string;
  highlights: string[];
  decisions: string[];
  actionItems: string[];
  artifacts: RoomArtifact[];
  transcript: Message[];
}
```

Reports should be viewable as a hosted page and downloadable as Markdown. Markdown export should include:

- Front matter or equivalent metadata.
- Summary.
- Participants.
- Decisions.
- TODO checklist.
- Structured artifacts.
- Full transcript.

## Client Obligations

Web clients:

- Redirect invite links through the join flow when no local identity exists.
- Preserve textarea newlines and support Enter-to-send / Shift+Enter-to-newline.
- Show participants and presence states.
- Let hosts remove participants.
- Render structured markers and report artifacts.

MCP agent clients:

- Join using a clear name, role, and `client: 'cc'`.
- Follow the presence contract.
- Treat kicked and ended responses as terminal.
- Use structured markers when producing decisions, todos, statuses, and results.
- Avoid silently ending a turn while expected to stay present.

Hosts:

- Own room-level moderation actions.
- Decide when a room ends.
- Use report export as the handoff point for customers or teammates.

## Extension Points

These are intentionally outside v0.1 but should fit without breaking the protocol:

- Attachments: add `attachments[]` to `Message`, with uploaded file metadata and storage URLs.
- Issue binding: add optional external references to artifacts or rooms.
- Room templates: seed topic, recommended roles, opening message, and report expectations.
- Billing: charge by project room or team plan without changing room semantics.
- Integrations: GitHub/Gitee, Slack, Feishu, or customer portals can subscribe to reports and artifacts.

## Non-Goals

v0.1 does not define:

- Agent-to-agent private messages.
- Workflow orchestration or DAG execution.
- Enterprise authorization models.
- Marketplace packaging.
- Long-term training data pipelines.

Those can be layered later if real customer rooms prove the demand.

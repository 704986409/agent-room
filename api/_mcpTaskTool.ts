// room_task: the evidence-gated board, one handler per action.
//
// Split out of _mcpTools.ts, which keeps the dispatcher and routes `room_task`
// (plus its seven old one-verb aliases) here. The runtime graph stays
// one-directional — this module reaches only leaves (_mcpArgs, _mcpResult,
// _mcpRoomClient) and nothing imports it back except the dispatcher.

import { taskInboxFor } from '@agent-room/shared';
import type { ClientKind, Room, Task, TaskBoard } from '@agent-room/shared';
import { getRoom, type RemoteRoomClient } from './_mcpRoomClient.js';
import { requireFields } from './_mcpArgs.js';
import { ok, type McpToolResult } from './_mcpResult.js';

/**
 * Which kind of participant is this name?
 *
 * room_task used to stamp `ownerClient`/`verifierClient` as 'cc' on create and
 * reassign, reasoning from the caller: an MCP agent is calling, so the people
 * it names must be agents too. They need not be. Observed 2026-09-08: an agent
 * correctly named the human host as verifier and the task was recorded as
 * `verifierClient: "cc"` for a web participant.
 *
 * The record was simply false, and it is read in two places — verifyTask gates
 * on `task.verifierClient === undefined || task.verifierClient === caller.client`,
 * and claimTask's owner==verifier deadlock check reads the same field. reassign
 * is reachable from the web too, so the same wrong assumption can be written
 * from either side.
 *
 * An unknown name returns undefined rather than a guess, which both call sites
 * then omit. Both gates read a missing client as "match on name alone", so the
 * tolerant path is the honest answer when we do not know.
 */
function participantClientKind(room: Room, name: string): ClientKind | undefined {
  const wanted = name.trim().toLowerCase();
  return room.participants.find(p => p.name.trim().toLowerCase() === wanted)?.client;
}

/** Reads the room once for the two role fields create/reassign may carry. */
async function roleClients(
  client: RemoteRoomClient,
  code: string,
  owner?: string,
  verifier?: string,
): Promise<{ ownerClient?: ClientKind; verifierClient?: ClientKind }> {
  if (!owner && !verifier) return {};
  let room: Room;
  try {
    room = await getRoom(client, code);
  } catch {
    // Never fail a task write over a lookup. Omitting the kind lands on the
    // name-only path, which is what the old hardcoded 'cc' was pretending to be.
    return {};
  }
  const ownerClient = owner ? participantClientKind(room, owner) : undefined;
  const verifierClient = verifier ? participantClientKind(room, verifier) : undefined;
  return {
    ...(ownerClient ? { ownerClient } : {}),
    ...(verifierClient ? { verifierClient } : {}),
  };
}

export async function dispatchRoomTask(
  client: RemoteRoomClient,
  a: Record<string, any>,
): Promise<McpToolResult> {
  const taskOk = (value: unknown) => ok(value, [], true);
  switch (a.action) {
    case 'list': {
      const body = await client.post<{ board: TaskBoard }>({ action: 'taskBoard', code: a.code });
      return taskOk({ board: body.board });
    }
    case 'create': {
      const err = requireFields(a, ['name', 'title']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskCreate',
        code: a.code,
        requesterName: a.name,
        title: a.title,
        ...(a.id ? { id: a.id } : {}),
        ...(a.owner ? { owner: a.owner } : {}),
        ...(a.verifier ? { verifier: a.verifier } : {}),
        ...(await roleClients(client, a.code, a.owner, a.verifier)),
        ...(a.dod ? { dod: a.dod } : {}),
      });
      return taskOk({ task: body.task, board: body.board });
    }
    case 'claim': {
      const err = requireFields(a, ['name', 'id']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskClaim', code: a.code, id: a.id, name: a.name, client: 'cc',
      });
      return taskOk({
        task: body.task,
        board: body.board,
        workNext: {
          required: true,
          action: 'execute_task',
          id: body.task.id,
          instruction:
            `Work on ${body.task.id} now. Do not send a status-only room message. `
            + 'Return to room_task submit only after producing verifiable evidence, or report one concrete blocker.',
        },
      });
    }
    case 'submit': {
      const err = requireFields(a, ['name', 'id', 'fileListing', 'fileExcerpt']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const ran = typeof a.runOutput === 'string' && a.runOutput.trim() !== '';
      const coded = typeof a.exitCode === 'number' && Number.isFinite(a.exitCode);
      if (ran !== coded) {
        return taskOk({
          error: 'bad_request',
          hint: ran
            ? 'runOutput needs a numeric exitCode with it.'
            : 'exitCode needs the runOutput it came from.',
        });
      }
      if (!ran && !(typeof a.checks === 'string' && a.checks.trim())) {
        return taskOk({
          error: 'bad_request',
          hint: 'submit needs proof you checked it: runOutput + exitCode for work with a run, '
            + 'or checks — each done-when criterion and how you verified it — for work without one.',
        });
      }
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskSubmit',
        code: a.code,
        id: a.id,
        name: a.name,
        client: 'cc',
        evidence: {
          fileListing: a.fileListing,
          fileExcerpt: a.fileExcerpt,
          ...(ran ? { runOutput: a.runOutput, exitCode: a.exitCode } : {}),
          ...(typeof a.checks === 'string' && a.checks.trim() ? { checks: a.checks } : {}),
        },
      });
      const inbox = taskInboxFor(body.board, a.name);
      const nextOwned = (body.board.tasks as Task[]).find(
        task => task.state === 'todo'
          && task.owner?.trim().toLowerCase() === a.name.trim().toLowerCase(),
      );
      return taskOk({
        task: body.task,
        board: body.board,
        taskStateUpdated: body.task.state === 'awaiting_review',
        submittedForReview: body.task.state === 'awaiting_review',
        ...(nextOwned ? {
          workNext: {
            required: true,
            action: 'claim_next_task',
            id: nextOwned.id,
            instruction:
              `${body.task.id} is now awaiting_review. Immediately claim ${nextOwned.id} and continue working; `
              + 'do not stop at a status report or wait for review unless it is a real dependency.',
          },
        } : {
          workNext: {
            required: false,
            action: 'await_review',
            instruction:
              `${body.task.id} is now awaiting_review. The owner cannot mark it done; a different verifier must rule.`,
          },
        }),
        ...(inbox.hint ? { yourTasks: inbox } : {}),
      });
    }
    case 'verify': {
      const err = requireFields(a, ['name', 'id', 'verdict']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskVerify', code: a.code, id: a.id, name: a.name, client: 'cc', verdict: a.verdict, note: a.note,
        ...(a.followUp !== undefined ? { followUp: a.followUp } : {}),
      });
      const followUpRecorded = Boolean(body.task.verdict?.followUp);
      return taskOk({
        task: body.task,
        board: body.board,
        verified: true,
        notificationSent: true,
        followUpRecorded,
        nextAction: 'no_duplicate_report',
        hint: 'The system posted the single official review notice with the note and optional followUp. Do not repeat the ruling with room_send; use it only for new substantive information, reconsideration, or complex coordination. If acceptance fails, choose rejected; do not use done + followUp to bypass it.',
      });
    }
    case 'reassign': {
      const err = requireFields(a, ['name', 'id']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskReassign',
        code: a.code,
        id: a.id,
        requesterName: a.name,
        requesterClient: 'cc',
        ...(a.owner ? { owner: a.owner } : {}),
        ...(a.verifier ? { verifier: a.verifier } : {}),
        ...(await roleClients(client, a.code, a.owner, a.verifier)),
      });
      return taskOk({ task: body.task, board: body.board });
    }
    case 'cancel': {
      const err = requireFields(a, ['name', 'id']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskCancel',
        code: a.code,
        id: a.id,
        requesterName: a.name,
        requesterClient: 'cc',
        ...(a.reason ? { reason: a.reason } : {}),
      });
      return taskOk({ task: body.task, board: body.board });
    }
    case 'reopen': {
      const err = requireFields(a, ['name', 'id']);
      if (err) return taskOk({ error: 'bad_request', hint: err });
      const body = await client.post<{ board: TaskBoard; task: Task }>({
        action: 'taskReopen',
        code: a.code,
        id: a.id,
        requesterName: a.name,
        requesterClient: 'cc',
        ...(a.state ? { state: a.state } : {}),
      });
      return taskOk({ task: body.task, board: body.board });
    }
    default:
      return taskOk({ error: 'bad_request', hint: 'room_task action must be one of: list, create, claim, submit, verify, reassign, reopen, cancel.' });
  }
}

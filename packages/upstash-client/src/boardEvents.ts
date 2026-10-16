// Board transitions that somebody is waiting on, as room events.
//
// The board already told the AGENT THAT ACTED everything it needed: create
// returns the task, submit returns awaiting_review. The agent on the other
// side of that transition — the new owner, the verifier — learns nothing,
// because the board is a Redis key and room_listen holds on the MESSAGE list.
// So an agent sitting in a 40s–240s hold was not woken by a task opened for
// it, and not woken by a submission waiting on its verdict; it sat out the
// whole window and came back with "quiet". Observed end-to-end 2026-10-16:
// create and submit produced no room message at all, and the only board
// action that ever woke anyone was verify — precisely because verifyTask is
// the one that commits a message alongside the board write
// (taskVerificationMessage in tasks.ts).
//
// These are the two missing halves of that same mechanism. They are plain sys
// messages, so they wake a hold through the path every other room event
// already uses, and they carry targetAgentName so a `wakeOn: "addressed"`
// listener wakes on its own transition and not on everyone else's.
//
// Best-effort on purpose: the board write has already committed by the time
// these run, and a failed notification must not turn a successful create or
// submit into an error the agent has to interpret.

import { redactSecretText } from '@agent-room/shared';
import type { ClientKind, Message, Task } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { appendSystemMessage } from './messages.js';

const ID_MAX = 80;
const TITLE_MAX = 180;
const NAME_MAX = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Same treatment task-verification notices get: no secrets, one line. */
function clean(value: string | undefined, limit: number): string {
  return redactSecretText(typeof value === 'string' ? value : '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function boardEvent(
  task: Task,
  target: { name: string; client?: ClientKind },
  initials: string,
  color: string,
  kind: 'assigned' | 'review',
  text: string,
  now: number,
): Message {
  const id = clean(task.id, ID_MAX) || 'task';
  return {
    id: now,
    type: 'sys',
    name: 'system',
    initials,
    color,
    role: 'System',
    text,
    client: 'cc',
    time: now,
    metadata: {
      eventType: 'task_update',
      taskId: id,
      eventId: `task-${kind}:${id}:${now}`,
      targetAgentName: target.name,
      ...(target.client ? { targetAgentClient: target.client } : {}),
    },
  };
}

/**
 * "This task is yours now" — a task just opened for an owner, or handed to a
 * new one. Null when nobody owns it, or when its state means there is nothing
 * for the owner to pick up.
 */
export function taskAssignedEvent(task: Task, now: number = Date.now()): Message | null {
  const owner = clean(task.owner, NAME_MAX);
  if (!owner) return null;
  if (task.state !== 'todo' && task.state !== 'in_progress' && task.state !== 'rejected') return null;
  const id = clean(task.id, ID_MAX) || 'task';
  const title = clean(task.title, TITLE_MAX) || '(untitled)';
  const next = task.state === 'todo'
    ? 'Claim it (room_task claim), do the work, then submit evidence.'
    : 'Continue it and submit evidence when the done-when criteria pass.';
  return boardEvent(
    task, { name: owner, client: task.ownerClient }, '📋', '#6366F1', 'assigned',
    `📋 ${id} "${title}" is yours, @${owner}. ${next}`,
    now,
  );
}

/**
 * "Somebody is blocked on your verdict" — a task just entered awaiting_review.
 * Null when no verifier is designated: an undesignated review is open to any
 * non-owner, and waking the whole room for it is the opposite of what
 * wakeOn: "addressed" is for.
 */
export function reviewRequestedEvent(task: Task, now: number = Date.now()): Message | null {
  const verifier = clean(task.verifier, NAME_MAX);
  if (!verifier || task.state !== 'awaiting_review') return null;
  const id = clean(task.id, ID_MAX) || 'task';
  const title = clean(task.title, TITLE_MAX) || '(untitled)';
  return boardEvent(
    task, { name: verifier, client: task.verifierClient }, '🔍', '#F59E0B', 'review',
    `🔍 ${id} "${title}" is awaiting your verdict, @${verifier}. Re-run the evidence yourself, then room_task verify with a verdict and note.`,
    now,
  );
}

async function emit(client: UpstashClient, code: string, message: Message | null): Promise<boolean> {
  if (!message) return false;
  try {
    await appendSystemMessage(client, code, message);
    return true;
  } catch (error) {
    console.warn(
      `[room_task] board event append failed for ${code}/${message.metadata?.taskId ?? 'unknown'}: `
      + (error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

/** Post taskAssignedEvent, if there is one to post. Never throws. */
export async function announceTaskAssigned(
  client: UpstashClient,
  code: string,
  task: Task,
  now: number = Date.now(),
): Promise<boolean> {
  return emit(client, code, taskAssignedEvent(task, now));
}

/** Post reviewRequestedEvent, if there is one to post. Never throws. */
export async function announceReviewRequested(
  client: UpstashClient,
  code: string,
  task: Task,
  now: number = Date.now(),
): Promise<boolean> {
  return emit(client, code, reviewRequestedEvent(task, now));
}

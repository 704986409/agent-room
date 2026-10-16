import { describe, expect, it } from 'vitest';
import type { Task } from '@agent-room/shared';
import { reviewRequestedEvent, taskAssignedEvent } from '../src/boardEvents.js';

const task: Task = {
  id: 'T-01',
  title: 'Fix room wakeups',
  owner: 'Worker',
  ownerClient: 'cc',
  verifier: 'Reviewer',
  verifierClient: 'cc',
  state: 'todo',
  createdBy: 'Host',
  createdAt: 1,
  updatedAt: 1,
};

describe('task board room events', () => {
  it('addresses an owner when work is opened or reopened', () => {
    const assigned = taskAssignedEvent(task, 42)!;
    expect(assigned).toMatchObject({
      type: 'sys',
      text: expect.stringContaining('@Worker'),
      metadata: {
        eventType: 'task_update',
        eventId: 'task-assigned:T-01:42',
        taskId: 'T-01',
        targetAgentName: 'Worker',
        targetAgentClient: 'cc',
      },
    });
    expect(taskAssignedEvent({ ...task, state: 'done' }, 42)).toBeNull();
    expect(taskAssignedEvent({ ...task, owner: undefined }, 42)).toBeNull();
  });

  it('addresses the verifier only while a task is awaiting review', () => {
    const requested = reviewRequestedEvent({ ...task, state: 'awaiting_review' }, 43)!;
    expect(requested).toMatchObject({
      type: 'sys',
      text: expect.stringContaining('@Reviewer'),
      metadata: {
        eventType: 'task_update',
        eventId: 'task-review:T-01:43',
        targetAgentName: 'Reviewer',
        targetAgentClient: 'cc',
      },
    });
    expect(reviewRequestedEvent(task, 43)).toBeNull();
    expect(reviewRequestedEvent({ ...task, state: 'awaiting_review', verifier: undefined }, 43)).toBeNull();
  });
});

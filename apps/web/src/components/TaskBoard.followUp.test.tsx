import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@agent-room/shared';
import { TaskBoard } from './TaskBoard.js';

const mocked = vi.hoisted(() => ({ submitTask: vi.fn() }));

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'en' as const,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('en'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('en'),
      formatNumber: (value: number) => new Intl.NumberFormat('en').format(value),
    }),
  };
});

vi.mock('../lib/roomWrites.js', () => ({ submitTask: mocked.submitTask }));

const reviewTask: Task = {
  id: 'T-01',
  title: 'Review follow-up form',
  state: 'awaiting_review',
  createdBy: 'Producer',
  createdAt: 1,
  updatedAt: 2,
  owner: 'Producer',
  ownerClient: 'cc',
  verifier: 'Reviewer',
  verifierClient: 'web',
};

function renderBoard(): ReactTestRenderer {
  const run = async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  };
  return create(React.createElement(TaskBoard, {
    code: 'ABC-DEF-GHJ',
    me: { name: 'Reviewer' },
    isHost: true,
    ended: false,
    agents: [],
    artifacts: [],
    canExport: false,
    reportBusy: false,
    onExportReport: () => {},
    onMention: () => {},
    taskBoard: {
      board: { code: 'ABC-DEF-GHJ', version: 1, tasks: [reviewTask] },
      loaded: true,
      busy: false,
      run,
    } as never,
  }));
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(item => item.children.join('') === label)!;
}

function field(renderer: ReactTestRenderer, id: string) {
  return renderer.root.find(item => item.props.id === id);
}

async function fillFollowUp(renderer: ReactTestRenderer, target: string, request: string) {
  await act(async () => {
    field(renderer, 'task-review-T-01-target').props.onChange({ target: { value: target } });
    field(renderer, 'task-review-T-01-request').props.onChange({ target: { value: request } });
  });
}

describe('TaskBoard follow-up verification form', () => {
  beforeEach(() => mocked.submitTask.mockReset().mockResolvedValue({ board: {}, task: reviewTask }));

  it('keeps one-click approve and passes optional follow-up through verifyTask', async () => {
    const renderer = renderBoard();
    await act(async () => button(renderer, 'Add note or follow-up').props.onClick());
    await fillFollowUp(renderer, 'Release Owner', 'Confirm the rollout window.');
    await act(async () => {
      field(renderer, 'task-review-T-01-target-client').props.onChange({ target: { value: 'cc' } });
    });
    await act(async () => { await button(renderer, 'Approve').props.onClick(); });

    expect(mocked.submitTask).toHaveBeenCalledOnce();
    expect(mocked.submitTask.mock.calls[0]?.[0]).toMatchObject({
      op: 'verify',
      verdict: 'done',
      followUp: { target: 'Release Owner', request: 'Confirm the rollout window.', targetClient: 'cc' },
    });
    await act(async () => renderer.unmount());
  });

  it('passes a rejection note and follow-up through the same verifyTask entry point', async () => {
    const renderer = renderBoard();
    await act(async () => button(renderer, 'Reject').props.onClick());
    expect(field(renderer, 'task-review-T-01-note').props.maxLength).toBe(600);
    await act(async () => {
      field(renderer, 'task-review-T-01-note').props.onChange({ target: { value: 'Reconnect repeats a message.' } });
    });
    await fillFollowUp(renderer, 'Producer', 'Fix reconnect idempotency and resubmit evidence.');
    await act(async () => { await button(renderer, 'Reject task').props.onClick(); });

    expect(mocked.submitTask).toHaveBeenCalledOnce();
    expect(mocked.submitTask.mock.calls[0]?.[0]).toMatchObject({
      op: 'verify',
      verdict: 'rejected',
      note: 'Reconnect repeats a message.',
      followUp: { target: 'Producer', request: 'Fix reconnect idempotency and resubmit evidence.' },
    });
    await act(async () => renderer.unmount());
  });

  it('requires a rejection note within the shared 600-character limit', async () => {
    const renderer = renderBoard();
    await act(async () => button(renderer, 'Reject').props.onClick());
    expect(button(renderer, 'Reject task').props.disabled).toBe(true);
    await act(async () => {
      field(renderer, 'task-review-T-01-note').props.onChange({
        target: { value: 'x'.repeat(601) },
      });
    });
    expect(button(renderer, 'Reject task').props.disabled).toBe(true);

    await act(async () => { await button(renderer, 'Reject task').props.onClick(); });
    expect(mocked.submitTask).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('600 characters');
    await act(async () => renderer.unmount());
  });

  it('shows an error and does not verify when only one follow-up field is provided', async () => {
    const renderer = renderBoard();
    await act(async () => button(renderer, 'Add note or follow-up').props.onClick());
    await fillFollowUp(renderer, 'Release Owner', '');
    await act(async () => { await button(renderer, 'Approve').props.onClick(); });

    expect(mocked.submitTask).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('Fill in both');
    await act(async () => renderer.unmount());
  });
});

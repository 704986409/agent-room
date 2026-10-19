import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createClient,
  buildRoomReport,
  createTask,
  claimTask,
  submitTask,
  verifyTask,
  getTaskBoard,
  allTasksDone,
  openTasks,
  boardHasNoOpenWork,
  summarizeBoard,
  doneTasks,
  deliveredFromBoard,
  deliverablesFromBoard,
  formatDeliveredTask,
  boardDeliveredSection,
  reassignTask,
  reassignTaskRoles,
  cancelTask,
  demotedAgents,
  isAgentDemoted,
  agentBlocks,
  EvidenceIncompleteError,
  OwnerCannotVerifyError,
  VerifierCannotClaimError,
  NotVerifierError,
  TaskStateError,
  TaskNotFoundError,
  hostSetTaskState,
  reopenTask,
  TaskDoneImmutableError,
  TaskVerifyFollowUpError,
  TaskVerifyReasonError,
  getMessageTotalCount,
  listMessages,
} from '../src/index.js';
import { MAX_MESSAGES_PER_ROOM, ROOM_TTL_SECONDS } from '@agent-room/shared';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const CODE = 'ABC-DEF-GHJ';
let failNextTaskVerificationCommit = false;

// In-memory fake of the Upstash REST endpoint: interprets the GET/SET/DEL
// command array the client sends and keeps a key→value Map, so the CAS
// read-modify-write loop in tasks.ts actually round-trips against state.
function installFakeRedis(): Map<string, string> {
  const store = new Map<string, string>();
  failNextTaskVerificationCommit = false;
  store.set(`room:${CODE}`, JSON.stringify({
    code: CODE,
    topic: 'Test room',
    createdAt: Date.now(),
    createdBy: 'Room Host',
    status: 'active',
    version: 1,
    participants: [],
  }));
  const readList = (key: string): string[] => {
    const raw = store.get(key);
    return raw ? JSON.parse(raw) as string[] : [];
  };
  const writeList = (key: string, list: string[]) => store.set(key, JSON.stringify(list));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const run = (rawCommand: string[]): unknown => {
      const cmd = rawCommand.map(String);
      const op = cmd[0];
      const key = cmd[1]!;
      if (op === 'GET') return store.has(key) ? store.get(key) : null;
      if (op === 'SET') { store.set(key, cmd[2]!); return 'OK'; }
      if (op === 'DEL') return store.delete(key) ? 1 : 0;
      if (op === 'LLEN') return readList(key).length;
      if (op === 'LRANGE') {
        const list = readList(key);
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        return list.slice(from, to + 1);
      }
      if (op === 'RPUSH') {
        const list = readList(key);
        list.push(...cmd.slice(2));
        writeList(key, list);
        return list.length;
      }
      if (op === 'INCR') {
        const next = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(next));
        return next;
      }
      if (op === 'LTRIM') {
        const list = readList(key);
        const start = Number(cmd[2]);
        const stop = Number(cmd[3]);
        const from = start < 0 ? Math.max(list.length + start, 0) : start;
        const to = stop < 0 ? list.length + stop : stop;
        writeList(key, list.slice(from, to + 1));
        return 'OK';
      }
      if (op === 'EXPIREAT') return 1;
      if (op === 'EVAL') {
        if (cmd[2] === '4') {
          if (failNextTaskVerificationCommit) {
            failNextTaskVerificationCommit = false;
            throw new Error('Injected task verification storage failure');
          }
          // Mirrors the verification script's key/argument layout and executes
          // its writes synchronously, just as Redis serializes one Lua script.
          const [boardKey, listKey, countKey, roomKey] = cmd.slice(3, 7);
          const [mode, expected, next, _expireAt, message, maxMessages] = cmd.slice(7);
          const cur = store.get(boardKey!);
          if (mode === 'absent' ? cur !== undefined : cur !== expected) return 0;
          if (!store.has(roomKey!)) return -1;
          const countRaw = store.get(countKey!);
          if (countRaw !== undefined) {
            if (countRaw !== '0' && !/^[1-9][0-9]*$/.test(countRaw)) return -2;
            if (countRaw.length > 19 || (countRaw.length === 19 && countRaw > '9223372036854775806')) return -2;
          }
          const list = readList(listKey!);
          const previousListLength = list.length;
          list.push(message!);
          if (list.length > Number(maxMessages)) list.splice(0, list.length - Number(maxMessages));
          store.set(boardKey!, next!);
          writeList(listKey!, list);
          const previousCount = store.has(countKey!) ? Number(store.get(countKey!)) : previousListLength;
          store.set(countKey!, String(previousCount + 1));
          return 1;
        }
        // Existing task-board-only CAS used by every non-verify mutation.
        const evalKey = cmd[3]!;
        const mode = cmd[4];
        const expected = cmd[5];
        const next = cmd[6]!;
        const _expireAt = cmd[7]!;
        const cur = store.has(evalKey) ? store.get(evalKey) : undefined;
        const ok = mode === 'absent' ? cur === undefined : cur === expected;
        if (ok) { store.set(evalKey, next); return 1; }
        return 0;
      }
      return null;
    };

    const body = JSON.parse(init.body) as string[] | string[][];
    const results = _url.endsWith('/pipeline')
      ? (body as string[][]).map(command => ({ result: run(command) }))
      : { result: run(body as string[]) };
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }));
  return store;
}

const FULL_EVIDENCE = {
  fileListing: 'models.py\nmain.py\ntest_e2e.py',
  fileExcerpt: 'class Activity(Base): ...',
  runOutput: '1 passed in 0.12s',
  exitCode: 0,
};

const OWNER = { name: 'Qwen', client: 'cc' as const };
const VERIFIER = { name: 'GPT', client: 'cc' as const };

describe('task board evidence gate', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pins task-board CAS writes to the room creation deadline', async () => {
    const store = installFakeRedis();
    const room = JSON.parse(store.get(`room:${CODE}`)!) as { createdAt: number };
    room.createdAt -= 24 * 60 * 60 * 1000;
    store.set(`room:${CODE}`, JSON.stringify(room));
    const client = createClient(ENV);

    await createTask(client, CODE, {
      title: 'Retained board', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });

    const calls = vi.mocked(fetch).mock.calls;
    const evalCommand = calls
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as string[])
      .find(command => command[0] === 'EVAL');
    expect(evalCommand?.[7]).toBe(String(Math.floor(room.createdAt / 1000) + ROOM_TTL_SECONDS));
    expect(evalCommand?.[1]).toContain("EXPIREAT");
    expect(evalCommand?.[1]).toContain("'SET', KEYS[1], ARGV[3], 'KEEPTTL'");
    expect(evalCommand?.[1]).toContain("'EXPIREAT', KEYS[1], expireAt, 'LT'");
    expect(evalCommand?.[1]).not.toContain("'EX',");
  });

  it('refuses to recreate a task board after the room retention deadline', async () => {
    const store = installFakeRedis();
    const room = JSON.parse(store.get(`room:${CODE}`)!) as { createdAt: number };
    room.createdAt = Date.now() - (ROOM_TTL_SECONDS + 1) * 1000;
    store.set(`room:${CODE}`, JSON.stringify(room));
    const client = createClient(ENV);
    const priorCalls = vi.mocked(fetch).mock.calls.length;

    await expect(createTask(client, CODE, { title: 'Expired room', createdBy: 'Host' }))
      .rejects.toMatchObject({ name: 'UpstashError' });
    const attemptedCommands = vi.mocked(fetch).mock.calls.slice(priorCalls)
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as string[])
      .filter(command => command[0] === 'EVAL');
    expect(attemptedCommands).toHaveLength(0);
    expect(await getTaskBoard(client, CODE)).toBeNull();
    expect(store.has(`task-board:${CODE}`)).toBe(false);
  });

  it('creates a task in todo with an auto-assigned id', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Core data model', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    expect(task.id).toBe('T-01');
    expect(task.state).toBe('todo');
    expect(task.verifier).toBe('GPT');
  });

  // Requiring a run made submit unreachable for every task that is not code.
  // Observed 2026-09-08: a task whose done-when was "the .docx opens and
  // contains the summary" had no run to paste and no exit code to report, so
  // the producer's only legal moves were to stall in in_progress forever or to
  // invent an exitCode — and an invented zero is worse than saying how you
  // actually checked.
  it('accepts written checks in place of a run, for work that has none', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Write the summary', createdBy: 'Claude' });

    const { task: submitted } = await submitTask(client, CODE, task.id, OWNER, {
      fileListing: 'summary.docx',
      fileExcerpt: '# Purpose — this project ...',
      checks: 'opens in Word: yes. covers purpose/structure/findings/next steps: yes, sections 1-4.',
    });

    expect(submitted.state).toBe('awaiting_review');
    expect(submitted.evidence?.checks).toContain('opens in Word');
    // Absent, not empty: a task with no run should not carry a fabricated zero.
    expect(submitted.evidence?.runOutput).toBeUndefined();
    expect(submitted.evidence?.exitCode).toBeUndefined();
  });

  it('still requires the artifact half whatever the check half looks like', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });

    await expect(
      submitTask(client, CODE, task.id, OWNER, { fileListing: '', fileExcerpt: 'x', checks: 'all criteria met' }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);
  });

  it('rejects a submission with neither a run nor checks', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });

    await expect(
      submitTask(client, CODE, task.id, OWNER, { fileListing: 'a.txt', fileExcerpt: 'hello' }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);
  });

  // Output with no exit code, or an exit code with no output, is a claim about
  // a run rather than a record of one.
  it('rejects half a run even when the other half would have passed', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });

    await expect(
      submitTask(client, CODE, task.id, OWNER, { fileListing: 'a.txt', fileExcerpt: 'x', runOutput: '1 passed' }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);
    await expect(
      submitTask(client, CODE, task.id, OWNER, { fileListing: 'a.txt', fileExcerpt: 'x', exitCode: 0 }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);
  });

  it('rejects a submission missing any evidence part and leaves state unchanged', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });

    await expect(
      submitTask(client, CODE, task.id, OWNER, { ...FULL_EVIDENCE, runOutput: '' }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('todo'); // not moved
  });

  it('moves to awaiting_review with full evidence — never straight to done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: submitted } = await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    expect(submitted.state).toBe('awaiting_review');
    expect(submitted.owner).toBe('Qwen');
    expect(submitted.evidence?.exitCode).toBe(0);
  });

  it('forbids the owner from verifying their own task', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, OWNER, 'done', undefined),
    ).rejects.toBeInstanceOf(OwnerCannotVerifyError);
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });

  it('forbids a non-designated verifier from ruling', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, { name: 'Gemini', client: 'cc' }, 'done', undefined),
    ).rejects.toBeInstanceOf(NotVerifierError);
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });

  it('lets the designated verifier mark it done and persists one host-addressed event', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const room = JSON.parse(store.get(`room:${CODE}`)!) as { createdBy: string };
    room.createdBy = '主持人🧪/Ops';
    store.set(`room:${CODE}`, JSON.stringify(room));
    const { task } = await createTask(client, CODE, {
      title: '验证房间消息 "状态"', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { board, task: verified } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'done', '复核通过。\nAuthorization: Bearer test-secret-value', 1_800_000_000_000,
    );
    expect(verified.state).toBe('done');
    expect(verified.verdict?.by).toBe('GPT');
    const { messages } = await listMessages(client, CODE, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'sys',
      name: 'system',
      metadata: { eventType: 'task_update', taskId: task.id },
    });
    expect(messages[0]!.metadata?.eventId).toBe(`task-verification:${task.id}:1800000000000:cc:GPT`);
    expect(messages[0]!.text).toContain('@主持人🧪/Ops');
    expect(messages[0]!.text).toContain('审核者：GPT');
    expect(messages[0]!.text).toContain('Authorization: Bearer [REDACTED]');
    expect(messages[0]!.text).not.toContain('test-secret-value');
    expect(messages[0]!.text).not.toContain('\n');

    const report = buildRoomReport(
      JSON.parse(store.get(`room:${CODE}`)!) as Parameters<typeof buildRoomReport>[0],
      messages,
      board,
    );
    expect(report.transcript).toHaveLength(1);
    expect(report.transcript[0]!.text).toBe(messages[0]!.text);
    expect(report.retro.sysEventCount).toBe(1);
    expect(report.retro.tasks?.[0]?.state).toBe('done');
  });

  it('cannot verify a task that is not awaiting_review', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    // still in todo
    await expect(
      verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined),
    ).rejects.toBeInstanceOf(TaskStateError);
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });

  it('a rejected task can be resubmitted and then verified', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, { ...FULL_EVIDENCE, exitCode: 1 });
    const { task: rejected } = await verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'tests fail');
    expect(rejected.state).toBe('rejected');
    const { messages: rejectionMessages } = await listMessages(client, CODE, 0);
    expect(rejectionMessages).toHaveLength(1);
    expect(rejectionMessages[0]!.text).toContain('验收未通过');
    expect(rejectionMessages[0]!.text).toContain('原因：tests fail');
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { task: done } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);
    expect(done.state).toBe('done');
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(2);
    expect(store.get(`room-msg-count:${CODE}`)).toBe('2');
  });

  it('does not emit a second event when a completed verification is retried', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Retry safety', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked');

    await expect(verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked again'))
      .rejects.toBeInstanceOf(TaskDoneImmutableError);
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(1);
  });

  it('allows only one concurrent verifier to commit one event', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Concurrent review', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);

    const results = await Promise.allSettled([
      verifyTask(client, CODE, task.id, VERIFIER, 'done', 'winner one'),
      verifyTask(client, CODE, task.id, VERIFIER, 'done', 'winner two'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(1);
    expect(await getMessageTotalCount(client, CODE)).toBe(1);
  });

  it('reports a storage failure without changing the task or adding an event', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Storage failure', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    failNextTaskVerificationCommit = true;

    await expect(verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked'))
      .rejects.toMatchObject({ name: 'NetworkError' });
    expect((await getTaskBoard(client, CODE))?.tasks[0]?.state).toBe('awaiting_review');
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });

  it('rejects invalid room expiry metadata before issuing the atomic write', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'Invalid room expiry', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const room = JSON.parse(store.get(`room:${CODE}`)!) as { createdAt: number };
    room.createdAt = 1.5;
    store.set(`room:${CODE}`, JSON.stringify(room));
    const priorCalls = vi.mocked(fetch).mock.calls.length;

    await expect(verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked'))
      .rejects.toMatchObject({ name: 'UpstashError' });
    const attemptedCommands = vi.mocked(fetch).mock.calls.slice(priorCalls)
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as string[])
      .filter(command => command[0] === 'EVAL');
    expect(attemptedCommands).toHaveLength(0);
    expect((await getTaskBoard(client, CODE))?.tasks[0]?.state).toBe('awaiting_review');
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
  });

  it('keeps absolute cursors, the 1000-message cap, and the fixed seven-day message expiry', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const oldMessages = Array.from({ length: MAX_MESSAGES_PER_ROOM }, (_, index) => JSON.stringify({
      id: index,
      type: 'msg',
      name: 'Earlier agent',
      initials: 'EA',
      color: '#000000',
      role: 'Agent',
      text: `earlier ${index}`,
      client: 'cc',
      time: index,
    }));
    store.set(`room-msgs:${CODE}`, JSON.stringify(oldMessages));
    store.set(`room-msg-count:${CODE}`, '1200');
    const { task } = await createTask(client, CODE, { title: 'Cursor boundary', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked', 1_800_000_000_000);

    expect(JSON.parse(store.get(`room-msgs:${CODE}`)!).length).toBe(MAX_MESSAGES_PER_ROOM);
    expect(await getMessageTotalCount(client, CODE)).toBe(1201);
    const { messages: unread } = await listMessages(client, CODE, 1200);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.metadata?.eventType).toBe('task_update');

    const commitCommand = vi.mocked(fetch).mock.calls
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as string[])
      .find(command => command[0] === 'EVAL' && command[2] === '4');
    const room = JSON.parse(store.get(`room:${CODE}`)!) as { createdAt: number };
    expect(commitCommand?.[10]).toBe(String(Math.floor(room.createdAt / 1000) + ROOM_TTL_SECONDS));
    expect(commitCommand?.[12]).toBe(String(MAX_MESSAGES_PER_ROOM));
    expect(commitCommand?.[1]).toContain("'SET', KEYS[1], ARGV[3], 'KEEPTTL'");
    expect(commitCommand?.[1]).toContain("'EXPIREAT', KEYS[1], expireAt, 'LT'");
    expect(commitCommand?.[1]).toContain("'EXPIREAT', KEYS[2], expireAt, 'LT'");
    expect(commitCommand?.[1]).toContain("'EXPIREAT', KEYS[3], expireAt, 'LT'");
    expect(commitCommand?.[1]).toContain("'SET', KEYS[3], legacyCount, 'KEEPTTL'");
  });

  it('initializes a legacy room counter from its retained list before adding the event', async () => {
    const store = installFakeRedis();
    const client = createClient(ENV);
    const oldMessages = Array.from({ length: 8 }, (_, index) => JSON.stringify({
      id: index,
      type: 'msg',
      name: 'Earlier agent',
      initials: 'EA',
      color: '#000000',
      role: 'Agent',
      text: `earlier ${index}`,
      client: 'cc',
      time: index,
    }));
    store.set(`room-msgs:${CODE}`, JSON.stringify(oldMessages));
    const { task } = await createTask(client, CODE, { title: 'Legacy counter', createdBy: 'Host' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);

    expect(await getMessageTotalCount(client, CODE)).toBe(9);
    const { messages: unread } = await listMessages(client, CODE, 8);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.metadata?.taskId).toBe(task.id);
  });

  it.each(['open', 'sequential', 'moderator'] as const)(
    'posts verification as a system event in %s mode without claiming the turn or speaker seat',
    async (replyMode) => {
      const store = installFakeRedis();
      const client = createClient(ENV);
      const room = JSON.parse(store.get(`room:${CODE}`)!) as Record<string, unknown>;
      room.replyMode = replyMode;
      room.participants = [{
        name: VERIFIER.name,
        client: VERIFIER.client,
        role: 'Reviewer',
        color: '#000000',
        initials: 'RV',
        joinedAt: 1,
        lastSeenAt: 1,
        canSpeak: false,
      }];
      store.set(`room:${CODE}`, JSON.stringify(room));

      const { task } = await createTask(client, CODE, {
        title: `${replyMode} verification`, owner: OWNER.name, ownerClient: OWNER.client,
        verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Host',
      });
      await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
      await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'reviewed');

      const { messages } = await listMessages(client, CODE, 0);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('sys');
      expect(messages[0]!.metadata?.eventType).toBe('task_update');
      expect(store.has(`turn-state:${CODE}`)).toBe(false);
      expect((JSON.parse(store.get(`room:${CODE}`)!) as { replyMode: string }).replyMode).toBe(replyMode);
    },
  );

  it('stamps lastProgressAt on each meaningful change', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { board: afterCreate } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    expect(typeof afterCreate.lastProgressAt).toBe('number');
    const before = afterCreate.lastProgressAt!;
    const { board: afterSubmit } = await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    expect(afterSubmit.lastProgressAt!).toBeGreaterThanOrEqual(before);
  });
});

// T-03: the claim/submit state machine used to exist only in the hosted path
// (evaluateClaimGuard / evaluateSubmitGuard). MCP + api/room.ts call claimTask
// and submitTask directly, so every one of these was reachable in a live room.
describe('claim/submit state machine (T-03)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const OTHER = { name: 'DeepSeek', client: 'cc' as const };

  async function doneTask(client: ReturnType<typeof createClient>) {
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);
    return task.id;
  }

  it('a done task cannot be resubmitted back into review', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const id = await doneTask(client);

    await expect(
      submitTask(client, CODE, id, OWNER, FULL_EVIDENCE),
    ).rejects.toBeInstanceOf(TaskDoneImmutableError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('done');
  });

  it('a cancelled task cannot be resubmitted', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, { name: 'Robin', client: 'web' }, 'out of scope');

    await expect(
      submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE),
    ).rejects.toBeInstanceOf(TaskStateError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('cancelled');
  });

  it('a non-owner cannot submit evidence on a task someone else is working on', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await claimTask(client, CODE, task.id, OWNER);

    await expect(
      submitTask(client, CODE, task.id, OTHER, FULL_EVIDENCE),
    ).rejects.toBeInstanceOf(TaskStateError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('in_progress');
    expect(board!.tasks[0]!.owner).toBe('Qwen');
  });

  it('the owner can still resubmit their own awaiting_review task (case-insensitive)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);

    const { task: resubmitted } = await submitTask(
      client, CODE, task.id, { name: ' qwen ', client: 'cc' }, { ...FULL_EVIDENCE, runOutput: '2 passed' },
    );
    expect(resubmitted.state).toBe('awaiting_review');
    expect(resubmitted.evidence?.runOutput).toBe('2 passed');
  });

  it('claiming does not steal a task another agent is in_progress on', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await claimTask(client, CODE, task.id, OWNER);

    await expect(
      claimTask(client, CODE, task.id, OTHER),
    ).rejects.toBeInstanceOf(TaskStateError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.owner).toBe('Qwen');
  });

  it('re-claiming your own in_progress task is idempotent', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await claimTask(client, CODE, task.id, OWNER);

    const { task: again } = await claimTask(client, CODE, task.id, OWNER);
    expect(again.state).toBe('in_progress');
    expect(again.owner).toBe('Qwen');
  });

  it('claiming cannot yank a submitted task back out of review', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);

    // Even the owner may not re-claim: that would erase the pending verdict.
    await expect(claimTask(client, CODE, task.id, OWNER)).rejects.toBeInstanceOf(TaskStateError);
    await expect(claimTask(client, CODE, task.id, OTHER)).rejects.toBeInstanceOf(TaskStateError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('awaiting_review');
  });

  it('an unstarted todo owned only nominally stays claimable (no board deadlock)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', owner: OWNER.name, ownerClient: OWNER.client, createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');

    const { task: claimed } = await claimTask(client, CODE, task.id, OTHER);
    expect(claimed.owner).toBe('DeepSeek');
    expect(claimed.state).toBe('in_progress');
  });

  it('a rejected task can still be resubmitted by its owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, { ...FULL_EVIDENCE, exitCode: 1 });
    await verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'tests fail');

    const { task: resubmitted } = await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    expect(resubmitted.state).toBe('awaiting_review');
  });
});

describe('host task state override', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('host can set a todo task straight to done, with a host verdict stamp', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: done } = await hostSetTaskState(client, CODE, task.id, 'done', 'robin');
    expect(done.state).toBe('done');
    expect(done.verdict?.by).toBe('robin');
    expect(done.verdict?.byClient).toBe('web');
  });

  it('host can move a task between open states', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: t1 } = await hostSetTaskState(client, CODE, task.id, 'in_progress', 'robin');
    expect(t1.state).toBe('in_progress');
    const { task: t2 } = await hostSetTaskState(client, CODE, task.id, 'rejected', 'robin');
    expect(t2.state).toBe('rejected');
    expect(t2.verdict?.verdict).toBe('rejected');
  });

  it('done tasks are locked — host cannot change them', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, task.id, 'done', 'robin');
    await expect(hostSetTaskState(client, CODE, task.id, 'todo', 'robin'))
      .rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('host can reopen a cancelled task to todo', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await cancelTask(client, CODE, task.id, { name: 'robin', client: 'web' }, 'dup');
    const { task: opened } = await hostSetTaskState(client, CODE, task.id, 'todo', 'robin');
    expect(opened.state).toBe('todo');
    expect(opened.cancellation).toBeUndefined();
  });

  it('setting the current state is a no-op that does not throw', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: same } = await hostSetTaskState(client, CODE, task.id, 'todo', 'robin');
    expect(same.state).toBe('todo');
  });
});

describe('board sweep helpers', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('allTasksDone / openTasks reflect state', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' });
    await createTask(client, CODE, { title: 'B', createdBy: 'C' });
    let board = (await getTaskBoard(client, CODE))!;
    expect(allTasksDone(board)).toBe(false);
    expect(openTasks(board)).toHaveLength(2);

    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await submitTask(client, CODE, 'T-02', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-02', VERIFIER, 'done', undefined);
    board = (await getTaskBoard(client, CODE))!;
    expect(allTasksDone(board)).toBe(true);
    expect(openTasks(board)).toHaveLength(0);
  });

  it('openTasks excludes rejected terminals (not actionable open work)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task: keep } = await createTask(client, CODE, {
      title: 'Still working',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    const { task: rejected } = await createTask(client, CODE, {
      title: 'Superseded',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await claimTask(client, CODE, rejected.id, OWNER);
    await submitTask(client, CODE, rejected.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, rejected.id, VERIFIER, 'rejected', 'superseded by later plan');

    const board = (await getTaskBoard(client, CODE))!;
    const open = openTasks(board);
    expect(open.map(t => t.id)).toEqual([keep.id]);
    expect(open.every(t => t.state !== 'rejected')).toBe(true);
    expect(board.tasks.find(t => t.id === rejected.id)?.state).toBe('rejected');
    expect(allTasksDone(board)).toBe(false);
    expect(boardHasNoOpenWork(board)).toBe(false); // keep still open
  });

  it('boardHasNoOpenWork is true for done+rejected boards without false allTasksDone', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task: done } = await createTask(client, CODE, {
      title: 'Shipped',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    const { task: rejected } = await createTask(client, CODE, {
      title: 'Superseded',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await claimTask(client, CODE, done.id, OWNER);
    await submitTask(client, CODE, done.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, done.id, VERIFIER, 'done', 'ok');
    await claimTask(client, CODE, rejected.id, OWNER);
    await submitTask(client, CODE, rejected.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, rejected.id, VERIFIER, 'rejected', 'superseded');

    const board = (await getTaskBoard(client, CODE))!;
    expect(openTasks(board)).toHaveLength(0);
    expect(boardHasNoOpenWork(board)).toBe(true);
    expect(allTasksDone(board)).toBe(false);
  });

  it('allTasksDone is false for an empty board', () => {
    expect(allTasksDone({ code: CODE, tasks: [], version: 0 })).toBe(false);
  });

  it('summarizeBoard lists one line per open task with a state icon', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Core model', createdBy: 'C' });
    const board = (await getTaskBoard(client, CODE))!;
    const summary = summarizeBoard(board);
    expect(summary).toContain('T-01');
    expect(summary).toContain('Core model');
    expect(summary).toContain('todo');
    expect(summary).not.toMatch(/✅ \d+ done/);
  });

  it('summarizeBoard keeps rejected history visible without counting it as open work', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Old approach',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'use plan B instead');

    const board = (await getTaskBoard(client, CODE))!;
    expect(openTasks(board)).toHaveLength(0);
    const summary = summarizeBoard(board);
    expect(summary).toContain('T-01 Old approach');
    expect(summary).toContain('rejected');
    expect(summary).toContain('use plan B instead');
    expect(summary).not.toMatch(/✅ \d+ done/);
  });

  it('summarizeBoard aggregates done tasks into a single trailing line', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task: t1 } = await createTask(client, CODE, {
      title: 'Ship A',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    const { task: t2 } = await createTask(client, CODE, {
      title: 'Ship B',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await createTask(client, CODE, { title: 'Still open', createdBy: 'C' });

    await claimTask(client, CODE, t1.id, OWNER);
    await submitTask(client, CODE, t1.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, t1.id, VERIFIER, 'done', 'ok');
    await claimTask(client, CODE, t2.id, OWNER);
    await submitTask(client, CODE, t2.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, t2.id, VERIFIER, 'done', 'ok');

    const board = (await getTaskBoard(client, CODE))!;
    const summary = summarizeBoard(board);
    expect(summary).toContain('T-03 Still open');
    expect(summary).toContain('todo');
    expect(summary).not.toContain('Ship A');
    expect(summary).not.toContain('Ship B');
    expect(summary.endsWith('✅ 2 done')).toBe(true);
    expect(summary.split('\n')).toHaveLength(2);
  });

  it('summarizeBoard is only the aggregate line when every task is done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Only one',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'ok');
    const board = (await getTaskBoard(client, CODE))!;
    expect(summarizeBoard(board)).toBe('✅ 1 done');
  });
});

describe('board-derived delivery (minutes / report source of truth)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('deliveredFromBoard is true only after room_task_submit evidence is verified done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Core data model',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    let board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(false);
    expect(doneTasks(board)).toHaveLength(0);

    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(false);

    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'looks good');
    board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(true);
    expect(doneTasks(board)).toHaveLength(1);
    expect(deliverablesFromBoard(board)).toEqual([
      'T-01: Core data model (verified by GPT) — models.py',
    ]);
    expect(formatDeliveredTask(doneTasks(board)[0]!)).toBe(
      'T-01: Core data model (verified by GPT) — models.py',
    );
    expect(boardDeliveredSection(board)).toContain('verified-done');
    expect(boardDeliveredSection(board)).toContain('T-01: Core data model');
  });

  it('deliveredFromBoard returns null when there is no task board', () => {
    expect(deliveredFromBoard(null)).toBeNull();
    expect(deliveredFromBoard({ code: CODE, tasks: [], version: 0 })).toBeNull();
  });
});

describe('moderator-mode blocked-agent reassignment', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reassigns a task to a new owner, resets it to todo, and tallies a block on the old owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Build it', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    await claimTask(client, CODE, 'T-01', OWNER); // Qwen → in_progress

    const r = await reassignTask(client, CODE, 'T-01', { name: 'GPT', client: 'cc' });
    expect(r.fromOwner).toBe('Qwen');
    expect(r.task.owner).toBe('GPT');
    expect(r.task.state).toBe('todo');
    expect(r.demoted).toBe(false);
    expect(r.blocks).toBe(1);

    const board = (await getTaskBoard(client, CODE))!;
    expect(agentBlocks(board, 'Qwen')).toBe(1);
    expect(isAgentDemoted(board, 'Qwen')).toBe(false);
  });

  it('auto-demotes an agent after 2 blocked tasks', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    await createTask(client, CODE, { title: 'B', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });

    const r1 = await reassignTask(client, CODE, 'T-01', { name: 'GPT', client: 'cc' });
    expect(r1.demoted).toBe(false);
    const r2 = await reassignTask(client, CODE, 'T-02', { name: 'Claude', client: 'cc' });
    expect(r2.demoted).toBe(true); // crosses the threshold on this turn
    expect(r2.blocks).toBe(2);

    const board = (await getTaskBoard(client, CODE))!;
    expect(isAgentDemoted(board, 'Qwen')).toBe(true);
    expect(demotedAgents(board)).toContain('Qwen');
  });

  it('does not tally a block when reassigning to the same owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    const r = await reassignTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' });
    expect(r.blocks).toBe(0);
    const board = (await getTaskBoard(client, CODE))!;
    expect(agentBlocks(board, 'Qwen')).toBe(0);
  });
});

describe('role reassignment (owner/verifier escape hatch)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const MOD = { name: 'Claude', client: 'cc' as const };
  /** Default multi-agent room (Qwen + GPT + moderator). */
  const MULTI_AGENTS = 3;

  it('reassigns the owner without changing state and records an audit entry', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Build it', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    await claimTask(client, CODE, 'T-01', OWNER); // Qwen → in_progress

    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, 1234, MULTI_AGENTS);
    expect(task.owner).toBe('Gemini');
    expect(task.ownerClient).toBe('cc');
    expect(task.state).toBe('in_progress'); // state untouched — unlike reassignTask
    expect(task.verifier).toBe('GPT');
    expect(task.roleHistory).toEqual([
      { by: 'Claude', byClient: 'cc', at: 1234, field: 'owner', from: 'Qwen', to: 'Gemini' },
    ]);
  });

  it('reassigns the verifier and appends to the existing audit trail', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });

    await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, 1000, MULTI_AGENTS);
    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { verifier: 'Qwen', verifierClient: 'cc' }, MOD, 2000, MULTI_AGENTS);
    expect(task.verifier).toBe('Qwen');
    expect(task.owner).toBe('Gemini');
    expect(task.roleHistory).toEqual([
      { by: 'Claude', byClient: 'cc', at: 1000, field: 'owner', from: 'Qwen', to: 'Gemini' },
      { by: 'Claude', byClient: 'cc', at: 2000, field: 'verifier', from: 'GPT', to: 'Qwen' },
    ]);
  });

  it('can swap both roles at once, one audit entry per changed field', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    const { task } = await reassignTaskRoles(
      client, CODE, 'T-01',
      { owner: 'GPT', ownerClient: 'cc', verifier: 'Qwen', verifierClient: 'cc' },
      MOD, 3000, MULTI_AGENTS,
    );
    expect(task.owner).toBe('GPT');
    expect(task.verifier).toBe('Qwen');
    expect(task.roleHistory).toHaveLength(2);
  });

  it('rejects a reassignment whose RESULT is owner == verifier when multiple agents exist', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    // New owner collides with the EXISTING verifier.
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { owner: ' gpt ', ownerClient: 'cc' }, MOD, Date.now(), MULTI_AGENTS),
    ).rejects.toBeInstanceOf(TaskStateError);
    // New verifier collides with the EXISTING owner.
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { verifier: 'QWEN', verifierClient: 'cc' }, MOD, Date.now(), MULTI_AGENTS),
    ).rejects.toBeInstanceOf(TaskStateError);
    // Nothing moved.
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks[0]!.owner).toBe('Qwen');
    expect(board.tasks[0]!.verifier).toBe('GPT');
    expect(board.tasks[0]!.roleHistory).toBeUndefined();
  });

  it('allows owner == verifier when the room has exactly one eligible agent', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Solo', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    const { task } = await reassignTaskRoles(
      client, CODE, 'T-01',
      { owner: 'SoloAgent', ownerClient: 'cc', verifier: 'SoloAgent', verifierClient: 'cc' },
      MOD, 5000, 1,
    );
    expect(task.owner).toBe('SoloAgent');
    expect(task.verifier).toBe('SoloAgent');
    expect(task.roleHistory).toHaveLength(2);
  });

  it('rejects reassignment of a done task — completed work is locked', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Mod' });
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, Date.now(), MULTI_AGENTS),
    ).rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('rejects reassignment of a rejected task — terminal work is locked', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: OWNER.name, ownerClient: OWNER.client, verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Mod' });
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'rejected', 'needs rework');
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, Date.now(), MULTI_AGENTS),
    ).rejects.toBeInstanceOf(TaskStateError);
  });

  it('rejects an empty patch and empty names', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', createdBy: 'Mod' });
    await expect(reassignTaskRoles(client, CODE, 'T-01', {}, MOD)).rejects.toBeInstanceOf(TaskStateError);
    await expect(reassignTaskRoles(client, CODE, 'T-01', { owner: '  ' }, MOD)).rejects.toBeInstanceOf(TaskStateError);
  });

  it('a reassignment to the same holder changes nothing and records no audit entry', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Qwen', ownerClient: 'cc' }, MOD);
    expect(task.owner).toBe('Qwen');
    expect(task.roleHistory).toBeUndefined();
  });
});

describe('cancelTask (host/moderator archive to cancelled lane)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('archives a todo task to cancelled with audit metadata', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Duplicate', createdBy: 'Mod' });
    await createTask(client, CODE, { title: 'Keep', createdBy: 'Mod' });
    const { task, board } = await cancelTask(client, CODE, 'T-01', { name: 'Claude', client: 'cc' }, 'duplicate', 9999);
    expect(task.state).toBe('cancelled');
    expect(task.cancellation).toEqual({ by: 'Claude', byClient: 'cc', at: 9999, reason: 'duplicate' });
    expect(board.tasks).toHaveLength(2);
    expect(board.tasks.find(t => t.id === 'T-01')?.state).toBe('cancelled');
    expect(board.tasks.find(t => t.id === 'T-02')?.state).toBe('todo');
  });

  it('archives an in_progress task with no evidence', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'WIP', createdBy: 'Mod' });
    await claimTask(client, CODE, 'T-01', OWNER);
    const { task } = await cancelTask(client, CODE, 'T-01', { name: 'Host', client: 'web' });
    expect(task.state).toBe('cancelled');
    expect(task.owner).toBe('Qwen');
  });

  it('rejects cancelling a done task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Mod' });
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await expect(cancelTask(client, CODE, 'T-01', { name: 'Host', client: 'web' })).rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('rejects cancelling a task with submitted evidence', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Mod' });
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await expect(cancelTask(client, CODE, 'T-01', { name: 'Host', client: 'web' })).rejects.toBeInstanceOf(TaskStateError);
    expect((await getTaskBoard(client, CODE))!.tasks[0]!.state).toBe('awaiting_review');
  });

  it('excludes cancelled tasks from openTasks', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Dup', createdBy: 'Mod' });
    await cancelTask(client, CODE, 'T-01', { name: 'Host', client: 'web' });
    const board = (await getTaskBoard(client, CODE))!;
    expect(openTasks(board)).toHaveLength(0);
  });

  it('rejects cancelling a missing task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await expect(cancelTask(client, CODE, 'T-99', { name: 'Host', client: 'web' })).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe('reopenTask', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reopens cancelled and rejected tasks to an open state', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'Mod' });
    await createTask(client, CODE, { title: 'B', createdBy: 'Mod', verifier: VERIFIER.name, verifierClient: VERIFIER.client });
    await cancelTask(client, CODE, 'T-01', { name: 'Host', client: 'web' }, 'dup');
    const { task: fromCancel } = await reopenTask(client, CODE, 'T-01', 'todo');
    expect(fromCancel.state).toBe('todo');
    expect(fromCancel.cancellation).toBeUndefined();

    await submitTask(client, CODE, 'T-02', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-02', VERIFIER, 'rejected', 'needs work');
    const { task: fromReject } = await reopenTask(client, CODE, 'T-02', 'in_progress');
    expect(fromReject.state).toBe('in_progress');
    expect(fromReject.rejectCount).toBe(0);
  });

  it('does not reopen a todo or a done task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'Mod', verifier: VERIFIER.name, verifierClient: VERIFIER.client });
    await expect(reopenTask(client, CODE, 'T-01', 'todo')).rejects.toBeInstanceOf(TaskStateError);
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await expect(reopenTask(client, CODE, 'T-01', 'todo')).rejects.toBeInstanceOf(TaskDoneImmutableError);
  });
});

describe('verifyTask with unset client kinds (name-only records)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lets the named verifier rule when verifierClient was never recorded', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // createTask accepts a verifier name alone — no verifierClient.
    const { task } = await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { task: done } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);
    expect(done.state).toBe('done');
    expect(done.verdict?.by).toBe('GPT');
  });

  it('still rejects the wrong name when verifierClient is unset', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, { name: 'Gemini', client: 'cc' }, 'done', undefined),
    ).rejects.toBeInstanceOf(NotVerifierError);
  });

  it('still blocks self-verify when ownerClient was never recorded', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // Owner recorded by name only, moved to awaiting_review by the host —
    // ownerClient stays undefined, and a bare name match must still block.
    const { task } = await createTask(client, CODE, { title: 'X', owner: OWNER.name, createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, task.id, 'awaiting_review', 'robin');
    await expect(
      verifyTask(client, CODE, task.id, OWNER, 'done', undefined),
    ).rejects.toBeInstanceOf(OwnerCannotVerifyError);
  });
});

describe('createTask owner/verifier separation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects a task whose verifier equals the owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await expect(
      createTask(client, CODE, {
        title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'Qwen', verifierClient: 'cc', createdBy: 'Claude',
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    // Nothing was written — the board stays absent.
    expect(await getTaskBoard(client, CODE)).toBeNull();
  });

  it('rejects a same-agent verifier that differs only by case/whitespace', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await expect(
      createTask(client, CODE, {
        title: 'X', owner: '  qwen ', ownerClient: 'cc', verifier: 'QWEN', verifierClient: 'cc', createdBy: 'Claude',
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    expect(await getTaskBoard(client, CODE)).toBeNull();
  });

  it('still accepts a distinct verifier', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', owner: OWNER.name, ownerClient: OWNER.client, verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.owner).toBe('Qwen');
    expect(task.verifier).toBe('GPT');
  });

  it('still accepts a task with an owner and no verifier', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', owner: OWNER.name, ownerClient: OWNER.client, createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.verifier).toBeUndefined();
  });
});

describe('claimTask verifier-conflict guard (T-13 deadlock)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects when the designated verifier claims the task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // Create with no owner — verifier set to GPT; GPT claiming would deadlock.
    const { task } = await createTask(client, CODE, {
      title: 'Flash banner',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.owner).toBeUndefined();

    await expect(
      claimTask(client, CODE, task.id, VERIFIER),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);

    const board = (await getTaskBoard(client, CODE))!;
    const still = board.tasks.find(t => t.id === task.id)!;
    expect(still.state).toBe('todo');
    expect(still.owner).toBeUndefined();
  });

  it('rejects case/whitespace variants of the verifier name', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: 'GPT',
      verifierClient: 'cc',
      createdBy: 'Claude',
    });
    await expect(
      claimTask(client, CODE, task.id, { name: '  gpt ', client: 'cc' }),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);
  });

  it('rejects on name match when verifierClient is unset (client-tolerant)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: 'Auto',
      createdBy: 'Claude',
    });
    await expect(
      claimTask(client, CODE, task.id, { name: 'Auto', client: 'cc' }),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);
  });

  it('allows a non-verifier to claim', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    const { task: claimed } = await claimTask(client, CODE, task.id, OWNER);
    expect(claimed.state).toBe('in_progress');
    expect(claimed.owner).toBe(OWNER.name);
    expect(claimed.verifier).toBe(VERIFIER.name);
  });

  it('rejects claiming a rejected terminal (host must reopen first)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Old approach',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'use plan B');

    await expect(
      claimTask(client, CODE, task.id, OWNER),
    ).rejects.toBeInstanceOf(TaskStateError);

    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks.find(t => t.id === task.id)?.state).toBe('rejected');

    // Host reopen → claim works again.
    await hostSetTaskState(client, CODE, task.id, 'todo', 'Host');
    const { task: reclaimed } = await claimTask(client, CODE, task.id, OWNER);
    expect(reclaimed.state).toBe('in_progress');
  });
});

describe('task board CAS (no lost updates / no blanking)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('concurrent writes to different tasks both survive', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' }); // T-01
    await createTask(client, CODE, { title: 'B', createdBy: 'C' }); // T-02
    // Without a real CAS one of these claims would clobber the other (both read
    // the same board, both wrote vN+1, last-write-wins).
    await Promise.all([
      claimTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' }),
      claimTask(client, CODE, 'T-02', { name: 'GPT', client: 'cc' }),
    ]);
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks.find(t => t.id === 'T-01')!.owner).toBe('Qwen');
    expect(board.tasks.find(t => t.id === 'T-02')!.owner).toBe('GPT');
    expect(board.tasks.every(t => t.state === 'in_progress')).toBe(true);
  });

  it('a stale-snapshot write does not blank the board', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' });
    await createTask(client, CODE, { title: 'B', createdBy: 'C' });
    // Two concurrent claims + a create racing — the board must keep all 3 tasks,
    // never collapse to an empty/0 board.
    await Promise.all([
      claimTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' }),
      createTask(client, CODE, { title: 'C', createdBy: 'C' }),
      claimTask(client, CODE, 'T-02', { name: 'GPT', client: 'cc' }),
    ]);
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks).toHaveLength(3);
  });
});

describe('verifyTask structured follow-up', () => {
  beforeEach(() => vi.restoreAllMocks());

  async function pendingReview(participants: unknown[] = []) {
    const store = installFakeRedis();
    const room = JSON.parse(store.get(`room:${CODE}`)!) as Record<string, unknown>;
    room.participants = participants;
    store.set(`room:${CODE}`, JSON.stringify(room));
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Follow-up verification',
      owner: OWNER.name,
      ownerClient: OWNER.client,
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Host',
    });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    return { store, client, task };
  }

  it('records one system notice for a legacy verification without follow-up', async () => {
    const { client, task } = await pendingReview();
    const { task: verified } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'Acceptance passed.');

    expect(verified.state).toBe('done');
    expect(verified.verdict?.followUp).toBeUndefined();
    const messages = (await listMessages(client, CODE, 0)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('Acceptance passed.');
    expect(messages[0]!.text).not.toContain('后续处理：');
    expect(await getMessageTotalCount(client, CODE)).toBe(1);
  });

  it('persists a validated participant request and appends it to the same notice', async () => {
    const { client, task } = await pendingReview([
      { name: 'Build Agent', client: 'cc', role: '', color: '#000000', initials: 'BA', joinedAt: 1, lastSeenAt: 1 },
    ]);
    const { task: verified } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'done', 'Passes acceptance.', 1_800_000_000_000,
      { target: '  Build Agent  ', request: '  Check the deployment window.  ' },
    );

    expect(verified.verdict?.followUp).toEqual({
      target: 'Build Agent',
      request: 'Check the deployment window.',
      targetClient: 'cc',
    });
    const messages = (await listMessages(client, CODE, 0)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('@Build Agent Check the deployment window.');
    expect(messages[0]!.metadata).toMatchObject({
      eventType: 'task_update',
      targetAgentName: 'Build Agent',
      targetAgentClient: 'cc',
    });
    expect(await getMessageTotalCount(client, CODE)).toBe(1);
  });

  it('records a rejection reason and requested rework in one notification', async () => {
    const { client, task } = await pendingReview([
      { name: 'Producer', client: 'cc', role: '', color: '#000000', initials: 'PR', joinedAt: 1, lastSeenAt: 1 },
    ]);
    const { task: rejected } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'rejected', 'Reconnect repeats the last message.', Date.now(),
      { target: 'Producer', request: 'Fix reconnect idempotency and submit new evidence.' },
    );

    expect(rejected.state).toBe('rejected');
    expect(rejected.verdict?.followUp?.target).toBe('Producer');
    const messages = (await listMessages(client, CODE, 0)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('原因：Reconnect repeats the last message.');
    expect(messages[0]!.text).toContain('@Producer Fix reconnect idempotency and submit new evidence.');
  });

  it('rejects missing, invisible, and overlong rejection reasons without any write, then permits a valid retry', async () => {
    const invalidNotes: Array<{ label: string; note: string | undefined }> = [
      { label: 'missing', note: undefined },
      { label: 'empty', note: '' },
      { label: 'whitespace only', note: '  \t  ' },
      { label: 'control characters only', note: '\n\r\u0000\u0008\u007f' },
      { label: 'over 600 characters', note: 'x'.repeat(601) },
    ];
    const { store, client, task } = await pendingReview();
    const pendingBoardRaw = store.get(`task-board:${CODE}`);

    for (const { label, note } of invalidNotes) {
      await expect(
        verifyTask(client, CODE, task.id, VERIFIER, 'rejected', note),
        label,
      ).rejects.toBeInstanceOf(TaskVerifyReasonError);
      expect((await getTaskBoard(client, CODE))?.tasks[0]?.state, label).toBe('awaiting_review');
      expect((await getTaskBoard(client, CODE))?.tasks[0]?.verdict, label).toBeUndefined();
      expect((await listMessages(client, CODE, 0)).messages, label).toHaveLength(0);
      expect(await getMessageTotalCount(client, CODE), label).toBeNull();
      expect(store.get(`task-board:${CODE}`), label).toBe(pendingBoardRaw);
      expect(store.has(`room-msgs:${CODE}`), label).toBe(false);
      expect(store.has(`room-msg-count:${CODE}`), label).toBe(false);
    }

    const boundaryReason = 'x'.repeat(600);
    const { task: rejected } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'rejected', boundaryReason,
    );
    const messages = (await listMessages(client, CODE, 0)).messages;
    expect(rejected.state).toBe('rejected');
    expect(rejected.verdict?.note).toBe(boundaryReason);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain(`原因：${boundaryReason}`);
    expect(await getMessageTotalCount(client, CODE)).toBe(1);
  });

  it('stores and announces the same normalized rejection reason', async () => {
    const { client, task } = await pendingReview();
    const { task: rejected } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'rejected', '  Inspect\tbecause\nretry  ',
    );

    expect(rejected.verdict?.note).toBe('Inspect because retry');
    const [message] = (await listMessages(client, CODE, 0)).messages;
    expect(message!.text).toContain(`原因：${rejected.verdict?.note}`);
  });

  it('resolves the host seat even before it joins the participants array', async () => {
    const { client, task } = await pendingReview();
    const { task: verified } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'done', undefined, Date.now(),
      { target: 'Room Host', request: 'Please approve the rollout window.' },
    );

    expect(verified.verdict?.followUp).toMatchObject({ target: 'Room Host', targetClient: 'web' });
    expect((await listMessages(client, CODE, 0)).messages[0]!.metadata).toMatchObject({
      targetAgentName: 'Room Host',
      targetAgentClient: 'web',
    });
  });

  it('uses targetClient to resolve a real same-name participant', async () => {
    const { client, task } = await pendingReview([
      { name: 'Shared', client: 'web', role: '', color: '#000000', initials: 'SH', joinedAt: 1, lastSeenAt: 1 },
      { name: 'Shared', client: 'cc', role: '', color: '#000000', initials: 'SH', joinedAt: 2, lastSeenAt: 2 },
    ]);
    const { task: verified } = await verifyTask(
      client, CODE, task.id, VERIFIER, 'done', undefined, Date.now(),
      { target: 'Shared', request: 'Please verify the data.', targetClient: 'cc' },
    );

    expect(verified.verdict?.followUp).toEqual({
      target: 'Shared',
      request: 'Please verify the data.',
      targetClient: 'cc',
    });
    expect((await listMessages(client, CODE, 0)).messages[0]!.metadata?.targetAgentClient).toBe('cc');
  });

  it('rejects invalid or ambiguous follow-ups without changing state or messages', async () => {
    const ambiguousParticipants = [
      { name: 'Shared', client: 'web', role: '', color: '#000000', initials: 'SH', joinedAt: 1, lastSeenAt: 1 },
      { name: 'Shared', client: 'cc', role: '', color: '#000000', initials: 'SH', joinedAt: 2, lastSeenAt: 2 },
    ];
    const cases: Array<{ label: string; followUp: unknown; participants?: unknown[] }> = [
      { label: 'empty target', followUp: { target: ' ', request: 'do something' } },
      { label: 'empty request', followUp: { target: 'Room Host', request: '  ' } },
      { label: 'long request', followUp: { target: 'Room Host', request: 'x'.repeat(241) } },
      { label: 'non-string target', followUp: { target: 7, request: 'do something' } },
      { label: 'non-string request', followUp: { target: 'Room Host', request: false } },
      { label: 'long target', followUp: { target: 'x'.repeat(121), request: 'do something' } },
      { label: 'non-object', followUp: ['Room Host', 'do something'] },
      { label: 'unknown field', followUp: { target: 'Room Host', request: 'do something', extra: true } },
      { label: 'unknown target', followUp: { target: 'Ghost', request: 'do something' } },
      { label: 'control character in target', followUp: { target: 'Room\nHost', request: 'do something' } },
      { label: 'invalid target client', followUp: { target: 'Room Host', request: 'do something', targetClient: 'desktop' } },
      { label: 'ambiguous target', followUp: { target: 'Shared', request: 'do something' }, participants: ambiguousParticipants },
    ];

    for (const { label, followUp, participants } of cases) {
      const { store, client, task } = await pendingReview(participants);
      await expect(
        verifyTask(client, CODE, task.id, VERIFIER, 'done', 'checked', Date.now(), followUp as never),
        label,
      ).rejects.toBeInstanceOf(TaskVerifyFollowUpError);
      expect((await getTaskBoard(client, CODE))?.tasks[0]?.state, label).toBe('awaiting_review');
      expect((await getTaskBoard(client, CODE))?.tasks[0]?.verdict, label).toBeUndefined();
      expect((await listMessages(client, CODE, 0)).messages, label).toHaveLength(0);
      expect(await getMessageTotalCount(client, CODE), label).toBeNull();
      expect(store.has(`room-msgs:${CODE}`), label).toBe(false);
    }
  });

  it('allows only one concurrent follow-up verification and one recorded action', async () => {
    const { client, task } = await pendingReview([
      { name: 'Producer', client: 'cc', role: '', color: '#000000', initials: 'PR', joinedAt: 1, lastSeenAt: 1 },
    ]);
    const followUp = { target: 'Producer', request: 'Submit the missing reconnect evidence.' };
    const results = await Promise.allSettled([
      verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'Reconnect behavior failed.', 1_800_000_000_000, followUp),
      verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'Reconnect behavior failed.', 1_800_000_000_001, followUp),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getTaskBoard(client, CODE))?.tasks[0]?.verdict?.followUp?.target).toBe('Producer');
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(1);
    expect(await getMessageTotalCount(client, CODE)).toBe(1);
  });

  it('does not persist a follow-up or report success when the atomic commit fails', async () => {
    const { store, client, task } = await pendingReview([
      { name: 'Producer', client: 'cc', role: '', color: '#000000', initials: 'PR', joinedAt: 1, lastSeenAt: 1 },
    ]);
    failNextTaskVerificationCommit = true;
    await expect(
      verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined, Date.now(), {
        target: 'Producer', request: 'Confirm receipt.' as string,
      }),
    ).rejects.toMatchObject({ name: 'NetworkError' });

    expect((await getTaskBoard(client, CODE))?.tasks[0]?.state).toBe('awaiting_review');
    expect((await getTaskBoard(client, CODE))?.tasks[0]?.verdict?.followUp).toBeUndefined();
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(await getMessageTotalCount(client, CODE)).toBeNull();
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });

  it('fails closed at the Redis counter limit before writing the board or notice', async () => {
    const { store, client, task } = await pendingReview([
      { name: 'Producer', client: 'cc', role: '', color: '#000000', initials: 'PR', joinedAt: 1, lastSeenAt: 1 },
    ]);
    store.set(`room-msg-count:${CODE}`, '9223372036854775807');

    await expect(
      verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined, Date.now(), {
        target: 'Producer', request: 'Confirm receipt.',
      }),
    ).rejects.toMatchObject({ name: 'UpstashError' });

    expect((await getTaskBoard(client, CODE))?.tasks[0]?.state).toBe('awaiting_review');
    expect((await getTaskBoard(client, CODE))?.tasks[0]?.verdict?.followUp).toBeUndefined();
    expect(store.get(`room-msg-count:${CODE}`)).toBe('9223372036854775807');
    expect((await listMessages(client, CODE, 0)).messages).toHaveLength(0);
    expect(store.has(`room-msgs:${CODE}`)).toBe(false);
  });
});

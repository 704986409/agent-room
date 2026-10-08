// Full integration test: imports the REAL TypeScript source of @agent-room/upstash-client
// and @agent-room/shared, and exercises every function the web app uses against live Upstash.
//
// Run with: node --import tsx scripts/integration-test.ts

import {
  createClient,
  createRoom,
  getRoom,
  joinRoom,
  updatePresence,
  appendMessage,
  listMessages,
  RoomNotFoundError,
  ConcurrencyError,
} from '../packages/upstash-client/src/index.ts';
import {
  generateCode,
  isValidCode,
  ROOM_TTL_SECONDS,
  MAX_MESSAGES_PER_ROOM,
} from '../packages/shared/src/index.ts';
import type { Participant, Message } from '../packages/shared/src/types.ts';

const env = {
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
};
if (!env.url || !env.token) {
  console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  const client = createClient(env);

  console.log('\n[1] generateCode + isValidCode');
  const code = generateCode();
  check('generateCode() shape', /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code), `code=${code}`);
  check('isValidCode() accepts generated', isValidCode(code));
  check('isValidCode() rejects excluded chars', !isValidCode('ABC-DEF-GH0'));
  check('isValidCode() rejects lowercase', !isValidCode('abc-def-ghj'));

  // Clean up any prior run
  await client.command(['DEL', `room:${code}`, `room-msgs:${code}`, `room-min:${code}`]);

  console.log('\n[2] createRoom');
  const room = await createRoom(client, { code, topic: 'Integration probe', createdBy: 'TestBot' });
  check('returns Room with version=1', room.version === 1);
  check('returns empty participants', room.participants.length === 0);
  check('code matches', room.code === code);

  console.log('\n[3] getRoom — hit');
  const got = await getRoom(client, code);
  check('topic round-trip', got.topic === 'Integration probe');
  check('createdBy round-trip', got.createdBy === 'TestBot');

  console.log('\n[4] getRoom — miss throws RoomNotFoundError');
  try {
    await getRoom(client, 'ZZZ-ZZZ-ZZZ');
    check('throws', false, 'did not throw');
  } catch (e) {
    check('throws RoomNotFoundError', e instanceof RoomNotFoundError);
  }

  console.log('\n[5] joinRoom (CAS: version bumps 1 → 2)');
  const alice: Participant = {
    name: 'Alice',
    role: 'Engineer',
    color: '#5B6AFF',
    initials: 'AL',
    client: 'web',
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  const afterAlice = await joinRoom(client, code, alice);
  check('version = 2 after join', afterAlice.version === 2);
  check('participants length = 1', afterAlice.participants.length === 1);
  check('Alice present', afterAlice.participants[0]?.name === 'Alice');

  console.log('\n[6] joinRoom twice with same name — upsert, no duplicate');
  const aliceAgain: Participant = { ...alice, role: 'Tech Lead', joinedAt: Date.now() + 1 };
  const afterUpsert = await joinRoom(client, code, aliceAgain);
  check('still 1 participant after same-name rejoin', afterUpsert.participants.length === 1);
  check('role updated to Tech Lead', afterUpsert.participants[0]?.role === 'Tech Lead');
  check('version bumped to 3', afterUpsert.version === 3);

  console.log('\n[7] joinRoom with a different name — appends');
  const bob: Participant = {
    name: 'Bob',
    role: 'Designer',
    color: '#EC4899',
    initials: 'BO',
    client: 'cc',
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  const afterBob = await joinRoom(client, code, bob);
  check('2 participants', afterBob.participants.length === 2);
  check('version = 4', afterBob.version === 4);

  console.log('\n[8] updatePresence — heartbeat updates lastSeenAt');
  const heartbeatAt = Date.now() + 10_000;
  await updatePresence(client, code, 'Alice', heartbeatAt);
  const afterHeartbeat = await getRoom(client, code);
  const aliceSeen = afterHeartbeat.participants.find(p => p.name === 'Alice')?.lastSeenAt;
  check('Alice lastSeenAt updated', aliceSeen === heartbeatAt);
  check('version bumped to 5', afterHeartbeat.version === 5);

  console.log('\n[9] updatePresence — unknown name is silent no-op');
  const before = (await getRoom(client, code)).version;
  await updatePresence(client, code, 'Nobody', Date.now());
  const after = (await getRoom(client, code)).version;
  check('version still bumps (by design)', after === before + 1);
  check('participants unchanged', (await getRoom(client, code)).participants.length === 2);

  console.log('\n[10] appendMessage + listMessages');
  const msg1: Message = {
    id: 1000, type: 'msg', name: 'Alice', initials: 'AL', color: '#5B6AFF',
    role: 'Tech Lead', text: 'first', client: 'web', time: 1000,
  };
  const msg2: Message = { ...msg1, id: 2000, text: 'second', time: 2000 };
  await appendMessage(client, code, msg1);
  await appendMessage(client, code, msg2);
  const msgs = await listMessages(client, code, 0);
  check('got 2 messages', msgs.length === 2);
  check('ordering preserved (first)', msgs[0]?.text === 'first');
  check('ordering preserved (second)', msgs[1]?.text === 'second');

  console.log('\n[11] listMessages with cursor');
  const onlyLast = await listMessages(client, code, 1);
  check('cursor skip first', onlyLast.length === 1 && onlyLast[0]?.text === 'second');

  console.log('\n[12] TTL — room-msgs must expire alongside room (final review fix #2)');
  const roomTtl = (await client.command(['TTL', `room:${code}`])) as number;
  const msgsTtl = (await client.command(['TTL', `room-msgs:${code}`])) as number;
  check('room:{code} TTL ≈ 604800', roomTtl > 604700 && roomTtl <= ROOM_TTL_SECONDS);
  check('room-msgs:{code} TTL ≈ 604800', msgsTtl > 604700 && msgsTtl <= ROOM_TTL_SECONDS, `ttl=${msgsTtl}`);

  console.log('\n[13] Bulk append under the LTRIM cap');
  // push 10 messages and verify listMessages returns them in order
  for (let i = 0; i < 10; i++) {
    await appendMessage(client, code, { ...msg1, id: 3000 + i, text: `bulk-${i}`, time: 3000 + i });
  }
  const allMsgs = await listMessages(client, code, 0);
  check('total = 12 (2 + 10)', allMsgs.length === 12);
  check('last text is bulk-9', allMsgs[11]?.text === 'bulk-9');
  check('cap is 500 per spec', MAX_MESSAGES_PER_ROOM === 500);

  // Cleanup
  console.log('\n[14] Cleanup');
  await client.command(['DEL', `room:${code}`, `room-msgs:${code}`, `room-min:${code}`]);
  try {
    await getRoom(client, code);
    check('getRoom after DEL throws', false);
  } catch (e) {
    check('getRoom after DEL throws RoomNotFoundError', e instanceof RoomNotFoundError);
  }

  console.log(`\n━━━ ${passed} passed, ${failed} failed ━━━`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(2);
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
    if (path.endsWith(`${join('lib', 'roomWrites.ts')}`)) continue;
    out.push(path);
  }
  return out;
}

const FORBIDDEN = [
  'appendMessage(',
  'updatePresence(',
  'joinRoom(',
  'appendSystemMessage(',
  'setMuted(',
  'removeParticipant(',
  'endRoom(',
  'reactivateRoom(',
  'setReplyMode(',
  'createRoomReport(',
  'runDeliverSweep(',
  'startDeliverPlanAndWake(',
  'directInvoke(',
  'hostSkipCurrent(',
  'onDeliverHostMessage(',
  'createRoomTask(',
  'createTask(',
  'blockTask(',
  'cancelTask(',
  'updateTask(',
  'verifyTask(',
  'reassignRoomTaskRoles(',
  'verifyHostKey(',
  'setProjectPrompt(',
  "['SET'",
  "['SADD'",
  "['DEL'",
  "['LPUSH'",
  "['RPUSH'",
  "['EVAL'",
  "['EVALSHA'",
];

describe('web redis writes', () => {
  it('keeps browser writes on /api/web instead of the Redis proxy', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      for (const token of FORBIDDEN) {
        if (text.includes(token)) hits.push(`${file} ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

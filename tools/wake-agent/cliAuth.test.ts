import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearAuthCache,
  getCachedAuth,
  loginHintFor,
  probeCliAuth,
  setCachedAuth,
} from './src/cliAuth.js';

describe('cliAuth', () => {
  it('detects agy login from the oauth token file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-auth-'));
    const tokenDir = join(home, '.gemini', 'antigravity-cli');
    await mkdir(tokenDir, { recursive: true });
    await writeFile(join(tokenDir, 'antigravity-oauth-token'), JSON.stringify({ access_token: 'tok' }));
    const status = await probeCliAuth('agy', 'agy', { HOME: home });
    expect(status.loggedIn).toBe(true);
  });

  it('marks agy logged out when the token file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-auth-missing-'));
    const status = await probeCliAuth('agy', 'agy', { HOME: home });
    expect(status.loggedIn).toBe(false);
  });

  it('caches auth results and returns login hints', () => {
    clearAuthCache();
    setCachedAuth('codex', { loggedIn: false, detail: 'no' });
    expect(getCachedAuth('codex')).toEqual({ loggedIn: false, detail: 'no' });
    expect(loginHintFor('codex')).toContain('codex login');
    expect(loginHintFor('cursor-agent')).toContain('agent login');
    expect(loginHintFor('agy')).toContain('agy');
  });
});

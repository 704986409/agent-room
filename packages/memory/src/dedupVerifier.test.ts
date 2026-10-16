import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDuplicateVerifier } from './dedupVerifier.js';

describe('resolveDuplicateVerifier', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is disabled when the endpoint is unset', () => {
    vi.stubEnv('MEMORY_DEDUP_VERIFIER_URL', '');
    expect(resolveDuplicateVerifier()).toBeUndefined();
  });

  it('does not call fetch when an endpoint is configured but unimplemented', () => {
    vi.stubEnv('MEMORY_DEDUP_VERIFIER_URL', 'https://verifier.invalid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveDuplicateVerifier()).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

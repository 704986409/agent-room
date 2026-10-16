export interface DuplicateVerifier {
  verify(input: {
    candidate: { title: string; content: string };
    existing: { id: string; kind: 'memory' | 'proposal'; title: string; content: string };
    score: number;
  }): Promise<boolean>;
}

let warnedAboutUnimplementedEndpoint = false;

export function resolveDuplicateVerifier(env: NodeJS.ProcessEnv = process.env): DuplicateVerifier | undefined {
  if (!env.MEMORY_DEDUP_VERIFIER_URL) return undefined;
  if (!warnedAboutUnimplementedEndpoint) {
    warnedAboutUnimplementedEndpoint = true;
    console.warn('MEMORY_DEDUP_VERIFIER_URL is configured, but the verifier endpoint is not implemented yet.');
  }
  return undefined;
}

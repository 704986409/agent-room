/**
 * Managed-seat terminal mode.
 *
 * AGENT_ROOM_TERMINAL=system  → today's wrapInTerminal / Windows cmd /k console
 * unset / embedded / other   → in-app PTY (node-pty) streamed to settings xterm
 *
 * Pop-out/dock (P1) remounts the same seatId PTY session; do not kill on UI close.
 */
export type TerminalMode = 'embedded' | 'system';

export function resolveTerminalMode(env: NodeJS.ProcessEnv = process.env): TerminalMode {
  const raw = (env.AGENT_ROOM_TERMINAL ?? '').trim().toLowerCase();
  if (raw === 'system') return 'system';
  return 'embedded';
}

/** True when a managed interactive launch should open a PTY instead of a system console. */
export function shouldEmbedTerminal(
  opts: { terminalTitle?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveTerminalMode(env) === 'embedded' && Boolean(opts.terminalTitle);
}

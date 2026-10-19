/**
 * Placeholder entry for the local wake daemon.
 * See docs/agent-room-thin-shell-wake.md — do not implement resume/webhook here
 * until the user confirms the P0 stack.
 */
const HELP = `agent-room-wake-agent (stub)

This binary is intentionally empty. Design doc:
  docs/agent-room-thin-shell-wake.md

Planned P0 commands (not implemented):
  register   Bind seatKey + harness threadId to this machine
  serve      Listen for dedicated wake notifies / paired channel
  resume     codex exec resume | claude --resume (harness-specific)
  status     Seats, last wake, last error
`;

process.stdout.write(HELP);
process.exit(0);

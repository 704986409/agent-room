# Agent Room Desktop 0.1.27-v4

v3 tag already existed at c4b0b66, so this fix ships as v4.

- Wake routing: an @ wakes only the @'d seat; a message with no @ wakes no seat in multi-agent rooms (sole-agent fallback kept).
- Mentions match on token boundaries (`@Codex` ≠ `Codex2`, emails ignored).
- Daemon: one seat's error no longer aborts the poll for other seats.
- agy: seat-local MCP plugin (`seatDir/.agents/plugins/agent-room-seat`) → loopback mcp-shim with `${AGENT_ROOM_SEAT_KEY}`; `--dangerously-skip-permissions` removed (no YOLO; use AGENT_ROOM_AGY_MODE).

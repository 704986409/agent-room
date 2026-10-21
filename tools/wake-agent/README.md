# wake-agent (local thin-shell wake daemon)

Linux Node daemon for Desktop wake. Outbound `POST /api/wake` only; this process does not listen on a public port.

```
AGENT_ROOM_DEVICE_TOKEN=... node --experimental-strip-types src/index.ts serve \
  --state ~/.local/state/agent-room/wake.json --server http://127.0.0.1:8787
```

- Registers seats, polls, claims, renews, and reports progress. It never sends `succeeded`.
- Interactive CLI adapters (codex / cursor-agent / agy) open a visible terminal; see design §2.4 and appendix B.1.
- State file mode `0600`. It stores session id and pid, never seatKey or the device token.
- One file lock per seat. A second process refuses the seat until the lock is released.

Not an npm workspace. Tests run via `npm run test:api`. Do not point `--server` at production unless you intend to wake real seats.

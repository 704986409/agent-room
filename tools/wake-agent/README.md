# wake-agent (local thin-shell wake daemon) — stub

**Status:** skeleton only. Do not run in production. Full design: [`docs/agent-room-thin-shell-wake.md`](../../docs/agent-room-thin-shell-wake.md).

## Intent (P0)

Local process that:

1. Registers this machine’s Codex/Claude seats with the Agent Room server (seatKey + harness thread id).
2. Receives wake notifies when the host `@`s a seat that is **not** in `room_listen`.
3. Resumes the CLI session (`codex exec resume …` / Claude resume) or injects into a live TUI.
4. ACKs success or NACKs so the host can see **未送达**.

Room/memory/invite stay on the server. This folder is **not** an npm workspace package yet (avoids breaking `apps/*` installs).

## Layout

```
tools/wake-agent/
  README.md          ← this file
  package.json       ← private stub metadata only
  src/index.ts       ← placeholder entry (prints help, exits)
```

## Non-goals until stack is confirmed

- No tray UI, no Tauri/Electron shell, no real HTTP server, no production webhook handler.
- No commit of secrets, seatKeys, or thread ids into room transcripts.

## Next (after user picks stack)

See phased plan in the design doc. Likely: Node daemon + tray (P0), Tauri webview shell (P1).

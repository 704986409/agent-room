# Desktop Agent-Room-0.1.26-v9

Same app semver **0.1.26**; pack/tag label **Agent-Room-0.1.26-v9** / `desktop-v0.1.26-v9`.

## Naming

- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v9` → `Agent-Room-0.1.26-v9_*` so successive fix packs on the same semver stay distinguishable.

## What’s in this pack (vs v8)

1. **Cursor HostLocal flash-exit:** `seat-launch` expands `%SCRIPT_DIR%` when unwrapping `cursor-agent.cmd`, keeps `-File …\cursor-agent.ps1`, and refuses a missing `.ps1` so PowerShell no longer gets `-File --resume` and exits `-196608`.
2. **PTY exit visible in rail:** on process exit the docked terminal shows `exit=<code>` plus a short log tail (no silent disappear); wake resume still reconnects.
3. **「请先登录」→ embedded login modal:** clicking login opens an MCP-approval-style modal with a virtual terminal running the CLI login command (`agy` / `codex login` / `cursor-agent login` / `claude auth login`). After auth succeeds, HostLocal continues hosting automatically without another 托管 click.
4. **Wake ~30s long-poll:** `/api/wake` poll can hold up to 30s until work appears; daemon uses long-poll with try/catch + detailed logs and falls back to short poll + backoff for a few minutes after failures. Web tip must include the API change.

Also includes all v8 pack fixes (Quiet→sleep, daemon crash harden, frosted offline overlay).

## Install

- Prefer Windows **NSIS** `Agent-Room-0.1.26-v9_x64-setup.exe` (has force-kill upgrade hooks).
- Quit Agent Room completely (tray → 退出) before upgrading.
- After install: reopen desktop; hard-refresh the room page so wake long-poll + login modal load from the deployed web tip.

## Branch

- Built from `dev-grok-0.1.26` tip (**not** merged to `dev-grok` / `main`).

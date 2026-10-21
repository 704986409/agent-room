# Agent Room Desktop

Tauri v2 shell + Node wake daemon. The shell opens the web app and a local settings page; the daemon pairs the device, launches interactive agent CLIs, and polls `/api/wake`.

## Requirements

- **Node.js ≥ 20** to build. Installers bundle a portable Node runtime for the daemon (`resources/node`). Set `AGENT_ROOM_NODE` to override it.
- A checkout of the forked MCP (`feat/stop-hook-one-round`) next to this repo, or `AGENT_ROOM_MCP_SRC` pointing at it. CI sets `AGENT_ROOM_MCP_SRC=$GITHUB_WORKSPACE/agent-room-mcp`. `npm run bundle-mcp` stages it to `resources/mcp`, and MCP 一键配置 launches that bundle.
- One supported agent CLI: `agy`, `cursor-agent`, or `codex` (interactive TUI)
- A reachable Agent Room **server** (set `AGENT_ROOM_SERVER` or `desktop.json`; defaults to `https://ai-room.pupgo.top`). The desktop app alone is not enough.

## Configure server URL

1. Environment: `AGENT_ROOM_SERVER=https://your-server.example`
2. Or config file:
   - Linux: `~/.config/agent-room/desktop.json` → `{"serverUrl":"https://..."}`
   - Windows: `%APPDATA%\agent-room\desktop.json` → same JSON

Default if unset: `https://ai-room.pupgo.top`.

## Start on Windows

After installing the portable daemon, start it manually with:

```powershell
node "$env:LOCALAPPDATA\AgentRoom\Desktop\daemon\agent-room-daemon.mjs" serve --server "https://ai-room.pupgo.top"
```

The portable Installer desktop shortcut also passes `serve --server <url>`. It selects the URL from `%APPDATA%\agent-room\desktop.json` (`serverUrl`) first, then `AGENT_ROOM_SERVER`, then `https://ai-room.pupgo.top`.

## Pairing (first run)

1. Start the desktop app (or `node daemon-dist/agent-room-daemon.mjs serve --server URL`).
2. Open **本机设置** from the tray.
3. In the web app: log in → 个人中心 → **生成配对码** → paste into settings → **绑定**.
4. Or use username/password on the settings page (**登录并绑定**).

## Build on Linux (this repo)

```bash
cd desktop
npm install
npm run package:linux   # AppImage + deb + tarball
```

Needs: Rust (rustup), webkit2gtk-4.1, libayatana-appindicator3, Node 20+.

## Build on Windows (produce .msi / NSIS .exe)

Cross-compiling Windows installers from Linux is not supported here. Build on a Windows machine (or CI `windows-latest`):

```powershell
# Prerequisites: Node 20+, Rust (rustup), WebView2 (usually preinstalled on Win10/11)
cd desktop
npm install
npm run package:windows
# Outputs under:
#   src-tauri/target/release/bundle/nsis/*.exe
#   src-tauri/target/release/bundle/msi/*.msi
```

The NSIS/MSI packages embed `daemon-dist/`, a portable Node runtime under `resources/node`, and the forked MCP under `resources/mcp`. The shell starts the daemon with that Node. 一键配置 launches `node resources/mcp/dist/index.js`.

### GitHub Actions

Workflow `.github/workflows/desktop-release.yml` builds Linux + Windows on tag `desktop-v*` and uploads release assets.

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
# or: gh workflow run desktop-release.yml -f tag=desktop-v0.1.0
```

## Interactive agent windows

- **Linux:** `xfce4-terminal` / `x-terminal-emulator` when `DISPLAY` is set.
- **Windows:** Windows Terminal (`wt`) if on PATH, otherwise `cmd /c start … cmd /k` (new console window).

## Credentials

- Linux: libsecret (`secret-tool`) when available, else `%config%/credentials.json` (0600).
- Windows: Credential Manager via `win-cred.ps1`, else file fallback under `%APPDATA%\agent-room\credentials.json`.

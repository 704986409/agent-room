# Desktop Agent-Room-0.1.26-v4

Pack label for the HostLocal CLI detect-cache fix on branch `dev-grok-0.1.26` (tip includes `e22951d` and earlier v3 tip).

## Naming choice
- **App semver / Tauri `version` / `productName`:** still `0.1.26` / `Agent Room` (install path, upgrade identity, MSI/NSIS product code stay compatible with previous 0.1.26 packs).
- **Release tag / download filenames:** `desktop-v0.1.26-v4` → `Agent-Room-0.1.26-v4_*` so successive fix packs on the same semver stay distinguishable.

## Included in this pack (vs v3)
1. **HostLocal CLI list no longer blocks on every open:** daemon/control boot warms `adapter.detect()` + live model lists into a process cache; `GET /api/status` (and HostLocal adapter picking) reads the cache instead of serializing a full detect round-trip.
2. Cold start: status may wait up to ~1.5s for the first warm-up; stale cache refreshes in the background (~60s TTL) without blocking the dialog.
3. Status `whoami` capped at **2s** so a slow/offline server cannot stall the HostLocal dialog for minutes.
4. After CLI install success, detect cache is updated immediately (models refresh in the background).

## Not in this pack
- Unrelated HostLocal / room / leave issues still being tested.
- No Tauri semver bump; this is a same-semver pack rebuild.

## Install
- Prefer Windows **NSIS** `Agent-Room-0.1.26-v4_x64-setup.exe` (has force-kill upgrade hooks).
- Linux: AppImage or deb with the same pack prefix.
- Quit Agent Room before upgrading; re-pair only if the device binding is lost.

# Desktop Updater

Handles checking for available updates, downloading them, and notifying the renderer process. Uses `electron-updater` with auto-download disabled; the renderer polls via IPC and controls when to download/install.

## Key Files
- `packages/desktop/src/main/updater.ts` — Core updater logic: `setupAutoUpdater()` configures `electron-updater`, `checkUpdate()` returns cached/pending result or triggers `checkAndDownloadUpdate()`
- `packages/desktop/src/main/ipc.ts` — IPC handlers exposing updater and other desktop APIs to the renderer
- `packages/desktop/src/main/index.ts` — Main entry point; imports updater setup constants (`UPDATER_ENABLED`) and registers IPC handlers

## Notes
- `autoUpdater.autoDownload = false` means updates are only downloaded when renderer explicitly requests it.
- Renderer-side polling lives in `packages/app/src/pages/layout.tsx` via `platform.checkUpdate()` query with 10-minute refetch interval.
- CLI/TUI has separate update-available logic (`packages/opencode/src/cli/cmd/tui/app.tsx`) listening to `installation.update-available` events — distinct from Electron updater.
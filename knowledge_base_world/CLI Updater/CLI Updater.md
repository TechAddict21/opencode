# CLI Updater

Handles checking for newer versions of the opencode CLI and emitting update-available events. Supports multiple installation methods and respects user configuration flags to disable or force notifications.

## Key Files
- `packages/opencode/src/cli/upgrade.ts` — Main entry point (`upgrade()`): checks `autoupdate` config and `OPENCODE_DISABLE_AUTOUPDATE` flag, detects install method, fetches latest version, and emits `UpdateAvailable` event via `GlobalBus` if `OPENCODE_ALWAYS_NOTIFY_UPDATE` is set

## Notes
- Early returns if auto-update is disabled via config or environment flag
- Uses `Installation.method()` to detect how the CLI was installed
- `Installation.latest(method)` fetches the latest version; failures are silently caught
- Events are emitted on `GlobalBus` with directory `"global"` for global-level notifications
# Drill-Down Tree

A LEAN index of knowledge areas. ONE entry per area (a domain or feature),
NOT one per source file. Each entry is ONLY a pointer to that area's doc plus a
one-line description — NO source-file paths live here. The doc holds the detail,
including a "Key Files" list that maps each file to its use case.

Each area is a "## Area Name" header followed by one bullet:
  - **Area/Doc.md** — one-line description of the whole area

No areas captured yet — the knowledge completer adds them as the codebase is explored.

## CLI Launch & Branding
- **CLI Launch & Branding/CLI Launch & Branding.md** — How `nous` launches (`run.sh` → compiled binary or bun dev) and where the "nous" name surfaces; the terminal-tab name is the process executable name, so the binary filename in build.ts/run.sh/bin must stay in lockstep.

## Desktop Updater
- **Desktop Updater/Desktop Updater.md** — Auto-update checking and download logic for the Electron desktop app using electron-updater.

## CLI Updater
- **CLI Updater/CLI Updater.md** — Auto-update checking and notification logic for the CLI tool, supporting multiple install methods (npm, brew, curl).

## TUI Prompt
- **TUI Prompt/TUI Prompt.md** — TUI prompt component that renders agent status labels and busy-state display names.

## TUI Session
- **TUI Session/TUI Session.md** — TUI route that renders the interactive chat session view with message list, user input, and message action dialogs.

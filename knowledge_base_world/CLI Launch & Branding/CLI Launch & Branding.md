# CLI Launch & Branding

The `packages/opencode/bin/nous` CLI is launched via `run.sh`, which either runs a compiled Bun binary or falls back to `bun dev` for development. The terminal-tab title and `process.title` are set to `packages/opencode/bin/nous` so users can identify the process in their OS process list and terminal tabs. The binary filename (`bin/nous`) is the source of the terminal-tab name on macOS, so the name in `bin/`, the build pipeline, and `run.sh` must stay in lockstep — renaming the binary silently breaks the tab title.

## Key Files
- `packages/opencode/bin/nous` — Node.js wrapper that sets `process.title = "nous"` and writes the terminal escape sequence `\x1b]0;nous\x07` to stderr, then spawns the real binary with inherited stdio and forwards SIGINT/SIGTERM/SIGHUP.
- `packages/opencode/script/build.ts` — `outfile: dist/${name}/bin/nous` (~209) and the post-build smoke-test path (~228). Source of the binary filename.
- `packages/opencode/src/index.ts` — yargs entry. `.scriptName("nous")` (help/usage text), `show()` gating on `text.startsWith("nous ")`, and `process.title = "nous"`.
- `packages/opencode/src/cli/cmd/tui/app.tsx` — `createEffect` (~347) calls `renderer.setTerminalTitle("Nous" | \`nous | ${title}\`)`, gated by `terminal_title_enabled` KV and `Flag.OPENCODE_DISABLE_TERMINAL_TITLE`. Sets the OSC title but does NOT override VS Code's process-name-based tab.

## Notes
- The wrapper is a thin shim: the actual CLI logic lives in the spawned child (`target`). The wrapper exists primarily to own the `packages/opencode/bin/nous` process name and tab title.
- When the compiled binary is used, all dev-mode `console.log` debug statements added to TUI/server code are NOT picked up — must run via `run.sh --dev` (bun) to test new logs.
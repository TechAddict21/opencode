# TUI Prompt

Renders the interactive prompt in the TUI. Handles agent name display and maps busy states to user-facing labels (e.g., "Building", "Planning", "Reviewing").

## Key Files
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — Prompt component with `agentDisplayName` that converts agent names to status labels based on session state

## Notes
- `agentDisplayName` returns `"Reviewing"` when `status().label === "reviewing"`, otherwise maps `"build"` → `"Building"`, `"plan"` → `"Planning"`.
- Uses `sync.data.session_status` keyed by `sessionID` to determine busy/idle state.
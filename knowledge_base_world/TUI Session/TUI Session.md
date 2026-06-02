# TUI Session

The main TUI route for an individual chat session. Renders the scrollable message timeline, handles user input via a prompt component, and provides message-level actions through modal dialogs.

## Key Files
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — Main session route component; renders message list, handles input, and opens message action dialogs on user message click
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` — Dialog for actions on a single message (copy, etc.)
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-timeline.tsx` — Dialog for browsing and moving to a specific message in the timeline

## Notes
- `UserMessage` accepts an optional `onMouseUp` prop to trigger message actions; previously wired to open `DialogMessage`
- Dialogs are managed via `useDialog()` and rendered through `dialog.replace()`
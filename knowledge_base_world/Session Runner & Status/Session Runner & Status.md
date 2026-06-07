# Session Runner & Status

Effect-based session execution pipeline. The runner uses a tagged-union state machine (`Idle` / `ShellThenRun` / `Running`) inside `ensureRunning` to fire the `onBusy` signal at the right transition point before delegating to `startRun`. Status events flow from the server and are consumed in the TUI via `sync.tsx`, which must apply them with a deep-reconcile merge so partial updates don't carry stale label fields from the previous turn.

## Key Files
- `packages/opencode/src/effect/runner.ts` — `ensureRunning` state machine (`Idle` / `ShellThenRun` / `Running`) that yields `onBusy` before delegating to `startRun`; symmetry between the `Idle` and `ShellThenRun` branches is required so the busy-signal is never missed on the Idle→Running transition.
- `packages/opencode/src/session/status.ts` — `SessionStatus` Effect service: `get`/`list`/`set` backed by `InstanceState`, publishes `Event.Status` and `Event.Idle` (the latter on idle, then drops sessionID from in-memory map).
- `packages/opencode/src/session/run-state.ts` — `SessionRunState.runner` factory: reuses an existing runner for the sessionID or constructs a new `Runner.make` with `onIdle`/`onBusy` wiring that drives `SessionStatus.set`.
- `packages/opencode/src/session/prompt.ts` — calls `status.set(sessionID, { type: "busy" })` around code-review work (e.g. gating `need_changes` → inject fix plan → re-review loop) and uses `status` for per-turn `recordReviewUsage`.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` — TUI event sync: handles the `"session.status"` case by writing the new status into the `session_status` store keyed by sessionID.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — TUI prompt UI: derives `status`/`isBusy` from `sync.data.session_status`, and `agentDisplayName` maps agent names to user-facing labels (`Reviewing` when busy with `label === "reviewing"`, `Processing` for `build`, `Planning` for `plan`).
- `packages/opencode/src/session/processor.ts` — Per-step processor invoked by the prompt loop; sets `needsCompaction` and publishes `Session.Event.Error` on context overflow.
- `packages/opencode/src/cli/cmd/tui/context/event.ts` — TUI bus event subscription; drops `sync` events and filters by `event.project === project.project()`.

## Notes
- **Idle vs ShellThenRun symmetry**: `yield* onBusy` MUST be present in BOTH cases of `ensureRunning`. Dropping it from the `Idle` case (the regression caught this session) causes the UI to skip the busy transition entirely.
- **Status merge gotcha (TUI side, `sync.tsx:249`)**: server status events must be applied with `reconcile(status)`, NOT a shallow `setStore` merge. The server publishes clean partial payloads like `{type: "busy"}` (no `label` field), and a shallow merge leaves the previous turn's `label` attached — surfacing wrong text like "Reviewing" while the server is actually just "busy".
- **Diagnostic roundtrip pattern**: when the label looks wrong, log the raw event on the TUI receive path AND the merged status the prompt renders with — the diff between the two pinpoints whether the bug is server-side (publishing the wrong payload) or client-side (merging it wrong).
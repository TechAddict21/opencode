# Session runLoop & Snapshot service

How a user turn is processed, where post-turn reviewers hook in, and the snapshot
mechanism used to scope diffs to a single turn.

## runLoop turn lifecycle (`prompt.ts`)

`runLoop(sessionID)` is an `Effect.fnUntraced` with a `while (true)` loop. Each
iteration:

1. Loads messages (`MessageV2.filterCompactedEffect`) and `MessageV2.latest(msgs)`
   → `{ user: lastUser, assistant: lastAssistant, finished, tasks }`.
2. Computes the **genuine user** = latest user message that is NOT entirely synthetic
   (`!parts.every(p => "synthetic" in p && p.synthetic)`). This distinguishes a real
   user request from reviewer-injected feedback.
3. **Captures the turn baseline snapshot** once per genuine turn, *before* the agent
   runs: `if (genuineUserID !== turnBaselineUserID) turnBaselineSnapshot = yield* snapshot.track()`.
   This is the pre-edit working-tree state for the turn.
4. If the last assistant message is **finished with no pending tool calls** and is newer
   than the user message → run the post-turn review block (text reviewer, then code
   reviewer). Otherwise → run the agent: create an assistant message, `processor.create(...)`,
   stream the response + tool calls.
5. Reviewers can `continue` the loop by injecting a **synthetic user message** (a user
   message whose text part has `synthetic: true`). That drives the main agent to
   regenerate / apply fixes. The loop exits with `break` when no reviewer requests more.

Key point: synthetic user messages have new, higher message IDs, so `lastUser` becomes
the synthetic one after injection. Anything that must persist across a turn (iteration
counters, the snapshot baseline) is therefore keyed off the **genuine** user id, not
`lastUser.id`.

Other loop responsibilities: title generation (step 1), compaction/overflow handling,
subtask handling, agent resolution, building tools, running the processor.

## Snapshot service (`snapshot/index.ts`)

A side git repo (under `<data>/snapshot/<project>/<hash(worktree)>`) that tracks the
user's working tree without touching their real `.git`. Used by revert, summary, the
processor, and (now) the reviewer for turn-scoped diffs.

- `track(): Effect<string | undefined>` — stage current working-tree changes into the
  snapshot index and `write-tree`; returns the tree hash. `undefined` if disabled
  (`config.snapshot === false` or non-git project). Tree hashes are valid across
  Snapshot instances (shared object store), so a hash from one call works in another.
- `diffFull(from, to): Effect<FileDiff[]>` — per-file diff between two tree hashes.
  `FileDiff = { file?, patch?, additions, deletions, status? }` where status ∈
  added/deleted/modified. `patch` is **full-file context** (whole file with +/- markers),
  so cap it when feeding to an LLM.
- `patch(hash): Effect<{hash, files}>` — list of files changed since `hash` (absolute paths).
- `diff(hash): Effect<string>` — one combined unified diff (3 lines context) since `hash`.
- `restore` / `revert` — used by the undo/revert feature.

The processor records per-step snapshot hashes on `StepStartPart.snapshot` /
`StepFinishPart.snapshot` (see `message-v2.ts`) — useful if you need before/after a
specific tool call, but for turn-scoping the explicit `turnBaselineSnapshot` in runLoop
is simpler and robust across re-injections.

## How turn-scoping works (the 8–10 / 10–12 requirement)

- Turn 1 (e.g. 8:00): baseline `S0` captured before the agent edits. Review = `diffFull(S0, now)`.
- Turn 2 (10:00): new genuine user message → new baseline `S1` captured. `S1` already
  *contains* turn-1's edits (committed or not), so `diffFull(S1, now)` shows only turn-2's
  changes. Re-review iterations within a turn reuse that turn's baseline.

## Key Files

- `packages/opencode/src/session/prompt.ts` — `runLoop` (search `while (true)`, `genuineUser`, `turnBaselineSnapshot`); the post-turn review block; layer wiring at bottom (`defaultLayer`, `Layer.mergeAll`).
- `packages/opencode/src/snapshot/index.ts` — Snapshot service (`track`, `diffFull`, `patch`, `diff`, `restore`, `revert`).
- `packages/opencode/src/session/processor.ts` — `processor.create` runs one agent turn; captures `initialSnapshot` and records step snapshots.
- `packages/opencode/src/session/message-v2.ts` — message/part schemas; `latest(msgs)`; `TextPart.synthetic`; `StepStart/StepFinishPart.snapshot`.

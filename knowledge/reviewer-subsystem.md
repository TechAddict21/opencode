# Reviewer subsystem

Automated post-turn review that runs after the agent finishes a user turn. Two
independent stages run in `prompt.ts`'s runLoop, in order:

1. **Text Reviewer** (`reviewer.ts`) — peer-reviews the assistant's *chat reply*
   (text/reasoning). Can rewrite the reply (`refined_response`) or inject feedback
   to request a regeneration. Reviews prose, not files. Runs on every finished turn.
2. **Code Reviewer** (`code-reviewer.ts`) — the multi-agent code review. Fires only
   when **more than `code_reviewer.max_files`** files changed this turn. Groups the
   changed files by category, runs one specialist "expert" reviewer per category in
   parallel, then feeds all their feedback to a single **full-stack fixer**.

Both stages can loop (bounded), feeding work back to the main agent.

## Code reviewer flow (the main pipeline)

1. `collectChanges` resolves the turn's changes:
   - **Preferred (turn-scoped):** diff the turn-start snapshot baseline against the
     current working tree (`Snapshot.diffFull(baseline, current)`) → only THIS turn's
     edits. See [session-loop-and-snapshots.md](session-loop-and-snapshots.md).
   - **Fallback (snapshots off):** whole working tree vs `HEAD` via the Git service
     (untracked files via `git.patchUntracked`, since `git diff HEAD` ignores them).
2. If `changes.length <= max_files` → skip (logged).
3. `groupChangesByCategory` buckets files into categories by path heuristics
   (`categorizeFile`): frontend, backend, database, config, general, nestjs,
   react_vite, postgresql, caching, security. **Plus** extra lenses added over filtered
   subsets (same files, additional reviewer):
   - `design` — UI files (`isUIFile`: .tsx/.jsx/.vue/.svelte/.html/.css/…, /components/, /styles/, …)
     → UI/UX lens (`prompts/design.txt`, `ui-design-reviewer`). Gated by `design_review` (default true).
     Has an explicit **AI-slop ban list** (file:line each): Sparkles/✨/Wand icons, Bot/robot avatars,
     emoji-as-icons, "AI-powered" badges, gradient text / purple-pink hero gradients. The same ban list
     lives in the `frontend-design` SKILL.md so the agent doesn't re-introduce them when implementing.
     (Real miss: the reviewer wrote a great layout critique but ignored 5× `Sparkles` icons until the
     ban list was added — holistic aesthetic judgment alone doesn't catch specific cliché tells.)
   - `functional` — same UI files → HOLISTIC functional-completeness lens (`prompts/functional.txt`,
     `ui-functional-reviewer`). Gated by `functional_review` (default true). Catches dead/stub controls
     (console.log-only/empty handlers, no onClick), forms that submit nowhere, and especially the
     **missing-data-layer smell** (static mockData + scattered local useState → mutations can't persist
     across views). Per-file experts each see only their slice and miss this; the holistic lens gets ALL
     UI files at once. Real incident: frontend expert flagged "Create button does nothing" but NOT the
     root cause (no shared store), so the fix stayed shallow and buttons remained dead.
   - `curl` — API files (`isAPIFile`: *.controller/.resolver/.gateway/.service.ts, /api//routes//handlers//resolvers/,
     openapi/swagger) → curl/API-test lens (`prompts/curl.txt`, `api-curl-tester`). Gated by
     `curl_testing` (default true). It's a PLANNER: emits a safe curl test plan; the MAIN agent
     executes it. `review()` reads `<directory>/CURL_TESTING.md` and injects it into the prompt's
     `{curl_context}` so auth/base-URL are reused. `FileGroup.context` carries that; `reviewCategory`
     fills `{curl_context}` (no-op for prompts that lack the placeholder).
3b. **Batching for scale** (`batchGroups`): a per-category expert group with more than
   `batch_size` files (default 6) is split into parallel batches of ≤`batch_size`, so a single
   agent is never handed 20+ files (it would miss issues + the diff would truncate). Holistic
   lenses (`HOLISTIC_CATEGORIES` = design/functional/curl) are NEVER batched — they must see all
   their files to reason across them. Batch feedback is merged per category ("BACKEND REVIEW (batch 2/4)").
   Config: `batch_size` (default 6; 0 disables), `concurrency` (default 4 parallel batches).
   Diff budget is ADAPTIVE per call: `reviewCategory` splits a ~48k-char budget across that call's
   files (`perFile = max(1200, 48000/N)`), so the prompt is bounded for any N and later files are
   never silently dropped — replaces the old flat 50k total-slice that truncated big changesets.
4. **Phase 1:** run each reviewer batch in parallel (concurrency = `concurrency`),
   each prompted with that category's `prompts/<cat>.txt` + the file list + diff +
   the real user requirement. Each returns JSON `{need_changes, feedback, refined_response}`
   (only `need_changes`/`feedback` are used here).
5. **Phase 2:** if any expert flagged issues, the **full-stack fixer**
   (`prompts/full-stack-fixer.txt`) consolidates ALL feedback into a single,
   prioritized, file-by-file **fix plan** (in `refined_response`). It is a quality
   gate: it drops false positives and can return `need_changes:false` to ship clean.
6. `review()` returns the fixer result (or, if the fixer LLM fails, a fallback
   carrying the raw combined feedback).

## Critical invariants (do NOT regress these — each fixed a real bug)

- **Turn-scoping.** Review must cover only the *current* turn's changes, never
  earlier uncommitted work. Achieved by snapshotting the working tree at the start
  of each genuine user turn and diffing baseline→now. (User requirement: "8:00→8:10
  reviewed in turn 1; 10:00→12:00 reviewed in turn 2, not 8–10 again.")
- **Iteration caps key off the GENUINE user turn.** Reviewers inject *synthetic*
  user messages (new message IDs) to drive re-loops. The caps (`reviewer.max_iterations`,
  `code_reviewer.max_iterations`) and the snapshot baseline are keyed off the latest
  *non-synthetic* user message (`!parts.every(p => p.synthetic)`), NOT `lastUser.id`.
  Keying off `lastUser.id` makes synthetic injections reset the counters every loop →
  runaway review loop / token burn.
- **The fixer applies fixes via re-injection, not by editing chat.** The fixer LLM has
  NO tools. Its fix plan is injected as a synthetic user message so the MAIN agent (which
  has Edit/Write) applies it to files, then re-enters review. Do NOT route the fix plan
  into the assistant's chat text — that just prints code and changes nothing on disk.
- **Prompt templates are filled with function replacements.** Use
  `template.replace("{x}", () => value)`, never `.replace("{x}", value)`. Diffs/feedback
  routinely contain `$&`, `$1`, `${...}` which `String.replace`'s string form treats as
  special patterns and corrupts.

## Config (config.ts → `reviewer`, `code_reviewer`)

- `reviewer`: `enabled` (default true), `max_iterations` (3), `model` (override; else session model).
- `code_reviewer`:
  - `enabled` (default true)
  - `max_files` (default **0** → review any turn that changes ≥1 file; skip only when 0 changed; set N to require N+1)
  - `max_iterations` (default 2)
  - `model` (override for experts + fixer; else session model)
  - `reviewer_timeout` (per-expert LLM timeout, default 90s)
  - `fixer_timeout` (fixer LLM timeout, default 300s)
  - `fixer_small` (default **true** → run the fixer on the fast/small model)
  - `design_review` (default **true** → run the extra UI/UX design reviewer on UI files)
  - `functional_review` (default **true** → run the extra holistic UI functional-completeness reviewer)
  - `curl_testing` (default **true** → run the extra curl/API-test reviewer on API files)
  - `batch_size` (default **6** → max files per reviewer call; big categories split into parallel batches; 0 disables)
  - `concurrency` (default **4** → max reviewer batches running in parallel; lower if rate-limited)
- Experts always run on the small model (`small: true`). The fixer also runs on the small model
  by default (`fixer_small: true`) — the experts already did the analysis, so consolidation is cheap.
  **Lesson learned (real incident):** the session's main model is a *reasoning* model; running the
  fixer on it (`small: false`) burned ~6–9k tokens / 166–274s to emit a ~500-char plan and nearly
  re-hit the timeout. Keep the fixer on `small` unless the main model is fast and non-reasoning.
- Diff sizes fed to LLMs: each **expert** prompt gets its per-category diff sliced to 50k chars;
  the **fixer** gets a deliberately small diff (≤12k) because it works from the experts' feedback
  (which already cites file:line) and the main agent has the real files. A big fixer diff was what
  caused the original 120s timeouts (`error: "TimeoutError"`, `durationMs == timeout`, 0 output →
  fell back to raw feedback).

## Per-session audit log

Every review action appends one JSON line to `<data>/log/review/<sessionID>.jsonl`
(see `review-log.ts`; best-effort, never throws). Phases: `review-start`, `changes`,
`reviewer` (one per expert), `fixer`, `skip` (+reason), `categories`, `review-end`
(+outcome), `text-reviewer`. Each LLM call line carries full `input`, full `output`,
`tokens` {input/output/reasoning/cacheRead/total}, `durationMs`, model, decision.
Inspect with `jq` (e.g. `jq 'select(.phase=="reviewer")|{category,durationMs,tokens}'`).
Log dir: `<data>/log/review/` where `<data>` = `$XDG_DATA_HOME/nous` (e.g. `~/.local/share/nous`).

## Token accounting & UI status

- Reviewer/expert/fixer calls go straight through `llm.stream`, bypassing the processor's
  step-finish handler, so their usage is **not** auto-counted. To make spend visible: each call's
  usage is computed via `Session.getUsage` (cost uses `input.model` — `small` is only a telemetry
  tag, it does NOT swap the model), aggregated, and returned as `{ result, usage }` from
  `reviewer.review()` / `code-reviewer.review()`. `prompt.ts` then writes a `step-finish` part
  (reason `code-review` / `text-review`) onto the turn's assistant message → the session-cost
  projector (`session/projectors.ts`, `applyUsage`) rolls it into `SessionTable.cost`/`tokens`.
  Net effect: reviewer usage now shows in the TUI **cumulative total + cost**, but NOT the
  **context-%** display (that reads the message-level `.tokens`, left untouched).
- While the FILE reviewers run, `prompt.ts` sets `{ type: "busy", label: "reviewing" }`; the TUI
  (`component/prompt/index.tsx`, `agentDisplayName`) shows **"Reviewing"** instead of the agent
  name ("Building"). The text reviewer does NOT set this. Needs the optional `label` field on the
  busy `SessionStatus` variant (`session/status.ts`).

## Key Files

- `packages/opencode/src/reviewer/code-reviewer.ts` — multi-agent code review: `collectChanges`, `categorizeFile`/`groupChangesByCategory`, `streamReviewer` (captures text+tokens+timing), `reviewCategory` (expert), `runFullStackFixer`, `review`. Service `@opencode/CodeReviewer`, exported as `CodeReviewer`.
- `packages/opencode/src/reviewer/reviewer.ts` — text reviewer (`@opencode/Reviewer`, exported `Reviewer`); reviews chat reply, can refine or request changes.
- `packages/opencode/src/reviewer/review-log.ts` — per-session JSONL audit writer (`ReviewLog.append`, `ReviewLog.location`).
- `packages/opencode/src/reviewer/prompts/*.txt` — one per category + `design.txt` (UI/UX lens; applies the `frontend-design` skill) + `curl.txt` (API-test lens; also fills `{curl_context}` with CURL_TESTING.md) + `full-stack-fixer.txt`; each has `{files}`, `{diff}`, `{user_requirement}` (fixer also `{all_reviewer_feedback}`). NOTE: the code-expert `need_changes` gate is "real defects only / no style nitpicks", but `design.txt` (flag bland UI) and `curl.txt` (always test changed APIs) are the OPPOSITE. The fixer prompt is told to KEEP design-review feedback AND the curl test plan (`### API TEST` section), not drop them as nitpicks. The curl plan is executed by the main agent, which maintains `CURL_TESTING.md` (project root, holds base-URL/auth/token; must be git-ignored — it's a secret).
- `packages/opencode/src/reviewer/prompt.txt` — the text reviewer's prompt (`{history_text}`, `{final_text}`, `{final_reasoning}`).
- `packages/opencode/src/session/prompt.ts` — wiring: runLoop captures the turn baseline, runs both reviewers, injects fixes, enforces caps, records reviewer token usage, sets the "reviewing" status. Search `genuineUser`, `turnBaselineSnapshot`, `codeReviewer.review`, `recordReviewUsage`, `label: "reviewing"`.
- `packages/opencode/src/session/status.ts` — `SessionStatus`; busy variant carries optional `label` (used for "reviewing").
- `packages/opencode/src/session/projectors.ts` — `applyUsage` rolls `step-finish` part cost/tokens into the session total.
- `packages/opencode/src/config/config.ts` — `reviewer` / `code_reviewer` schema (search those keys; incl. `reviewer_timeout`, `fixer_timeout`, `fixer_small`).

## Gotchas

- Source edits here need `./run.sh --build` to affect the user's `nous` binary (see README).
- `categorizeFile` is path-heuristic and has false positives (e.g. any path containing
  `.tsx`, or `queue` → caching). Acceptable; tighten only if it misroutes real reviews.
- Snapshot diffs are full-file context; each file's diff is capped at `MAX_FILE_DIFF` (15k).
  Each expert prompt then slices the per-category diff to 50k; the fixer to 12k (see Config).
- Experts still over-flag nitpicks despite the `need_changes` gate, but the fixer is the gate that
  matters — it filters nitpicks/contradictions/already-correct out of the final plan, so what
  reaches the main agent is clean. Don't expect experts to self-converge; expect the fixer to.

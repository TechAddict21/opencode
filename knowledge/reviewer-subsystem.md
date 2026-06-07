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
     Refactored into `collectFromRepo(repoDir, prefix)`.
   - **Nested-repo fallback (launch dir is NOT a git repo):** if `git.hasHead(directory)`
     is false, `findNestedRepos()` does a bounded walk (depth ≤2, skips node_modules/dist/…)
     for nested `.git` repos and runs `collectFromRepo` on each, prefixing file paths with
     the repo's path relative to `directory` (e.g. `agent-claw/backend/src/tasks/task.model.ts`).
     **Why (real incident, ses_178141634…):** nous was launched from `code-claw/`, a parent
     folder holding nested repos `agent-claw/`+`cli-claw/`. Snapshots self-disable when
     `vcs !== "git"` (`snapshot/index.ts` `enabled()`), so `turnBaselineSnapshot` was undefined;
     the git fallback's `hasHead(code-claw)` was false → returned `[]` → `changedCount: 0` →
     `skip: not_enough_files`. The WHOLE panel (db, curl, frontend) was bypassed even though
     the turn edited real files. The nested-repo walk fixes this so reviewers fire regardless.
1b. `collectSideEffects` (sibling of `collectChanges`, see below) resolves the turn's non-file
    side-effect tool calls from the side-effect ledger (`session/side-effect-ledger.ts`).
    If `sideEffects.length > 0` AND `changes.length <= max_files`, the early-skip is BYPASSED
    so the infra lens can still fire — a turn whose work is purely `docker run`/`psql -c`/etc.
    has an empty file diff but still needs review.
2. If `changes.length <= max_files` AND `sideEffects.length === 0` → skip (logged).
3. `groupChangesByCategory` buckets files into categories via `categorizeFile`.
   Routing is **framework-path-first, then extension**: strong path rules win
   (nestjs, react_vite, caching, postgresql, frontend, database, config, security,
   backend), so e.g. a `.ts` under `/services/` stays `backend`. Files matching no
   framework rule fall to a **per-language lens** by extension so each gets a deep,
   language-specific prompt instead of `general`: `css` (css/scss/sass/less — checked
   FIRST, before any path rule, since no framework owns a stylesheet), `html`,
   `typescript` (bare .ts/.mts/.cts), `javascript` (.js/.mjs/.cjs), `python`, `go`,
   `rust`, `java`, `shell`. `.tsx`/`.jsx` → `react_vite` (reuses `react-vite.txt`).
   Each has its own `prompts/<lang>.txt` + `<lang>-reviewer` agent. **Plus** extra
   lenses added over filtered subsets (same files, additional reviewer):
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
   - `schema` — column-bearing files (`isSchemaFile`: *.entity.ts/.model.ts/.schema.ts/.dto.ts, .sql,
     /entities//models//migration(s)//schema(s)/, prisma/drizzle/typeorm/sequelize/knex) → HOLISTIC
     DB/schema lens (REUSES `prompts/database.txt`, `db-schema-reviewer`). Gated by `schema_review`
     (default true). Sees ALL column-bearing files together so it can cross-check **a newly-added
     column ↔ the migration that creates it**. **Why (same incident):** `categorizeFile` assigns ONE
     category per file by path, so `task.model.ts`→`general` and `create-task.dto.ts`→`nestjs` — a new
     `created_by` column never reached `database`/`postgresql`, and nothing forced a "does a migration
     add this column?" check. `database.txt` was strengthened to REQUIRE that: a field added to an
     entity/model/DTO must have a backing migration in the same diff (relying on ORM `synchronize:true`
     does NOT count — the column is missing in the real DB at runtime); it also flags the reverse
     (migration adds a column but the model/serializer never exposes it) and type/nullability mismatch.
     **Plus a redundancy/normalization check:** reject a NEW column that duplicates existing data —
     an ownership/actor field ("created by", owner, author) must be a FK to the existing user entity
     (reuse `user_id`, resolve the name via the relation), NOT a denormalized free-text `createdBy`
     string; same for any name/label/email that should be a FK+join or a value derivable from existing data.
3b. **Batching for scale** (`batchGroups`): a per-category expert group with more than
   `batch_size` files (default 6) is split into parallel batches of ≤`batch_size`, so a single
   agent is never handed 20+ files (it would miss issues + the diff would truncate). Holistic
   lenses (`HOLISTIC_CATEGORIES` = design/functional/curl/schema) are NEVER batched — they must see all
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
  - `schema_review` (default **true** → run the extra holistic DB/schema reviewer over column-bearing files; verifies every new column is backed by a migration)
  - `infra_review` (default **true** → run the extra runtime/infra reviewer when the side-effect ledger shows mutating docker/db/network/system/package commands in this turn; catches secrets on the CLI, unverified `docker run`, missing DB assertions, exposed ports, etc.)
  - `batch_size` (default **6** → max files per reviewer call; big categories split into parallel batches; 0 disables)
  - `concurrency` (default **4** → max reviewer batches running in parallel; lower if rate-limited)
  - `change_ledger` (default **true** → maintain the out-of-context per-session change manifest fed to triage; see below)
  - `side_effect_ledger` (default **true** → maintain the out-of-context per-session side-effect ledger of non-file bash calls; fed to triage as a tool-call summary and used to gate the infra lens)
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

## Change manifest (out-of-context) + context-handling robustness

Three robustness features feed/surround review (all config-gated, default on, best-effort):

- **Change ledger → triage** (`session/change-ledger.ts`, gate `code_reviewer.change_ledger`).
  The processor records every completed `write`/`edit` into a per-session manifest keyed by
  **absolute** path (`<data>/analysis/<sessionID>/changes.json`): `+A/-D over N edits — symbols`
  (symbols parsed cheaply from `@@` hunk headers, no LLM). It is **never** in the main agent's
  context — only `review()` reads it, joins the snapshot's repo-relative `Change.file` to absolute
  via `path.resolve(directory, file)`, and injects a compact manifest into triage's `{change_manifest}`
  so triage can size/route the change from a summary, not the full diff.
- **Stale-read invalidation** (`message-v2.ts` `toModelMessagesEffect`, option `invalidateStaleReads`
  from `experimental.stale_read_invalidation`). When a `read` is superseded by a later `write`/`edit`
  of the same absolute file, its output is blanked to a "re-read for current content" marker (same
  mechanism as the `compacted` marker), so the model never reasons against stale file content.
  Self-contained: a forward pass records last-write sequence per file, then any earlier read is flagged
  by callID. read/write/edit all stamp absolute `metadata.filepath` to make this comparable.
- **Per-call API log** (`session/analysis-log.ts`, gate `experimental.api_analysis_log`). `llm.stream`
  writes the assembled request (system+messages+tools) and the folded response (text/tools/usage/outcome)
  as paired `<seq>_<ts>_request.json` / `_response.json` under `<data>/analysis/<sessionID>/`. Covers the
  main agent AND every reviewer/triage/fixer call (all funnel through `llm.stream`). The response is
  written by a scope finalizer so it's captured even on error/abort (`outcome: ok|interrupted|error`).

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

- `packages/opencode/src/reviewer/code-reviewer.ts` — multi-agent code review: `collectChanges` (+ `collectFromRepo`, `findNestedRepos` for the no-git-repo / nested-repo case), `categorizeFile`/`groupChangesByCategory`, `isUIFile`/`isAPIFile`/`isSchemaFile` (lens selectors), `streamReviewer` (captures text+tokens+timing), `reviewCategory` (expert), `runFullStackFixer`, `review`. Service `@opencode/CodeReviewer`, exported as `CodeReviewer`.
- `packages/opencode/src/reviewer/reviewer.ts` — text reviewer (`@opencode/Reviewer`, exported `Reviewer`); reviews chat reply, can refine or request changes.
- `packages/opencode/src/reviewer/review-log.ts` — per-session JSONL audit writer (`ReviewLog.append`, `ReviewLog.location`).
- `packages/opencode/src/session/change-ledger.ts` — out-of-context per-session change manifest (`ChangeLedger.record`/`read`/`manifestText`); written by the processor's `completeToolCall`, read by `review()` for triage.
- `packages/opencode/src/session/analysis-log.ts` — per-call request/response JSON logger (`AnalysisLog.begin`/`complete`); hooked into `llm.stream`. Shares `<data>/analysis/<sessionID>/` with the change ledger.
- `packages/opencode/src/reviewer/prompts/*.txt` — one per category (incl. the per-language lenses `css/typescript/javascript/python/go/rust/java/html/shell.txt`) + `design.txt` (UI/UX lens; applies the `frontend-design` skill) + `curl.txt` (API-test lens; also fills `{curl_context}` with CURL_TESTING.md) + `triage.txt` (now also carries `{change_manifest}`) + `full-stack-fixer.txt`; the `schema` lens has NO own file — it REUSES `database.txt` (which carries the mandatory new-column ↔ migration check) under a distinct `db-schema-reviewer` agent name; each has `{files}`, `{diff}`, `{user_requirement}` (fixer also `{all_reviewer_feedback}`). NOTE: the code-expert `need_changes` gate is "real defects only / no style nitpicks", but `design.txt` (flag bland UI) and `curl.txt` (always test changed APIs) are the OPPOSITE. The fixer prompt is told to KEEP design-review feedback AND the curl test plan (`### API TEST` section), not drop them as nitpicks. The curl plan is executed by the main agent, which maintains `CURL_TESTING.md` (project root, holds base-URL/auth/token; must be git-ignored — it's a secret).
- `packages/opencode/src/reviewer/prompt.txt` — the text reviewer's prompt (`{history_text}`, `{final_text}`, `{final_reasoning}`).
- `packages/opencode/src/session/prompt.ts` — wiring: runLoop captures the turn baseline, runs both reviewers, injects fixes, enforces caps, records reviewer token usage, sets the "reviewing" status. Search `genuineUser`, `turnBaselineSnapshot`, `codeReviewer.review`, `recordReviewUsage`, `label: "reviewing"`.
- `packages/opencode/src/session/status.ts` — `SessionStatus`; busy variant carries optional `label` (used for "reviewing").
- `packages/opencode/src/session/projectors.ts` — `applyUsage` rolls `step-finish` part cost/tokens into the session total.
- `packages/opencode/src/config/config.ts` — `reviewer` / `code_reviewer` schema (search those keys; incl. `reviewer_timeout`, `fixer_timeout`, `fixer_small`).

## Gotchas

- Source edits here need `./run.sh --build` to affect the user's `nous` binary (see README).
- `categorizeFile` is path-heuristic and has false positives (e.g. any path containing
  `.tsx`, or `queue` → caching). Acceptable; tighten only if it misroutes real reviews.
  It also assigns only ONE category per file, so column-bearing files get misrouted away
  from a DB reviewer (`.model.ts`→general, `.dto.ts`→nestjs) — the extra `schema` lens
  (`isSchemaFile`) exists precisely to cover that gap; don't "fix" it by rewriting routing.
- Launch dir must not be assumed to be a git repo root. Snapshots disable themselves when
  `vcs !== "git"`, and a parent folder of nested repos has no HEAD — `findNestedRepos` is the
  safety net so review still runs. If reviewers mysteriously never fire, check the review log
  for `changedCount: 0` / `skip: not_enough_files` and confirm the launch directory.
- Snapshot diffs are full-file context; each file's diff is capped at `MAX_FILE_DIFF` (15k).
  Each expert prompt then slices the per-category diff to 50k; the fixer to 12k (see Config).
- Experts still over-flag nitpicks despite the `need_changes` gate, but the fixer is the gate that
  matters — it filters nitpicks/contradictions/already-correct out of the final plan, so what
  reaches the main agent is clean. Don't expect experts to self-converge; expect the fixer to.

## Side-effect ledger + `infra` lens (runtime state review)

The default pipeline is file-diff based: it only knows about `write`/`edit` tool calls.
A turn whose work is "create a docker container" or "run a migration" or "publish a package"
produces no file edits, so the file pipeline sees `changedCount: 0` and skips review entirely
(turn `ses_161e9f7e6ffer2MM2Zp3SYtXHO`: user asked to `docker run` a postgres container; the
agent ran `docker run` + `docker exec psql` correctly, but the only file changes were
`knowledge_base_world/{.gitignore,DRILL_DOWN_TREE.md,UNDERSTANDING.md}` — triage decided
"trivial doc additions" and skipped review. The runtime work was unaudited).

The side-effect ledger (`packages/opencode/src/session/side-effect-ledger.ts`) closes that
gap. It is the runtime sibling of the change ledger:

- `processor.completeToolCall` records every completed `bash`/`shell` call (command, description,
  exit code, ~280 chars of output) to `<data>/analysis/<sessionID>/side-effects.json` (gated on
  `code_reviewer.side_effect_ledger`, default true).
- A cheap pattern-based classifier in `side-effect-ledger.classify` tags each command as
  `docker:create` / `db:migrate` / `network:mutate` / `system:install` / `package:publish` / …
  (`mutates: true`) or `read-only` (skipped). Conservative: unknown → `mutates: true`.
- `collectSideEffects` is a sibling of `collectChanges` and returns this turn's
  mutating infra-relevant calls time-scoped to the same `baselineTime` the file diff uses.
- `SideEffectLedger.summaryText` renders a compact tool-call summary (`se_1 docker:create …`,
  exit code, output preview) and feeds it to triage as a new `{tool_call_summary}` block.
- The triage prompt now has a "non-file side effects" branch: if the user asked for infra work
  (docker/db/kubectl/…) but the change manifest is empty, the `infra` candidate is the way to
  find out whether the work was actually attempted and whether it succeeded → pick it.
- The `infra` lens (`packages/opencode/src/reviewer/prompts/infra.txt`) reviews the COMMAND
  itself, not a file diff. Catches:
  - secrets on the CLI (`-e POSTGRES_PASSWORD=hunter2` in `docker run` — should be `_FILE` or env)
  - unverified `docker run` (no `docker ps`/`docker exec`/log check after a `docker:create`)
  - DB mutations without assertion (`psql -c "CREATE TABLE x ..."` with no `\d x` follow-up)
  - ports exposed without auth (e.g. `0.0.0.0:5432:5432` for postgres with no password)
  - data loss / irreversibility (`docker rm -f`, `DROP TABLE`, `kubectl delete`, `rm -rf`)
    without a backup step
  - persistence / restart (`docker run` without `--restart`, `systemctl start` without `enable`)
  - container hardening (--privileged, --cap-add broad, --user root when unneeded)
  - mismatch with the user requirement (user asked for `postgres:18`, agent used `postgres:18-alpine`;
    user asked for port 9001, command maps a different port)

### Lens wiring

The `infra` lens reuses the existing `FileGroup` plumbing — it gets one virtual "file" per
side-effect entry (`id` = `se_1`, `se_2`, …) and the diff is `formatInfraDiff`'s structured block
(`kind`, `tool`, `exit`, `description`, `command`, `output-preview`). Same batching/concurrency
as file reviews; only the prompt and routing are different. `reviewCategory` calls
`buildPrompt(group)` with `PROMPT_INFRA`, and `{files}` / `{diff}` get the formatted blocks.

### Opt-out

Set `code_reviewer.side_effect_ledger: false` to disable recording (the ledger stops being
written; triage falls back to file-diff only — back to the old behavior). Set
`code_reviewer.infra_review: false` to keep recording but skip the `infra` lens while still
letting the tool-call summary influence triage routing.

### Gotcha

The `infra` lens is the ONLY lens that runs on a turn whose work is purely runtime/infra state
with no file changes. If you see triage skipping review for a `docker run`/`psql`/`kubectl apply`
turn, check the review log for `sideEffectCount: 0` — that means the side-effect ledger didn't
catch the bash call (e.g. the tool name isn't `bash`/`shell`, or the call hasn't completed yet
by the time review fires — review reads the ledger asynchronously). Both should be rare; the
bash tool is the only shell-like tool nous wires today, and review only fires AFTER the assistant
turn completes, so all `completeToolCall` events have fired by then.

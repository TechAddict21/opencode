# Code Reviewer

Post-turn code-review pipeline that runs after the assistant edits files. A cheap **triage** LLM call decides whether review is warranted at all and which specialist reviewers to invoke; specialists then run against the changed files. Both stages consume runtime **support ledgers** (change + side-effect) to know what actually happened this turn.

## Pipeline shape

1. **Triage** — `prompts/triage.txt` instructs the model to ONLY route, not review. Returns `need_review` and a per-specialist keep/drop decision. Trivial edits (rename, comment, guard, formatting) get `need_review=false`. Sub-decisions: skip lens if change is docs/formatting-only; skip curl if no API surface touched.
2. **Specialist reviewers** — invoked only if triage said YES. Currently two specialists:
   - **File reviewer** (the main lens) — per-file prompts, capped at `MAX_LENS_FILE` chars per file to stop one big file from eating the prompt budget. Previously the cap was `96_000 / file_count` which could give 16k+ to a 30k file in a small batch.
   - **Curl tester** (`prompts/curl.txt`) — an API integration tester with a real shell. Writes ONE self-contained bash script that hits the running server; a separate executor runs it verbatim. Reuses state from `CURL_TESTING.md` at the project root (base URL, auth tokens, how-to-run-server) so repeated runs don't re-authenticate.
3. **Iter-2 dedup** — to stop the loop re-summarising the same findings, the previous turn's `kept` set is cached in a module-level map keyed by session ID; the next iteration suppresses findings already in that set.

## Wiring

Configured under `cfg.code_reviewer` in `packages/opencode/src/config/config.ts` (separate from the older `cfg.reviewer`): `enabled` (default true), `max_files` (skip unless N+ files changed; default 0 = review any), `max_iterations` (default 2), and a `model` override (otherwise falls back to session model). Gated in `session/prompt.ts` by `flags.disableReview` and the iteration counter; only runs when a `directory` is set.

The `isAPIFile` heuristic used to pick curl candidates matches `*.env`, `*.env.*`, `.<name>.env` and other env-file patterns — the tester needs the URLs/tokens from them to construct requests.

## Key Files
- `packages/opencode/src/reviewer/code-reviewer.ts` — pipeline orchestrator: triage prompt, per-file lens cap (`MAX_LENS_FILE = 8_000`), `isAPIFile` heuristic (env-file patterns), session-keyed iter-2 dedup map; imports `ChangeLedger`, `SideEffectLedger`, `Agent`, `Git`, `Snapshot`, `Session`, `LLM`, `Provider`.
- `packages/opencode/src/reviewer/prompts/curl.txt` — prompt for the API integration tester that emits one self-contained bash script and reuses `CURL_TESTING.md` for base URL / auth / run-server state.
- `packages/opencode/src/reviewer/prompts/triage.txt` — master decision-maker prompt: emits `need_review` plus a per-specialist keep/drop routing decision; never reports bugs itself.
- `packages/opencode/src/config/config.ts` — `code_reviewer` config schema (`enabled`, `max_files`, `max_iterations`, `model`) and the legacy `reviewer` schema with its own `max_iterations` and `model`.
- `packages/opencode/src/session/prompt.ts` — gates the reviewer behind `flags.disableReview` + iteration counter; resolves the model override or falls back to the session model; runs only when a `directory` is present.
- `packages/opencode/src/session/side-effect-ledger.ts` — Runtime sibling of `change-ledger.ts`. Records every completed `bash`/`shell` call (command + description + exit + 280-char output preview) to `<data>/analysis/<sessionID>/side-effects.json`. Classifies calls into `Kind` (`docker:create`/`docker:destroy`/`docker:exec`/`docker:mutate`/`db:query`/…) with a `mutates: boolean` flag; the `infra` lens reviews `mutate` calls. Same pattern as ChangeLedger: in-memory cache + per-session lock + atomic rename, best-effort (never throws).
- `packages/opencode/src/session/processor.ts` — Integration point: after every `write`/`edit` tool call, re-reads `config` live (so a mid-session toggle of `code_reviewer.change_ledger` takes effect on the next tool call) and calls `ChangeLedger.record({sessionID, absFile: fp, tool, …})` using `output.metadata.filepath`.
- `knowledge/reviewer-subsystem.md` — distilled overview of both stages, pipeline order, and the file-diff-only trigger condition.
- `src/agent/reviewer.ts` — Text Reviewer: LLM inspects/refines the assistant's chat reply; can inject `feedback` to trigger regeneration.
- `src/agent/code-reviewer.ts` — Multi-agent Code Reviewer: triage → per-category specialists in parallel → single full-stack fixer; gated by `code_reviewer.max_files`.
- `src/agent/prompt.ts` — `runLoop` orchestrates the post-turn review pipeline (text reviewer first, then code reviewer), each with its own bounded loop.
- `packages/opencode/src/tool/shell.ts` — shell command execution tool using `ChildProcessSpawner`
- `packages/opencode/src/project/project.ts` — project service that uses `ChildProcessSpawner` for git operations
- `packages/opencode/src/mcp/index.ts` — MCP server using `ChildProcessSpawner` for child-process tree discovery via `pgrep`

## Notes
- `isAPIFile` env-file regex must stay broader than just `.env` — patterns like `.<name>.env` and `*.env.<scope>` exist in real apps and the curl tester depends on reading their URLs/tokens.
- The `MAX_LENS_FILE` cap is per-file, not per-batch — for a 42-file turn at 96k budget, the old `budget/count` math gave >2k chars per file which silently truncated large files; the fixed cap makes that explicit.
- Two config sections coexist: legacy `cfg.reviewer` and newer `cfg.code_reviewer` — check which one the call site reads before changing defaults.
- The `code_reviewer` snapshot is exposed via `packages/opencode/src/snapshot/index.ts`; the triage step reads it to know which files were touched.
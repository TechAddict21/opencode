# Agent Knowledge Base — nous

Hand-written notes for AI agents working in this repo (an opencode fork). Goal:
gather context fast without re-deriving hard-won, non-obvious facts. Each area doc
is a distilled summary; **source paths live in each doc's "Key Files" section**, not
here. Keep this lean and area-based — one router entry per area, never per file.

## Areas

- [reviewer-subsystem.md](reviewer-subsystem.md) — post-turn review pipeline: text Reviewer + multi-agent code reviewer (experts) + full-stack fixer + per-session audit log.
- [session-loop-and-snapshots.md](session-loop-and-snapshots.md) — `prompt.ts` runLoop turn lifecycle, how reviewers hook in, and the Snapshot service used for turn-scoped diffs.
- [llm-streaming.md](llm-streaming.md) — consuming `llm.stream` (text + token usage + timing) and a String.replace pitfall when filling prompt templates.
- [skills.md](skills.md) — how local skills (SKILL.md) are discovered, and why a skill shows as "not found" (it's almost always a cwd/location issue).

## Operational essentials (read first)

- **The user runs a COMPILED binary, not source.** `which nous` → `~/.noussh/bin/nous`;
  `run.sh` prefers the native binary at `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`.
  **Source edits under `packages/opencode/src` do NOT take effect until you rebuild:**
  `./run.sh --build` (runs `bun run build`, from the **repo root**). Symptom of forgetting: "I changed the code but behavior is unchanged."
- **Bash cwd resets to the repo root between tool calls**, but persists *within* one chained
  command. Gotcha: `cd packages/opencode && bun run typecheck && ./run.sh` runs `./run.sh` from
  `packages/opencode` where it doesn't exist → silent no-op build. Run `./run.sh --build` as its own command.
- **Typecheck:** `cd packages/opencode && bun run typecheck` (uses `tsgo --noEmit`). It checks the whole
  package and can take a few minutes — run it in the background and grep for `error TS`.
- **Config vs rebuild:** config files (`~/.config/nous/nous.jsonc`, project `.noussh`) are read at
  runtime — config changes need NO rebuild. Only `packages/opencode/src` edits need `./run.sh --build`.
- **Logs:** global log file via `Log.create(...)` lands in `<data>/log/` (`<data>` = `$XDG_DATA_HOME/nous`,
  e.g. `~/.local/share/nous`). Per-session review audit logs are JSONL at `<data>/log/review/<sessionID>.jsonl`.
- **Effect codebase:** services are Effect `Context.Service`s wired via `Layer`s; most modules export
  `Service`, `layer`, and `defaultLayer`. Error handling uses `Effect.catch(...)` (established, 100+ uses).
- **Knowledge note:** there is a *separate* runtime knowledge system (`session/knowledge.ts`,
  `knowledge-base.ts`, target-repo `knowledge_base_world/` dirs, `script/knowledge_optimizer.sh`) — that is
  the in-app KB feeder/completer for *target* codebases, NOT this `knowledge/` dir (which is for agents).

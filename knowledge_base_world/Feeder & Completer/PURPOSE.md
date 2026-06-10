# Feeder & Completer — Purpose

The knowledge system exists so the agent does NOT re-explore the same code every
session. Every turn that touches code should leave the project knowledge base
richer; every later prompt should start out already knowing which file has what.

## The two halves

- **Feeder** (read side, zero LLM calls): before every LLM call, lexically match
  the user's prompt against the knowledge base and inject up to ~8KB of distilled
  context — a file-map block ("what's where"), matched area docs, or at minimum
  the lean area index.
- **Completer** (write side, ≤1 small-model call per turn): after every
  tool-using turn, distill what the agent actually saw and concluded into the
  knowledge base. The LLM is the sole author of knowledge content; code owns
  structure, validation, and bookkeeping.

## The three artifacts (all under `knowledge_base_world/`, git-tracked)

1. **DRILL_DOWN_TREE.md** — LEAN router. One `## Area` header + one doc-pointer
   bullet per area. Never contains source paths.
2. **`<Area>/<Doc>.md`** — one distilled doc per area: overview, "## Key Files"
   (path → use case), Notes (flows/gotchas). Capped 16KB, section-aware trimming.
3. **FILE_MAP.jsonl** — the fine-grained layer: one JSON line per source file —
   `path, purpose (≤140 chars), symbols (≤8), area, hash (12-hex content hash),
   seen, sessions`. Code-written only (the model emits a FILES section; code
   validates paths and maintains the file) so the format cannot drift. This is
   the artifact that directly answers "which file has what".

Plus one transient artifact: **.pending.jsonl** (gitignored) — explored-but-
undocumented files queued so the one-call-per-turn budget never silently
discards knowledge.

## Design principles

- **Grounded or queued**: a file is only documented from evidence the agent saw
  this turn (read preview, edit/write diff) or the agent's own final analysis —
  never guessed from a path. No evidence → pending queue, not fiction.
- **The agent's conclusions are the best evidence.** A turn's final analysis text
  is distilled knowledge already; the completer prefers it over code excerpts.
- **Reuse over duplication**: one tree entry per domain; near-duplicate area
  names are canonicalized (`resolveCanonicalArea`); merging never loses old Key
  Files (`mergeAreaDoc`).
- **Knowledge deepens, never freezes**: coverage is three-state
  (mapped-fresh / mapped-stale-by-hash / unmapped). Stale or insight-heavy turns
  trigger UPDATE-mode rewrites of existing docs (cooldown-limited) instead of
  the old "covered forever" dead end.
- **Hallucination-proof writes**: FILES paths are validated against the set the
  turn actually saw (explored ∪ queued); rejects are dropped and counted.
- **Cache-friendly injection**: the injection rides the last user message
  (transient `<project-knowledge>` block), not the system prompt, so the
  provider prefix cache for the whole conversation survives across turns.
- **Everything is additive**: an old KB without FILE_MAP/queue keeps working;
  the map backfills naturally as files are re-explored.

## Success metric

`nous kb stats` → **redundancy rate** = reads of already-mapped-fresh files /
all reads, logged per turn by the completer (`action: "redundancy"`). If the
system works, this falls over time. Secondary: feeder no-match rate (pre-overhaul
baseline: 25% over 13 sessions) and KB depth (pre-overhaul plateau: 8 areas /
180 lines after 38 completer writes — see TECHDEBT.md for why it was stuck).

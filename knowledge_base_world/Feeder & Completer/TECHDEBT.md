# Feeder & Completer — Tech Debt & Lessons

State as of the 2026-06-10 overhaul. Top section is the cautionary history;
the rest is open debt, roughly ordered by impact.

## Fixed, but remember why it happened

- **The space-path regex bug (root cause of the pre-overhaul plateau).**
  `parseTree`'s bullet regex used `[^\s*]+\.md` — doc paths containing spaces
  ("Storage & Persistence/Storage & Persistence.md") never parsed. Since the
  completer derives folder names from area names, 7 of 8 nous areas were
  invisible to the feeder index AND to coverage detection; the old regex parsed
  exactly 1 "entry": the format-example line in the tree preamble. The write
  side (upsertAreaSection, header-based) worked fine, which is why the tree
  LOOKED healthy while the read side saw nothing. Fixed to `[^*]+?\.md` in
  `knowledge-base.ts parseTree` and `knowledge.ts docPathForArea`; regression
  tests exist. Lesson: when feeder matching regresses, test the parser against
  the REAL tree first — write-path success says nothing about read-path health.
- Pre-overhaul empirical baseline (13 sessions): 93 injects / 31 no-match (25%
  miss) / 2128 cache-hits; 38 completer writes yet only 8 areas / 180 doc lines —
  growth was capped by one-area-per-turn, 900B/5KB evidence, binary "covered
  forever" gating, and the regex bug above.

## Open debt

1. **Cross-process index staleness.** The feeder's in-memory index invalidates
   on tree-byte change or same-process completer writes. Another session's
   map-only or doc-only write (tree unchanged) stays invisible until this
   session's tree changes or restart. Fix idea: include FILE_MAP.jsonl mtime/size
   in the index key.
2. **Hash window blind spot.** `contentHash` = sha256(first 64KB) + size. A
   same-size edit beyond the first 64KB of a large file evades staleness
   detection. Rare (any size drift catches it) but real for big generated files.
3. **Stale-file retry loop (no per-file cooldown).** If the model declines to
   emit a FILES line for a stale file, it stays stale and re-prompts every turn
   that touches it. Enrichment has an area cooldown; files have none. Fix idea:
   re-hash-and-bump `seen` on N consecutive declines, or park as `stale` with a
   drain delay.
4. **Completer is synchronous** at end of turn (required: non-interactive `run`
   exits immediately and would orphan a forked fiber). With 12KB evidence +
   conclusions the small-model call adds noticeable latency on heavy turns.
   Fix idea: fork in interactive/TUI mode only, keep sync for `run`.
5. **ChangeLedger is session-cumulative, not turn-scoped** — completer prompt
   may include edit summaries from earlier turns of the same session (filtered
   to involved files, capped at 10 lines, so low risk; still imprecise).
6. **FILES→area attribution is substring `body.includes(path)`** — a path
   mentioned in prose (not Key Files) still attributes; bare-name mentions miss.
   Good enough, not precise.
7. **Single `.kb.lock` serializes all writers** across sessions; a slow LLM call
   holds it for the whole call (drain happens under it too). Lock-held work is
   parked to the queue (reason `lock-held`) but loses its original hint.
8. **Lexical-only retrieval by design.** No embeddings/LLM router. Revisit only
   if `nous kb stats` miss rate stays high now that the parse bug is fixed and
   the index hint is always-on. An optional small-model router on no-match was
   considered and rejected (latency on the worst path).
9. **Frontend-skill hack lives in knowledge.ts** (`isFrontendQuery` + forced
   `frontend-design` skill instruction). Works, but it's routing policy inside
   the knowledge module; no equivalent for backend/infra domains. Belongs in
   prompt/skill routing.
10. **UNDERSTANDING.md is seeded but never read** by any code path. Either
    inject it once per session or stop seeding it.
11. **No consolidation pass** (`nous kb compact <area>` — deferred "phase 4b").
    Long-lived areas will accumulate merge-carried Key Files bullets and stale
    Notes; `mergeAreaDoc` only ever adds. Enrichment rewrites help but only for
    touched areas. Doctor flags nothing about doc quality.
12. **Queue starvation at the margin**: solo map-calls need backlog ≥10; a
    repo where every turn has main work drains only 5/turn — fine — but a repo
    with rare tool turns can sit at depth 9 indefinitely.
13. **Evidence is head-of-file**, not the byte range the agent actually read
    (read tool previews = file head). Mid-file knowledge arrives only via the
    agent's conclusions text.
14. **Test infra is minimal by intent.** The repo's old suite was deliberately
    deleted (commit c36da8f08 "Removal -> Tests"); only `test/preload.ts` (XDG
    isolation, required by bunfig preload) was restored plus the four
    `src/session/knowledge*.test.ts` files. Don't recreate the old suite
    uninvited; run with `bun test src/session/` from `packages/opencode`.
15. **These three docs are tree-orphans on purpose** (developer-facing meta-docs
    about the knowledge system itself, like `knowledge/`); `nous kb doctor`
    flags them as "orphan doc (no tree entry)". Either teach doctor an
    ignore-list or live with the three ✗ lines.

## Deliberately NOT doing

- Embeddings/vector store (cost/complexity; lexical + file map should carry it)
- Per-area-doc sharding of FILE_MAP (single sorted JSONL is fine ≤5000 entries;
  doctor warns at the cap)
- Automatic doc compaction (manual `kb compact` first if ever; auto-rewrites
  without a human in the loop risk silent knowledge loss)
- Shell-output path harvesting beyond grep/glob (fragile parsing, low signal)

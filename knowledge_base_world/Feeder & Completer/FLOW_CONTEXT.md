# Feeder & Completer — Flow Context (post-overhaul, 2026-06-10)

End-to-end trace of the knowledge system as implemented. Function names are the
stable references; line numbers rot.

## Key Files

- `packages/opencode/src/session/knowledge.ts` — feeder + completer orchestration: matching (`matchEntries`, `matchFileMap`), index (`buildIndexPure`), injection assembly, evidence/conclusion collectors, completer prompt + `parseCompleterResponse`, enrichment, queue wiring
- `packages/opencode/src/session/knowledge-base.ts` — KB file ops: `parseTree`, `upsertAreaSection`, `resolveCanonicalArea`, `mergeAreaDoc`, `fitDoc`/`splitForFit`, `ensureInit` (seeds + gitignore migration), lock (`acquireLock`/`releaseLock`, 5-min TTL)
- `packages/opencode/src/session/knowledge-file-map.ts` — FILE_MAP.jsonl: `parseFileMap`/`serializeFileMap`/`upsertEntries` (pure), `loadFileMap`/`saveFileMap` (tmp+rename atomic), `contentHash` (sha256 of first 64KB + size, 12 hex), `hashWorkspaceFile`
- `packages/opencode/src/session/knowledge-queue.ts` — .pending.jsonl: `appendPending` (lock-free O_APPEND), `drainPending` (under KB lock, dedupe FIFO, cap 500), `harvestGrepPaths`/`harvestGlobPaths`
- `packages/opencode/src/session/knowledge-log.ts` — per-session JSONL audit at `<XDG data>/nous/log/knowledge/<sessionID>.jsonl`
- `packages/opencode/src/session/prompt.ts` — wiring: feeder call in the runLoop before each LLM call; `injectKnowledgeIntoLastUser` (placement); synchronous completer trigger after tool-using turns
- `packages/opencode/src/session/change-ledger.ts` — per-session edit manifest; hunk-symbol summaries feed completer enrichment evidence
- `packages/opencode/src/cli/cmd/kb.ts` — `nous kb stats` / `nous kb doctor [--fix]`
- `packages/opencode/src/config/config.ts` — `experimental.knowledge_in_system` (legacy injection placement rollback)
- Tests: `packages/opencode/src/session/knowledge*.test.ts` (`bun test` from the package dir; root bunfig blocks root runs)

## Feeder flow (per LLM call; dedups by userMessageID)

1. `prompt.ts` runLoop extracts the last user text → `knowledge.feeder(userText, msgID, sessionID)` (skipped when `--no-knowledge`).
2. `ensureInit` seeds/migrates the KB dir. Cache hit on same msgID returns the previous injection.
3. Tree re-read from disk; index rebuilt iff tree bytes changed OR a completer write nulled the cache. `buildIndexPure(tree, docTexts, fileMap)` builds: per-area token sets + IDF (range [1, 2.5)), path/basename/dir maps, and pre-tokenized file-map entries.
4. **File-map match** (`matchFileMap`): exact path +12 > basename +6 > dir +3 > symbol token +4 > path token +2 > purpose token +1; floor 3; ≤12 entries / 2KB rendered as "### File map (what's where)".
5. **Area match** (`matchEntries`): path passes (+12/+6/+4) tracked separately from text pass (exact token 2×idf; substring only for tokens ≥5 chars at 0.5×idf). Text-only candidates need ≥2 distinct exact hits or one hit scoring ≥4. Floor MIN_SCORE=3, top 3 areas.
6. Doc assembly (`assembleDocs`): budget = 8192 − file-block bytes, fair floor per area, section-priority trimming (`fitDoc` keeps lead, then Key Files whole-bullets, then rest).
7. Fallbacks: keyword-less follow-up carries previous areas (≤2 turns); otherwise the lean index hint is ALWAYS injected so the agent can self-route (it names FILE_MAP.jsonl too).
8. Placement: `injectKnowledgeIntoLastUser` prepends a transient `<project-knowledge>` block to the last user model message (string or parts content). System-prompt placement only when `experimental.knowledge_in_system: true` or no user message exists.
9. Log: `inject` (bytes, matched, fileBlockBytes, indexHint, followup, frontend) / `no-match` / `cache-hit`.

## Completer flow (after each turn with completed tool calls; synchronous)

1. **Collect**: `collectExploredPaths` (filePath/file_path/path inputs of completed tools), `collectSearchedPaths` (grep/glob output harvest, ≤15/call, junk dirs filtered), `collectFileEvidence` (read preview preferred over edit/write diff; 1200B/file, 12KB total), `collectFinalText` (last assistant text ≤4000 chars), ChangeLedger summaries for involved files.
2. **Classify** vs FILE_MAP: mapped-fresh (hash match) / stale (hash mismatch — includes files edited this turn) / new (no entry; doc-regex mention alone = thin, still needs a map entry → flows as new, which is how old KBs backfill).
3. **Redundancy metric** logged before any gate: `{reads, knownReads}`.
4. **Enrichment decision**: no grounded-new but (grounded-stale OR insight turn: final text ≥600 chars AND ≥3 tool calls) → UPDATE mode for ≤2 areas of the involved files, skipping areas enriched within the last 3 completer runs (in-session cooldown).
5. **Queue persist** (lock-free, before lock): ungrounded new → `overflow`, ungrounded stale → `stale`, searched-uncovered → `grep-hit`/`glob-hit`. On lock-held, grounded work parks as `lock-held`.
6. **Lock → drain**: ≤5 queued entries ride the main call (solo map-call of ≤8 only when the turn would otherwise skip AND backlog ≥10). Drained files get a fresh head re-read as evidence; unreadable ones self-clean. Hard budget: ≤1 small-model call/turn (2 never happens in practice — the solo call replaces the main one).
7. **Prompt** (small model, `COMPLETER_SYSTEM_PROMPT`): history snippet (700 chars/msg) + agent's conclusions + existing area names + NEW files & evidence + STALE files (with previous purpose) & evidence + change-ledger lines + QUEUED files & heads + CURRENT doc text per enrichment target (`fitDoc` 6KB) + tree.
8. **Output contract**: `## FILES` (`path | purpose | symbols` lines) + 0–3 `## AREA` blocks (`name:/doc:/summary:` + `## DOC … ## END`) or `## SKIP`. `parseCompleterResponse` is tolerant: malformed blocks dropped & counted, FILES-only is a valid result.
9. **Writes** (all under the one `.kb.lock`): per-block — canonicalize name, reuse existing doc path (`docPathForArea`), `normalizeKeyFilePaths`, `isKbPathSafe`, `mergeAreaDoc` when reusing, `fitDoc` at 16KB (never a mid-text slice); tree upserted once at the end. FILES → validate path ∈ explored∪queued, attribute area (block body containing the path > existing entry > first written area), hash each file, `upsertEntries` + atomic `saveFileMap`.
10. **Bookkeeping**: feeder index cache nulled (in-session freshness), enrichment cooldown recorded, drained entries re-queued on empty/unparseable responses (dropped on deliberate `## SKIP`).
11. Log actions: `write` / `write-multi` / `map-only` / `enrich` (field) / `redundancy` / `gap-detected` / `queued-only` / `skip` (reasons: no-tree, no-files-explored, all-covered, no-evidence, lock-held, no-model, empty-response, model-skip, unparseable, invalid-doc-path, unsafe-doc-path).

## Data formats

```jsonl
// FILE_MAP.jsonl (sorted by path on rewrite)
{"path":"src/x.ts","purpose":"…≤140…","symbols":["a","b"],"area":"Area","hash":"a1b2c3d4e5f6","seen":"ISO","sessions":3}
// .pending.jsonl (gitignored; reasons: overflow|grep-hit|glob-hit|lock-held|stale)
{"path":"src/y.ts","reason":"grep-hit","hint":"pattern: foo","sessionID":"ses_…","time":"ISO"}
```

## Constants that shape behavior (knowledge.ts unless noted)

MAX_AREAS_PER_TURN=3 · MAX_ENRICH_AREAS=2 · ENRICH_COOLDOWN_RUNS=3 ·
ENRICH_DOC_CAP=6144 · FINAL_TEXT_BYTES=4000 · INSIGHT_TEXT_MIN=600 ·
INSIGHT_TOOL_CALLS_MIN=3 · EVIDENCE_PER_FILE_BYTES=1200 · EVIDENCE_TOTAL_BYTES=12000 ·
QUEUE_DRAIN_MAIN=5 · QUEUE_DRAIN_SOLO=8 · MIN_QUEUE_SOLO=10 ·
SEARCH_HARVEST_PER_CALL=15 · FILE_MATCH_LIMIT=12 · FILE_BLOCK_BYTES=2048 ·
TOP_AREAS=3 · MIN_SCORE=3 · FOLLOWUP_REUSE_LIMIT=2 ·
MAX_INJECTION_BYTES=8192, MAX_DOC_BYTES=16384 (knowledge-base.ts) ·
MAX_ENTRIES=5000, MAX_PURPOSE_CHARS=140, MAX_SYMBOLS=8 (knowledge-file-map.ts) ·
MAX_PENDING=500 (knowledge-queue.ts)

## Observability

`nous kb stats [--sessions N]` — areas/docs/map freshness/queue depth + feeder
inject & miss rates, completer write/skip breakdown, redundancy rate.
`nous kb doctor [--fix]` — dangling tree pointers, orphan docs, dead map
entries (pruned with --fix), stale lock, gitignore migration, queue depth.

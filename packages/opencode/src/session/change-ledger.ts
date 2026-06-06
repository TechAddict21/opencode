export * as ChangeLedger from "./change-ledger"

import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@nous-ai/core/global"

// Per-session "change manifest" — a compact, out-of-(main-agent)-context record
// of every file the agent wrote/edited this session, keyed by ABSOLUTE path and
// aggregated per file:  `src/foo.ts: +12/-3 over 2 edits — refresh(), load()`.
//
// It is persisted to <data>/analysis/<sessionID>/changes.json (alongside the
// per-call API logs) and is read ONLY by the code reviewer's triage step, which
// uses it to decide what to review and which specialists to route to WITHOUT
// ingesting the full diff. The main agent's LLM context never includes it.
//
// Absolute path is the canonical key: the reviewer derives changed files from
// snapshot diffs (repo-relative) and joins to this ledger via
// path.resolve(directory, file), so the two always line up regardless of nested
// repos / worktree-relative vs repo-relative path shapes.
//
// Best-effort: never throws. The in-memory cache is the source of truth for a
// live session (seeded from disk on first touch) so concurrent record() calls
// within one session don't lose writes to a read-modify-write race.

const DEFAULT_BASE = path.join(Global.Path.data, "analysis")

export interface Entry {
  absFile: string
  // Stable human-readable display name (path.basename). NOT a path relative to
  // any specific root — callers that need a path relative to their own root
  // should compute it from `absFile` themselves. (Earlier this stored the
  // worktree-relative `output.title` from the tool, which silently disagreed
  // with the directory-relative paths the reviewer's diff block uses, leaving
  // the triage prompt with mismatched identifiers for the same file.)
  rel: string
  tool: string
  ops: number
  additions: number
  deletions: number
  // True when this file was newly created (not a pre-existing file edited).
  created: boolean
  firstTime: number
  lastTime: number
  // Cheap, no-LLM hint: enclosing symbols/sections pulled from diff hunk headers.
  summary: string
  // First slice of the most recent diff, for later inspection.
  diffPreview: string
}

export type Manifest = Record<string, Entry>

const cache = new Map<string, Manifest>()

function safe(sessionID: string) {
  return sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function fileFor(base: string, sessionID: string) {
  return path.join(base, safe(sessionID), "changes.json")
}

export function location(sessionID: string, base?: string) {
  return fileFor(base || DEFAULT_BASE, sessionID)
}

async function load(base: string, sessionID: string): Promise<Manifest> {
  const cached = cache.get(sessionID)
  if (cached) return cached
  let manifest: Manifest = {}
  try {
    const raw = await fs.readFile(fileFor(base, sessionID), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") manifest = parsed
  } catch {
    // no ledger yet → empty
  }
  if (!cache.has(sessionID)) cache.set(sessionID, manifest)
  return cache.get(sessionID)!
}

// Pull unique enclosing-section labels from unified-diff hunk headers:
//   "@@ -10,7 +10,8 @@ export function refresh() {"  ->  "export function refresh() {"
function summarizeHunks(diff: string): string {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const line of diff.split("\n")) {
    if (!line.startsWith("@@")) continue
    const close = line.indexOf("@@", 2)
    if (close === -1) continue
    const label = line.slice(close + 2).trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
    if (labels.length >= 5) break
  }
  return labels.join(" · ")
}

// Record one completed write/edit against the session ledger. Within one
// process, concurrent record() calls for the same session are serialized via
// a per-session promise chain so the in-memory cache and the on-disk file
// stay consistent (no read-modify-write race between parallel tool calls
// from the same session). Cross-process races are still possible — a process
// that loaded the file before another process wrote will overwrite the
// other's edits on its next write; that's an accepted limitation of the
// flat-file design (an in-process lock + atomic rename is the ceiling here).
const locks = new Map<string, Promise<unknown>>()

function chain(sessionID: string, work: () => Promise<void>): Promise<void> {
  const prev = locks.get(sessionID) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(work)
  locks.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}

// Record one completed write/edit against the session ledger.
export function record(input: {
  sessionID: string
  absFile: string
  tool: string
  additions: number
  deletions: number
  created?: boolean
  diff?: string
  base?: string
}): Effect.Effect<void> {
  return Effect.promise(() =>
    chain(input.sessionID, async () => {
      const base = input.base || DEFAULT_BASE
      try {
        const manifest = await load(base, input.sessionID)
        const now = Date.now()
        const prev = manifest[input.absFile]
        const summary = input.diff ? summarizeHunks(input.diff) : (prev?.summary ?? "")
        manifest[input.absFile] = {
          absFile: input.absFile,
          rel: prev?.rel || path.basename(input.absFile),
          tool: input.tool,
          ops: (prev?.ops ?? 0) + 1,
          additions: (prev?.additions ?? 0) + (input.additions || 0),
          deletions: (prev?.deletions ?? 0) + (input.deletions || 0),
          created: prev?.created ?? input.created ?? false,
          firstTime: prev?.firstTime ?? now,
          lastTime: now,
          summary: summary || prev?.summary || "",
          diffPreview: input.diff ? input.diff.slice(0, 400) : (prev?.diffPreview ?? ""),
        }
        const dir = path.dirname(fileFor(base, input.sessionID))
        await fs.mkdir(dir, { recursive: true })
        const target = fileFor(base, input.sessionID)
        const tmp = `${target}.${process.pid}.tmp`
        await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8")
        await fs.rename(tmp, target)
      } catch {
        // swallow — the ledger must never break a tool call
      }
    }),
  )
}

export function read(sessionID: string, base?: string): Effect.Effect<Manifest> {
  return Effect.promise(() => load(base || DEFAULT_BASE, sessionID))
}

// Render a compact manifest for the reviewer's triage step. `files` scopes it to
// THIS turn's changed files (abs = canonical key, rel = the path the diff shows,
// so the triage LLM can correlate the manifest with the diff). Returns "" when
// there's nothing to show.
export function manifestText(
  sessionID: string,
  files: ReadonlyArray<{ abs: string; rel: string }>,
  base?: string,
): Effect.Effect<string> {
  return Effect.promise(async () => {
    const manifest = await load(base || DEFAULT_BASE, sessionID)
    const lines: string[] = []
    for (const f of files) {
      const e = manifest[f.abs]
      if (!e) continue
      const noun = e.ops === 1 ? "edit" : "edits"
      const head = `- ${f.rel}: +${e.additions}/-${e.deletions} over ${e.ops} ${noun}`
      lines.push(e.summary ? `${head} — ${e.summary}` : head)
    }
    return lines.join("\n")
  })
}

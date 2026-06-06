export * as AnalysisLog from "./analysis-log"

import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@nous-ai/core/global"

// Per-session audit trail of every LLM call (main agent AND reviewers/triage/
// fixer — they all funnel through `LLM.stream`). For each call we write two
// JSON files under <data>/analysis/<sessionID>/:
//   <seq>_<epochMs>_request.json   — the assembled context we handed the model
//   <seq>_<epochMs>_response.json  — what came back (text/tools/usage/outcome)
// so the effectiveness of the context we build can be reviewed after the fact.
// `seq` is a monotonic per-session counter (recovered from disk on first use
// after a restart) so a request always pairs with its response and ordering is
// stable even when timestamps collide. Best-effort: never throws, never blocks
// the stream — a logging failure must not affect the user's session.

const DEFAULT_BASE = path.join(Global.Path.data, "analysis")

// sessionID -> last allocated sequence number (in-memory; seeded from disk).
const seqs = new Map<string, number>()

// Per-session promise chain so concurrent begin() calls (the reviewer panel
// fans out 4+ llm.stream calls in parallel; all share one sessionID) can't
// race on seed+alloc. The previous design had an `await ensureSeed` between
// the read and the local counter bump, letting two parallel calls both see
// the same max and both allocate the same `next` seq — second writer
// overwrote the first. The chain also documents the cross-process ceiling:
// a process that loaded the dir before another process wrote is still
// vulnerable to a stale seed, but the random filename suffix below keeps
// the on-disk files safe even then (the seqs map is monotonic per-process
// for ordering, not for global uniqueness).
const beginLocks = new Map<string, Promise<unknown>>()

function safe(sessionID: string) {
  return sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function dirFor(base: string, sessionID: string) {
  return path.join(base, safe(sessionID))
}

function pad(n: number) {
  return String(n).padStart(4, "0")
}

// Short random suffix so two processes allocating the same seq write to
// different filenames. Crypto not required — collisions only cost a lost
// audit pair, not data integrity.
function rand() {
  return Math.random().toString(36).slice(2, 8)
}

// Seed the in-memory counter from existing files the first time we see a
// session (so request/response pairs keep incrementing across restarts).
async function ensureSeed(dir: string, sessionID: string) {
  if (seqs.has(sessionID)) return
  let last = 0
  try {
    for (const f of await fs.readdir(dir)) {
      const m = f.match(/^(\d+)_/)
      if (m) last = Math.max(last, Number.parseInt(m[1], 10))
    }
  } catch {
    // dir does not exist yet → start from 0
  }
  // Don't clobber if a concurrent call already seeded this session.
  if (!seqs.has(sessionID)) seqs.set(sessionID, last)
}

// Synchronous allocation: no `await` between read and write, so concurrent
// calls (e.g. the parallel reviewer panel sharing one sessionID) never collide.
function allocSync(sessionID: string): number {
  const next = (seqs.get(sessionID) ?? 0) + 1
  seqs.set(sessionID, next)
  return next
}

export function location(sessionID: string, base?: string) {
  return dirFor(base || DEFAULT_BASE, sessionID)
}

// Write the request snapshot and return its sequence number. The returned seq
// must be passed to `complete` so the two files pair up.
export function begin(input: {
  sessionID: string
  request: Record<string, unknown>
  base?: string
}): Effect.Effect<number> {
  const work = async (): Promise<number> => {
    const dir = dirFor(input.base || DEFAULT_BASE, input.sessionID)
    await ensureSeed(dir, input.sessionID)
    const seq = allocSync(input.sessionID)
    try {
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${pad(seq)}_${Date.now()}_${rand()}_request.json`)
      await fs.writeFile(file, JSON.stringify({ seq, time: new Date().toISOString(), ...input.request }, null, 2), "utf8")
    } catch {
      // swallow — logging must never break the stream
    }
    return seq
  }
  const prev = beginLocks.get(input.sessionID) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(work)
  beginLocks.set(
    input.sessionID,
    next.catch(() => undefined),
  )
  return Effect.promise(() => next)
}

// Write the response snapshot for a previously-begun call.
export function complete(input: {
  sessionID: string
  seq: number
  response: Record<string, unknown>
  base?: string
}): Effect.Effect<void> {
  return Effect.promise(async () => {
    const dir = dirFor(input.base || DEFAULT_BASE, input.sessionID)
    try {
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${pad(input.seq)}_${Date.now()}_${rand()}_response.json`)
      await fs.writeFile(
        file,
        JSON.stringify({ seq: input.seq, time: new Date().toISOString(), ...input.response }, null, 2),
        "utf8",
      )
    } catch {
      // swallow — logging must never break the stream
    }
  })
}

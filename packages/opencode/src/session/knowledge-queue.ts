import path from "path"
import NFS from "fs/promises"
import { Effect } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import { KB_DIR_NAME } from "./knowledge-base"
import * as Log from "@nous-ai/core/util/log"

const log = Log.create({ service: "knowledge-queue" })

export const PENDING_FILENAME = ".pending.jsonl"
// The queue is a safety net, not an archive: bounded so a burst of busy
// sessions cannot grow it without limit. Oldest entries are dropped first.
export const MAX_PENDING = 500
// Cheap append-side guard: if the file already exceeds this, drains are not
// keeping up and further appends are pointless until one runs.
const MAX_PENDING_BYTES = 256 * 1024

export type QueueReason = "overflow" | "grep-hit" | "glob-hit" | "lock-held" | "stale"

// Explored-but-never-documented work, persisted so the one-LLM-call-per-turn
// budget no longer silently discards knowledge. No evidence is stored — files
// persist on disk, so the drain re-reads a fresh head instead of letting
// stale excerpts rot in the queue.
export interface QueueEntry {
  path: string
  reason: QueueReason
  hint?: string
  sessionID: string
  time: string
}

const REASONS = new Set<string>(["overflow", "grep-hit", "glob-hit", "lock-held", "stale"])

// Tolerant parse: a corrupt line loses that entry, never the queue.
export function parseQueue(content: string): QueueEntry[] {
  const out: QueueEntry[] = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>
      if (!raw || typeof raw !== "object") continue
      const p = typeof raw.path === "string" ? raw.path.trim() : ""
      const reason = typeof raw.reason === "string" && REASONS.has(raw.reason) ? (raw.reason as QueueReason) : null
      if (!p || !reason) continue
      out.push({
        path: p,
        reason,
        hint: typeof raw.hint === "string" ? raw.hint : undefined,
        sessionID: typeof raw.sessionID === "string" ? raw.sessionID : "",
        time: typeof raw.time === "string" ? raw.time : "",
      })
    } catch {
      // skip corrupt line
    }
  }
  return out
}

// FIFO by first appearance, one entry per path (later duplicates only refresh
// the hint). Keeps old discoveries draining before re-noticed ones.
export function dedupeQueue(entries: QueueEntry[]): QueueEntry[] {
  const byPath = new Map<string, QueueEntry>()
  for (const e of entries) {
    const prev = byPath.get(e.path)
    if (!prev) byPath.set(e.path, e)
    else if (e.hint && !prev.hint) byPath.set(e.path, { ...prev, hint: e.hint })
  }
  return [...byPath.values()]
}

function queuePath(workDir: string): string {
  return path.join(workDir, KB_DIR_NAME, PENDING_FILENAME)
}

// Lock-free: POSIX O_APPEND line writes are atomic at these sizes, so feeder
// or concurrent sessions can enqueue without taking the KB lock. Best-effort —
// the queue must never break a turn.
export function appendPending(workDir: string, entries: QueueEntry[]): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (entries.length === 0) return
    const file = queuePath(workDir)
    try {
      const stat = await NFS.stat(file).catch(() => null)
      if (stat && stat.size > MAX_PENDING_BYTES) {
        log.warn("pending queue full, dropping appends", { entries: entries.length })
        return
      }
      const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
      await NFS.appendFile(file, lines, "utf8")
    } catch (error) {
      log.warn("pending queue append failed", { error: String(error) })
    }
  })
}

// Pull up to `max` entries for processing and rewrite the remainder (deduped,
// capped at MAX_PENDING, oldest dropped beyond the cap). `exclude` filters out
// paths that no longer need documenting (already mapped fresh / being handled
// this turn) — those are silently discarded, not returned. When fewer than
// `min` candidates exist the queue is left untouched and nothing is drained,
// so a near-empty queue doesn't trigger LLM calls for one or two files.
// MUST be called under the KB lock: this is a read-modify-write.
export function drainPending(
  workDir: string,
  options: { max: number; min?: number; exclude?: (p: string) => boolean },
): Effect.Effect<QueueEntry[], never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const file = queuePath(workDir)
    const content = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    if (!content) return []
    const exclude = options.exclude ?? (() => false)
    const candidates = dedupeQueue(parseQueue(content)).filter((e) => !exclude(e.path))
    if (candidates.length < Math.max(options.min ?? 0, 1)) return []
    const drained = candidates.slice(0, options.max)
    let remainder = candidates.slice(options.max)
    if (remainder.length > MAX_PENDING) remainder = remainder.slice(remainder.length - MAX_PENDING)
    const next = remainder.length ? remainder.map((e) => JSON.stringify(e)).join("\n") + "\n" : ""
    yield* fs.writeFileString(file, next).pipe(Effect.orElseSucceed(() => {}))
    return drained
  })
}

// ---- exploration-signal harvesters ----------------------------------------
// The grep tool prints each matched file as an absolute-path header line
// ("/abs/path/file.ts:") followed by indented "  Line N: ..." lines; the glob
// tool prints absolute paths one per line. Harvesting these lets turns that
// only searched (no read/edit) still feed the knowledge queue instead of
// skipping as "no-files-explored".

export function harvestGrepPaths(output: string): string[] {
  const out: string[] = []
  for (const line of output.split("\n")) {
    if (!line || /^\s/.test(line)) continue
    if (!line.endsWith(":")) continue
    const p = line.slice(0, -1)
    if (!p.includes("/") && !/^[A-Za-z]:[\\/]/.test(p)) continue
    out.push(p)
  }
  return out
}

export function harvestGlobPaths(output: string): string[] {
  return output.split("\n").filter((l) => l.startsWith("/") || /^[A-Za-z]:[\\/]/.test(l))
}

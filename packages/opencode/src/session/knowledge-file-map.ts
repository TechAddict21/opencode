import path from "path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import { KB_DIR_NAME } from "./knowledge-base"
import * as Log from "@nous-ai/core/util/log"

const log = Log.create({ service: "knowledge-file-map" })

export const FILE_MAP_FILENAME = "FILE_MAP.jsonl"
export const MAX_PURPOSE_CHARS = 140
export const MAX_SYMBOLS = 8
// Soft ceiling on map size: beyond this the oldest-seen entries are dropped on
// upsert. At ~250B/line the full map stays around ~1.25MB at the cap.
export const MAX_ENTRIES = 5000
// Hash only the head of large files: enough to detect change cheaply, and the
// size suffix catches pure-append growth past the head window.
const HASH_HEAD_BYTES = 64 * 1024

// One line per source file in FILE_MAP.jsonl — the fine-grained "which file has
// what" layer under the area docs. The LLM never writes this file directly: the
// completer parses a FILES section out of the model response and the code owns
// path/hash/seen/sessions, so the format cannot drift.
export interface FileMapEntry {
  path: string
  purpose: string
  symbols: string[]
  area: string
  hash: string
  seen: string
  sessions: number
}

export interface FileMapUpdate {
  path: string
  purpose?: string
  symbols?: string[]
  area?: string
  hash?: string
}

export function contentHash(head: Uint8Array, size: number): string {
  return createHash("sha256").update(head).update(":" + size).digest("hex").slice(0, 12)
}

// Tolerant line-by-line parse: a corrupt line loses that one entry, never the map.
export function parseFileMap(content: string): Map<string, FileMapEntry> {
  const out = new Map<string, FileMapEntry>()
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>
      if (!raw || typeof raw !== "object") continue
      const p = typeof raw.path === "string" ? raw.path.trim() : ""
      if (!p) continue
      out.set(p, {
        path: p,
        purpose: typeof raw.purpose === "string" ? raw.purpose.slice(0, MAX_PURPOSE_CHARS) : "",
        symbols: Array.isArray(raw.symbols)
          ? raw.symbols.filter((s): s is string => typeof s === "string").slice(0, MAX_SYMBOLS)
          : [],
        area: typeof raw.area === "string" ? raw.area : "",
        hash: typeof raw.hash === "string" ? raw.hash : "",
        seen: typeof raw.seen === "string" ? raw.seen : "",
        sessions:
          typeof raw.sessions === "number" && Number.isFinite(raw.sessions) ? Math.max(1, Math.floor(raw.sessions)) : 1,
      })
    } catch {
      // skip corrupt line
    }
  }
  return out
}

// Sorted by path so rewrites produce stable, reviewable git diffs.
export function serializeFileMap(map: Map<string, FileMapEntry>): string {
  const entries = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return entries.length ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : ""
}

// Apply confirmed updates in place. Fields an update omits are preserved from
// the previous entry; `sessions` bumps on every re-confirmation of an existing
// entry (a soft confidence signal — how often different turns agreed on it).
export function upsertEntries(
  map: Map<string, FileMapEntry>,
  updates: FileMapUpdate[],
  now: string,
): Map<string, FileMapEntry> {
  for (const u of updates) {
    const p = u.path.trim()
    if (!p) continue
    const prev = map.get(p)
    map.set(p, {
      path: p,
      purpose: (u.purpose ?? prev?.purpose ?? "").slice(0, MAX_PURPOSE_CHARS),
      symbols: (u.symbols ?? prev?.symbols ?? []).slice(0, MAX_SYMBOLS),
      area: u.area ?? prev?.area ?? "",
      hash: u.hash ?? prev?.hash ?? "",
      seen: now,
      sessions: prev ? prev.sessions + 1 : 1,
    })
  }
  if (map.size > MAX_ENTRIES) {
    const excess = [...map.values()].sort((a, b) => a.seen.localeCompare(b.seen)).slice(0, map.size - MAX_ENTRIES)
    for (const e of excess) map.delete(e.path)
  }
  return map
}

export function loadFileMap(workDir: string): Effect.Effect<Map<string, FileMapEntry>, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const file = path.join(workDir, KB_DIR_NAME, FILE_MAP_FILENAME)
    const content = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    if (!content) return new Map<string, FileMapEntry>()
    return parseFileMap(content)
  })
}

// Atomic write (tmp + rename) so a concurrent reader never sees a torn map.
// The `.kbtmp` suffix is already covered by the KB's seeded .gitignore.
export function saveFileMap(
  workDir: string,
  map: Map<string, FileMapEntry>,
): Effect.Effect<void, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const target = path.join(workDir, KB_DIR_NAME, FILE_MAP_FILENAME)
    const tmp = `${target}.${process.pid}.kbtmp`
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(tmp, serializeFileMap(map))
      yield* fs.rename(tmp, target)
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => log.warn("file map save failed", { error: String(error) }))),
      Effect.orElseSucceed(() => {}),
    )
  })
}

// Hash a workspace file's current content for staleness checks. null = unreadable.
export function hashWorkspaceFile(
  workDir: string,
  rel: string,
): Effect.Effect<string | null, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bytes = yield* fs.readFile(path.join(workDir, rel)).pipe(Effect.orElseSucceed(() => undefined))
    if (!bytes) return null
    return contentHash(bytes.subarray(0, HASH_HEAD_BYTES), bytes.byteLength)
  })
}

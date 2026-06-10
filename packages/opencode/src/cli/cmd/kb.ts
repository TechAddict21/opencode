import type { Argv } from "yargs"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { Global } from "@nous-ai/core/global"
import * as KB from "@/session/knowledge-base"
import * as FileMap from "@/session/knowledge-file-map"
import * as Queue from "@/session/knowledge-queue"

// Observability for the knowledge system: `nous kb stats` shows what the KB
// knows and whether it is actually reducing re-exploration (redundancy rate);
// `nous kb doctor` finds and optionally repairs structural rot.

const LOG_DIR = path.join(Global.Path.log, "knowledge")

interface LogTotals {
  sessions: number
  injects: number
  noMatch: number
  cacheHits: number
  writes: number
  writeMulti: number
  mapOnly: number
  enriched: number
  skips: Record<string, number>
  reads: number
  knownReads: number
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  try {
    const raw = await fs.readFile(file, "utf8")
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        if (e && typeof e === "object") out.push(e)
      } catch {
        // skip corrupt line
      }
    }
  } catch {
    // missing file → empty
  }
  return out
}

async function aggregateLogs(lastN: number): Promise<LogTotals> {
  const totals: LogTotals = {
    sessions: 0,
    injects: 0,
    noMatch: 0,
    cacheHits: 0,
    writes: 0,
    writeMulti: 0,
    mapOnly: 0,
    enriched: 0,
    skips: {},
    reads: 0,
    knownReads: 0,
  }
  let files: { file: string; mtime: number }[] = []
  try {
    const names = await fs.readdir(LOG_DIR)
    files = await Promise.all(
      names
        .filter((n) => n.endsWith(".jsonl"))
        .map(async (n) => {
          const full = path.join(LOG_DIR, n)
          const st = await fs.stat(full).catch(() => null)
          return { file: full, mtime: st?.mtime.getTime() ?? 0 }
        }),
    )
  } catch {
    return totals
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(0, lastN)) {
    totals.sessions++
    for (const e of await readJsonl(f.file)) {
      const phase = e.phase
      const action = e.action
      if (phase === "feeder") {
        if (action === "inject") totals.injects++
        else if (action === "no-match") totals.noMatch++
        else if (action === "cache-hit") totals.cacheHits++
      } else if (phase === "completer") {
        if (action === "write") totals.writes++
        else if (action === "write-multi") totals.writeMulti++
        else if (action === "map-only") totals.mapOnly++
        else if (action === "redundancy") {
          totals.reads += typeof e.reads === "number" ? e.reads : 0
          totals.knownReads += typeof e.knownReads === "number" ? e.knownReads : 0
        } else if (action === "skip") {
          const r = typeof e.reason === "string" ? e.reason : "unknown"
          totals.skips[r] = (totals.skips[r] ?? 0) + 1
        }
        if (Array.isArray(e.enriched)) totals.enriched += e.enriched.length
      }
    }
  }
  return totals
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "n/a"
  return `${Math.round((part / whole) * 100)}%`
}

const StatsSub = effectCmd({
  command: "stats",
  describe: "knowledge base size and effectiveness metrics",
  builder: (yargs: Argv) =>
    yargs.option("sessions", {
      describe: "aggregate log metrics over the last N sessions",
      type: "number",
      default: 20,
    }),
  handler: Effect.fn("Cli.kb.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const workDir = ctx.directory
    const kbDir = path.join(workDir, KB.KB_DIR_NAME)

    const treeContent = yield* Effect.promise(() =>
      fs.readFile(path.join(kbDir, KB.DRILL_DOWN_FILENAME), "utf8").catch(() => ""),
    )
    const entries = treeContent ? KB.parseTree(treeContent) : []

    let docCount = 0
    let docBytes = 0
    for (const e of entries) {
      if (e.entryPath.includes("..") || e.entryPath.startsWith("/")) continue
      const st = yield* Effect.promise(() => fs.stat(path.join(kbDir, e.entryPath)).catch(() => null))
      if (st) {
        docCount++
        docBytes += st.size
      }
    }

    const mapRaw = yield* Effect.promise(() =>
      fs.readFile(path.join(kbDir, FileMap.FILE_MAP_FILENAME), "utf8").catch(() => ""),
    )
    const map = FileMap.parseFileMap(mapRaw)
    let fresh = 0
    let stale = 0
    let missing = 0
    for (const entry of map.values()) {
      const bytes = yield* Effect.promise(() => fs.readFile(path.join(workDir, entry.path)).catch(() => null))
      if (!bytes) {
        missing++
        continue
      }
      const h = FileMap.contentHash(bytes.subarray(0, 64 * 1024), bytes.byteLength)
      if (entry.hash && h === entry.hash) fresh++
      else stale++
    }

    const queueRaw = yield* Effect.promise(() =>
      fs.readFile(path.join(kbDir, Queue.PENDING_FILENAME), "utf8").catch(() => ""),
    )
    const queueDepth = Queue.dedupeQueue(Queue.parseQueue(queueRaw)).length

    const totals = yield* Effect.promise(() => aggregateLogs(args.sessions))

    console.log(`Knowledge base: ${kbDir}`)
    console.log(`  Areas: ${entries.length}  Docs: ${docCount} (${(docBytes / 1024).toFixed(1)} KB)`)
    console.log(`  File map: ${map.size} entries — ${fresh} fresh, ${stale} stale, ${missing} missing on disk`)
    console.log(`  Pending queue: ${queueDepth}`)
    console.log("")
    console.log(`Last ${totals.sessions} session(s):`)
    const evaluated = totals.injects + totals.noMatch
    console.log(
      `  Feeder: ${totals.injects} injects, ${totals.noMatch} no-match (${pct(totals.noMatch, evaluated)} miss rate), ${totals.cacheHits} cache-hits`,
    )
    console.log(
      `  Completer: ${totals.writes} writes, ${totals.writeMulti} multi-area writes, ${totals.mapOnly} map-only, ${totals.enriched} enrichments`,
    )
    const skipDesc = Object.entries(totals.skips)
      .sort((a, b) => b[1] - a[1])
      .map(([r, c]) => `${r}=${c}`)
      .join(", ")
    if (skipDesc) console.log(`  Skips: ${skipDesc}`)
    console.log(
      `  Redundancy: ${totals.knownReads}/${totals.reads} reads hit already-mapped-fresh files (${pct(totals.knownReads, totals.reads)})`,
    )
    console.log("    (lower is better — it means the agent re-read files the knowledge base already knows)")
  }),
})

const DoctorSub = effectCmd({
  command: "doctor",
  describe: "check the knowledge base for structural rot",
  builder: (yargs: Argv) =>
    yargs.option("fix", {
      describe: "prune file-map entries whose file no longer exists and clear stale locks",
      type: "boolean",
      default: false,
    }),
  handler: Effect.fn("Cli.kb.doctor")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const workDir = ctx.directory
    const kbDir = path.join(workDir, KB.KB_DIR_NAME)
    const issues: string[] = []
    const ok: string[] = []

    const treeContent = yield* Effect.promise(() =>
      fs.readFile(path.join(kbDir, KB.DRILL_DOWN_FILENAME), "utf8").catch(() => ""),
    )
    if (!treeContent) {
      console.log(`No knowledge base at ${kbDir} (it is seeded on the first knowledge-enabled run).`)
      return
    }
    const entries = KB.parseTree(treeContent)

    // Dangling tree pointers: tree entry whose doc file is missing.
    const docPaths = new Set<string>()
    for (const e of entries) {
      if (e.entryPath.includes("..") || e.entryPath.startsWith("/")) continue
      docPaths.add(e.entryPath)
      const exists = yield* Effect.promise(() =>
        fs.stat(path.join(kbDir, e.entryPath)).then(() => true).catch(() => false),
      )
      if (!exists) issues.push(`dangling tree pointer: "${e.entryPath}" (doc file missing)`)
    }
    if (!issues.some((i) => i.startsWith("dangling"))) ok.push(`tree pointers resolve (${entries.length} areas)`)

    // Orphan docs: .md files in the KB no tree entry points at.
    const walk = async (dir: string, acc: string[] = []): Promise<string[]> => {
      let names: { name: string; isDir: boolean }[] = []
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true })
        names = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      } catch {
        return acc
      }
      for (const n of names) {
        const full = path.join(dir, n.name)
        if (n.isDir) await walk(full, acc)
        else acc.push(full)
      }
      return acc
    }
    const allFiles = yield* Effect.promise(() => walk(kbDir))
    const reserved = new Set([KB.DRILL_DOWN_FILENAME, KB.UNDERSTANDING_FILENAME])
    let orphans = 0
    for (const f of allFiles) {
      const rel = path.relative(kbDir, f)
      if (!rel.toLowerCase().endsWith(".md") || reserved.has(rel)) continue
      if (!docPaths.has(rel)) {
        orphans++
        issues.push(`orphan doc (no tree entry): ${rel}`)
      }
    }
    if (orphans === 0) ok.push("no orphan docs")

    // File-map entries whose source file is gone.
    const mapPath = path.join(kbDir, FileMap.FILE_MAP_FILENAME)
    const mapRaw = yield* Effect.promise(() => fs.readFile(mapPath, "utf8").catch(() => ""))
    const map = FileMap.parseFileMap(mapRaw)
    const dead: string[] = []
    for (const entry of map.values()) {
      const exists = yield* Effect.promise(() =>
        fs.stat(path.join(workDir, entry.path)).then(() => true).catch(() => false),
      )
      if (!exists) dead.push(entry.path)
    }
    if (dead.length > 0) {
      if (args.fix) {
        for (const p of dead) map.delete(p)
        yield* Effect.promise(() => fs.writeFile(mapPath, FileMap.serializeFileMap(map), "utf8"))
        ok.push(`pruned ${dead.length} dead file-map entr${dead.length === 1 ? "y" : "ies"}`)
      } else {
        issues.push(`${dead.length} file-map entr${dead.length === 1 ? "y" : "ies"} point at deleted files (--fix prunes)`)
      }
    } else {
      ok.push(`file map clean (${map.size} entries)`)
    }

    // Stale lock.
    const lockPath = path.join(kbDir, ".kb.lock")
    const lockRaw = yield* Effect.promise(() => fs.readFile(lockPath, "utf8").catch(() => null))
    if (lockRaw !== null) {
      const ts = Number.parseInt(lockRaw.trim(), 10)
      const age = Number.isFinite(ts) ? Date.now() - ts : Number.POSITIVE_INFINITY
      if (age > 5 * 60 * 1000) {
        if (args.fix) {
          yield* Effect.promise(() => fs.rm(lockPath, { force: true }))
          ok.push("cleared stale completer lock")
        } else {
          issues.push(`stale completer lock (${Math.round(age / 60000)} min old; --fix clears)`)
        }
      } else {
        ok.push("completer lock held by a live run")
      }
    } else {
      ok.push("no completer lock")
    }

    // Gitignore migration.
    const gi = yield* Effect.promise(() => fs.readFile(path.join(kbDir, ".gitignore"), "utf8").catch(() => ""))
    const have = new Set(gi.split("\n").map((l) => l.trim()))
    const missingGi = [".kb.lock", "*.kbtmp", Queue.PENDING_FILENAME].filter((l) => !have.has(l))
    if (missingGi.length > 0) issues.push(`KB .gitignore missing: ${missingGi.join(", ")} (next run migrates it)`)
    else ok.push(".gitignore covers transient artifacts")

    // Queue depth.
    const queueRaw = yield* Effect.promise(() =>
      fs.readFile(path.join(kbDir, Queue.PENDING_FILENAME), "utf8").catch(() => ""),
    )
    const depth = Queue.dedupeQueue(Queue.parseQueue(queueRaw)).length
    if (depth > Queue.MAX_PENDING / 2) issues.push(`pending queue is deep (${depth}) — drains may not be keeping up`)
    else ok.push(`pending queue depth ${depth}`)

    for (const line of ok) console.log(`  ✓ ${line}`)
    for (const line of issues) console.log(`  ✗ ${line}`)
    if (issues.length === 0) console.log("\nKnowledge base is healthy.")
    else console.log(`\n${issues.length} issue(s) found.`)
  }),
})

export const KbCommand = cmd({
  command: "kb",
  describe: "inspect and maintain the project knowledge base",
  builder: (yargs: Argv) => yargs.command(StatsSub).command(DoctorSub).demandCommand(),
  handler: () => {},
})

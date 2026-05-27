import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import * as Log from "@nous-ai/core/util/log"

const log = Log.create({ service: "knowledge-base" })

export const KB_DIR_NAME = "knowledge_base_world"
export const UNDERSTANDING_FILENAME = "UNDERSTANDING.md"
export const DRILL_DOWN_FILENAME = "DRILL_DOWN_TREE.md"
export const MAX_INJECTION_BYTES = 8192
// A single knowledge doc should be a distilled summary, not a code dump.
export const MAX_DOC_BYTES = 16384

const _DEFAULT_UNDERSTANDING = `# Knowledge Base Understanding

Before exploring the codebase directly, consult DRILL_DOWN_TREE.md. It is a
LEAN index of knowledge *areas* (domains/features) — not a file listing. Each
area points to one knowledge doc that distils how that area works and lists the
source files to read for detail.

The goal is to spend tokens on distilled knowledge instead of re-reading raw
source every session.
`

const _DEFAULT_DRILL_DOWN = `# Drill-Down Tree

A LEAN index of knowledge areas. ONE entry per area (a domain or feature),
NOT one per source file. Each entry is ONLY a pointer to that area's doc plus a
one-line description — NO source-file paths live here. The doc holds the detail,
including a "Key Files" list that maps each file to its use case.

Each area is a "## Area Name" header followed by one bullet:
  - **Area/Doc.md** — one-line description of the whole area

No areas captured yet — the knowledge completer adds them as the codebase is explored.
`

const _DEFAULT_GITIGNORE = `.kb.lock
.kb.lock.d/
*.kbtmp
`

export interface TreeEntry {
  readonly entryPath: string
  readonly description: string
  readonly readPaths: string[]
}

export function parseTree(content: string): TreeEntry[] {
  const result: TreeEntry[] = []
  let category: string | null = null
  let currentEntry: string | null = null
  let currentDescription = ""
  let currentPaths: string[] = []

  const flush = () => {
    if (currentEntry) {
      result.push({ entryPath: currentEntry, description: currentDescription, readPaths: [...currentPaths] })
    }
  }

  for (const line of content.split("\n")) {
    const stripped = line.trim()
    const indent = line.length - line.trimStart().length

    if (!stripped) continue

    const hm = stripped.match(/^(#{2,6})\s+(.+)$/)
    if (hm) {
      flush()
      category = hm[2].trim()
      currentEntry = null
      currentDescription = ""
      currentPaths = []
      continue
    }

    if (indent === 0 && stripped.startsWith("- ") && !stripped.includes(".md")) {
      flush()
      category = stripped.slice(2).replace("(Folder)", "").trim()
      currentEntry = null
      currentDescription = ""
      currentPaths = []
      continue
    }

    const em = stripped.match(/^-\s+\*{0,2}([^\s*]+\.md)\*{0,2}\s*[—–\-]\s*(.*)$/)
    if (em && category) {
      flush()
      const rawPath = em[1]
      const entryPath = rawPath.includes("/") ? rawPath : `${category}/${rawPath}`
      currentEntry = entryPath
      currentDescription = em[2].trim()
      currentPaths = []
      continue
    }

    const rm = stripped.match(/^→\s*Read:\s+(.+)$/)
    if (rm && currentEntry && indent >= 2) {
      const paths = rm[1].split(",").map((p) => p.trim()).filter(Boolean)
      currentPaths.push(...paths)
    }
  }

  flush()
  return result
}

/**
 * Merge a single area into the tree, replacing that area's section if it
 * already exists or appending it otherwise. Every other section (and the
 * preamble) is preserved byte-for-byte — the LLM never has to reproduce the
 * whole tree, which is what previously caused unbounded growth.
 */
export function upsertAreaSection(treeContent: string, areaName: string, bodyLines: string): string {
  const lines = treeContent.split("\n")
  const headerRe = /^##\s+(.+?)\s*$/
  const target = areaName.trim().toLowerCase()

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe)
    if (m && m[1].trim().toLowerCase() === target) {
      start = i
      break
    }
  }

  const block = `## ${areaName.trim()}\n${bodyLines.trim()}`

  if (start === -1) {
    const base = treeContent.replace(/\s+$/, "")
    return `${base}\n\n${block}\n`
  }

  let end = lines.length
  for (let j = start + 1; j < lines.length; j++) {
    if (headerRe.test(lines[j])) {
      end = j
      break
    }
  }

  const before = lines.slice(0, start).join("\n").replace(/\s+$/, "")
  const after = lines.slice(end).join("\n").replace(/^\s+/, "").replace(/\s+$/, "")

  const parts: string[] = []
  if (before) parts.push(before)
  parts.push(block)
  if (after) parts.push(after)
  return `${parts.join("\n\n")}\n`
}

// Matches a workspace-relative source path (has a slash and a file extension),
// e.g. src/admin/foo.service.ts or src/x/model/ns.tudf.model.ts.
const PATH_IN_TEXT = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]*/g

function normalizeRel(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "").trim()
}

/**
 * The set of source files already documented by the knowledge base. Source
 * paths now live inside each area doc's "Key Files" section (not in the tree),
 * so coverage is derived by scanning the docs. Legacy `→ Read:` paths still in
 * the tree are also counted. Used by the completer's gap gate to decide whether
 * a session explored anything new.
 */
export function collectCoveredPaths(
  workDir: string,
  entries: TreeEntry[],
): Effect.Effect<string[], never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const out = new Set<string>()

    for (const entry of entries) {
      for (const raw of entry.readPaths) {
        const n = normalizeRel(raw)
        if (n) out.add(n)
      }
      if (entry.entryPath.includes("..") || entry.entryPath.startsWith("/")) continue
      const docPath = path.join(workDir, KB_DIR_NAME, entry.entryPath)
      const text = yield* fs.readFileStringSafe(docPath).pipe(Effect.orElseSucceed(() => undefined))
      if (!text) continue
      for (const m of text.matchAll(PATH_IN_TEXT)) {
        const n = normalizeRel(m[0])
        if (!n || n.endsWith(".md") || n.startsWith(KB_DIR_NAME + "/")) continue
        out.add(n)
      }
    }

    return [...out]
  })
}

// Seed the KB idempotently. We ensure each seed file exists individually rather
// than gating on the directory — otherwise, if the dir survives but a file is
// deleted (e.g. the user wiped DRILL_DOWN_TREE.md), the tree would never be
// recreated and the completer (which bails when the tree is missing) would be
// stuck forever. Existing files are never overwritten.
export function ensureInit(
  workDir: string,
): Effect.Effect<boolean, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const kbDir = path.join(workDir, KB_DIR_NAME)

    log.info("ensureInit", { workDir, kbDir })

    const ensureFile = (filePath: string, content: string) =>
      Effect.gen(function* () {
        const present = yield* fs.existsSafe(filePath).pipe(Effect.orElseSucceed(() => false))
        if (!present) {
          yield* fs.writeFileString(filePath, content)
          log.info("kb seeded file", { filePath })
        }
      })

    const ok = yield* Effect.gen(function* () {
      yield* fs.ensureDir(kbDir)
      yield* ensureFile(path.join(kbDir, DRILL_DOWN_FILENAME), _DEFAULT_DRILL_DOWN)
      yield* ensureFile(path.join(kbDir, UNDERSTANDING_FILENAME), _DEFAULT_UNDERSTANDING)
      yield* ensureFile(path.join(kbDir, ".gitignore"), _DEFAULT_GITIGNORE)
      return true
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => log.error("failed to init knowledge_base_world", { error: String(error), kbDir }))),
      Effect.orElseSucceed(() => false),
    )
    return ok
  })
}

export function loadTree(workDir: string): Effect.Effect<TreeEntry[] | null, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const treeFile = path.join(workDir, KB_DIR_NAME, DRILL_DOWN_FILENAME)
    const content = yield* fs.readFileStringSafe(treeFile).pipe(Effect.orElseSucceed(() => undefined))
    if (!content) return null
    return parseTree(content)
  })
}

export function loadTreeContent(workDir: string): Effect.Effect<string | null, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const treeFile = path.join(workDir, KB_DIR_NAME, DRILL_DOWN_FILENAME)
    const content = yield* fs.readFileStringSafe(treeFile).pipe(Effect.orElseSucceed(() => undefined))
    return content ?? null
  })
}

const LOCK_FILE = ".kb.lock"
// A completer run is short-lived; if a lock is older than this it is stale
// (e.g. a previous run crashed) and may be reclaimed.
const LOCK_TTL_MS = 5 * 60 * 1000

export function acquireLock(workDir: string): Effect.Effect<boolean, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const lockPath = path.join(workDir, KB_DIR_NAME, LOCK_FILE)
    const exists = yield* fs.existsSafe(lockPath).pipe(Effect.orElseSucceed(() => false))
    if (exists) {
      const raw = yield* fs.readFileStringSafe(lockPath).pipe(Effect.orElseSucceed(() => ""))
      const ts = Number.parseInt((raw ?? "").trim(), 10)
      const fresh = Number.isFinite(ts) && Date.now() - ts < LOCK_TTL_MS
      if (fresh) {
        log.info("kb lock held", { workDir })
        return false
      }
      log.info("kb lock stale, reclaiming", { workDir, ageMs: Date.now() - ts })
    }
    yield* fs.writeFileString(lockPath, String(Date.now())).pipe(Effect.orElseSucceed(() => {}))
    return true
  })
}

export function releaseLock(workDir: string): Effect.Effect<void, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const lockPath = path.join(workDir, KB_DIR_NAME, LOCK_FILE)
    yield* fs.remove(lockPath).pipe(Effect.orElseSucceed(() => {}))
  })
}

export function isKbPathSafe(workDir: string, filePath: string): boolean {
  const kbDir = path.join(workDir, KB_DIR_NAME)
  const fullPath = path.resolve(path.join(workDir, filePath))
  const relative = path.relative(kbDir, fullPath)
  return !relative.startsWith("..") && relative !== "" && filePath.startsWith(KB_DIR_NAME)
}

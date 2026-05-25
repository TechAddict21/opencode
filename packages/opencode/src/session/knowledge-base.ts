import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import * as Log from "@nous-ai/core/util/log"

const log = Log.create({ service: "knowledge-base" })

export const KB_DIR_NAME = "knowledge_base_world"
export const UNDERSTANDING_FILENAME = "UNDERSTANDING.md"
export const DRILL_DOWN_FILENAME = "DRILL_DOWN_TREE.md"
export const MAX_INJECTION_BYTES = 8192

const _DEFAULT_UNDERSTANDING = `# Knowledge Base Understanding

Before exploring the codebase directly, always refer to DRILL_DOWN_TREE.md
to identify which knowledge areas and code files are relevant to the
current task. This reduces token waste and keeps the agent focused.
`

const _DEFAULT_DRILL_DOWN = `# Drill-Down Tree

_Edit this file to describe your project's knowledge areas, their associated
documentation, and the code files to read for each._

Template:
- <Area Name>
  - <DOC.md> — <description>
    → Read: <path/to/code/files>
`

const _DEFAULT_GITIGNORE = `.kb.lock
.kb.lock.d/
*.kbtmp
`

export interface TreeEntry {
  readonly entryPath: string
  readonly readPaths: string[]
}

export function parseTree(content: string): TreeEntry[] {
  const result: TreeEntry[] = []
  let category: string | null = null
  let currentEntry: string | null = null
  let currentPaths: string[] = []

  for (const line of content.split("\n")) {
    const stripped = line.trim()
    const indent = line.length - line.trimStart().length

    if (!stripped) continue

    const hm = stripped.match(/^(#{2,6})\s+(.+)$/)
    if (hm) {
      if (currentEntry && currentPaths.length > 0) {
        result.push({ entryPath: currentEntry, readPaths: [...currentPaths] })
      }
      category = hm[2].trim()
      currentEntry = null
      currentPaths = []
      continue
    }

    if (indent === 0 && stripped.startsWith("- ") && !stripped.includes(".md")) {
      if (currentEntry && currentPaths.length > 0) {
        result.push({ entryPath: currentEntry, readPaths: [...currentPaths] })
      }
      category = stripped.slice(2).replace("(Folder)", "").trim()
      currentEntry = null
      currentPaths = []
      continue
    }

    const em = stripped.match(/^-\s+\*{0,2}([^\s*]+\.md)\*{0,2}\s*[\u2014\u2013\-]\s*(.*)$/)
    if (em && category) {
      if (currentEntry && currentPaths.length > 0) {
        result.push({ entryPath: currentEntry, readPaths: [...currentPaths] })
      }
      const rawPath = em[1]
      const entryPath = rawPath.includes("/") ? rawPath : `${category}/${rawPath}`
      currentEntry = entryPath
      currentPaths = []
      continue
    }

    const rm = stripped.match(/^\u2192\s*Read:\s+(.+)$/)
    if (rm && currentEntry && indent >= 2) {
      const paths = rm[1].split(",").map((p) => p.trim()).filter(Boolean)
      currentPaths.push(...paths)
    }
  }

  if (currentEntry && currentPaths.length > 0) {
    result.push({ entryPath: currentEntry, readPaths: [...currentPaths] })
  }

  return result
}

export function resolvePaths(workDir: string, rawPaths: string[]): string[] {
  const resolved: string[] = []
  const workReal = path.resolve(workDir)
  for (const raw of rawPaths) {
    if (!raw || raw.startsWith("/") || raw.startsWith("~")) continue
    const full = path.resolve(path.join(workDir, raw))
    const relative = path.relative(workReal, full)
    if (relative.startsWith("..") || relative === "") continue
    resolved.push(full)
  }
  return resolved
}

export function readRelevantCode(
  workDir: string,
  entries: TreeEntry[],
  matchedEntryPaths: string[],
): Effect.Effect<string, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const parts: string[] = []
    let totalBytes = 0

    for (const entryPath of matchedEntryPaths) {
      if (totalBytes >= MAX_INJECTION_BYTES) break

      const entry = entries.find((e) => e.entryPath === entryPath)
      if (!entry) continue

      const resolved = resolvePaths(workDir, entry.readPaths)
      if (resolved.length === 0) continue

      const sectionLines: string[] = [`## ${entryPath}`]
      for (const fp of resolved) {
        if (totalBytes >= MAX_INJECTION_BYTES) break
        const text = yield* fs.readFileStringSafe(fp).pipe(Effect.orElseSucceed(() => undefined))
        if (!text) continue
        const rel = path.relative(workDir, fp)
        const header = `\n### \`${rel}\``
        if (totalBytes + text.length > MAX_INJECTION_BYTES) {
          const available = MAX_INJECTION_BYTES - totalBytes - header.length - 50
          if (available <= 0) break
          const truncated = text.slice(0, available) + "\n... [truncated]"
          sectionLines.push(header, "```\n" + truncated + "\n```")
          totalBytes += truncated.length + header.length + 10
        } else {
          sectionLines.push(header, "```\n" + text + "\n```")
          totalBytes += text.length + header.length + 10
        }
      }

      if (sectionLines.length > 1) {
        parts.push(sectionLines.join("\n"))
      }
    }

    return parts.join("\n\n")
  })
}

export function ensureInit(
  workDir: string,
): Effect.Effect<boolean, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const kbDir = path.join(workDir, KB_DIR_NAME)

    log.info("ensureInit", { workDir, kbDir })

    const exists = yield* fs.existsSafe(kbDir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      log.info("creating knowledge_base_world", { kbDir })
      const ok = yield* Effect.gen(function* () {
        yield* fs.ensureDir(kbDir)
        yield* fs.writeFileString(path.join(kbDir, UNDERSTANDING_FILENAME), _DEFAULT_UNDERSTANDING)
        yield* fs.writeFileString(path.join(kbDir, DRILL_DOWN_FILENAME), _DEFAULT_DRILL_DOWN)
        yield* fs.writeFileString(path.join(kbDir, ".gitignore"), _DEFAULT_GITIGNORE)
        log.info("knowledge_base_world created", { kbDir })
        return true
      }).pipe(
        Effect.tapError((error) => Effect.sync(() => log.error("failed to create knowledge_base_world", { error: String(error), kbDir }))),
        Effect.orElseSucceed(() => false),
      )
      return ok
    }

    log.info("knowledge_base_world already exists", { kbDir })
    return true
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

export function acquireLock(workDir: string): Effect.Effect<boolean, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const lockPath = path.join(workDir, KB_DIR_NAME, LOCK_FILE)
    const exists = yield* fs.existsSafe(lockPath).pipe(Effect.orElseSucceed(() => false))
    if (exists) {
      log.info("kb lock already held", { workDir })
      return false
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

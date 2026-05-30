import path from "path"
import { Effect, Context, Layer, Stream } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@nous-ai/core/global"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import * as KB from "./knowledge-base"
import { KnowledgeLog } from "./knowledge-log"
import * as Log from "@nous-ai/core/util/log"
import { LLMEvent } from "@nous-ai/llm"

const log = Log.create({ service: "knowledge" })

export interface Interface {
  readonly feeder: (userText: string, userMessageID: string, sessionID: string) => Effect.Effect<string | null>
  readonly completer: (
    sessionID: string,
    messages: MessageV2.WithParts[],
  ) => Effect.Effect<void>
  readonly resetCache: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Knowledge") {}

interface IndexEntry {
  entryPath: string
  summary: string
  docText: string
  tokens: Set<string>
  paths: Set<string>
}

// In-memory search index over the knowledge base, rebuilt only when the tree
// changes. Lets the feeder match against doc contents (not just the lean tree
// summary) and do exact source-path lookups — fast and accurate.
interface KBIndex {
  treeContent: string
  entries: IndexEntry[]
  pathToEntries: Map<string, string[]>
  baseToEntries: Map<string, string[]>
  dirToEntries: Map<string, string[]>
  // Inverse document frequency per token across the area docs. Lets the matcher
  // reward rare, discriminating terms over ones that appear in every doc.
  idf: Map<string, number>
}

interface Cache {
  lastUserMessageID: string | null
  lastUserText: string | null
  lastInjection: string | null
  index: KBIndex | null
  // The areas matched on the last injecting turn, so a follow-up turn whose
  // text dropped the original keywords ("now refactor it") can still re-orient.
  lastMatched: string[]
  followupCount: number
}

// Match at most this many areas per query. The tree is a router, not a search
// index — too many matches drowns the real signal and wastes tokens.
const TOP_AREAS = 3

// Minimum match score for an area to be injected. Drops lone weak hits (a single
// substring/common-token overlap) that would otherwise spend the injection
// budget on a near-irrelevant doc. Every path-pass match (dir +4, basename +6,
// exact +12) and any sufficiently rare/multi-token text match clears this.
const MIN_SCORE = 3

// Cap how many consecutive keyword-less follow-up turns may reuse the previous
// turn's matched areas before we stop re-injecting stale context.
const FOLLOWUP_REUSE_LIMIT = 2

// Generic words that should never drive a knowledge-area match. Without this,
// queries match on "service"/"controller"/"admin" etc. and select half the tree.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "code", "file", "files", "service",
  "services", "controller", "controllers", "admin", "src", "function", "functions",
  "please", "help", "fix", "fixed", "fixes", "add", "adds", "added", "update",
  "updates", "updated", "change", "changes", "changed", "make", "made", "need",
  "needs", "want", "wants", "get", "set", "how", "what", "where", "why", "does",
  "use", "uses", "using", "used", "module", "modules", "class", "method", "methods",
  "into", "from", "your", "you", "are", "can", "should", "there", "their", "them",
  "when", "which", "also", "handle", "handles", "handling", "data", "logic", "main",
  "core", "new", "all", "any", "but", "not", "our", "its", "via", "per", "let",
  "may", "run", "see", "one", "two", "out", "off", "now", "has", "had", "was",
  "implement", "implementation", "feature", "issue", "bug", "error", "errors",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

// Extract source-file paths the user named in the query (e.g. the knowledge
// optimizer asks: what is the use of "src/admin/x.service.ts"). An exact path
// hit against a doc's Key Files is the highest-precision match we can make.
const QUERY_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]*/g

function extractQueryPaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(QUERY_PATH_RE)) out.push(normalizePath(m[0]))
  return out
}

const FRONTEND_KEYWORDS = [
  "html", "ui", "frontend", "component", "react", "vue", "css", "design",
  "interface", "web", "page", "layout", "styled", "tailwind", "component",
  "widget", "form", "button", "modal", "dashboard", "landing", "clone",
  "vite"
]

function isFrontendQuery(text: string): boolean {
  const lower = text.toLowerCase()
  return FRONTEND_KEYWORDS.some(kw => lower.includes(kw))
}

// Rank knowledge areas for a query across multiple passes, strongest first:
//   1. exact source-path hit against a doc's Key Files (very high precision)
//   2. filename (basename) hit
//   3. directory hit — query file's folder is documented by an area
//   4. exact token overlap with area name / summary / doc text
//   5. partial (substring) token overlap — the "try harder" fallback
function matchEntries(userText: string, index: KBIndex): string[] {
  const queryTokens = tokenize(userText)
  const queryPaths = extractQueryPaths(userText)
  const scores = new Map<string, number>()
  const add = (ep: string, s: number) => scores.set(ep, (scores.get(ep) ?? 0) + s)

  for (const qp of queryPaths) {
    for (const ep of index.pathToEntries.get(qp) ?? []) add(ep, 12)
    const base = qp.split("/").pop()?.toLowerCase()
    if (base) for (const ep of index.baseToEntries.get(base) ?? []) add(ep, 6)
    // Directory hit: a file we don't know yet, but whose folder is already
    // documented, almost certainly belongs to that same area.
    const dir = qp.includes("/") ? qp.slice(0, qp.lastIndexOf("/")) : ""
    if (dir) for (const ep of index.dirToEntries.get(dir) ?? []) add(ep, 4)
  }

  for (const entry of index.entries) {
    let s = 0
    for (const qt of queryTokens) {
      // Rarity boost (≈IDF): a term in one doc discriminates far better than one
      // in every doc. Neutral fallback (1) for tokens not in the index.
      const w = index.idf.get(qt) ?? 1
      if (entry.tokens.has(qt)) {
        s += 2 * w
        continue
      }
      for (const ht of entry.tokens) {
        if (ht.length >= 4 && (ht.includes(qt) || qt.includes(ht))) {
          s += 1 * w
          break
        }
      }
    }
    if (s > 0) add(entry.entryPath, s)
  }

  const byPath = new Map(index.entries.map((e) => [e.entryPath, e] as const))
  return [...scores.entries()]
    .filter(([ep, s]) => {
      // Floor: a lone weak hit (single common token / substring) is noise — don't
      // spend the injection budget on it. Path-pass matches always clear this.
      if (s < MIN_SCORE) return false
      // Never spend a result slot on a dangling pointer — an area whose doc is
      // missing/empty and which covers no source paths has nothing to inject.
      const e = byPath.get(ep)
      if (e && !e.docText.trim() && e.paths.size === 0) return false
      return true
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_AREAS)
    .map(([ep]) => ep)
}

// Fallback when nothing matched a conceptual query: surface the whole KB index
// (area + one-liner) so the agent can navigate to a doc itself instead of giving
// up. Cheap — summaries only, no doc bodies.
function assembleIndexHint(index: KBIndex): string {
  if (index.entries.length === 0) return ""
  const lines = index.entries.map((e) => `- ${e.entryPath} — ${e.summary}`)
  let body = lines.join("\n")
  if (body.length > KB.MAX_INJECTION_BYTES) body = body.slice(0, KB.MAX_INJECTION_BYTES) + "\n..."
  return body
}

const DOC_TRUNC_MARKER = "\n... [truncated — read the source files for more]"

// Split a doc into its lead (text before the first "## " section, i.e. the
// title + overview) and its "## "-level sections, each keeping its literal
// heading line. Used to trim a doc by whole sections instead of mid-text.
function splitForFit(docText: string): { lead: string; sections: { title: string; body: string }[] } {
  const lines = docText.split("\n")
  const leadLines: string[] = []
  const sections: { title: string; body: string[] }[] = []
  let cur: { title: string; body: string[] } | null = null
  for (const line of lines) {
    if (/^##\s+.+/.test(line)) {
      if (cur) sections.push(cur)
      cur = { title: line.trimEnd(), body: [] }
    } else if (cur) {
      cur.body.push(line)
    } else {
      leadLines.push(line)
    }
  }
  if (cur) sections.push(cur)
  return {
    lead: leadLines.join("\n").trim(),
    sections: sections.map((s) => ({ title: s.title, body: s.body.join("\n").replace(/\s+$/, "") })),
  }
}

// Trim one doc to `cap` bytes preserving the most useful content first: the
// lead/overview, then "Key Files", then remaining sections in original order.
// Whole sections are dropped rather than sliced mid-text; if Key Files itself
// overflows it is cut at the last complete bullet so no half-path survives.
function fitDoc(docText: string, cap: number): string {
  if (docText.length <= cap) return docText
  const { lead, sections } = splitForFit(docText)
  const keyIdx = sections.findIndex((s) => /\bfiles?\b/i.test(s.title))
  const order: number[] = []
  if (keyIdx >= 0) order.push(keyIdx)
  sections.forEach((_, i) => { if (i !== keyIdx) order.push(i) })

  let out = lead
  if (out.length > cap) return out.slice(0, Math.max(0, cap - DOC_TRUNC_MARKER.length)) + DOC_TRUNC_MARKER

  let truncated = false
  for (const i of order) {
    const sec = sections[i]
    const block = sec.title + (sec.body ? "\n" + sec.body : "")
    if (!block.trim()) continue
    if (out.length + 1 + block.length <= cap) {
      out += "\n" + block
      continue
    }
    // Key Files is the highest-value section — salvage as many whole bullets as
    // fit rather than dropping it entirely, but never emit a partial path.
    if (i === keyIdx) {
      const room = cap - out.length - 1 - sec.title.length - 1 - DOC_TRUNC_MARKER.length
      const kept: string[] = []
      let used = 0
      for (const bullet of sec.body.split("\n")) {
        if (used + bullet.length + 1 > room) break
        kept.push(bullet)
        used += bullet.length + 1
      }
      if (kept.length > 0) {
        out += "\n" + sec.title + "\n" + kept.join("\n")
      }
    }
    truncated = true
    // keep scanning — a later, smaller section may still fit under the cap
  }
  if (truncated && !out.endsWith(DOC_TRUNC_MARKER)) out += DOC_TRUNC_MARKER
  return out
}

// Build the injection text from the matched docs (held in the cached index, so
// no disk reads here). Reserves a fair budget floor per matched area so a large
// top match cannot starve the 2nd/3rd matches, and trims each doc by section
// priority rather than a raw byte cut.
function assembleDocs(index: KBIndex, matched: string[]): string {
  const byPath = new Map(index.entries.map((e) => [e.entryPath, e] as const))
  const present = matched.filter((ep) => {
    const e = byPath.get(ep)
    return !!e && !!e.docText.trim()
  })
  if (present.length === 0) return ""

  const floor = Math.max(1, Math.floor(KB.MAX_INJECTION_BYTES / present.length))
  const parts: string[] = []
  let total = 0
  present.forEach((ep, i) => {
    const remainingTotal = KB.MAX_INJECTION_BYTES - total
    if (remainingTotal <= 0) return
    const entry = byPath.get(ep)!
    const header = `\n### ${ep}\n`
    const areasLeft = present.length - i
    // This area may borrow budget the earlier areas left unspent, but must leave
    // each remaining area at least its floor.
    const reserveForRest = floor * (areasLeft - 1)
    const cap = Math.min(remainingTotal, Math.max(floor, remainingTotal - reserveForRest)) - header.length
    if (cap <= 0) return
    const body = fitDoc(entry.docText, cap)
    if (!body.trim()) return
    parts.push(header + body)
    total += header.length + body.length
  })
  return parts.join("\n")
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "").trim()
}

function toRelUnderWorkDir(p: string, workDir: string): string | null {
  let rel: string
  if (path.isAbsolute(p)) {
    const r = path.relative(workDir, p)
    if (!r || r.startsWith("..")) return null
    rel = r
  } else {
    rel = p
  }
  rel = normalizePath(rel)
  if (!rel || rel.startsWith("..")) return null
  if (rel === KB.KB_DIR_NAME || rel.startsWith(KB.KB_DIR_NAME + "/")) return null
  return rel
}

function extractInputPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const rec = input as Record<string, unknown>
  const out: string[] = []
  for (const key of ["filePath", "file_path", "path"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) out.push(v.trim())
  }
  return out
}

// Collect the workspace-relative files the agent actually opened/searched in
// the latest turn. This is the real "what did we explore" signal the completer
// needs — tool *names* alone (the old behaviour) can't tell it which code mattered.
function collectExploredPaths(messages: MessageV2.WithParts[], workDir: string): string[] {
  const out = new Set<string>()
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const state = (part as MessageV2.ToolPart).state as any
      if (!state || state.status !== "completed") continue
      for (const raw of extractInputPaths(state.input)) {
        const rel = toRelUnderWorkDir(raw, workDir)
        if (rel) out.add(rel)
      }
    }
  }
  return [...out]
}

// Cap how much evidence (a read preview or an edit/write diff) is shown per
// file, and the aggregate across all files, so grounding the completer stays
// bounded and cheap.
const EVIDENCE_PER_FILE_BYTES = 900
const EVIDENCE_TOTAL_BYTES = 5000

// Collect concrete evidence — actual content the agent saw this turn — for each
// target file: a `read` preview (clean head of file) or, failing that, an
// `edit`/`write` diff. This is what lets the completer distil OBSERVED behaviour
// into the doc instead of guessing a file's role from its path alone.
function collectFileEvidence(
  messages: MessageV2.WithParts[],
  workDir: string,
  targetFiles: Set<string>,
): Map<string, string> {
  const reads = new Map<string, string>()
  const diffs = new Map<string, string>()
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const tp = part as MessageV2.ToolPart
      const state = tp.state as any
      if (!state || state.status !== "completed") continue
      const rels = extractInputPaths(state.input)
        .map((raw) => toRelUnderWorkDir(raw, workDir))
        .filter((r): r is string => !!r && targetFiles.has(r))
      if (rels.length === 0) continue
      const md = (state.metadata ?? {}) as Record<string, unknown>
      let excerpt = ""
      let kind: "read" | "diff" | null = null
      if (tp.tool === "read" && typeof md.preview === "string" && md.preview.trim()) {
        excerpt = md.preview
        kind = "read"
      } else if ((tp.tool === "edit" || tp.tool === "write") && typeof md.diff === "string" && md.diff.trim()) {
        excerpt = md.diff
        kind = "diff"
      } else if (tp.tool === "read" && typeof state.output === "string" && state.output.trim()) {
        excerpt = state.output
        kind = "read"
      }
      if (!kind) continue
      excerpt = excerpt.slice(0, EVIDENCE_PER_FILE_BYTES)
      const target = kind === "read" ? reads : diffs
      for (const rel of rels) if (!target.has(rel)) target.set(rel, excerpt)
    }
  }
  // Prefer a read preview (what the file IS) over a diff (what changed); bound
  // the aggregate so a many-file turn cannot bloat the completer prompt.
  const out = new Map<string, string>()
  let total = 0
  for (const f of targetFiles) {
    const e = reads.get(f) ?? diffs.get(f)
    if (!e) continue
    if (total + e.length > EVIDENCE_TOTAL_BYTES) continue
    out.set(f, e)
    total += e.length
  }
  return out
}

function formatHistorySnippet(messages: MessageV2.WithParts[], workDir: string): string {
  const lines: string[] = []
  for (const msg of messages.slice(-30)) {
    const role = msg.info.role
    const text = msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .slice(0, 400)
    if (role === "user") {
      if (text) lines.push(`[user] ${text}`)
    } else if (role === "assistant") {
      const toolParts = msg.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
      const explored = new Set<string>()
      for (const tp of toolParts) {
        const state = tp.state as any
        if (!state || state.status !== "completed") continue
        for (const raw of extractInputPaths(state.input)) {
          const rel = toRelUnderWorkDir(raw, workDir)
          if (rel) explored.add(rel)
        }
      }
      let line = text ? `[assistant] ${text}` : ""
      if (toolParts.length > 0) {
        line += (line ? "\n" : "") + `[tools: ${toolParts.map((t) => t.tool).join(", ")}]`
      }
      if (explored.size > 0) {
        line += `\n[explored: ${[...explored].slice(0, 20).join(", ")}]`
      }
      if (line) lines.push(line)
    }
  }
  return lines.join("\n")
}

const KEYFILE_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]*/

// The doc path the tree currently points at for `areaName`, resolved the same
// way parseTree resolves a slash-less name (under the area's folder). Lets the
// completer reuse an existing area's doc file instead of orphaning it.
function docPathForArea(treeContent: string, areaName: string): string | null {
  const target = areaName.trim().toLowerCase()
  let inArea = false
  for (const line of treeContent.split("\n")) {
    const hm = line.match(/^##\s+(.+?)\s*$/)
    if (hm) {
      inArea = hm[1].trim().toLowerCase() === target
      continue
    }
    if (!inArea) continue
    const em = line.trim().match(/^-\s+\*{0,2}([^\s*]+\.md)\*{0,2}\s*[—–-]/)
    if (em) {
      const raw = em[1]
      if (raw.includes("/")) return raw
      const folder = areaName.replace(/[^a-zA-Z0-9]+/g, "") || "Area"
      return `${folder}/${raw}`
    }
  }
  return null
}

// Rewrite bare-filename Key-File references (`foo.service.ts`) to their full
// workspace path when the file was explored this turn. Coverage detection
// requires a slash, so without this a bare name is invisible to the gap gate and
// the completer would re-document the same file every session.
function normalizeKeyFilePaths(docBody: string, files: string[]): string {
  const byBase = new Map<string, string>()
  for (const f of files) {
    if (!f.includes("/")) continue
    const base = f.split("/").pop()
    if (base && !byBase.has(base)) byBase.set(base, f)
  }
  if (byBase.size === 0) return docBody
  return docBody.replace(/`([^`\n]+)`/g, (whole, inner: string) => {
    const token = inner.trim()
    if (token.includes("/")) return whole
    const full = byBase.get(token)
    return full ? "`" + full + "`" : whole
  })
}

// Merge a freshly written area doc with the area's previous doc so REUSING an
// existing area never silently loses its earlier Key Files. The new doc (with
// its refreshed overview/notes) is the base; any prior Key-Files bullet whose
// path the new doc omits is carried over.
function mergeAreaDoc(existingDoc: string, newDoc: string): string {
  const keyFilesSection = (doc: string): { start: number; end: number; bullets: string[] } | null => {
    const lines = doc.split("\n")
    const start = lines.findIndex((l) => /^##\s+.*\bfiles?\b/i.test(l))
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i
        break
      }
    }
    const bullets = lines.slice(start + 1, end).filter((l) => /^-\s+/.test(l.trim()))
    return { start, end, bullets }
  }
  const pathOf = (bullet: string): string | null => {
    const m = bullet.match(KEYFILE_PATH_RE)
    return m ? normalizePath(m[0]) : null
  }

  const oldSec = keyFilesSection(existingDoc)
  if (!oldSec || oldSec.bullets.length === 0) return newDoc

  const oldLines = existingDoc.split("\n")
  const newSec = keyFilesSection(newDoc)
  if (!newSec) {
    // New doc has no Key Files section — append the old one wholesale.
    return newDoc.replace(/\s+$/, "") + "\n\n" + oldLines[oldSec.start] + "\n" + oldSec.bullets.join("\n") + "\n"
  }

  const havePaths = new Set(newSec.bullets.map(pathOf).filter((p): p is string => !!p))
  const carry = oldSec.bullets.filter((b) => {
    const p = pathOf(b)
    return p ? !havePaths.has(p) : false
  })
  if (carry.length === 0) return newDoc

  const lines = newDoc.split("\n")
  let insertAt = newSec.start + 1
  for (let i = newSec.start + 1; i < newSec.end; i++) {
    if (/^-\s+/.test(lines[i].trim())) insertAt = i + 1
  }
  lines.splice(insertAt, 0, ...carry)
  return lines.join("\n")
}

const COMPLETER_SYSTEM_PROMPT = `You curate a project knowledge base that lets a coding agent avoid re-exploring the same code every session.

The knowledge base has two pieces:
- DRILL_DOWN_TREE.md — a LEAN index. ONE entry per knowledge AREA (a domain or feature such as "Collection", "CIBIL & Bureau", "Disbursement"). Each entry is ONLY a pointer to that area's doc plus a one-line description. It contains NO source-file paths.
- One distilled doc per area — this is where detail lives: how the area works AND a "## Key Files" section mapping each source file to its use case.

You are given:
1. The recent conversation (what the user wanted, the tools that ran, and the files explored).
2. The list of EXISTING areas already in the knowledge base.
3. Files explored this session that are NOT yet covered by the knowledge base.
4. Evidence: head/diff excerpts of those files — the actual content the agent saw this session.
5. The current DRILL_DOWN_TREE.md.

Your job: capture what was learned about ONE area this session so next time the agent can skip the exploration.

Rules:
- Output AT MOST ONE area — the one that best fits the files explored this session.
- REUSE by default. If the explored files plausibly belong to one of the EXISTING areas, REUSE that area's EXACT name, character-for-character — do NOT invent a near-duplicate. Singular/plural and near-synonym variants (e.g. "Collection" vs "Collections") are the SAME area, never a new one. Create a NEW area ONLY when none of the existing ones fit.
- The TREE entry is ONLY the doc pointer + a one-line summary. NEVER put source-file paths in the tree.
- Put EVERY source-file path inside the DOC's "## Key Files" section, one per line as: \`path/to/file.ext\` — its use case. Always write the FULL workspace-relative path (with directories), never a bare filename.
- Ground every Key-Files use-case in the provided Evidence. Do NOT document a file that has no Evidence entry, and do NOT invent behaviour, endpoints, or files that are not visible in the Evidence or the conversation.
- The doc is a distilled SUMMARY (responsibilities, key flows, gotchas) plus Key Files — NOT a copy of the code. Keep it under ~120 lines.
- If nothing reusable was learned, output exactly: ## SKIP

Output EXACTLY this structure and nothing else:

## AREA
name: <Area Name>
doc: <Area>/<DocName>.md
summary: <one line, <=120 chars, describing the area — NO file paths>
## DOC
# <Area Name>

<short overview of what this area does and how its pieces fit together>

## Key Files
- \`src/path/one.ts\` — what it's for / its use case
- \`src/path/two.ts\` — what it's for / its use case

## Notes
<key flows, gotchas, anything non-obvious — omit if nothing to add>
## END`

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Global.Service | Provider.Service | LLM.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const cache: InstanceState.InstanceState<Cache> = yield* InstanceState.make((_ctx) =>
      Effect.succeed<Cache>({
        lastUserMessageID: null,
        lastUserText: null,
        lastInjection: null,
        index: null,
        lastMatched: [],
        followupCount: 0,
      })
    )

    const getWorkDir = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      return ctx.directory
    })

    // Build the in-memory search index from the current tree + its docs. Reads
    // each doc once to extract searchable tokens and the source paths it covers,
    // so the feeder can match on doc contents and do exact path lookups.
    const buildIndex = (workDir: string, treeContent: string) =>
      Effect.gen(function* () {
        const entries: IndexEntry[] = []
        const pathToEntries = new Map<string, string[]>()
        const baseToEntries = new Map<string, string[]>()
        const dirToEntries = new Map<string, string[]>()
        const push = (map: Map<string, string[]>, key: string, ep: string) => {
          const arr = map.get(key)
          if (arr) arr.push(ep)
          else map.set(key, [ep])
        }
        for (const e of KB.parseTree(treeContent)) {
          if (e.entryPath.includes("..") || e.entryPath.startsWith("/")) continue
          const docPath = path.join(workDir, KB.KB_DIR_NAME, e.entryPath)
          const docText =
            (yield* fs.readFileStringSafe(docPath).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
          const paths = new Set<string>()
          for (const rp of e.readPaths) {
            const n = normalizePath(rp)
            if (n) paths.add(n)
          }
          for (const m of docText.matchAll(QUERY_PATH_RE)) {
            const n = normalizePath(m[0])
            if (n && !n.endsWith(".md") && !n.startsWith(KB.KB_DIR_NAME + "/")) paths.add(n)
          }
          const tokens = new Set(
            tokenize(
              e.entryPath.replace(/\.md$/i, "").replace(/[/_]/g, " ") + " " + e.description + " " + docText,
            ),
          )
          entries.push({ entryPath: e.entryPath, summary: e.description, docText, tokens, paths })
          for (const p of paths) {
            push(pathToEntries, p, e.entryPath)
            const base = p.split("/").pop()
            if (base) push(baseToEntries, base.toLowerCase(), e.entryPath)
            if (p.includes("/")) push(dirToEntries, p.slice(0, p.lastIndexOf("/")), e.entryPath)
          }
        }
        // Rarity boost per token (≈IDF): a token in fewer area docs is more
        // discriminating. Normalized by doc count so it behaves the same for a
        // 3-area KB as a 300-area one; range [1, 2.5).
        const df = new Map<string, number>()
        for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1)
        const n = Math.max(1, entries.length)
        const idf = new Map<string, number>()
        for (const [t, d] of df) idf.set(t, 1 + 1.5 * (1 - d / n))
        const index: KBIndex = { treeContent, entries, pathToEntries, baseToEntries, dirToEntries, idf }
        return index
      })

    const feeder = Effect.fn("Knowledge.feeder")(function* (userText: string, userMessageID: string, sessionID: string) {
      const workDir = yield* getWorkDir
      log.info("feeder start", { workDir, userMessageID, textLength: userText.length })

      const frontend = isFrontendQuery(userText)
      if (frontend) log.info("feeder frontend query detected", { userMessageID })

      const initialized = yield* KB.ensureInit(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs))
      if (!initialized) {
        log.warn("feeder init failed", { workDir })
        yield* KnowledgeLog.append(sessionID, { phase: "feeder", action: "init-failed", workDir }).pipe(Effect.ignore)
        return null
      }

      const c = yield* InstanceState.get(cache)
      if (userMessageID === c.lastUserMessageID && c.lastInjection !== null) {
        log.info("feeder cache hit", { userMessageID })
        yield* KnowledgeLog.append(sessionID, { phase: "feeder", action: "cache-hit", userMessageID, bytes: c.lastInjection.length }).pipe(Effect.ignore)
        return c.lastInjection || null
      }

      const treeContent = yield* KB.loadTreeContent(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )

      let matchedEntries: string[] = []
      let docs = ""
      let indexHint = ""
      let usedFollowup = false
      if (treeContent && treeContent.trim()) {
        let index = c.index
        if (!index || index.treeContent !== treeContent) {
          index = yield* buildIndex(workDir, treeContent)
          const built = index
          yield* InstanceState.useEffect(cache, (s) => Effect.sync(() => { s.index = built }))
          log.info("feeder index built", { areas: built.entries.length, paths: built.pathToEntries.size })
        }
        if (index) {
          matchedEntries = matchEntries(userText, index)
          docs = assembleDocs(index, matchedEntries)
          if (!docs && extractQueryPaths(userText).length === 0) {
            // No direct match on a conceptual query. First carry the previous
            // turn's areas — a follow-up like "now refactor it" drops the original
            // keywords but is still about the same code. Bounded so stale context
            // can't ride along forever. Then fall back to the navigable index.
            if (c.lastMatched.length > 0 && c.followupCount < FOLLOWUP_REUSE_LIMIT) {
              const carried = assembleDocs(index, c.lastMatched)
              if (carried) {
                docs = carried
                matchedEntries = c.lastMatched
                usedFollowup = true
              }
            }
            if (!docs) indexHint = assembleIndexHint(index)
          }
          log.info("feeder matched", { entries: matchedEntries.length, matchedEntries, indexHint: indexHint.length > 0, usedFollowup })
        }
      }

      const frontendHint = frontend
        ? "\n\n⚠️ CRITICAL INSTRUCTION: This is a frontend/UI/HTML/design request. " +
          "You MUST call the `skill` tool with parameter name='frontend-design' BEFORE you start coding or designing. " +
          "This will load the frontend-design skill instructions which are REQUIRED for this task. " +
          "Do not proceed with any design work, HTML generation, or code output until you have loaded this skill.\n"
        : ""

      if (!docs && !indexHint && !frontendHint) {
        yield* InstanceState.useEffect(cache, (s) =>
          Effect.sync(() => {
            s.lastUserMessageID = userMessageID
            s.lastUserText = userText
            s.lastInjection = ""
          }),
        )
        yield* KnowledgeLog.append(sessionID, { phase: "feeder", action: "no-match", userMessageID }).pipe(Effect.ignore)
        return null
      }

      const kbSection = docs
        ? "## Project knowledge base (relevant areas)\n" +
          (usedFollowup
            ? "No new area matched this follow-up, so the areas from the previous turn are carried over. "
            : "Distilled knowledge already captured for areas relevant to this task. ") +
          "Use it to orient quickly. Each doc's \"Key Files\" section lists the source files — read them only if you need detail beyond the summary.\n" +
          `Matched areas: ${matchedEntries.join(", ")}\n` +
          docs
        : indexHint
          ? "## Project knowledge base (index)\n" +
            "No single area matched, but the project has a knowledge base. If an area below fits the task, read its doc under knowledge_base_world/ before exploring code:\n" +
            indexHint
          : ""
      const injection = kbSection + frontendHint

      log.info("feeder inject", { bytes: injection.length, entries: matchedEntries, hasFrontendHint: !!frontendHint })

      yield* InstanceState.useEffect(cache, (s) =>
        Effect.sync(() => {
          s.lastUserMessageID = userMessageID
          s.lastUserText = userText
          s.lastInjection = injection
          // Track matched areas so a keyword-less follow-up can re-orient.
          if (docs && !usedFollowup) {
            s.lastMatched = matchedEntries
            s.followupCount = 0
          } else if (usedFollowup) {
            s.followupCount = c.followupCount + 1
          }
        }),
      )
      yield* KnowledgeLog.append(sessionID, {
        phase: "feeder",
        action: "inject",
        userMessageID,
        bytes: injection.length,
        matched: matchedEntries,
        indexHint: !!indexHint,
        followup: usedFollowup,
        frontend,
      }).pipe(Effect.ignore)
      return injection
    })

    const completerCore = Effect.fn("Knowledge.completer")(function* (sessionID: string, messages: MessageV2.WithParts[]) {
      const workDir = yield* getWorkDir
      log.info("completer start", { sessionID, workDir, messageCount: messages.length })

      // Seed the KB if missing so a deleted/absent tree is recreated rather than
      // permanently blocking the completer.
      yield* KB.ensureInit(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs))

      const treeContent = yield* KB.loadTreeContent(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      if (!treeContent) {
        log.info("completer no tree, skipping")
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "no-tree" }).pipe(Effect.ignore)
        return
      }

      // Gap gate: only invoke the model when this turn explored files the
      // knowledge base does not already cover. This stops the completer from
      // re-running (and re-bloating the tree) on every tool-using turn.
      const explored = collectExploredPaths(messages, workDir)
      if (explored.length === 0) {
        log.info("completer no files explored, skipping")
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "no-files-explored" }).pipe(Effect.ignore)
        return
      }
      const coveredPaths = yield* KB.collectCoveredPaths(workDir, KB.parseTree(treeContent)).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      const covered = new Set(coveredPaths.map(normalizePath))
      const newFiles = explored.filter((f) => !covered.has(normalizePath(f)))
      if (newFiles.length === 0) {
        log.info("completer explored files already covered, skipping", { explored: explored.length })
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "all-covered", explored: explored.length }).pipe(Effect.ignore)
        return
      }
      log.info("completer gap detected", { newFiles })

      // Grounding gate: only document files we have real evidence for this turn
      // (a read preview or an edit/write diff). Without evidence the model would
      // guess a file's role from its path, so skip BEFORE taking the lock or
      // spending an LLM call.
      const evidence = collectFileEvidence(messages, workDir, new Set(newFiles.map(normalizePath)))
      const groundedFiles = newFiles.filter((f) => evidence.has(normalizePath(f)))
      if (groundedFiles.length === 0) {
        log.info("completer no grounded evidence, skipping", { newFiles: newFiles.length })
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "no-evidence", newFiles: newFiles.length }).pipe(Effect.ignore)
        return
      }
      yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "gap-detected", newFiles, grounded: groundedFiles.length }).pipe(Effect.ignore)

      const acquired = yield* KB.acquireLock(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      if (!acquired) {
        log.info("completer lock held, skipping")
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "lock-held" }).pipe(Effect.ignore)
        return
      }

      yield* Effect.gen(function* () {
        const modelInfo = yield* provider.defaultModel().pipe(Effect.orElseSucceed(() => undefined))
        if (!modelInfo) {
          log.warn("completer no model available")
          return
        }

        const smallModel = yield* provider.getSmallModel(modelInfo.providerID).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const model =
          smallModel ??
          (yield* provider.getModel(modelInfo.providerID, modelInfo.modelID).pipe(
            Effect.orElseSucceed(() => undefined),
          ))
        if (!model) {
          log.warn("completer could not load model")
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "no-model" }).pipe(Effect.ignore)
          return
        }

        const history = formatHistorySnippet(messages, workDir)
        // Canonical area names already in the tree, surfaced to the model so it
        // reuses an exact existing name instead of minting a near-duplicate.
        const existingAreas = [...treeContent.matchAll(/^##\s+(.+?)\s*$/gm)]
          .map((m) => m[1].trim())
          .filter((nm) => nm.toLowerCase() !== "skip")
        const areaList = existingAreas.length
          ? `Existing areas (REUSE the EXACT name if the files below plausibly belong to one):\n${existingAreas.map((a) => `- ${a}`).join("\n")}\n\n`
          : ""
        const evidenceBlock = groundedFiles
          .map((f) => {
            const ex = evidence.get(normalizePath(f))
            return ex ? `\n${f}\n\`\`\`\n${ex}\n\`\`\`` : ""
          })
          .filter(Boolean)
          .join("\n")
        const prompt =
          `Recent conversation:\n${history}\n\n` +
          areaList +
          `Files explored this session NOT yet in the knowledge base:\n${groundedFiles.map((f) => `- ${f}`).join("\n")}\n\n` +
          `Evidence (head/diff excerpts of those files, captured this session — ground every use-case in these):${evidenceBlock}\n\n` +
          `Current DRILL_DOWN_TREE.md:\n${treeContent}\n\n` +
          `Capture what was learned about ONE area, following the rules.`

        const userMsg: MessageV2.User = {
          id: "msg_kb_completer" as any,
          role: "user",
          sessionID: sessionID as any,
          time: { created: Date.now() },
          agent: "knowledge-completer",
          model: { providerID: modelInfo.providerID as any, modelID: modelInfo.modelID as any },
        }

        const text = yield* llm
          .stream({
            agent: { name: "knowledge-completer", prompt: "", tools: [] } as any,
            user: userMsg,
            system: [COMPLETER_SYSTEM_PROMPT],
            // Keep the SMALL model: now that it's grounded in real evidence it
            // compresses faithfully — escalating buys little and costs more.
            small: true,
            tools: {},
            model,
            sessionID: sessionID as any,
            retries: 1,
            messages: [{ role: "user", content: prompt }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((e) => e.text),
            Stream.mkString,
            Effect.orElseSucceed(() => ""),
          )

        if (!text) {
          log.info("completer empty response")
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "empty-response" }).pipe(Effect.ignore)
          return
        }
        log.info("completer response", { bytes: text.length })

        if (/^##\s*SKIP\s*$/m.test(text)) {
          log.info("completer skip")
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "model-skip" }).pipe(Effect.ignore)
          return
        }

        const nameM = text.match(/^name:\s*(.+)$/m)
        const docM = text.match(/^doc:\s*(.+)$/m)
        const sumM = text.match(/^summary:\s*(.+)$/m)
        const docBodyM = text.match(/##\s*DOC\s*\n([\s\S]*?)(?:\n##\s*END|$)/)
        if (!nameM || !docM || !sumM || !docBodyM) {
          log.warn("completer unparseable response", { bytes: text.length })
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "unparseable", bytes: text.length }).pipe(Effect.ignore)
          return
        }

        const areaNameRaw = nameM[1].trim()
        // Merge near-duplicate area names (Collection/Collections/case variants)
        // into the existing area so the tree keeps ONE entry per domain.
        const areaName = KB.resolveCanonicalArea(treeContent, areaNameRaw)
        const reusing = existingAreas.some((a) => a.toLowerCase() === areaName.toLowerCase())
        let docRel = docM[1].trim().replace(/^\/+/, "")
        const summary = sumM[1].trim()
        let docBody = docBodyM[1].trim()

        if (!areaName || !summary || !docBody) {
          log.warn("completer missing fields")
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "missing-fields" }).pipe(Effect.ignore)
          return
        }
        if (docRel.includes("..") || !docRel.toLowerCase().endsWith(".md")) {
          log.warn("completer invalid doc path", { docRel })
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "invalid-doc-path", docRel }).pipe(Effect.ignore)
          return
        }
        // When reusing an existing area, write to its current doc path so we never
        // orphan it — the tree pointer wins over whatever path the model proposed.
        if (reusing) {
          const existingDocRel = docPathForArea(treeContent, areaName)
          if (existingDocRel) docRel = existingDocRel
        }
        // Keep the written doc path identical to the tree entry path so the
        // feeder can find it: parseTree resolves a slash-less name under its
        // area folder, so we ensure the doc lives under that same folder.
        if (!docRel.includes("/")) {
          const folder = areaName.replace(/[^a-zA-Z0-9]+/g, "") || "Area"
          docRel = `${folder}/${docRel}`
        }
        // Rewrite any bare-filename Key Files to full paths so coverage detection
        // (which needs a slash) sees them and the completer won't re-run forever.
        docBody = normalizeKeyFilePaths(docBody, newFiles)

        const kbRelPath = `${KB.KB_DIR_NAME}/${docRel}`
        if (!KB.isKbPathSafe(workDir, kbRelPath)) {
          log.warn("completer unsafe doc path rejected", { docRel })
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "unsafe-doc-path", docRel }).pipe(Effect.ignore)
          return
        }

        const fullPath = path.join(workDir, kbRelPath)
        yield* fs.ensureDir(path.dirname(fullPath)).pipe(Effect.orElseSucceed(() => {}))
        // Reusing an area? Merge with its previous doc so earlier Key Files the
        // model didn't see this turn are preserved rather than clobbered.
        const existingDoc = reusing
          ? yield* fs.readFileStringSafe(fullPath).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        let finalBody = existingDoc && existingDoc.trim() ? mergeAreaDoc(existingDoc, docBody) : docBody
        if (finalBody.length > KB.MAX_DOC_BYTES) finalBody = finalBody.slice(0, KB.MAX_DOC_BYTES)
        yield* fs.writeFileString(fullPath, finalBody).pipe(Effect.orElseSucceed(() => {}))
        log.info("completer wrote doc", { docRel, reusing, merged: !!(existingDoc && existingDoc.trim()) })

        const bodyLines = `- **${docRel}** — ${summary}`
        const newTree = KB.upsertAreaSection(treeContent, areaName, bodyLines)
        const treeChanged = newTree.trim() !== treeContent.trim()
        if (treeChanged) {
          yield* fs
            .writeFileString(path.join(workDir, KB.KB_DIR_NAME, KB.DRILL_DOWN_FILENAME), newTree)
            .pipe(Effect.orElseSucceed(() => {}))
          log.info("completer updated tree", { areaName })
        }
        yield* KnowledgeLog.append(sessionID, {
          phase: "completer",
          action: "write",
          area: areaName,
          docRel,
          reusing,
          treeChanged,
          files: groundedFiles,
        }).pipe(Effect.ignore)
      }).pipe(
        Effect.ensuring(
          KB.releaseLock(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs)),
        ),
      )
    })

    const completer = (sessionID: string, messages: MessageV2.WithParts[]) =>
      completerCore(sessionID, messages).pipe(
        Effect.catch((error: unknown) => Effect.sync(() => log.warn("completer error", { error: String(error) })))
      )

    const resetCache = Effect.fn("Knowledge.resetCache")(function* () {
      yield* InstanceState.useEffect(cache, (s) =>
        Effect.sync(() => {
          s.lastUserMessageID = null
          s.lastUserText = null
          s.lastInjection = null
          s.index = null
          s.lastMatched = []
          s.followupCount = 0
        }),
      )
    })

    return Service.of({ feeder, completer, resetCache })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(LLM.defaultLayer),
)

export * as Knowledge from "./knowledge"

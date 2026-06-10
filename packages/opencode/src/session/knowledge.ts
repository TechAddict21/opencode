import path from "path"
import { Effect, Context, Layer, Stream } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@nous-ai/core/global"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import * as KB from "./knowledge-base"
import * as FileMap from "./knowledge-file-map"
import * as Queue from "./knowledge-queue"
import { ChangeLedger } from "./change-ledger"
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

// Pre-tokenized view of one FILE_MAP entry so per-query matching is set lookups,
// not re-tokenization.
interface FileIndexEntry {
  entry: FileMap.FileMapEntry
  base: string
  dir: string
  pathTokens: Set<string>
  purposeTokens: Set<string>
  symbolsLower: Set<string>
}

// In-memory search index over the knowledge base, rebuilt only when the tree
// changes. Lets the feeder match against doc contents (not just the lean tree
// summary) and do exact source-path lookups — fast and accurate.
export interface KBIndex {
  treeContent: string
  entries: IndexEntry[]
  pathToEntries: Map<string, string[]>
  baseToEntries: Map<string, string[]>
  dirToEntries: Map<string, string[]>
  // Inverse document frequency per token across the area docs. Lets the matcher
  // reward rare, discriminating terms over ones that appear in every doc.
  idf: Map<string, number>
  // The fine-grained file→purpose layer (FILE_MAP.jsonl), pre-tokenized.
  files: FileIndexEntry[]
  fileByPath: Map<string, FileMap.FileMapEntry>
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
  // Completer-run counter + the run at which each area was last enriched, so
  // UPDATE-mode rewrites of the same doc are rate-limited within a session.
  completerRuns: number
  areaEnrichedAtRun: Record<string, number>
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

// Completer shape limits: how many distinct areas one turn may write, how many
// areas an enrichment pass may rewrite, and how long an enriched area rests
// before it can be rewritten again (in completer runs, not turns).
const MAX_AREAS_PER_TURN = 3
const MAX_ENRICH_AREAS = 2
const ENRICH_COOLDOWN_RUNS = 3
// Each enrichment target doc is trimmed to this before being shown to the model.
const ENRICH_DOC_CAP = 6144
// The agent's own final analysis is the most distilled knowledge a turn makes.
const FINAL_TEXT_BYTES = 4000
// A turn with this much final analysis and tool activity carries insight worth
// folding into existing docs even when no new files were explored.
const INSIGHT_TEXT_MIN = 600
const INSIGHT_TOOL_CALLS_MIN = 3
// Queue drain sizes: alongside a normal completer call, and for a solo
// map-focused call when the turn would otherwise skip entirely (only worth a
// model call once the backlog is deep enough).
const QUEUE_DRAIN_MAIN = 5
const QUEUE_DRAIN_SOLO = 8
const MIN_QUEUE_SOLO = 10
// Cap harvested grep/glob result paths per tool call.
const SEARCH_HARVEST_PER_CALL = 15
// File-map injection: max matched entries and byte budget of the rendered block.
const FILE_MATCH_LIMIT = 12
const FILE_BLOCK_BYTES = 2048

// Function words that should never drive a knowledge-area match. Deliberately
// excludes domain nouns ("service", "controller", "session", "error"…): those
// DO discriminate in many projects, and the IDF weighting already de-weights
// any term that appears in every doc.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "code", "file", "files",
  "please", "help", "fix", "fixed", "fixes", "add", "adds", "added", "update",
  "updates", "updated", "change", "changes", "changed", "make", "made", "need",
  "needs", "want", "wants", "get", "set", "how", "what", "where", "why", "does",
  "use", "uses", "using", "used",
  "into", "from", "your", "you", "are", "can", "should", "there", "their", "them",
  "when", "which", "also",
  "new", "all", "any", "but", "not", "our", "its", "via", "per", "let",
  "may", "run", "see", "one", "two", "out", "off", "now", "has", "had", "was",
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
export function matchEntries(userText: string, index: KBIndex): string[] {
  const queryTokens = tokenize(userText)
  const queryPaths = extractQueryPaths(userText)
  const pathScores = new Map<string, number>()
  const addPath = (ep: string, s: number) => pathScores.set(ep, (pathScores.get(ep) ?? 0) + s)

  for (const qp of queryPaths) {
    for (const ep of index.pathToEntries.get(qp) ?? []) addPath(ep, 12)
    const base = qp.split("/").pop()?.toLowerCase()
    if (base) for (const ep of index.baseToEntries.get(base) ?? []) addPath(ep, 6)
    // Directory hit: a file we don't know yet, but whose folder is already
    // documented, almost certainly belongs to that same area.
    const dir = qp.includes("/") ? qp.slice(0, qp.lastIndexOf("/")) : ""
    if (dir) for (const ep of index.dirToEntries.get(dir) ?? []) addPath(ep, 4)
  }

  // Text pass, tracked separately from path passes: an entry with no path
  // evidence needs either two distinct exact token hits or one strong (rare)
  // hit — a lone common-token or substring overlap selects nothing.
  const textScores = new Map<string, { score: number; exactHits: number }>()
  for (const entry of index.entries) {
    let s = 0
    let exactHits = 0
    for (const qt of queryTokens) {
      // Rarity boost (≈IDF): a term in one doc discriminates far better than one
      // in every doc. Neutral fallback (1) for tokens not in the index.
      const w = index.idf.get(qt) ?? 1
      if (entry.tokens.has(qt)) {
        s += 2 * w
        exactHits += 1
        continue
      }
      if (qt.length < 5) continue
      for (const ht of entry.tokens) {
        if (ht.length >= 5 && (ht.includes(qt) || qt.includes(ht))) {
          s += 0.5 * w
          break
        }
      }
    }
    if (s > 0) textScores.set(entry.entryPath, { score: s, exactHits })
  }

  const byPath = new Map(index.entries.map((e) => [e.entryPath, e] as const))
  const all = new Set([...pathScores.keys(), ...textScores.keys()])
  return [...all]
    .map((ep) => {
      const p = pathScores.get(ep) ?? 0
      const t = textScores.get(ep)
      return { ep, total: p + (t?.score ?? 0), pathScore: p, textScore: t?.score ?? 0, exactHits: t?.exactHits ?? 0 }
    })
    .filter(({ ep, total, pathScore, textScore, exactHits }) => {
      // Floor: a lone weak hit (single common token / substring) is noise — don't
      // spend the injection budget on it. Path-pass matches always clear this.
      if (total < MIN_SCORE) return false
      if (pathScore === 0 && exactHits < 2 && textScore < 4) return false
      // Never spend a result slot on a dangling pointer — an area whose doc is
      // missing/empty and which covers no source paths has nothing to inject.
      const e = byPath.get(ep)
      if (e && !e.docText.trim() && e.paths.size === 0) return false
      return true
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_AREAS)
    .map(({ ep }) => ep)
}

// Match the user's query against the fine-grained file map: exact path, then
// basename, then directory, then symbol/path/purpose tokens. Strong enough
// hits only — one purpose-token overlap alone never surfaces a file.
export function matchFileMap(userText: string, index: KBIndex): FileMap.FileMapEntry[] {
  if (index.files.length === 0) return []
  const queryTokens = tokenize(userText)
  const queryPaths = extractQueryPaths(userText)
  const scores = new Map<string, number>()
  const add = (p: string, s: number) => scores.set(p, (scores.get(p) ?? 0) + s)

  for (const qp of queryPaths) {
    const base = qp.split("/").pop()?.toLowerCase()
    const dir = qp.includes("/") ? qp.slice(0, qp.lastIndexOf("/")) : ""
    for (const f of index.files) {
      if (f.entry.path === qp) add(f.entry.path, 12)
      else if (base && f.base === base) add(f.entry.path, 6)
      else if (dir && f.dir === dir) add(f.entry.path, 3)
    }
  }
  for (const qt of queryTokens) {
    for (const f of index.files) {
      if (f.symbolsLower.has(qt)) add(f.entry.path, 4)
      else if (f.pathTokens.has(qt)) add(f.entry.path, 2)
      else if (f.purposeTokens.has(qt)) add(f.entry.path, 1)
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s >= MIN_SCORE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FILE_MATCH_LIMIT)
    .map(([p]) => index.fileByPath.get(p))
    .filter((e): e is FileMap.FileMapEntry => !!e)
}

// Pure index construction over pre-read inputs: tree content, each entry's doc
// text, and the parsed file map. Sync and deterministic so the matcher can be
// exercised in tests against fixture knowledge bases.
export function buildIndexPure(
  treeContent: string,
  docTexts: Map<string, string>,
  fileByPath: Map<string, FileMap.FileMapEntry>,
): KBIndex {
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
    const docText = docTexts.get(e.entryPath) ?? ""
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
      tokenize(e.entryPath.replace(/\.md$/i, "").replace(/[/_]/g, " ") + " " + e.description + " " + docText),
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
  // The fine-grained file→purpose layer, pre-tokenized for cheap matching.
  const files: FileIndexEntry[] = []
  for (const entry of fileByPath.values()) {
    files.push({
      entry,
      base: entry.path.split("/").pop()?.toLowerCase() ?? "",
      dir: entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "",
      pathTokens: new Set(tokenize(entry.path.replace(/[/._-]/g, " "))),
      purposeTokens: new Set(tokenize(entry.purpose)),
      symbolsLower: new Set(entry.symbols.map((s) => s.toLowerCase())),
    })
  }
  return { treeContent, entries, pathToEntries, baseToEntries, dirToEntries, idf, files, fileByPath }
}

// Render matched file-map entries as the injection's "what's where" block.
function renderFileMapBlock(entries: FileMap.FileMapEntry[]): string {
  if (entries.length === 0) return ""
  const lines: string[] = []
  let total = 0
  for (const e of entries) {
    if (!e.purpose) continue
    const sym = e.symbols.length ? ` (symbols: ${e.symbols.join(", ")})` : ""
    const line = `- \`${e.path}\` — ${e.purpose}${sym}`
    if (total + line.length + 1 > FILE_BLOCK_BYTES) break
    lines.push(line)
    total += line.length + 1
  }
  if (lines.length === 0) return ""
  return "### File map (what's where)\n" + lines.join("\n")
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

// Build the injection text from the matched docs (held in the cached index, so
// no disk reads here). Reserves a fair budget floor per matched area so a large
// top match cannot starve the 2nd/3rd matches, and trims each doc by section
// priority rather than a raw byte cut. `budget` shrinks when other injection
// blocks (the file map) already spent part of MAX_INJECTION_BYTES.
function assembleDocs(index: KBIndex, matched: string[], budget = KB.MAX_INJECTION_BYTES): string {
  const byPath = new Map(index.entries.map((e) => [e.entryPath, e] as const))
  const present = matched.filter((ep) => {
    const e = byPath.get(ep)
    return !!e && !!e.docText.trim()
  })
  if (present.length === 0) return ""

  const floor = Math.max(1, Math.floor(budget / present.length))
  const parts: string[] = []
  let total = 0
  present.forEach((ep, i) => {
    const remainingTotal = budget - total
    if (remainingTotal <= 0) return
    const entry = byPath.get(ep)!
    const header = `\n### ${ep}\n`
    const areasLeft = present.length - i
    // This area may borrow budget the earlier areas left unspent, but must leave
    // each remaining area at least its floor.
    const reserveForRest = floor * (areasLeft - 1)
    const cap = Math.min(remainingTotal, Math.max(floor, remainingTotal - reserveForRest)) - header.length
    if (cap <= 0) return
    const body = KB.fitDoc(entry.docText, cap)
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
const EVIDENCE_PER_FILE_BYTES = 1200
const EVIDENCE_TOTAL_BYTES = 12000

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
      .slice(0, 700)
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
    // Same space-tolerant path shape as KB.parseTree — area folders routinely
    // contain spaces.
    const em = line.trim().match(/^-\s+\*{0,2}([^*]+?\.md)\*{0,2}\s*[—–-]/)
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

// The agent's own final analysis this turn — the most distilled knowledge a
// turn produces, and the completer's highest-value evidence.
function collectFinalText(messages: MessageV2.WithParts[]): string {
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  for (let i = slice.length - 1; i >= 0; i--) {
    const msg = slice[i]
    if (msg.info.role !== "assistant") continue
    const text = msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) return text.slice(0, FINAL_TEXT_BYTES)
  }
  return ""
}

function countCompletedToolCalls(messages: MessageV2.WithParts[]): number {
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  let n = 0
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const state = (part as MessageV2.ToolPart).state as any
      if (state && state.status === "completed") n++
    }
  }
  return n
}

// Files the agent read this turn — drives the redundancy metric (re-reads of
// files the map already knows are the waste this system exists to remove).
function collectReadRels(messages: MessageV2.WithParts[], workDir: string): string[] {
  const out = new Set<string>()
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const tp = part as MessageV2.ToolPart
      if (tp.tool !== "read") continue
      const state = tp.state as any
      if (!state || state.status !== "completed") continue
      for (const raw of extractInputPaths(state.input)) {
        const rel = toRelUnderWorkDir(raw, workDir)
        if (rel) out.add(rel)
      }
    }
  }
  return [...out]
}

// Paths surfaced by grep/glob results this turn. These never carry read/diff
// evidence, so they can't be documented immediately — they feed the pending
// queue so a later turn can. Junk dirs are dropped at the source.
const HARVEST_SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor)(\/|$)/

function collectSearchedPaths(
  messages: MessageV2.WithParts[],
  workDir: string,
): { path: string; reason: "grep-hit" | "glob-hit"; hint?: string }[] {
  const out = new Map<string, { path: string; reason: "grep-hit" | "glob-hit"; hint?: string }>()
  const lastUserIdx = messages.findLastIndex((m) => m.info.role === "user")
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
  for (const msg of slice) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const tp = part as MessageV2.ToolPart
      if (tp.tool !== "grep" && tp.tool !== "glob") continue
      const state = tp.state as any
      if (!state || state.status !== "completed") continue
      const output = typeof state.output === "string" ? state.output : ""
      if (!output.trim()) continue
      const raw = tp.tool === "grep" ? Queue.harvestGrepPaths(output) : Queue.harvestGlobPaths(output)
      const input = (state.input ?? {}) as Record<string, unknown>
      const pattern = typeof input.pattern === "string" ? input.pattern : ""
      const hint = pattern ? `${tp.tool === "grep" ? "pattern" : "glob"}: ${pattern}`.slice(0, 80) : undefined
      const reason = tp.tool === "grep" ? ("grep-hit" as const) : ("glob-hit" as const)
      for (const r of raw.slice(0, SEARCH_HARVEST_PER_CALL)) {
        const rel = toRelUnderWorkDir(r, workDir)
        if (!rel || HARVEST_SKIP_RE.test(rel)) continue
        if (!out.has(rel)) out.set(rel, { path: rel, reason, hint })
      }
    }
  }
  return [...out.values()]
}

const COMPLETER_SYSTEM_PROMPT = `You curate a project knowledge base that lets a coding agent avoid re-exploring the same code every session.

The knowledge base has three pieces:
- DRILL_DOWN_TREE.md — a LEAN index. ONE entry per knowledge AREA (a domain or feature such as "Collection", "CIBIL & Bureau", "Disbursement"). Each entry is ONLY a pointer to that area's doc plus a one-line description. It contains NO source-file paths.
- One distilled doc per area — this is where detail lives: how the area works AND a "## Key Files" section mapping each source file to its use case.
- A per-file map (path → one-line purpose + key symbols). You never write this file directly: you emit a FILES section and the system maintains the map.

You may be given any of:
1. The recent conversation (what the user wanted, the tools that ran, the files explored).
2. The agent's conclusions — its own final analysis this turn. This is the most distilled knowledge available; prefer it over guessing from code excerpts.
3. The list of EXISTING areas already in the knowledge base.
4. NEW files explored this turn that the file map does not know yet, with evidence (head/diff excerpts).
5. STALE files — mapped before, but their content has changed; their previously recorded purpose is shown alongside current evidence.
6. QUEUED files — explored in earlier turns but never documented, with fresh head excerpts.
7. UPDATE mode: the CURRENT TEXT of one or more existing area docs this turn's work touched.
8. The current DRILL_DOWN_TREE.md.

Your job: capture what was learned this turn so next time the agent can skip the exploration.

Output EXACTLY this structure and nothing else (FILES first, then 0 to ${MAX_AREAS_PER_TURN} AREA blocks):

## FILES
src/path/one.ts | one-line purpose, <=140 chars | symbolA, symbolB
src/path/two.ts | one-line purpose | symbolC

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
## END

Rules:
- FILES: one line per listed file (NEW, STALE, or QUEUED) whose purpose you can ground in the evidence or the agent's conclusions. Use ONLY paths from the provided lists, exactly as written — NEVER invent or alter a path. Purpose <=140 chars. Up to 8 key symbols (exported functions/classes/types visible in the evidence); leave the symbols segment empty if unknown.
- AREA blocks: 0 to ${MAX_AREAS_PER_TURN}, one per genuinely distinct domain touched this turn — most turns need exactly ONE. Repeat the full "## AREA ... ## END" structure for each.
- REUSE by default. If the files plausibly belong to one of the EXISTING areas, REUSE that area's EXACT name, character-for-character — do NOT invent a near-duplicate. Singular/plural and near-synonym variants (e.g. "Collection" vs "Collections") are the SAME area, never a new one. Create a NEW area ONLY when none of the existing ones fit.
- The TREE entry is ONLY the doc pointer + a one-line summary. NEVER put source-file paths in the tree.
- Put EVERY source-file path inside the DOC's "## Key Files" section, one per line as: \`path/to/file.ext\` — its use case. Always write the FULL workspace-relative path (with directories), never a bare filename.
- Ground every claim in the provided evidence or the agent's conclusions. Do NOT invent behaviour, endpoints, or files.
- UPDATE mode (an area doc's CURRENT TEXT is provided): output that area's AREA block as an IMPROVED rewrite — correct statements the evidence contradicts, deepen Notes with this turn's findings, refresh Key Files lines for STALE files, and keep everything still accurate. Do not merely restate the old text.
- Each doc is a distilled SUMMARY (responsibilities, key flows, gotchas) plus Key Files — NOT a copy of the code. Keep it under ~120 lines.
- If nothing reusable was learned, output exactly: ## SKIP`

export interface CompleterFileLine {
  path: string
  purpose: string
  symbols: string[]
}

export interface CompleterAreaBlock {
  name: string
  doc: string
  summary: string
  body: string
}

// Parse the completer model's response: a "## FILES" section of `path |
// purpose | symbols` lines plus 0..N "## AREA" blocks. Tolerant by design —
// a malformed block is dropped (and counted by the caller) without sinking
// the valid ones, and FILES alone is a useful result.
export function parseCompleterResponse(text: string): {
  files: CompleterFileLine[]
  areas: CompleterAreaBlock[]
  skip: boolean
  droppedAreas: number
} {
  const skip = /^##\s*SKIP\s*$/m.test(text)

  const files: CompleterFileLine[] = []
  let inFiles = false
  for (const line of text.split("\n")) {
    if (/^##\s*FILES\s*$/.test(line.trim())) {
      inFiles = true
      continue
    }
    if (/^##\s/.test(line)) {
      inFiles = false
      continue
    }
    if (!inFiles) continue
    const t = line.trim().replace(/^[-*]\s+/, "")
    if (!t) continue
    const segs = t.split("|").map((s) => s.trim())
    if (segs.length < 2) continue
    const p = segs[0].replace(/^`+|`+$/g, "").trim()
    const purpose = segs[1] ?? ""
    if (!p || !purpose || /\s/.test(p)) continue
    const symbols = (segs[2] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, FileMap.MAX_SYMBOLS)
    files.push({ path: p, purpose, symbols })
  }

  const areas: CompleterAreaBlock[] = []
  let droppedAreas = 0
  const chunks = text.split(/^##\s*AREA\s*$/m).slice(1)
  for (const chunk of chunks) {
    if (areas.length >= MAX_AREAS_PER_TURN) break
    const nameM = chunk.match(/^name:\s*(.+)$/m)
    const docM = chunk.match(/^doc:\s*(.+)$/m)
    const sumM = chunk.match(/^summary:\s*(.+)$/m)
    const bodyM = chunk.match(/##\s*DOC\s*\n([\s\S]*?)(?:\n##\s*END|$)/)
    const body = bodyM?.[1]?.trim() ?? ""
    if (!nameM?.[1]?.trim() || !docM?.[1]?.trim() || !sumM?.[1]?.trim() || !body) {
      droppedAreas++
      continue
    }
    areas.push({ name: nameM[1].trim(), doc: docM[1].trim(), summary: sumM[1].trim(), body })
  }

  return { files, areas, skip, droppedAreas }
}

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
        completerRuns: 0,
        areaEnrichedAtRun: {},
      })
    )

    const getWorkDir = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      return ctx.directory
    })

    // Build the in-memory search index from the current tree + its docs. Reads
    // each doc once (and the file map), then hands off to the pure builder.
    const buildIndex = (workDir: string, treeContent: string) =>
      Effect.gen(function* () {
        const docTexts = new Map<string, string>()
        for (const e of KB.parseTree(treeContent)) {
          if (e.entryPath.includes("..") || e.entryPath.startsWith("/")) continue
          const docPath = path.join(workDir, KB.KB_DIR_NAME, e.entryPath)
          const docText =
            (yield* fs.readFileStringSafe(docPath).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
          docTexts.set(e.entryPath, docText)
        }
        const fileByPath = yield* FileMap.loadFileMap(workDir).pipe(
          Effect.provideService(AppFileSystem.Service, fs),
        )
        return buildIndexPure(treeContent, docTexts, fileByPath)
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
      let fileBlock = ""
      let usedFollowup = false
      if (treeContent && treeContent.trim()) {
        let index = c.index
        if (!index || index.treeContent !== treeContent) {
          index = yield* buildIndex(workDir, treeContent)
          const built = index
          yield* InstanceState.useEffect(cache, (s) => Effect.sync(() => { s.index = built }))
          log.info("feeder index built", { areas: built.entries.length, paths: built.pathToEntries.size, files: built.files.length })
        }
        if (index) {
          // The file-map block answers "which file has what" directly; the area
          // docs share the remaining injection budget.
          fileBlock = renderFileMapBlock(matchFileMap(userText, index))
          const docsBudget = Math.max(1024, KB.MAX_INJECTION_BYTES - fileBlock.length)
          matchedEntries = matchEntries(userText, index)
          docs = assembleDocs(index, matchedEntries, docsBudget)
          if (!docs && extractQueryPaths(userText).length === 0) {
            // No direct match on a conceptual query. Carry the previous turn's
            // areas — a follow-up like "now refactor it" drops the original
            // keywords but is still about the same code. Bounded so stale context
            // can't ride along forever.
            if (c.lastMatched.length > 0 && c.followupCount < FOLLOWUP_REUSE_LIMIT) {
              const carried = assembleDocs(index, c.lastMatched, docsBudget)
              if (carried) {
                docs = carried
                matchedEntries = c.lastMatched
                usedFollowup = true
              }
            }
          }
          // Always leave the lean index visible when no doc matched: the agent
          // can route itself to a doc (or to FILE_MAP.jsonl) instead of giving up
          // and re-exploring from scratch.
          if (!docs) indexHint = assembleIndexHint(index)
          log.info("feeder matched", {
            entries: matchedEntries.length,
            matchedEntries,
            fileHits: fileBlock.length > 0,
            indexHint: indexHint.length > 0,
            usedFollowup,
          })
        }
      }

      const frontendHint = frontend
        ? "\n\n⚠️ CRITICAL INSTRUCTION: This is a frontend/UI/HTML/design request. " +
          "You MUST call the `skill` tool with parameter name='frontend-design' BEFORE you start coding or designing. " +
          "This will load the frontend-design skill instructions which are REQUIRED for this task. " +
          "Do not proceed with any design work, HTML generation, or code output until you have loaded this skill.\n"
        : ""

      if (!docs && !indexHint && !fileBlock && !frontendHint) {
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

      const areaSection = docs
        ? (usedFollowup
            ? "No new area matched this follow-up, so the areas from the previous turn are carried over. "
            : "Distilled knowledge already captured for areas relevant to this task. ") +
          "Use it to orient quickly. Each doc's \"Key Files\" section lists the source files — read them only if you need detail beyond the summary.\n" +
          `Matched areas: ${matchedEntries.join(", ")}\n` +
          docs
        : indexHint
          ? "No single area matched, but the project has a knowledge base. If an area below fits the task, read its doc under knowledge_base_world/ before exploring code (FILE_MAP.jsonl there maps file → purpose):\n" +
            indexHint
          : ""
      const kbSection =
        docs || indexHint || fileBlock
          ? ["## Project knowledge base", fileBlock, areaSection].filter(Boolean).join("\n")
          : ""
      const injection = kbSection + frontendHint

      log.info("feeder inject", {
        bytes: injection.length,
        entries: matchedEntries,
        fileBlock: fileBlock.length,
        hasFrontendHint: !!frontendHint,
      })

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
        fileBlockBytes: fileBlock.length,
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

      // What did this turn touch? Explored = tools with explicit path inputs;
      // searched = grep/glob result paths (no evidence — pending-queue fodder).
      const explored = collectExploredPaths(messages, workDir)
      const searched = collectSearchedPaths(messages, workDir)
      const fileMap = yield* FileMap.loadFileMap(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs))

      // Classify explored files against the file map: fresh (hash unchanged),
      // stale (mapped but content changed — includes files edited this turn), or
      // new (no map entry yet). A doc merely regex-mentioning a path no longer
      // counts as covered — that's thin knowledge and its map entry still needs
      // backfilling, which is how pre-FILE_MAP knowledge bases migrate.
      const mappedFresh = new Set<string>()
      const staleFiles: string[] = []
      const newFiles: string[] = []
      for (const f of explored) {
        const n = normalizePath(f)
        const entry = fileMap.get(n)
        if (!entry) {
          newFiles.push(n)
          continue
        }
        const h = entry.hash
          ? yield* FileMap.hashWorkspaceFile(workDir, n).pipe(Effect.provideService(AppFileSystem.Service, fs))
          : null
        if (h && h === entry.hash) mappedFresh.add(n)
        else staleFiles.push(n)
      }

      // Redundancy: re-reads of files the map already knows — the waste this
      // system exists to drive down. Logged before any gate so skipped turns
      // (where redundancy is highest) are measured too.
      const reads = collectReadRels(messages, workDir)
      if (reads.length > 0) {
        const knownReads = reads.filter((r) => mappedFresh.has(normalizePath(r))).length
        yield* KnowledgeLog.append(sessionID, {
          phase: "completer",
          action: "redundancy",
          reads: reads.length,
          knownReads,
        }).pipe(Effect.ignore)
      }

      if (explored.length === 0 && searched.length === 0) {
        log.info("completer no files explored, skipping")
        yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "no-files-explored" }).pipe(Effect.ignore)
        return
      }

      // Grounding: only files with real evidence this turn (a read preview or
      // an edit/write diff) can be documented now; the rest goes to the queue.
      const candidates = new Set([...newFiles, ...staleFiles])
      const evidence = collectFileEvidence(messages, workDir, candidates)
      const groundedNew = newFiles.filter((f) => evidence.has(f))
      const groundedStale = staleFiles.filter((f) => evidence.has(f))

      const finalText = collectFinalText(messages)
      const toolCalls = countCompletedToolCalls(messages)

      // Enrichment: a turn that produced real analysis — or touched stale files —
      // should deepen/refresh the existing docs instead of skipping forever.
      // Targets are the areas of the involved files, minus any area enriched too
      // recently (cooldown) so docs don't thrash within a session.
      const c0 = yield* InstanceState.get(cache)
      const cooldownOk = (area: string) => {
        const at = c0.areaEnrichedAtRun[area]
        return at === undefined || c0.completerRuns - at >= ENRICH_COOLDOWN_RUNS
      }
      const areasOf = (paths: Iterable<string>) => {
        const out: string[] = []
        for (const p of paths) {
          const area = fileMap.get(normalizePath(p))?.area
          if (area && !out.includes(area)) out.push(area)
        }
        return out
      }
      const insightTurn = finalText.length >= INSIGHT_TEXT_MIN && toolCalls >= INSIGHT_TOOL_CALLS_MIN
      const enrichAreas =
        groundedStale.length > 0 || insightTurn
          ? [...new Set([...areasOf(groundedStale), ...(insightTurn ? areasOf(mappedFresh) : [])])]
              .filter(cooldownOk)
              .slice(0, MAX_ENRICH_AREAS)
          : []

      const hasMainWork = groundedNew.length > 0 || groundedStale.length > 0 || enrichAreas.length > 0

      // Persist what this turn could NOT document — ungrounded files and
      // search-only discoveries — so a later turn picks them up. Lock-free.
      const nowIso = new Date().toISOString()
      const enqueue: Queue.QueueEntry[] = []
      const queuedSeen = new Set<string>()
      const pushQ = (p: string, reason: Queue.QueueReason, hint?: string) => {
        const n = normalizePath(p)
        if (!n || queuedSeen.has(n) || mappedFresh.has(n)) return
        queuedSeen.add(n)
        enqueue.push({ path: n, reason, hint, sessionID, time: nowIso })
      }
      for (const f of newFiles) if (!evidence.has(f)) pushQ(f, "overflow")
      for (const f of staleFiles) if (!evidence.has(f)) pushQ(f, "stale")
      for (const s of searched) {
        if (candidates.has(s.path) || fileMap.has(s.path)) continue
        pushQ(s.path, s.reason, s.hint)
      }
      if (enqueue.length > 0) yield* Queue.appendPending(workDir, enqueue)

      if (groundedNew.length > 0 || groundedStale.length > 0) {
        log.info("completer gap detected", { groundedNew, groundedStale })
        yield* KnowledgeLog.append(sessionID, {
          phase: "completer",
          action: "gap-detected",
          newFiles: groundedNew,
          stale: groundedStale,
          grounded: groundedNew.length + groundedStale.length,
        }).pipe(Effect.ignore)
      }

      const acquired = yield* KB.acquireLock(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      if (!acquired) {
        // Don't lose this turn's documentable work — park it for a later turn.
        const parked = [...groundedNew, ...groundedStale].map(
          (p): Queue.QueueEntry => ({ path: p, reason: "lock-held", sessionID, time: nowIso }),
        )
        if (parked.length > 0) yield* Queue.appendPending(workDir, parked)
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

        // Drain the pending backlog: alongside main work a few entries ride in
        // the same call; with no main work a solo call only runs once the
        // backlog is deep enough to be worth a model invocation.
        const drained = yield* Queue.drainPending(workDir, {
          max: hasMainWork ? QUEUE_DRAIN_MAIN : QUEUE_DRAIN_SOLO,
          min: hasMainWork ? 1 : MIN_QUEUE_SOLO,
          exclude: (p) => mappedFresh.has(p) || candidates.has(p),
        }).pipe(Effect.provideService(AppFileSystem.Service, fs))
        const queued: { path: string; head: string; hint?: string }[] = []
        for (const q of drained) {
          // Re-read a fresh head as evidence; unreadable files were already
          // removed from the queue, so they self-clean.
          const head = yield* fs
            .readFileStringSafe(path.join(workDir, q.path))
            .pipe(Effect.orElseSucceed(() => undefined))
          if (head && head.trim()) queued.push({ path: q.path, head: head.slice(0, EVIDENCE_PER_FILE_BYTES), hint: q.hint })
        }

        if (!hasMainWork && queued.length === 0) {
          const reason =
            explored.length === 0
              ? "queued-only"
              : newFiles.length + staleFiles.length === 0
                ? "all-covered"
                : "no-evidence"
          log.info("completer nothing to document, skipping", { reason, explored: explored.length, enqueued: enqueue.length })
          yield* KnowledgeLog.append(sessionID, {
            phase: "completer",
            action: "skip",
            reason,
            explored: explored.length,
            enqueued: enqueue.length,
          }).pipe(Effect.ignore)
          return
        }

        // Enrichment targets: the current doc text for areas this turn touched,
        // shown to the model so it rewrites them improved instead of from scratch.
        const enrichDocs: { area: string; text: string }[] = []
        for (const area of enrichAreas) {
          const rel = docPathForArea(treeContent, area)
          if (!rel) continue
          const docText = yield* fs
            .readFileStringSafe(path.join(workDir, KB.KB_DIR_NAME, rel))
            .pipe(Effect.orElseSucceed(() => undefined))
          if (docText && docText.trim()) enrichDocs.push({ area, text: KB.fitDoc(docText, ENRICH_DOC_CAP) })
        }

        const history = formatHistorySnippet(messages, workDir)
        // Canonical area names already in the tree, surfaced to the model so it
        // reuses an exact existing name instead of minting a near-duplicate.
        const existingAreas = [...treeContent.matchAll(/^##\s+(.+?)\s*$/gm)]
          .map((m) => m[1].trim())
          .filter((nm) => nm.toLowerCase() !== "skip")

        const evidenceFor = (files: string[]) =>
          files
            .map((f) => {
              const ex = evidence.get(f)
              return ex ? `\n${f}\n\`\`\`\n${ex}\n\`\`\`` : ""
            })
            .filter(Boolean)
            .join("\n")

        const sections: string[] = []
        sections.push(`Recent conversation:\n${history}`)
        if (finalText)
          sections.push(
            `Agent's conclusions this turn (the most distilled knowledge available — prefer it over guessing from code excerpts):\n${finalText}`,
          )
        if (existingAreas.length)
          sections.push(
            `Existing areas (REUSE the EXACT name if files plausibly belong to one):\n${existingAreas.map((a) => `- ${a}`).join("\n")}`,
          )
        if (groundedNew.length)
          sections.push(
            `NEW files explored this turn, not yet in the file map:\n${groundedNew.map((f) => `- ${f}`).join("\n")}\n\n` +
              `Evidence (head/diff excerpts captured this turn — ground every claim in these):${evidenceFor(groundedNew)}`,
          )
        if (groundedStale.length)
          sections.push(
            `STALE files — mapped before, but their content changed (refresh their purpose and Key Files lines):\n${groundedStale
              .map((f) => `- ${f} (previously: ${fileMap.get(f)?.purpose || "unknown"})`)
              .join("\n")}\n\nEvidence:${evidenceFor(groundedStale)}`,
          )
        // Session change ledger: enclosing symbols from this session's edit
        // hunks — cheap, precise evidence of WHAT changed in involved files.
        const ledger = yield* ChangeLedger.read(sessionID)
        const ledgerLines: string[] = []
        for (const entry of Object.values(ledger)) {
          if (ledgerLines.length >= 10) break
          const rel = toRelUnderWorkDir(entry.absFile, workDir)
          if (!rel) continue
          const n = normalizePath(rel)
          if (!candidates.has(n) && !mappedFresh.has(n)) continue
          ledgerLines.push(
            `- ${n}: +${entry.additions}/-${entry.deletions} over ${entry.ops} edit(s)${entry.summary ? ` — ${entry.summary}` : ""}`,
          )
        }
        if (ledgerLines.length)
          sections.push(`Files edited this session (change ledger — enclosing symbols from diff hunks):\n${ledgerLines.join("\n")}`)
        if (queued.length)
          sections.push(
            `QUEUED files — explored in earlier turns but never documented; map them now:` +
              queued.map((q) => `\n${q.path}${q.hint ? ` (${q.hint})` : ""}\n\`\`\`\n${q.head}\n\`\`\``).join(""),
          )
        for (const d of enrichDocs)
          sections.push(
            `CURRENT doc for area "${d.area}" (UPDATE mode — output an improved rewrite of this area):\n\`\`\`\n${d.text}\n\`\`\``,
          )
        sections.push(`Current DRILL_DOWN_TREE.md:\n${treeContent}`)
        sections.push(`Capture what was learned this turn, following the rules.`)
        const prompt = sections.join("\n\n")

        // Count model invocations — drives the enrichment cooldown.
        yield* InstanceState.useEffect(cache, (s) => Effect.sync(() => { s.completerRuns += 1 }))

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
          // The drained queue entries were never processed — put them back.
          if (drained.length > 0) yield* Queue.appendPending(workDir, drained)
          yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "empty-response" }).pipe(Effect.ignore)
          return
        }
        log.info("completer response", { bytes: text.length })

        const parsed = parseCompleterResponse(text)
        if (parsed.areas.length === 0 && parsed.files.length === 0) {
          if (parsed.skip) {
            // The model judged there was nothing reusable — drained entries are
            // dropped deliberately (requeueing would retry them forever).
            log.info("completer skip")
            yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "model-skip" }).pipe(Effect.ignore)
          } else {
            if (drained.length > 0) yield* Queue.appendPending(workDir, drained)
            log.warn("completer unparseable response", { bytes: text.length })
            yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "unparseable", bytes: text.length }).pipe(Effect.ignore)
          }
          return
        }

        // ---- AREA blocks: validate + write each doc, fold into the tree once.
        let currentTree = treeContent
        const writtenAreas: string[] = []
        const writtenBlocks: { name: string; body: string }[] = []
        const enriched: string[] = []
        for (const block of parsed.areas) {
          // Merge near-duplicate area names (Collection/Collections/case
          // variants) into the existing area so the tree keeps ONE entry per domain.
          const areaName = KB.resolveCanonicalArea(currentTree, block.name)
          const namesNow = [...currentTree.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim())
          const reusing = namesNow.some((a) => a.toLowerCase() === areaName.toLowerCase())
          let docRel = block.doc.replace(/^\/+/, "")
          if (!areaName || docRel.includes("..") || !docRel.toLowerCase().endsWith(".md")) {
            log.warn("completer invalid doc path", { docRel })
            yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "invalid-doc-path", docRel }).pipe(Effect.ignore)
            continue
          }
          // When reusing an existing area, write to its current doc path so we
          // never orphan it — the tree pointer wins over the model's proposal.
          if (reusing) {
            const existingDocRel = docPathForArea(currentTree, areaName)
            if (existingDocRel) docRel = existingDocRel
          }
          // Keep the written doc path identical to the tree entry path so the
          // feeder can find it: parseTree resolves a slash-less name under its
          // area folder, so we ensure the doc lives under that same folder.
          if (!docRel.includes("/")) {
            const folder = areaName.replace(/[^a-zA-Z0-9]+/g, "") || "Area"
            docRel = `${folder}/${docRel}`
          }
          // Rewrite any bare-filename Key Files to full paths so coverage
          // detection (which needs a slash) sees them.
          const docBody = normalizeKeyFilePaths(block.body, [...candidates])

          const kbRelPath = `${KB.KB_DIR_NAME}/${docRel}`
          if (!KB.isKbPathSafe(workDir, kbRelPath)) {
            log.warn("completer unsafe doc path rejected", { docRel })
            yield* KnowledgeLog.append(sessionID, { phase: "completer", action: "skip", reason: "unsafe-doc-path", docRel }).pipe(Effect.ignore)
            continue
          }

          const fullPath = path.join(workDir, kbRelPath)
          yield* fs.ensureDir(path.dirname(fullPath)).pipe(Effect.orElseSucceed(() => {}))
          // Reusing an area? Merge with its previous doc so earlier Key Files
          // the model didn't see this turn are preserved rather than clobbered.
          const existingDoc = reusing
            ? yield* fs.readFileStringSafe(fullPath).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          let finalBody = existingDoc && existingDoc.trim() ? KB.mergeAreaDoc(existingDoc, docBody) : docBody
          // Section-aware compaction — never a mid-text slice.
          if (finalBody.length > KB.MAX_DOC_BYTES) finalBody = KB.fitDoc(finalBody, KB.MAX_DOC_BYTES)
          yield* fs.writeFileString(fullPath, finalBody).pipe(Effect.orElseSucceed(() => {}))
          log.info("completer wrote doc", { docRel, reusing, merged: !!(existingDoc && existingDoc.trim()) })

          currentTree = KB.upsertAreaSection(currentTree, areaName, `- **${docRel}** — ${block.summary}`)
          writtenAreas.push(areaName)
          writtenBlocks.push({ name: areaName, body: docBody })
          if (enrichDocs.some((d) => d.area.toLowerCase() === areaName.toLowerCase())) enriched.push(areaName)
        }

        const treeChanged = currentTree.trim() !== treeContent.trim()
        if (treeChanged) {
          yield* fs
            .writeFileString(path.join(workDir, KB.KB_DIR_NAME, KB.DRILL_DOWN_FILENAME), currentTree)
            .pipe(Effect.orElseSucceed(() => {}))
          log.info("completer updated tree", { areas: writtenAreas })
        }

        // ---- FILES section → file map. Paths are validated against what this
        // turn actually saw; anything else is a hallucination and is dropped.
        const allowed = new Set<string>([...candidates, ...queued.map((q) => q.path)])
        const accepted: { path: string; purpose: string; symbols: string[] }[] = []
        let rejectedFiles = 0
        for (const f of parsed.files) {
          const rel = toRelUnderWorkDir(f.path, workDir)
          const n = rel ? normalizePath(rel) : null
          if (n && allowed.has(n)) accepted.push({ path: n, purpose: f.purpose, symbols: f.symbols })
          else rejectedFiles++
        }
        if (accepted.length > 0) {
          const areaFor = (p: string): string => {
            for (const b of writtenBlocks) if (b.body.includes(p)) return b.name
            return fileMap.get(p)?.area || writtenAreas[0] || ""
          }
          const updates: FileMap.FileMapUpdate[] = []
          for (const a of accepted) {
            const hash = yield* FileMap.hashWorkspaceFile(workDir, a.path).pipe(
              Effect.provideService(AppFileSystem.Service, fs),
            )
            updates.push({
              path: a.path,
              purpose: a.purpose,
              symbols: a.symbols,
              area: areaFor(a.path),
              hash: hash ?? undefined,
            })
          }
          FileMap.upsertEntries(fileMap, updates, nowIso)
          yield* FileMap.saveFileMap(workDir, fileMap).pipe(Effect.provideService(AppFileSystem.Service, fs))
          log.info("completer mapped files", { mapped: accepted.length, rejected: rejectedFiles })
        }

        if (writtenAreas.length === 0 && accepted.length === 0) {
          if (drained.length > 0) yield* Queue.appendPending(workDir, drained)
          log.warn("completer response produced no usable output", { rejectedFiles, droppedAreas: parsed.droppedAreas })
          yield* KnowledgeLog.append(sessionID, {
            phase: "completer",
            action: "skip",
            reason: "unparseable",
            bytes: text.length,
            rejectedFiles,
            droppedAreas: parsed.droppedAreas,
          }).pipe(Effect.ignore)
          return
        }

        // Fresh knowledge is on disk — make the in-session feeder see it, and
        // start the enrichment cooldown for rewritten areas.
        yield* InstanceState.useEffect(cache, (s) =>
          Effect.sync(() => {
            s.index = null
            for (const a of enriched) s.areaEnrichedAtRun[a] = s.completerRuns
          }),
        )

        const action = writtenAreas.length > 1 ? "write-multi" : writtenAreas.length === 1 ? "write" : "map-only"
        yield* KnowledgeLog.append(sessionID, {
          phase: "completer",
          action,
          areas: writtenAreas,
          enriched,
          treeChanged,
          mapped: accepted.length,
          rejectedFiles,
          droppedAreas: parsed.droppedAreas,
          queuedDrained: queued.length,
          files: [...groundedNew, ...groundedStale],
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
          s.completerRuns = 0
          s.areaEnrichedAtRun = {}
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

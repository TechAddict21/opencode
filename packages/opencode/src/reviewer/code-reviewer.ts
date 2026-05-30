import path from "path"
import fs from "fs/promises"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { serviceUse } from "@/effect/service-use"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import * as Log from "@nous-ai/core/util/log"
import * as Stream from "effect/Stream"
import { Effect, Layer, Context, Schema, Option, Duration } from "effect"
import { LLMEvent, Usage } from "@nous-ai/llm"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { Snapshot } from "@/snapshot"
import { Session } from "@/session/session"
import { ReviewLog } from "./review-log"
import PROMPT_FRONTEND from "./prompts/frontend.txt"
import PROMPT_BACKEND from "./prompts/backend.txt"
import PROMPT_DATABASE from "./prompts/database.txt"
import PROMPT_CONFIG from "./prompts/config.txt"
import PROMPT_GENERAL from "./prompts/general.txt"
import PROMPT_NESTJS from "./prompts/nestjs.txt"
import PROMPT_REACT_VITE from "./prompts/react-vite.txt"
import PROMPT_POSTGRESQL from "./prompts/postgresql.txt"
import PROMPT_CACHING from "./prompts/caching.txt"
import PROMPT_SECURITY from "./prompts/security.txt"
import PROMPT_DESIGN from "./prompts/design.txt"
import PROMPT_FUNCTIONAL from "./prompts/functional.txt"
import PROMPT_CURL from "./prompts/curl.txt"
import PROMPT_TRIAGE from "./prompts/triage.txt"
import PROMPT_FULL_STACK_FIXER from "./prompts/full-stack-fixer.txt"
import { extractJsonObject } from "./util"

const log = Log.create({ service: "code-reviewer" })

export const CodeReviewResult = Schema.Struct({
  need_changes: Schema.Boolean,
  feedback: Schema.String,
  refined_response: Schema.String,
}).annotate({ identifier: "CodeReviewResult" })

export type CodeReviewResult = Schema.Schema.Type<typeof CodeReviewResult>

type Category =
  | "frontend"
  | "backend"
  | "database"
  | "config"
  | "general"
  | "nestjs"
  | "react_vite"
  | "postgresql"
  | "caching"
  | "security"
  | "design"
  | "functional"
  | "curl"

// Short, human-readable summary of what each reviewer covers — fed to the
// triage decision-maker so it can route to the right specialists.
const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  frontend: "Generic frontend (HTML/CSS/JS/Vue/Svelte) correctness & best practices",
  backend: "Server-side logic, routes/controllers/services, error handling, data flow",
  database: "ORM/migrations/schema (Prisma/Drizzle/TypeORM/Knex/Sequelize)",
  config: "Build/infra/tooling config (docker, CI, tsconfig, package.json, env, lint)",
  general: "General code correctness for files no specialist covers",
  nestjs: "NestJS modules/controllers/services/guards/pipes/DTOs idioms",
  react_vite: "React + Vite: hooks rules, state, effects, rendering, router/store",
  postgresql: "PostgreSQL/SQL queries, indexes, transactions, schema correctness",
  caching: "Redis/cache/queues: TTL, invalidation, stampede, consistency",
  security: "Auth, crypto, secrets, input validation, access control, injection",
  design: "UI/UX visual quality & banned AI-slop tells (sparkle/bot/emoji icons)",
  functional: "UI functional completeness: dead controls, missing data layer, no-op handlers",
  curl: "Live API testing via curl for new/changed endpoints & business logic",
}

// Triage decision: which specialists (if any) actually apply to THIS turn's diff.
const TriageResult = Schema.Struct({
  need_review: Schema.Boolean,
  categories: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "TriageResult" })

// A single file's change for THIS turn, with its diff text already resolved.
interface Change {
  file: string
  status: "added" | "modified"
  diff: string
}

interface TokenSummary {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  total?: number
}

function toTokens(u: {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadInputTokens?: number
  totalTokens?: number
}): TokenSummary {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    reasoning: u.reasoningTokens,
    cacheRead: u.cacheReadInputTokens,
    total: u.totalTokens,
  }
}

// Cost + normalized token counts for a reviewer call, shaped like a
// step-finish part so it can be rolled into the session cumulative total.
export type Account = ReturnType<typeof Session.getUsage>

const EMPTY_ACCOUNT: Account = {
  cost: 0,
  tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

function addAccount(a: Account, b: Account): Account {
  return {
    cost: a.cost + b.cost,
    tokens: {
      total: (a.tokens.total ?? 0) + (b.tokens.total ?? 0),
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cache: {
        read: a.tokens.cache.read + b.tokens.cache.read,
        write: a.tokens.cache.write + b.tokens.cache.write,
      },
    },
  }
}

interface StreamOutcome {
  text: string
  tokens?: TokenSummary
  account?: Account
  durationMs: number
  error?: string
}

interface FileGroup {
  category: Category
  changes: Change[]
  prompt: string
  agentName: string
  // Optional extra text injected into the prompt's {curl_context} placeholder
  // (used by the curl lens to pass current CURL_TESTING.md contents).
  context?: string
  // Set when a large category was split — e.g. "2/4" — for logging + merge.
  batchLabel?: string
}

// Holistic lenses must see ALL their files together (they reason across files),
// so they are never split into batches. Per-file code experts ARE batched.
const HOLISTIC_CATEGORIES = new Set<Category>(["design", "functional", "curl"])

// Split big per-category expert groups into batches of `size` so no single
// reviewer call gets more than `size` files. Holistic lenses pass through whole.
function batchGroups(groups: FileGroup[], size: number): FileGroup[] {
  if (size <= 0) return groups
  const out: FileGroup[] = []
  for (const g of groups) {
    if (HOLISTIC_CATEGORIES.has(g.category) || g.changes.length <= size) {
      out.push(g)
      continue
    }
    const total = Math.ceil(g.changes.length / size)
    for (let i = 0; i < total; i++) {
      out.push({ ...g, changes: g.changes.slice(i * size, i * size + size), batchLabel: `${i + 1}/${total}` })
    }
  }
  return out
}

export interface Interface {
  readonly review: (input: {
    sessionID: SessionID
    directory: string
    user: MessageV2.User
    model: Provider.Model
    userRequirement: string
    // Working-tree snapshot captured at the START of this user turn. When set,
    // the review is scoped to changes made during the turn (diff baseline→now).
    // When absent (snapshots disabled), falls back to a whole-tree diff vs HEAD.
    baselineSnapshot?: string
  }) => Effect.Effect<{ result: CodeReviewResult | null; usage?: Account }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeReviewer") {}

export const use = serviceUse(Service)

function categorizeFile(file: string): Category {
  const lower = file.toLowerCase()
  const ext = lower.split(".").pop() || ""

  // Check framework-specific patterns FIRST to avoid false positives

  // NESTJS: Check NestJS-specific patterns before generic patterns
  if (
    lower.includes("nestjs") ||
    lower.includes("@nestjs") ||
    lower.includes(".module.ts") ||
    lower.includes(".controller.ts") ||
    lower.includes(".service.ts") ||
    lower.includes(".guard.ts") ||
    lower.includes(".interceptor.ts") ||
    lower.includes(".pipe.ts") ||
    lower.includes(".middleware.ts") ||
    lower.includes(".filter.ts") ||
    lower.includes(".decorator.ts") ||
    lower.endsWith("dto.ts") ||
    lower.endsWith(".dto.ts") ||
    lower.includes("/dto/") ||
    lower.includes("/dtos/") ||
    lower.includes("/modules/") ||
    lower.includes("/decorators/") ||
    lower.includes("/pipes/") ||
    lower.includes("/interceptors/") ||
    lower.includes("/filters/") ||
    lower.includes("/entities/")
  ) {
    return "nestjs"
  }

  // REACT_VITE: React and Vite-specific files
  if (
    lower.includes("vite.config") ||
    lower.includes("/vite/") ||
    lower.includes("react-router") ||
    lower.includes("tanstack") ||
    lower.includes("zustand") ||
    lower.includes("redux") ||
    lower.includes("/store/") ||
    lower.includes("/stores/") ||
    lower.includes("/context/") ||
    lower.includes("/providers/") ||
    lower.includes("/router/") ||
    lower.includes(".tsx") ||
    (lower.includes("/components/") && ext === "tsx") ||
    (lower.includes("/hooks/") && ext === "ts") ||
    lower.includes("useeffect") ||
    lower.includes("usestate") ||
    lower.includes("usecallback")
  ) {
    return "react_vite"
  }

  // CACHING: Redis, cache manager, memoization
  if (
    lower.includes("redis") ||
    lower.includes("cache-manager") ||
    lower.includes("lru-cache") ||
    lower.includes("memoize") ||
    lower.includes("/cache/") ||
    lower.includes("ttl") ||
    lower.includes("expire") ||
    lower.includes("invalidate") ||
    lower.includes("stale-while") ||
    lower.includes("bull") ||
    lower.includes("queue") ||
    lower.includes("bullmq")
  ) {
    return "caching"
  }

  // POSTGRESQL: SQL and PostgreSQL-specific
  if (
    lower.endsWith(".sql") ||
    lower.includes("postgresql") ||
    lower.includes("postgres") ||
    lower.includes("/sql/") ||
    lower.includes("prisma/schema") ||
    lower.includes("drizzle/schema") ||
    lower.includes("typeorm/entity") ||
    lower.includes("/queries/") ||
    lower.includes("/query/") ||
    lower.includes("knexfile") ||
    lower.includes("pg-") ||
    lower.includes("/seeds/") ||
    lower.includes("/seeders/")
  ) {
    return "postgresql"
  }

  // FRONTEND: General frontend files
  if (
    ["html", "htm", "css", "scss", "sass", "less", "js", "jsx", "vue", "svelte", "svg", "png", "jpg", "jpeg", "gif", "webp"].includes(ext) ||
    lower.includes("/styles/") ||
    lower.includes("/assets/") ||
    lower.includes("/public/") ||
    lower.includes("/ui/") ||
    lower.includes("tailwind") ||
    lower.includes("/widgets/") ||
    lower.includes("/modals/") ||
    lower.includes("/forms/") ||
    lower.includes("/layout")
  ) {
    return "frontend"
  }

  // DATABASE: Generic database files (not PostgreSQL-specific)
  if (
    lower.includes("/migration") ||
    lower.includes("/migrations/") ||
    lower.includes("/schema") ||
    lower.includes("/schemas/") ||
    lower.includes("/db/") ||
    lower.includes("/database/") ||
    lower.includes("drizzle") ||
    lower.includes("prisma") ||
    lower.includes("knex") ||
    lower.includes("sequelize") ||
    lower.includes("typeorm")
  ) {
    return "database"
  }

  // CONFIG: Infrastructure and tooling
  if (
    lower.includes("docker") ||
    lower.includes("dockerfile") ||
    lower.includes("/ci/") ||
    lower.includes("/.github/") ||
    lower.includes("/.gitlab/") ||
    lower.includes("/terraform/") ||
    lower.includes("/k8s/") ||
    lower.includes("/kubernetes/") ||
    lower.includes("nginx") ||
    lower.includes("webpack.config") ||
    lower.includes("rollup.config") ||
    lower.includes("tsconfig") ||
    lower.includes("package.json") ||
    lower.includes("bun.lock") ||
    lower.includes("yarn.lock") ||
    lower.includes("pnpm-lock") ||
    lower.includes("Makefile") ||
    lower.includes(".env") ||
    lower.includes("compose") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.includes("eslint") ||
    lower.includes("prettier") ||
    lower.includes("jest.config") ||
    lower.includes("vitest.config")
  ) {
    return "config"
  }

  // SECURITY: Only flag files that are SPECIFICALLY about security implementation
  // NOT generic files that happen to contain these words (like auth.service.ts)
  if (
    lower.includes("/security/") ||
    (lower.includes("/auth/") && (lower.includes("strategy") || lower.includes("protocol") || lower.includes("scheme"))) ||
    lower.includes("password-hash") ||
    lower.includes("bcrypt") ||
    lower.includes("argon2") ||
    lower.includes("csrf-protection") ||
    lower.includes("xss-filter") ||
    lower.includes("helmet-config") ||
    lower.includes("rate-limiter") ||
    lower.includes("throttle") ||
    lower.includes("sanitize-html") ||
    lower.includes("dompurify") ||
    lower.includes("crypto-") ||
    lower.includes("encryption-") ||
    lower.includes("jwt-strategy") ||
    lower.includes("oauth-config") ||
    lower.includes("ssl-") ||
    lower.includes("tls-")
  ) {
    return "security"
  }

  // BACKEND: Generic backend files
  if (
    lower.includes("/api/") ||
    lower.includes("/server/") ||
    lower.includes("/controller/") ||
    lower.includes("/controllers/") ||
    lower.includes("/service/") ||
    lower.includes("/services/") ||
    lower.includes("/route/") ||
    lower.includes("/routes/") ||
    lower.includes("/middleware/") ||
    lower.includes("/handler/") ||
    lower.includes("/handlers/") ||
    lower.includes("/endpoint/") ||
    lower.includes("/endpoints/") ||
    lower.includes("/resolver/") ||
    lower.includes("/resolvers/") ||
    lower.includes("/model/") ||
    lower.includes("/models/") ||
    lower.includes("/repository/") ||
    lower.includes("/repositories/") ||
    lower.includes("/lib/") ||
    lower.includes("/utils/") ||
    lower.includes("/util/") ||
    lower.includes("/helpers/") ||
    lower.includes("/core/") ||
    lower.includes("/effect/") ||
    lower.includes("/cli/") ||
    lower.includes("/cmd/") ||
    lower.includes("/command/")
  ) {
    return "backend"
  }

  return "general"
}

// UI-bearing files get an extra design/UX lens (in addition to their code
// category). Independent of categorizeFile, which assigns one category per file.
function isUIFile(file: string): boolean {
  const lower = file.toLowerCase()
  const ext = lower.split(".").pop() || ""
  if (["tsx", "jsx", "vue", "svelte", "html", "htm", "css", "scss", "sass", "less"].includes(ext)) return true
  return (
    lower.includes("/components/") ||
    lower.includes("/styles/") ||
    lower.includes("/pages/") ||
    lower.includes("/views/") ||
    lower.includes("/ui/") ||
    lower.includes("/layout")
  )
}

// Files that add or change observable API surface (HTTP/GraphQL endpoints or the
// business logic behind them) get an extra curl/API-test lens. Heuristic only.
function isAPIFile(file: string): boolean {
  const lower = file.toLowerCase()
  return (
    lower.includes(".controller.ts") ||
    lower.includes(".resolver.ts") ||
    lower.includes(".gateway.ts") ||
    lower.includes(".service.ts") ||
    lower.includes("/controllers/") ||
    lower.includes("/controller/") ||
    lower.includes("/routes/") ||
    lower.includes("/route/") ||
    lower.includes("/api/") ||
    lower.includes("/handlers/") ||
    lower.includes("/handler/") ||
    lower.includes("/endpoints/") ||
    lower.includes("/endpoint/") ||
    lower.includes("/resolvers/") ||
    lower.includes("/services/") ||
    lower.includes("/service/") ||
    lower.includes("openapi") ||
    lower.includes("swagger")
  )
}

function groupChangesByCategory(changes: Change[]): FileGroup[] {
  const groups = new Map<Category, Change[]>()

  for (const change of changes) {
    const category = categorizeFile(change.file)
    const existing = groups.get(category) || []
    existing.push(change)
    groups.set(category, existing)
  }

  const prompts: Record<Category, { prompt: string; agentName: string }> = {
    frontend: { prompt: PROMPT_FRONTEND, agentName: "frontend-reviewer" },
    backend: { prompt: PROMPT_BACKEND, agentName: "backend-reviewer" },
    database: { prompt: PROMPT_DATABASE, agentName: "database-reviewer" },
    config: { prompt: PROMPT_CONFIG, agentName: "config-reviewer" },
    general: { prompt: PROMPT_GENERAL, agentName: "general-reviewer" },
    nestjs: { prompt: PROMPT_NESTJS, agentName: "nestjs-expert-reviewer" },
    react_vite: { prompt: PROMPT_REACT_VITE, agentName: "react-vite-reviewer" },
    postgresql: { prompt: PROMPT_POSTGRESQL, agentName: "postgresql-reviewer" },
    caching: { prompt: PROMPT_CACHING, agentName: "caching-reviewer" },
    security: { prompt: PROMPT_SECURITY, agentName: "security-reviewer" },
    // `design`, `functional`, and `curl` are never produced by categorizeFile —
    // they are added as separate lenses in review(). Here for type completeness.
    design: { prompt: PROMPT_DESIGN, agentName: "ui-design-reviewer" },
    functional: { prompt: PROMPT_FUNCTIONAL, agentName: "ui-functional-reviewer" },
    curl: { prompt: PROMPT_CURL, agentName: "api-curl-tester" },
  }

  return [...groups.entries()]
    .map(([category, changes]) => ({
      category,
      changes,
      ...prompts[category],
    }))
    .filter((g) => g.changes.length > 0)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const git = yield* Git.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service

    // Run a single-shot reviewer/fixer LLM call, capturing the full text plus
    // token usage and wall-clock time for the audit log. Never fails — on
    // timeout/error it returns whatever was accumulated and an `error` string.
    const streamReviewer = Effect.fn("CodeReviewer.stream")(function* (req: {
      agentName: string
      system: string
      user: MessageV2.User
      model: Provider.Model
      sessionID: SessionID
      small: boolean
      content: string
      timeoutSeconds: number
    }) {
      const started = Date.now()
      let text = ""
      let rawUsage: Usage | undefined
      let error: string | undefined

      const reviewAgent: Agent.Info = {
        name: req.agentName,
        mode: "subagent",
        hidden: true,
        permission: [],
        options: {},
      }

      yield* llm
        .stream({
          agent: reviewAgent,
          user: req.user,
          system: [req.system],
          small: req.small,
          tools: {},
          model: req.model,
          sessionID: req.sessionID,
          retries: 0,
          messages: [{ role: "user", content: req.content }],
        })
        .pipe(
          Stream.runForEach((e) =>
            Effect.sync(() => {
              if (LLMEvent.is.textDelta(e)) text += e.text
              else if (LLMEvent.is.stepFinish(e)) {
                if (e.usage) rawUsage = e.usage
              } else if (LLMEvent.is.finish(e)) {
                if (e.usage) rawUsage = e.usage
              }
            }),
          ),
          Effect.timeout(Duration.seconds(req.timeoutSeconds)),
          Effect.catch((err: unknown) =>
            Effect.sync(() => {
              error = String(err)
            }),
          ),
        )

      // Account = cost + normalized tokens for the session cumulative; tokens =
      // a flat summary for the audit log.
      const account = rawUsage ? Session.getUsage({ model: req.model, usage: rawUsage }) : undefined
      const tokens = rawUsage ? toTokens(rawUsage) : undefined
      return { text, tokens, account, durationMs: Date.now() - started, error } satisfies StreamOutcome
    })

    // Cap any single file's diff so one huge file can't crowd out the others.
    const MAX_FILE_DIFF = 15_000

    // Context lines kept around each changed hunk in the review diff. The
    // snapshot's diffFull defaults to full-file context (needed for the TUI diff
    // view + summaries), but reviewers must see the ACTUAL edit — a few changed
    // lines in a 400-line file should be a few-line diff, not the whole file.
    // Otherwise triage misreads a tiny edit as a big change and every reviewer
    // wastes tokens re-reading unchanged code. 8 lines = enough to see the
    // enclosing function without dumping the file.
    const REVIEW_DIFF_CONTEXT = 8

    // Resolve the set of changes to review.
    //   Preferred: diff the turn-start snapshot against the current tree, so
    //   ONLY edits made during THIS user turn are reviewed (earlier uncommitted
    //   work is in the baseline and excluded).
    //   Fallback (snapshots disabled): whole working tree vs HEAD — not
    //   turn-scoped, but keeps the feature working.
    const collectChanges = Effect.fn("CodeReviewer.collectChanges")(function* (input: {
      directory: string
      baselineSnapshot?: string
    }) {
      if (input.baselineSnapshot) {
        const current = yield* snapshot.track().pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!current) return [] as Change[]
        const diffs = yield* snapshot
          .diffFull(input.baselineSnapshot, current, REVIEW_DIFF_CONTEXT)
          .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        return diffs
          .filter((d): d is Snapshot.FileDiff & { file: string } => Boolean(d.file) && d.status !== "deleted")
          .map(
            (d): Change => ({
              file: d.file,
              status: d.status === "added" ? "added" : "modified",
              diff: (d.patch ?? "").slice(0, MAX_FILE_DIFF),
            }),
          )
          .filter((c) => c.diff.trim().length > 0)
      }

      const hasHead = yield* git.hasHead(input.directory).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!hasHead) return [] as Change[]
      const status = yield* git.status(input.directory).pipe(Effect.catch(() => Effect.succeed([] as Git.Item[])))
      const modified = status.filter((i) => i.status === "modified" || i.status === "added")
      const out: Change[] = []
      for (const item of modified) {
        // Untracked files (porcelain "??") are invisible to `git diff HEAD`.
        const source =
          item.code === "??"
            ? git.patchUntracked(input.directory, item.file, { context: 3, maxOutputBytes: 100_000 })
            : git.patch(input.directory, "HEAD", item.file, { context: 3, maxOutputBytes: 100_000 })
        const patch = yield* source.pipe(
          Effect.catch(() => Effect.succeed({ text: "", truncated: false } as Git.Patch)),
        )
        if (patch.text.trim()) {
          out.push({
            file: item.file,
            status: item.status === "added" ? "added" : "modified",
            diff: patch.text.slice(0, MAX_FILE_DIFF),
          })
        }
      }
      return out
    })

    // Master decision-maker: a single fast call that looks at the user's
    // request + the actual diff and decides which specialist reviewers (if any)
    // are worth running. Gates out trivial edits (null guards, typos, renames)
    // and prunes irrelevant specialists so a one-line change doesn't summon a
    // full panel. Returns the kept category set; null/empty means "skip review".
    const runTriage = Effect.fn("CodeReviewer.triage")(function* (input: {
      sessionID: SessionID
      user: MessageV2.User
      model: Provider.Model
      candidates: Category[]
      changes: Change[]
      userRequirement: string
      timeoutSeconds: number
    }) {
      const candidateList = input.candidates
        .map((c) => `- ${c}: ${CATEGORY_DESCRIPTIONS[c]}`)
        .join("\n")

      // Keep the triage diff compact — it only needs to recognize the SHAPE of
      // the change, not review it line by line.
      const TRIAGE_DIFF_BUDGET = 24_000
      const perFile = Math.max(600, Math.floor(TRIAGE_DIFF_BUDGET / Math.max(1, input.changes.length)))
      const diff = input.changes
        .map((c) => {
          const body = c.diff.length > perFile ? c.diff.slice(0, perFile) + "\n… [diff truncated]" : c.diff
          return `--- ${c.file} (${c.status}) ---\n${body}\n`
        })
        .join("\n")

      const prompt = PROMPT_TRIAGE.replace("{candidates}", () => candidateList)
        .replace("{user_requirement}", () => input.userRequirement || "Review the changes for correctness")
        .replace("{diff}", () => diff)

      const outcome = yield* streamReviewer({
        agentName: "review-triage",
        system: "You are the review triage router. Respond only with valid JSON.",
        user: input.user,
        model: input.model,
        sessionID: input.sessionID,
        small: true,
        content: prompt,
        timeoutSeconds: input.timeoutSeconds,
      })

      const raw = outcome.text
      const parsed = raw.trim() ? extractJsonObject(raw) : null
      let decision = parsed && typeof parsed === "object"
        ? Option.getOrNull(Schema.decodeUnknownOption(TriageResult)(parsed))
        : null

      // Keep only category keys the triage returned that are actually candidates.
      const candidateSet = new Set<Category>(input.candidates)
      const kept = decision
        ? (decision.categories.filter((c) => candidateSet.has(c as Category)) as Category[])
        : null

      yield* ReviewLog.append(input.sessionID, {
        phase: "triage",
        agent: "review-triage",
        model: `${input.model.providerID}/${input.model.id}`,
        durationMs: outcome.durationMs,
        tokens: outcome.tokens,
        inputChars: prompt.length,
        input: prompt,
        output: raw,
        error: outcome.error,
        parsed: Boolean(decision),
        need_review: decision?.need_review ?? null,
        candidates: input.candidates,
        kept,
        reason: decision?.reason ?? null,
      })

      log.info("code-reviewer.triage-decision", {
        sessionID: input.sessionID,
        parsed: Boolean(decision),
        need_review: decision?.need_review ?? null,
        candidates: input.candidates,
        kept,
        reason: decision?.reason,
      })

      return { decision, kept, account: outcome.account }
    })

    const reviewCategory = Effect.fn("CodeReviewer.reviewCategory")(function* (input: {
      sessionID: SessionID
      user: MessageV2.User
      model: Provider.Model
      group: FileGroup
      userRequirement: string
      timeoutSeconds: number
    }) {
      const { group, userRequirement } = input

      log.info("code-reviewer.reviewing-category", {
        sessionID: input.sessionID,
        category: group.category,
        fileCount: group.changes.length,
        files: group.changes.map((c) => c.file),
      })

      const fileList = group.changes.map((c) => c.file).join("\n")
      // Adaptive per-file diff budget: split a fixed prompt budget across the
      // files in THIS call so the prompt stays bounded regardless of file count
      // (a flat total-slice silently dropped later files when many changed).
      // Batched code-expert calls get few files → large per-file budget;
      // holistic lenses (design/functional/curl) get many files → shallow but
      // complete coverage (every file at least present, never truncated away).
      const PROMPT_DIFF_BUDGET = 48_000
      const perFile = Math.max(1_200, Math.floor(PROMPT_DIFF_BUDGET / group.changes.length))
      const gitDiff = group.changes
        .map((c) => {
          const body = c.diff.length > perFile ? c.diff.slice(0, perFile) + "\n… [diff truncated]" : c.diff
          return `--- ${c.file} ---\n${body}\n`
        })
        .join("\n")

      if (!gitDiff.trim()) {
        log.info("code-reviewer.empty-diff", { sessionID: input.sessionID, category: group.category })
        return { result: null as CodeReviewResult | null, account: undefined as Account | undefined }
      }

      // Function replacements insert values literally; otherwise `$&`, `$1`, …
      // inside a diff or the user's text would be mangled by String.replace.
      const reviewPrompt = group.prompt
        .replace("{files}", () => fileList)
        .replace("{diff}", () => gitDiff)
        .replace("{user_requirement}", () => userRequirement || "Review the changes for correctness")
        .replace("{curl_context}", () => group.context || "(CURL_TESTING.md does not exist yet — create it)")

      const outcome = yield* streamReviewer({
        agentName: group.agentName,
        system: `You are a ${group.category} code reviewer. Respond only with valid JSON.`,
        user: input.user,
        model: input.model,
        sessionID: input.sessionID,
        small: true,
        content: reviewPrompt,
        timeoutSeconds: input.timeoutSeconds,
      })

      const raw = outcome.text
      const parsed = raw.trim() ? extractJsonObject(raw) : null
      let result: CodeReviewResult | null = null
      if (parsed && typeof parsed === "object") {
        result = Option.getOrNull(Schema.decodeUnknownOption(CodeReviewResult)(parsed))
      }

      // Audit entry: full input/output, tokens, timing and decision — one line.
      yield* ReviewLog.append(input.sessionID, {
        phase: "reviewer",
        category: group.category,
        agent: group.agentName,
        model: `${input.model.providerID}/${input.model.id}`,
        files: group.changes.map((c) => c.file),
        durationMs: outcome.durationMs,
        tokens: outcome.tokens,
        inputChars: reviewPrompt.length,
        input: reviewPrompt,
        output: raw,
        error: outcome.error,
        parsed: Boolean(result),
        need_changes: result?.need_changes ?? null,
        feedback: result?.feedback ?? null,
      })

      if (!result) {
        log.warn("code-reviewer.unusable-response", {
          sessionID: input.sessionID,
          category: group.category,
          hasText: Boolean(raw.trim()),
          error: outcome.error,
        })
        return { result: null as CodeReviewResult | null, account: outcome.account }
      }

      log.info("code-reviewer.decision", {
        category: group.category,
        need_changes: result.need_changes,
        has_feedback: Boolean(result.feedback),
        durationMs: outcome.durationMs,
        sessionID: input.sessionID,
      })

      return { result, account: outcome.account }
    })

    const runFullStackFixer = Effect.fn("CodeReviewer.fullStackFixer")(function* (input: {
      sessionID: SessionID
      user: MessageV2.User
      model: Provider.Model
      allFeedback: string
      changes: Change[]
      userRequirement: string
      timeoutSeconds: number
      small: boolean
    }) {
      log.info("code-reviewer.running-fixer", {
        sessionID: input.sessionID,
        feedbackLength: input.allFeedback.length,
      })

      const fileList = input.changes.map((c) => c.file).join("\n")
      // Keep the fixer's diff small: the experts already cite file:line in their
      // feedback and the main agent has the real files. A 50k diff on a slow
      // model blew past the timeout with zero output; the feedback is what the
      // fixer actually needs to prioritize and de-duplicate.
      const gitDiff = input.changes.map((c) => `--- ${c.file} ---\n${c.diff}\n`).join("\n")

      // Function replacements insert values literally; otherwise `$&`, `$1`, …
      // inside the diff or feedback would be mangled by String.replace.
      const fixerPrompt = PROMPT_FULL_STACK_FIXER
        .replace("{all_reviewer_feedback}", () => input.allFeedback)
        .replace("{files}", () => fileList)
        .replace("{diff}", () => gitDiff.slice(0, 12_000))
        .replace("{user_requirement}", () => input.userRequirement || "Fix the issues identified by reviewers")

      const outcome = yield* streamReviewer({
        agentName: "full-stack-fixer",
        system: "You are a full-stack fixer. Respond only with valid JSON.",
        user: input.user,
        model: input.model,
        sessionID: input.sessionID,
        small: input.small,
        content: fixerPrompt,
        timeoutSeconds: input.timeoutSeconds,
      })

      const raw = outcome.text
      const parsed = raw.trim() ? extractJsonObject(raw) : null
      let result: CodeReviewResult | null = null
      if (parsed && typeof parsed === "object") {
        result = Option.getOrNull(Schema.decodeUnknownOption(CodeReviewResult)(parsed))
      }

      // Audit entry: full input/output, tokens, timing and decision — one line.
      yield* ReviewLog.append(input.sessionID, {
        phase: "fixer",
        agent: "full-stack-fixer",
        model: `${input.model.providerID}/${input.model.id}`,
        files: input.changes.map((c) => c.file),
        durationMs: outcome.durationMs,
        tokens: outcome.tokens,
        inputChars: fixerPrompt.length,
        feedbackChars: input.allFeedback.length,
        input: fixerPrompt,
        output: raw,
        error: outcome.error,
        parsed: Boolean(result),
        need_changes: result?.need_changes ?? null,
        has_refined: Boolean(result?.refined_response),
      })

      if (!result) {
        log.warn("code-reviewer.fixer-unusable-response", {
          sessionID: input.sessionID,
          hasText: Boolean(raw.trim()),
          error: outcome.error,
        })
        return { result: null as CodeReviewResult | null, account: outcome.account }
      }

      log.info("code-reviewer.fixer-decision", {
        need_changes: result.need_changes,
        has_feedback: Boolean(result.feedback),
        has_refined: Boolean(result.refined_response),
        durationMs: outcome.durationMs,
        sessionID: input.sessionID,
      })

      return { result, account: outcome.account }
    })

    const review = Effect.fn("CodeReviewer.review")(function* (input: {
      sessionID: SessionID
      directory: string
      user: MessageV2.User
      model: Provider.Model
      userRequirement: string
      baselineSnapshot?: string
    }) {
      const cfg = yield* config.get()
      const codeReviewerConfig = cfg.code_reviewer
      const enabled = codeReviewerConfig?.enabled ?? true
      // Default 0 → review any turn that changes at least one file (skip only
      // when nothing changed). Raise it to require N+ changed files first.
      const maxFiles = codeReviewerConfig?.max_files ?? 0
      const reviewerTimeout = codeReviewerConfig?.reviewer_timeout ?? 90
      const fixerTimeout = codeReviewerConfig?.fixer_timeout ?? 300
      const fixerSmall = codeReviewerConfig?.fixer_small ?? true
      const designReview = codeReviewerConfig?.design_review ?? true
      const functionalReview = codeReviewerConfig?.functional_review ?? true
      const curlTesting = codeReviewerConfig?.curl_testing ?? true
      // Master decision-maker gate: one fast call decides which specialists (if
      // any) apply to this turn's diff, so trivial edits skip review entirely
      // and only relevant reviewers run. Disable to always run the full panel.
      const triageEnabled = codeReviewerConfig?.triage ?? true
      const triageTimeout = codeReviewerConfig?.triage_timeout ?? 45
      // Cap files per reviewer call so a single agent never reviews too many at
      // once (it would miss issues + truncate diffs). Big categories are split
      // into parallel batches. 0 disables batching.
      const batchSize = codeReviewerConfig?.batch_size ?? 6
      const concurrency = Math.max(1, codeReviewerConfig?.concurrency ?? 5)

      log.info("code-reviewer.checking", {
        sessionID: input.sessionID,
        directory: input.directory,
        model: `${input.model.providerID}/${input.model.id}`,
        enabled,
        maxFiles,
        scoped: Boolean(input.baselineSnapshot),
      })

      if (!enabled) {
        log.info("code-reviewer.disabled", { sessionID: input.sessionID })
        return { result: null, usage: undefined }
      }

      const startedAt = Date.now()
      // Accumulated cost/tokens across every reviewer + fixer call this run, so
      // the caller can roll it into the session cumulative total.
      let usage: Account = EMPTY_ACCOUNT
      let didCall = false
      yield* ReviewLog.append(input.sessionID, {
        phase: "review-start",
        model: `${input.model.providerID}/${input.model.id}`,
        scoped: Boolean(input.baselineSnapshot),
        maxFiles,
        requirement: input.userRequirement?.trim() || null,
      })

      const changes = yield* collectChanges({
        directory: input.directory,
        baselineSnapshot: input.baselineSnapshot,
      })

      log.info("code-reviewer.files", {
        sessionID: input.sessionID,
        changedCount: changes.length,
        files: changes.map((c) => c.file),
      })

      yield* ReviewLog.append(input.sessionID, {
        phase: "changes",
        changedCount: changes.length,
        files: changes.map((c) => ({ file: c.file, status: c.status, diffChars: c.diff.length })),
      })

      if (changes.length <= maxFiles) {
        log.info("code-reviewer.skipping", {
          sessionID: input.sessionID,
          reason: "not_enough_files",
          count: changes.length,
          maxFiles,
        })
        yield* ReviewLog.append(input.sessionID, {
          phase: "skip",
          reason: "not_enough_files",
          changedCount: changes.length,
          maxFiles,
          durationMs: Date.now() - startedAt,
        })
        return { result: null, usage: undefined }
      }

      const groups = groupChangesByCategory(changes)

      // Extra UI/UX design lens over UI files, in addition to their code category.
      if (designReview) {
        const uiChanges = changes.filter((c) => isUIFile(c.file))
        if (uiChanges.length > 0) {
          groups.push({
            category: "design",
            changes: uiChanges,
            prompt: PROMPT_DESIGN,
            agentName: "ui-design-reviewer",
          })
        }
      }

      // Extra holistic functional-completeness lens over UI files: catches dead
      // controls (console.log/empty handlers) and the missing-data-layer smell
      // (mutations that can't persist/propagate across views).
      if (functionalReview) {
        const uiChanges = changes.filter((c) => isUIFile(c.file))
        if (uiChanges.length > 0) {
          groups.push({
            category: "functional",
            changes: uiChanges,
            prompt: PROMPT_FUNCTIONAL,
            agentName: "ui-functional-reviewer",
          })
        }
      }

      // Extra curl/API-test lens over API files. Plans real curl tests for the
      // main agent to run; reuses auth/base-URL from CURL_TESTING.md (injected
      // here as {curl_context}) so repeat runs don't re-authenticate.
      if (curlTesting) {
        const apiChanges = changes.filter((c) => isAPIFile(c.file))
        if (apiChanges.length > 0) {
          const curlContext = yield* Effect.promise(() =>
            fs
              .readFile(path.join(input.directory, "CURL_TESTING.md"), "utf8")
              .then((t) => t.slice(0, 8_000))
              .catch(() => ""),
          )
          groups.push({
            category: "curl",
            changes: apiChanges,
            prompt: PROMPT_CURL,
            agentName: "api-curl-tester",
            context: curlContext,
          })
        }
      }

      const userRequirement = input.userRequirement?.trim() || "Multiple files modified - review for correctness"

      // Master decision-maker: prune the candidate reviewers down to the set
      // that actually applies to this diff — and skip review entirely for
      // trivial changes (null guards, typos, renames). Runs once, before the
      // specialist panel. If triage is disabled or returns an unusable answer,
      // fall back to running every candidate reviewer (fail-open).
      let selected = groups
      if (triageEnabled && groups.length > 0) {
        const { decision, kept, account: triageAccount } = yield* runTriage({
          sessionID: input.sessionID,
          user: input.user,
          model: input.model,
          candidates: groups.map((g) => g.category),
          changes,
          userRequirement,
          timeoutSeconds: triageTimeout,
        }).pipe(
          Effect.catch((error: unknown) => {
            log.warn("code-reviewer.triage-failed", { sessionID: input.sessionID, error: String(error) })
            return Effect.succeed({ decision: null, kept: null, account: undefined as Account | undefined })
          }),
        )
        if (triageAccount) {
          usage = addAccount(usage, triageAccount)
          didCall = true
        }

        if (decision) {
          // Trivial change, or triage selected nothing → skip the whole panel.
          if (!decision.need_review || !kept || kept.length === 0) {
            log.info("code-reviewer.triage-skip", {
              sessionID: input.sessionID,
              reason: decision.reason,
              need_review: decision.need_review,
            })
            yield* ReviewLog.append(input.sessionID, {
              phase: "review-end",
              outcome: "triage_skipped",
              reason: decision.reason ?? null,
              need_review: decision.need_review,
              durationMs: Date.now() - startedAt,
            })
            return { result: null, usage: didCall ? usage : undefined }
          }
          const keptSet = new Set(kept)
          selected = groups.filter((g) => keptSet.has(g.category))
        }
        // decision === null (unusable triage response) → keep all groups (fail-open).
      }

      // Split oversized per-category groups into batches so no single reviewer
      // call is overwhelmed by too many files (holistic lenses pass through).
      const batched = batchGroups(selected, batchSize)

      log.info("code-reviewer.categories", {
        sessionID: input.sessionID,
        candidateCount: groups.length,
        categoryCount: selected.length,
        batchCount: batched.length,
        batchSize,
        concurrency,
        categories: batched.map((g) => `${g.category}${g.batchLabel ? `[${g.batchLabel}]` : ""}(${g.changes.length})`),
      })

      yield* ReviewLog.append(input.sessionID, {
        phase: "categories",
        batchSize,
        concurrency,
        categories: batched.map((g) => ({
          category: g.category,
          agent: g.agentName,
          fileCount: g.changes.length,
          batch: g.batchLabel ?? null,
        })),
      })

      if (batched.length === 0) {
        log.info("code-reviewer.no-categories", { sessionID: input.sessionID })
        yield* ReviewLog.append(input.sessionID, {
          phase: "skip",
          reason: "no_categories",
          durationMs: Date.now() - startedAt,
        })
        return { result: null, usage: didCall ? usage : undefined }
      }

      // Phase 1: Run all reviewer batches in parallel (capped to avoid rate limits)
      const reviewResults = yield* Effect.all(
        batched.map((group) =>
          reviewCategory({
            sessionID: input.sessionID,
            user: input.user,
            model: input.model,
            group,
            userRequirement,
            timeoutSeconds: reviewerTimeout,
          }).pipe(
            Effect.catch((error: unknown) => {
              log.warn("code-reviewer.category-failed", {
                error: String(error),
                sessionID: input.sessionID,
                category: group.category,
                batch: group.batchLabel,
              })
              return Effect.succeed({ result: null as CodeReviewResult | null, account: undefined as Account | undefined })
            }),
          ),
        ),
        { concurrency },
      )

      // Collect all reviewer feedback + accumulate token/cost usage
      const feedbacks: string[] = []
      let hasIssues = false

      for (let i = 0; i < reviewResults.length; i++) {
        const { result, account } = reviewResults[i]
        const group = batched[i]
        const heading = `${group.category.toUpperCase()} REVIEW${group.batchLabel ? ` (batch ${group.batchLabel})` : ""}`

        if (account) {
          usage = addAccount(usage, account)
          didCall = true
        }
        if (result?.need_changes && result.feedback) {
          hasIssues = true
          feedbacks.push(`## ${heading}\n${result.feedback}`)
        }
      }

      if (!hasIssues) {
        log.info("code-reviewer.all-clean", { sessionID: input.sessionID })
        yield* ReviewLog.append(input.sessionID, {
          phase: "review-end",
          outcome: "all_clean",
          reviewerCount: batched.length,
          durationMs: Date.now() - startedAt,
        })
        return { result: null, usage: didCall ? usage : undefined }
      }

      const combinedFeedback = feedbacks.join("\n\n")

      log.info("code-reviewer.issues-found", {
        sessionID: input.sessionID,
        reviewerCount: feedbacks.length,
        feedbackLength: combinedFeedback.length,
      })

      // Phase 2: Run full-stack fixer with all feedback
      const { result: fixerResult, account: fixerAccount } = yield* runFullStackFixer({
        sessionID: input.sessionID,
        user: input.user,
        model: input.model,
        allFeedback: combinedFeedback,
        changes,
        userRequirement,
        timeoutSeconds: fixerTimeout,
        small: fixerSmall,
      })
      if (fixerAccount) {
        usage = addAccount(usage, fixerAccount)
        didCall = true
      }

      if (fixerResult) {
        log.info("code-reviewer.fixer-returned", {
          sessionID: input.sessionID,
          need_changes: fixerResult.need_changes,
          has_feedback: Boolean(fixerResult.feedback),
          has_refined: Boolean(fixerResult.refined_response),
        })
        yield* ReviewLog.append(input.sessionID, {
          phase: "review-end",
          outcome: fixerResult.need_changes ? "fixes_requested" : "fixer_cleared",
          reviewerCount: feedbacks.length,
          need_changes: fixerResult.need_changes,
          has_refined: Boolean(fixerResult.refined_response),
          durationMs: Date.now() - startedAt,
        })
        return { result: fixerResult, usage: didCall ? usage : undefined }
      }

      // If fixer fails, return reviewer feedback as fallback
      log.warn("code-reviewer.fixer-failed-fallback", { sessionID: input.sessionID })
      yield* ReviewLog.append(input.sessionID, {
        phase: "review-end",
        outcome: "fixer_failed_fallback",
        reviewerCount: feedbacks.length,
        feedbackChars: combinedFeedback.length,
        durationMs: Date.now() - startedAt,
      })
      return {
        result: { need_changes: true, feedback: combinedFeedback, refined_response: "" },
        usage: didCall ? usage : undefined,
      }
    })

    return Service.of({ review })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(LLM.defaultLayer),
)

export * as CodeReviewer from "./code-reviewer"

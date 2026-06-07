export * as SideEffectLedger from "./side-effect-ledger"

import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@nous-ai/core/global"

// Per-session "side-effect manifest" — a compact, out-of-(main-agent)-context
// record of every non-file side-effect tool call the agent made this session.
//
// The code reviewer's `ChangeLedger` only sees `write`/`edit` (file diffs), so
// a turn whose work is purely runtime/infra state — `docker run`, `psql -c`,
// `kubectl apply`, `npm publish`, network mutations, etc. — is invisible to
// the file-diff pipeline. The triage step then sees "no files changed" and
// skips review, even when the user asked for exactly that infra work.
//
// This ledger closes that gap. The processor records every completed
// `bash`/`shell`/network call into a per-session JSON file
// (<data>/analysis/<sessionID>/side-effects.json) with:
//   - the tool name + the FULL command string (cheap, no LLM)
//   - a CHEAP pattern-based classification (kind: "docker:create", "db:query",
//     "network:mutate", "system:mutate", "package:publish", "read-only", …)
//     so triage can route by kind without re-parsing the command
//   - exit code + truncated output (so the reviewer can see whether the
//     command actually succeeded — a `docker run` that printed "permission
//     denied" is not the same as one that printed a container id)
//
// It is read ONLY by the code reviewer's triage step (in
// `collectSideEffects`); the main agent's LLM context never includes it.
// Best-effort: never throws. Same in-memory-cache + per-session lock + atomic
// rename pattern as ChangeLedger.

const DEFAULT_BASE = path.join(Global.Path.data, "analysis")

// Coarse classification of a side-effect tool call. Used by triage to decide
// whether the call is review-worthy (`mutate`) or just a read (`read-only`).
//   - "docker:create"     : creates a container (docker run, docker create)
//   - "docker:destroy"    : removes a container/image/volume (docker rm/rmi,
//                            stop/kill/compose down)
//   - "docker:exec"       : runs a command inside an existing container
//   - "docker:mutate"     : other state-mutating docker command (push, pull,
//                            network create, volume create, tag, etc.)
//   - "db:query"          : database query (psql -c, mysql -e, redis-cli, mongo,
//                            mongosh, etc.)
//   - "db:migrate"        : database schema change (psql -c with CREATE/ALTER/
//                            DROP, prisma migrate, drizzle-kit, knex migrate,
//                            flyway, alembic, etc.)
//   - "db:mutate"         : any other DB-mutating command (INSERT/UPDATE/DELETE
//                            via CLI, redis SET/DEL, etc.)
//   - "network:mutate"    : network state mutation (curl -X POST/PUT/DELETE/
//                            PATCH, wget POST, httpie, ssh, scp, rsync, etc.)
//   - "network:expose"    : opens a port / exposes a service (iptables, ngrok,
//                            cloudflared tunnel, socat, etc.)
//   - "system:mutate"     : system state change (systemctl start/stop/restart,
//                            service, launchctl, crontab, etc.)
//   - "system:install"    : installs a system component (apt install, brew
//                            install, yum install, dnf, snap, pip install,
//                            npm/yarn/pnpm/bun install at top level, etc.)
//   - "package:publish"   : publishes a package (npm publish, yarn publish,
//                            pnpm publish, bun publish, pip upload, gem push,
//                            cargo publish, docker push, etc.)
//   - "package:exec"      : runs a project script (npm/yarn/pnpm/bun run, …)
//   - "vcs:mutate"        : VCS state change (git commit/push/checkout/reset/
//                            rebase/merge/cherry-pick, gh pr create/merge, …)
//   - "mutate"            : other state-mutating command we haven't classified
//   - "read-only"         : pure read (ls, cat, docker ps, docker inspect,
//                            git status/diff/log, psql -c "SELECT …" read
//                            patterns, curl -X GET, etc.)
export type Kind =
  | "docker:create"
  | "docker:destroy"
  | "docker:exec"
  | "docker:mutate"
  | "db:query"
  | "db:migrate"
  | "db:mutate"
  | "network:mutate"
  | "network:expose"
  | "system:mutate"
  | "system:install"
  | "package:publish"
  | "package:exec"
  | "vcs:mutate"
  | "mutate"
  | "read-only"

export interface Entry {
  // A short id ("se_1", "se_2", …) so triage / reviewer prompts can refer to
  // entries by id rather than by full command (cheaper, and stable across
  // dedup-rewrites).
  id: string
  tool: string
  // First line of the command (the rest is in `fullCommand`). For multi-line
  // bash scripts we keep the first 280 chars here and the FULL command under
  // `fullCommand` so triage can pick the right kind from a glance but the
  // reviewer can still see the script if it survives triage.
  command: string
  fullCommand: string
  // Optional user-supplied description from the bash tool (the LLM's reason
  // for running the command — often the most useful context for the reviewer).
  description: string
  // Pattern-based classification. See Kind above.
  kind: Kind
  // True when `kind` is one of the `*:mutate` / `:create` / `:destroy` /
  // `:migrate` / `:publish` / `:install` / `:expose` categories — i.e. the
  // command can change persistent state. Triage uses this flag to skip
  // `read-only` calls (ls, cat, docker ps, …) without per-call reasoning.
  mutates: boolean
  exit?: number
  // First ~280 chars of stdout/stderr. Just enough for the reviewer to see
  // "container id abc123", "ERROR: permission denied", "1 row inserted", …
  outputPreview: string
  // When the command finished. Same epoch-ms clock the rest of the session
  // uses; lets `collectSideEffects` scope to the current turn via `baselineTime`.
  time: number
}

export type Manifest = Record<string, Entry[]>

const cache = new Map<string, Manifest>()
// Module-level cache lifetime: one process run. In long-running sessions the
// in-memory map grows with one entry per session, NOT one entry per tool call —
// the value is the full `Manifest` for that session and is the source of truth
// during the session's lifetime. The on-disk file (`<data>/analysis/<id>/side-effects.json`)
// is the cross-process store. Process restart reseeds from disk on first read.
// This matches ChangeLedger's exact pattern; an LRU cap is intentionally NOT
// added here because the per-process session count is bounded in practice
// (single-user desktop CLI), and silently dropping a session's cache while it
// is still being recorded would cause read() to return a stale view of the
// ledger — a worse failure than unbounded growth.

function safe(sessionID: string) {
  return sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function fileFor(base: string, sessionID: string) {
  return path.join(base, safe(sessionID), "side-effects.json")
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

// Cheap, no-LLM classifier: pattern-matches the first word(s) of the command
// and the verb following it. Designed to be conservative — when in doubt we
// return `mutate` (so triage can still inspect) rather than `read-only` (which
// the triage prompt uses as a hard skip signal). Pattern order matters: the
// first hit wins, so put more-specific patterns first.
//
// For chained commands (`sleep 3 && docker ps`, `cd /tmp && psql -c "…"`), the
// first word is a connector (`sleep`, `cd`) and the real tool only appears
// later. We therefore ALSO scan the first ~6 tokens across the chain
// separators (`;`, `&&`, `||`, `|`, `$(`, backtick) so a docker/kubectl/curl
// anywhere in a short pipeline still classifies correctly. The intent is to
// catch the common "verification" pattern — `docker run ... && sleep 3 &&
// docker ps` — not to fully parse the shell grammar.
export function classify(command: string): { kind: Kind; mutates: boolean } {
  const cmd = command.trim()
  const first = cmd.split(/\s+/)[0]?.toLowerCase() ?? ""
  const rest = cmd.slice(first.length).trim().toLowerCase()
  const second = rest.split(/\s+/)[0] ?? ""
  const third = rest.split(/\s+/)[1] ?? ""
  // For `docker compose up/down/...` style invocations, take the first TWO
  // subcommands (e.g. "compose" + "up").
  const subcommand = `${second} ${third}`.trim()

  // Find the first "real" tool token in a short pipeline. We split on shell
  // separators and pick the first non-empty token that is NOT a connector
  // (`cd`, `sleep`, `env`, `sudo`, `time`, `xargs`, `nohup`, …). The chained
  // search is bounded — we only look at the first 8 segments.
  const CONNECTORS = new Set([
    "&&", "||", ";", "|", "&", "$(", "`", "sudo", "time", "env", "xargs",
    "nohup", "nice", "ionice", "timeout", "command", "builtin", "exec",
    "cd", "sleep", "wait", "echo", "printf", "true", "false", ":", "test",
    "[", "[[", "if", "then", "fi", "do", "done", "for", "in", "while",
  ])
  let pipelineTool = ""
  for (const seg of cmd.split(/&&|\|\||;|\|(?!\|)|`|\$\(/).slice(0, 8)) {
    const tok = seg.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
    if (!tok) continue
    if (CONNECTORS.has(tok)) continue
    pipelineTool = tok
    break
  }
  // `tool` is what we route on: prefer the pipeline tool if `first` was a
  // connector (so `sleep 3 && docker ps` routes to docker), else use `first`.
  const tool = CONNECTORS.has(first) ? pipelineTool : first

  // --- docker ---------------------------------------------------------------
  if (tool === "docker" || tool === "podman" || tool === "nerdctl" || tool.endsWith("/docker") || tool.endsWith("/podman")) {
    // Decide which subcommand/verb applies. We re-resolve from the original
    // command so `docker compose down` is treated as a compose subcommand even
    // if `first` was a connector.
    const lcCmd = cmd.toLowerCase()
    const toolIdx = lcCmd.indexOf(tool)
    const realRest = toolIdx >= 0 ? lcCmd.slice(toolIdx + tool.length).trim() : ""
    const realSecond = realRest.split(/\s+/)[0] ?? ""
    const realThird = realRest.split(/\s+/)[1] ?? ""
    const realSubcommand = `${realSecond} ${realThird}`.trim()
    if (realSecond === "run" || realSecond === "create") return { kind: "docker:create", mutates: true }
    if (
      realSecond === "rm" ||
      realSecond === "rmi" ||
      realSecond === "stop" ||
      realSecond === "kill" ||
      realSecond === "down" ||
      realSecond === "volume" && (realThird === "rm" || realThird === "prune")
    ) {
      return { kind: "docker:destroy", mutates: true }
    }
    if (realSecond === "exec" || realSecond === "attach" || realSecond === "cp") {
      return { kind: "docker:exec", mutates: true }
    }
    if (realSecond === "push" || realSecond === "pull" || realSecond === "tag" || realSecond === "build") {
      return { kind: "docker:mutate", mutates: true }
    }
    if (
      realSecond === "ps" ||
      realSecond === "ls" ||
      realSecond === "inspect" ||
      realSecond === "logs" ||
      realSecond === "stats" ||
      realSecond === "images" ||
      realSecond === "network" && realThird === "ls" ||
      realSecond === "volume" && realThird === "ls"
    ) {
      return { kind: "read-only", mutates: false }
    }
    if (realSubcommand === "compose up" || realSubcommand === "compose restart") {
      return { kind: "docker:create", mutates: true }
    }
    if (realSubcommand === "compose down") {
      return { kind: "docker:destroy", mutates: true }
    }
    if (realSubcommand === "compose pull" || realSubcommand === "compose build") {
      return { kind: "docker:mutate", mutates: true }
    }
    return { kind: "docker:mutate", mutates: true }
  }

  // --- databases ------------------------------------------------------------
  // psql / mysql / mariadb / sqlite3 / mongosh / mongo / redis-cli / etcdctl
  if (
    tool === "psql" ||
    tool === "mysql" ||
    tool === "mariadb" ||
    tool.endsWith("/psql") ||
    tool.endsWith("/mysql")
  ) {
    // `psql -c "SELECT …"` is read; everything else (INSERT/UPDATE/DELETE/
    // CREATE/ALTER/DROP) we treat as a potential schema/data migration.
    if (/\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|\\copy|vacuum|cluster|reindex)\b/i.test(cmd)) {
      if (/\b(create|alter|drop|truncate)\b/i.test(cmd)) return { kind: "db:migrate", mutates: true }
      return { kind: "db:mutate", mutates: true }
    }
    return { kind: "db:query", mutates: false }
  }
  if (tool === "sqlite3" || tool.endsWith("/sqlite3")) {
    if (/\b(create|alter|drop|insert|update|delete)\b/i.test(cmd)) {
      if (/\b(create|alter|drop)\b/i.test(cmd)) return { kind: "db:migrate", mutates: true }
      return { kind: "db:mutate", mutates: true }
    }
    return { kind: "db:query", mutates: false }
  }
  if (tool === "mongosh" || tool === "mongo" || tool.endsWith("/mongosh") || tool.endsWith("/mongo")) {
    return { kind: /insert|update|delete|create|drop/i.test(cmd) ? "db:mutate" : "db:query", mutates: /insert|update|delete|create|drop/i.test(cmd) }
  }
  if (tool === "redis-cli" || tool.endsWith("/redis-cli")) {
    const mutating = /^(set|del|incr|hset|lpush|rpush|sadd|zadd|expire|persist|flushall|flushdb|rename|copy|move|config|save|bgsave|shutdown|replicaof|cluster|script|eval)/i.test(rest)
    return { kind: mutating ? "db:mutate" : "db:query", mutates: mutating }
  }
  // Migration runners — they ALWAYS mutate schema, never read-only.
  if (
    /(^|\/)(prisma|drizzle-kit|knex|migrate|flyway|alembic|sequelize-cli|umzug|dbmate|sqlx|skyclark|atlas|liquibase)(\s|$)/.test(
      cmd,
    )
  ) {
    return { kind: "db:migrate", mutates: true }
  }

  // --- network --------------------------------------------------------------
  if (tool === "curl" || tool === "wget" || tool === "http" || tool === "httpie" || tool === "xh") {
    // `-X POST/PUT/PATCH/DELETE` (or the long forms) is a mutation. Default
    // for `curl` without `-X` is GET → read-only. We also treat the explicit
    // `-d`/`--data`/`--data-raw`/`-T`/`--upload-file` flags as a mutation
    // signal even without `-X` (most users POST when they pass `-d`).
    const method = (cmd.match(/-X\s+([A-Za-z]+)/i)?.[1] || "").toUpperCase()
    const hasDataFlag = /(-d|--data|--data-raw|--data-binary|-T|--upload-file|--json|-F|--form)\b/.test(cmd)
    const explicitMutatingMethod = /^(POST|PUT|PATCH|DELETE)$/.test(method)
    if (explicitMutatingMethod || hasDataFlag) return { kind: "network:mutate", mutates: true }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "ssh" || tool === "scp" || tool === "rsync") return { kind: "network:mutate", mutates: true }
  if (tool === "ngrok" || tool === "cloudflared" || tool === "socat" || tool === "iptables") {
    return { kind: "network:expose", mutates: true }
  }

  // --- system / services ----------------------------------------------------
  if (tool === "systemctl" || tool === "service" || tool === "launchctl" || tool === "sc.exe") {
    return { kind: "system:mutate", mutates: true }
  }
  if (tool === "crontab" || tool === "at") return { kind: "system:mutate", mutates: true }
  if (tool === "kubectl" || tool === "helm" || tool === "kustomize") {
    // Re-resolve the verb from the kubectl position in case of `cd /tmp && kubectl apply …`.
    const lcCmd2 = cmd.toLowerCase()
    const toolIdx2 = lcCmd2.indexOf(tool)
    const realRest = toolIdx2 >= 0 ? lcCmd2.slice(toolIdx2 + tool.length).trim() : ""
    const kverb = realRest.split(/\s+/)[0] ?? ""
    if (
      kverb === "get" ||
      kverb === "describe" ||
      kverb === "logs" ||
      kverb === "version" ||
      kverb === "api-resources" ||
      kverb === "explain"
    ) {
      return { kind: "read-only", mutates: false }
    }
    return { kind: "system:mutate", mutates: true }
  }
  if (tool === "terraform" || tool === "tofu") {
    if (second === "plan" || second === "validate" || second === "show" || second === "output" || second === "state" && third === "list") {
      return { kind: "read-only", mutates: false }
    }
    return { kind: "system:mutate", mutates: true }
  }
  if (tool === "ansible" || tool === "ansible-playbook") return { kind: "system:mutate", mutates: true }

  // --- package managers -----------------------------------------------------
  if (tool === "apt" || tool === "apt-get" || tool === "yum" || tool === "dnf" || tool === "pacman" || tool === "zypper") {
    if (second === "install" || second === "remove" || second === "purge" || second === "upgrade" || second === "update") {
      return { kind: "system:install", mutates: true }
    }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "brew" || tool === "port" || tool === "snap" || tool === "flatpak") {
    if (second === "install" || second === "uninstall" || second === "upgrade") {
      return { kind: "system:install", mutates: true }
    }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "pip" || tool === "pip3" || tool === "uv" || tool === "poetry" || tool === "pipx") {
    if (second === "install" || second === "uninstall") return { kind: "system:install", mutates: true }
    if (second === "publish" || second === "upload") return { kind: "package:publish", mutates: true }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "npm" || tool === "yarn" || tool === "pnpm" || tool === "bun" || tool === "bunx") {
    if (second === "publish") return { kind: "package:publish", mutates: true }
    if (second === "install" || second === "add" || second === "remove" || second === "uninstall" || second === "update" || second === "upgrade") {
      return { kind: "system:install", mutates: true }
    }
    if (second === "run" || second === "exec" || second === "test" || second === "build" || second === "start" || second === "x") {
      return { kind: "package:exec", mutates: true }
    }
    if (second === "login" || second === "logout" || second === "config") return { kind: "mutate", mutates: true }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "cargo") {
    if (second === "publish") return { kind: "package:publish", mutates: true }
    if (second === "install") return { kind: "system:install", mutates: true }
    return { kind: "package:exec", mutates: true }
  }
  if (tool === "gem") {
    if (second === "push" || second === "publish") return { kind: "package:publish", mutates: true }
    if (second === "install") return { kind: "system:install", mutates: true }
    return { kind: "read-only", mutates: false }
  }

  // --- VCS ------------------------------------------------------------------
  if (tool === "git") {
    if (
      second === "commit" ||
      second === "push" ||
      second === "pull" ||
      second === "fetch" ||
      second === "merge" ||
      second === "rebase" ||
      second === "reset" ||
      second === "checkout" ||
      second === "cherry-pick" ||
      second === "revert" ||
      second === "tag" ||
      second === "branch" && (third === "-D" || third === "-d" || third === "-m" || third === "delete") ||
      second === "stash" && (third === "pop" || third === "drop" || third === "apply" || third === "push")
    ) {
      return { kind: "vcs:mutate", mutates: true }
    }
    return { kind: "read-only", mutates: false }
  }
  if (tool === "gh") {
    if (
      second === "pr" && (third === "create" || third === "merge" || third === "close" || third === "edit" || third === "delete" || third === "review") ||
      second === "issue" && (third === "create" || third === "close" || third === "edit" || third === "delete") ||
      second === "release" && (third === "create" || third === "edit" || third === "delete" || third === "upload") ||
      second === "repo" && (third === "create" || third === "delete" || third === "edit" || third === "clone" || third === "fork") ||
      second === "workflow" && third === "run"
    ) {
      return { kind: "vcs:mutate", mutates: true }
    }
    return { kind: "read-only", mutates: false }
  }

  // --- common read-only fallthroughs ----------------------------------------
  if (first === "ls" || first === "cat" || first === "head" || first === "tail" || first === "echo" || first === "printf" || first === "pwd" || first === "env" || first === "which" || first === "type") {
    return { kind: "read-only", mutates: false }
  }

  // Default: assume mutating. Reviewers catch false positives; missing a
  // mutation is a real bug (whole reason this ledger exists).
  return { kind: "mutate", mutates: true }
}

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

// Record one completed non-write tool call against the session ledger. Cheap
// to call for every bash invocation; the per-session promise chain serializes
// concurrent record() calls in the same process. Cross-process races are an
// accepted limitation (see ChangeLedger.record for the full discussion).
export function record(input: {
  sessionID: string
  tool: string
  command: string
  description?: string
  output?: string
  exit?: number
  base?: string
}): Effect.Effect<void> {
  return Effect.promise(() =>
    chain(input.sessionID, async () => {
      const base = input.base || DEFAULT_BASE
      try {
        const manifest = await load(base, input.sessionID)
        const cls = classify(input.command)
        const trimmed = input.command.trim()
        const firstLine = trimmed.split("\n")[0] ?? ""
        const commandPreview = firstLine.length > 280 ? firstLine.slice(0, 277) + "…" : firstLine
        const outputPreview = (input.output ?? "").slice(0, 280)
        const existing = manifest[input.sessionID] ?? []
        const id = `se_${existing.length + 1}`
        const entry: Entry = {
          id,
          tool: input.tool,
          command: commandPreview,
          fullCommand: trimmed.length > 4000 ? trimmed.slice(0, 4000) + "\n… [truncated]" : trimmed,
          description: input.description?.slice(0, 280) ?? "",
          kind: cls.kind,
          mutates: cls.mutates,
          exit: input.exit,
          outputPreview,
          time: Date.now(),
        }
        existing.push(entry)
        manifest[input.sessionID] = existing
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

export function read(sessionID: string, base?: string): Effect.Effect<Entry[]> {
  return Effect.promise(async () => {
    const manifest = await load(base || DEFAULT_BASE, sessionID)
    return manifest[sessionID] ?? []
  })
}

// Render a compact tool-call summary for the reviewer's triage step. Caps the
// output so a turn with 50 docker calls doesn't blow the prompt budget:
//   - At most `maxMutations` mutating entries are shown IN FULL.
//   - `read-only` entries are collapsed to a count by default (the triage
//     prompt doesn't need to see every `ls`/`cat`/`docker ps`).
//   - The total entry count is always reported so triage can spot a turn
//     where the agent mostly ran read-only checks (low signal).
export function summaryText(
  sessionID: string,
  options: {
    maxMutations?: number
    includeReadOnly?: boolean
    maxReadOnlyExamples?: number
    base?: string
    baselineTime?: number
  } = {},
): Effect.Effect<string> {
  const maxMutations = options.maxMutations ?? 20
  const includeReadOnly = options.includeReadOnly ?? false
  const maxReadOnlyExamples = options.maxReadOnlyExamples ?? 3
  return Effect.promise(async () => {
    const entries = await load(options.base || DEFAULT_BASE, sessionID).then((m) => m[sessionID] ?? [])
    const inTurn = options.baselineTime
      ? entries.filter((e) => e.time >= (options.baselineTime ?? 0))
      : entries
    if (inTurn.length === 0) return ""

    const mutations = inTurn.filter((e) => e.mutates)
    const reads = inTurn.filter((e) => !e.mutates)

    const lines: string[] = []
    lines.push(`Total: ${inTurn.length} tool call(s) this turn (${mutations.length} mutating, ${reads.length} read-only).`)

    if (mutations.length > 0) {
      lines.push("")
      lines.push("Mutating calls (side effects outside the file system):")
      const show = mutations.slice(0, maxMutations)
      for (const e of show) {
        const exit = typeof e.exit === "number" ? (e.exit === 0 ? "ok" : `exit ${e.exit}`) : "?"
        const desc = e.description ? `  // ${e.description}` : ""
        lines.push(`  [${e.id}] ${e.kind} (${exit})  ${e.tool} ${e.command}${desc}`)
        if (e.outputPreview) {
          // Indent the preview so it doesn't blend with the next entry.
          const preview = e.outputPreview.split("\n").slice(0, 3).join(" ⏎ ")
          lines.push(`         output: ${preview}`)
        }
      }
      if (mutations.length > show.length) {
        lines.push(`  … (${mutations.length - show.length} more mutating call(s) not shown)`)
      }
    }

    if (includeReadOnly && reads.length > 0) {
      lines.push("")
      lines.push(`Read-only calls (${reads.length} total — e.g. ls/cat/docker ps/psql SELECT):`)
      for (const e of reads.slice(0, maxReadOnlyExamples)) {
        lines.push(`  [${e.id}] ${e.tool} ${e.command}`)
      }
      if (reads.length > maxReadOnlyExamples) {
        lines.push(`  … (${reads.length - maxReadOnlyExamples} more)`)
      }
    }

    return lines.join("\n")
  })
}

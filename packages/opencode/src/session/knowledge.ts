import path from "path"
import { Effect, Context, Layer, Stream } from "effect"
import { AppFileSystem } from "@nous-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@nous-ai/core/global"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import * as KB from "./knowledge-base"
import * as Log from "@nous-ai/core/util/log"
import { LLMEvent } from "@nous-ai/llm"

const log = Log.create({ service: "knowledge" })

export interface Interface {
  readonly feeder: (userText: string, userMessageID: string) => Effect.Effect<string | null>
  readonly completer: (
    sessionID: string,
    messages: MessageV2.WithParts[],
  ) => Effect.Effect<void>
  readonly resetCache: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Knowledge") {}

interface Cache {
  lastUserMessageID: string | null
  lastUserText: string | null
  lastInjection: string | null
}

function extractWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length >= 3)
}

function isTrivialQuery(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length <= 2) return true
  const hasTechChars = /[._\-\/]/.test(text)
  if (words.length <= 3 && !hasTechChars) return true
  return false
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

function formatHistorySnippet(messages: MessageV2.WithParts[]): string {
  const lines: string[] = []
  for (const msg of messages.slice(-40)) {
    const role = msg.info.role
    let text = ""
    if (role === "user") {
      text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .slice(0, 500)
    } else if (role === "assistant") {
      text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .slice(0, 500)
      const tools = msg.parts.filter((p) => p.type === "tool")
      if (tools.length > 0) {
        text += `\n[Tool calls: ${tools.map((t) => (t as MessageV2.ToolPart).tool).join(", ")}]`
      }
    }
    if (text) {
      lines.push(`[${role}] ${text}`)
    }
  }
  return lines.join("\n")
}

const COMPLETER_SYSTEM_PROMPT = `You are a Knowledge Base Curator. Your job is to analyze a conversation and update the project's knowledge base.

You will receive:
1. A conversation history showing what the user asked and what tools the assistant used
2. The current DRILL_DOWN_TREE.md content

Your task:
1. Analyze what code was explored and what was learned
2. Identify gaps - areas the agent had to explore because knowledge was missing
3. Update DRILL_DOWN_TREE.md with new entries or improved descriptions
4. Create new knowledge documentation files if needed

Output format:
Provide your response in two sections:

## UPDATED_TREE
<the complete updated DRILL_DOWN_TREE.md content>

## NEW_FILES
For each new file, provide:
### filepath: knowledge_base_world/Area/Doc.md
<file content>

Guidelines:
- Be conservative - only add knowledge clearly demonstrated in the session
- Use ## Category headers and - **Area/File.md** — description format
- Use → Read: path/to/file.py syntax for code references
- Keep descriptions concise (1-2 sentences) but technically informative
- Preserve all existing entries unless clearly wrong
- Only create NEW_FILES section if there are genuinely new knowledge areas
- If no changes are needed, output "## UPDATED_TREE\n<current tree>" and omit NEW_FILES`

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
      })
    )

    const getWorkDir = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      return ctx.directory
    })

    const feeder = Effect.fn("Knowledge.feeder")(function* (userText: string, userMessageID: string) {
      const workDir = yield* getWorkDir
      log.info("feeder start", { workDir, userMessageID, textLength: userText.length })

      if (isTrivialQuery(userText)) {
        log.info("feeder trivial query, skipping")
        return null
      }

      if (isFrontendQuery(userText)) {
        log.info("feeder frontend query detected", { userMessageID })
      }

      const initialized = yield* KB.ensureInit(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs))
      if (!initialized) {
        log.warn("feeder init failed", { workDir })
        return null
      }

      const tree = yield* KB.loadTree(workDir).pipe(Effect.provideService(AppFileSystem.Service, fs))
      if (!tree || tree.length === 0) {
        log.info("feeder no tree", { workDir })
        return null
      }

      const c = yield* InstanceState.get(cache)
      if (userMessageID === c.lastUserMessageID && c.lastInjection !== null) {
        log.info("feeder cache hit", { userMessageID })
        return c.lastInjection || null
      }

      const words = extractWords(userText)
      const matchedEntries: string[] = []
      for (const entry of tree) {
        const entryLower = entry.entryPath.toLowerCase()
        for (const word of words) {
          const w = word.toLowerCase().replace(/[^a-z0-9]/g, "")
          if (w.length < 3) continue
          if (entryLower.includes(w)) {
            matchedEntries.push(entry.entryPath)
            break
          }
        }
      }

      log.info("feeder matched", { entries: matchedEntries.length, matchedEntries })

      const codeContext =
        matchedEntries.length > 0
          ? yield* KB.readRelevantCode(workDir, tree, matchedEntries).pipe(
              Effect.provideService(AppFileSystem.Service, fs),
            )
          : null

      const frontendHint = isFrontendQuery(userText)
        ? "\n\n⚠️ CRITICAL INSTRUCTION: This is a frontend/UI/HTML/design request. " +
          "You MUST call the `skill` tool with parameter name='frontend-design' BEFORE you start coding or designing. " +
          "This will load the frontend-design skill instructions which are REQUIRED for this task. " +
          "Do not proceed with any design work, HTML generation, or code output until you have loaded this skill.\n"
        : ""

      if (!codeContext && !frontendHint) {
        yield* InstanceState.useEffect(cache, (s) =>
          Effect.sync(() => {
            s.lastUserMessageID = userMessageID
            s.lastUserText = userText
            s.lastInjection = ""
          }),
        )
        return null
      }

      const injection =
        (codeContext
          ? "IMPORTANT: The following files have already been read and their " +
            "content is provided below. Do NOT read/re-read these files. " +
            "Use this context directly as the source of truth.\n" +
            `Knowledge entries matched: ${matchedEntries.join(", ")}\n\n` +
            codeContext
          : "") +
        frontendHint

      log.info("feeder inject", { bytes: injection.length, entries: matchedEntries, hasFrontendHint: !!frontendHint })

      yield* InstanceState.useEffect(cache, (s) =>
        Effect.sync(() => {
          s.lastUserMessageID = userMessageID
          s.lastUserText = userText
          s.lastInjection = injection
        }),
      )
      return injection
    })

    const completerCore = Effect.fn("Knowledge.completer")(function* (sessionID: string, messages: MessageV2.WithParts[]) {
      const workDir = yield* getWorkDir
      log.info("completer start", { sessionID, workDir, messageCount: messages.length })

      const treeContent = yield* KB.loadTreeContent(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      if (!treeContent) {
        log.info("completer no tree, skipping")
        return
      }

      const acquired = yield* KB.acquireLock(workDir).pipe(
        Effect.provideService(AppFileSystem.Service, fs),
      )
      if (!acquired) {
        log.info("completer lock held, skipping")
        return
      }

      const release = () =>
        KB.releaseLock(workDir).pipe(
          Effect.provideService(AppFileSystem.Service, fs),
          Effect.orElseSucceed(() => {}),
        )

      const history = formatHistorySnippet(messages)
      const prompt = `Session conversation:\n${history}\n\nCurrent DRILL_DOWN_TREE.md:\n${treeContent}\n\nAnalyze the session. What new knowledge was gained? What was missed? Update the tree and create files as needed.`

      const modelInfo = yield* provider.defaultModel().pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (!modelInfo) {
        log.warn("completer no model available")
        yield* release()
        return
      }

      const smallModel = yield* provider.getSmallModel(modelInfo.providerID).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const model = smallModel ?? (yield* provider.getModel(modelInfo.providerID, modelInfo.modelID).pipe(
        Effect.orElseSucceed(() => undefined),
      ))
      
      if (!model) {
        log.warn("completer could not load model")
        yield* release()
        return
      }

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
        yield* release()
        return
      }

      log.info("completer response", { bytes: text.length })

      // Parse UPDATED_TREE section
      const treeMatch = text.match(/## UPDATED_TREE\n([\s\S]*?)(?=\n## NEW_FILES|\n## END|$)/)
      if (treeMatch) {
        const newTree = treeMatch[1].trim()
        if (newTree && newTree !== treeContent.trim()) {
          yield* fs
            .writeFileString(path.join(workDir, KB.KB_DIR_NAME, KB.DRILL_DOWN_FILENAME), newTree)
            .pipe(Effect.orElseSucceed(() => {}))
          log.info("completer updated tree")
        }
      }

      // Parse NEW_FILES sections
      const fileMatches = text.matchAll(/### filepath:\s*(knowledge_base_world\/[^\n]+)\n([\s\S]*?)(?=\n### filepath:|\n## END|$)/g)
      for (const match of fileMatches) {
        const filePath = match[1].trim()
        const fileContent = match[2].trim()
        if (filePath && fileContent && KB.isKbPathSafe(workDir, filePath)) {
          const fullPath = path.join(workDir, filePath)
          const dir = path.dirname(fullPath)
          yield* fs.ensureDir(dir).pipe(Effect.orElseSucceed(() => {}))
          yield* fs.writeFileString(fullPath, fileContent).pipe(Effect.orElseSucceed(() => {}))
          log.info("completer created file", { filePath })
        } else if (filePath) {
          log.warn("completer unsafe path rejected", { filePath })
        }
      }

      yield* release()
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

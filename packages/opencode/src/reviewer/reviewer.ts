import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { serviceUse } from "@/effect/service-use"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import * as Log from "@nous-ai/core/util/log"
import * as Stream from "effect/Stream"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { LLMEvent } from "@nous-ai/llm"
import { Agent } from "@/agent/agent"
import PROMPT_REVIEWER from "./prompt.txt"

const log = Log.create({ service: "reviewer" })

export const ReviewResult = Schema.Struct({
  need_changes: Schema.Boolean,
  feedback: Schema.String,
  refined_response: Schema.String,
  refined_reasoning: Schema.optional(Schema.String),
}).annotate({ identifier: "ReviewResult" })

export type ReviewResult = Schema.Schema.Type<typeof ReviewResult>

export interface Interface {
  readonly review: (input: {
    sessionID: SessionID
    history: MessageV2.WithParts[]
    finalMessage: MessageV2.WithParts
    model: Provider.Model
    user: MessageV2.User
  }) => Effect.Effect<ReviewResult | null>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Reviewer") {}

export const use = serviceUse(Service)

function extractTextFromMessage(msg: MessageV2.WithParts): string {
  return msg.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

function extractReasoningFromMessage(msg: MessageV2.WithParts): string {
  return msg.parts
    .filter((p): p is MessageV2.ReasoningPart => p.type === "reasoning")
    .map((p) => p.text)
    .join("\n")
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  // Try to find JSON object between curly braces
  let depth = 0
  let start = -1
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") {
      if (depth === 0) start = i
      depth++
    } else if (trimmed[i] === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1))
        } catch {
          // Continue searching
        }
      }
    }
  }
  return null
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const llm = yield* LLM.Service

    const review = Effect.fn("Reviewer.review")(function* (input: {
      sessionID: SessionID
      history: MessageV2.WithParts[]
      finalMessage: MessageV2.WithParts
      model: Provider.Model
      user: MessageV2.User
    }) {
      const cfg = yield* config.get()
      const reviewerConfig = cfg.reviewer
      const enabled = reviewerConfig?.enabled ?? true
      const maxIterations = reviewerConfig?.max_iterations ?? 3

      log.info("reviewer.checking", {
        sessionID: input.sessionID,
        enabled,
        maxIterations,
        messageID: input.finalMessage.info.id,
        model: `${input.model.providerID}/${input.model.id}`,
      })

      if (!enabled) {
        log.info("reviewer.disabled", { sessionID: input.sessionID })
        return null
      }

      // Get recent user/assistant turns (last 4)
      const recent = input.history
        .filter((m) => m.info.role === "user" || m.info.role === "assistant")
        .slice(-4)

      const historyText = recent
        .map((msg) => {
          const text = extractTextFromMessage(msg)
          return `${msg.info.role}: ${text.slice(0, 500)}`
        })
        .join("\n\n")

      const finalText = extractTextFromMessage(input.finalMessage)
      const finalReasoning = extractReasoningFromMessage(input.finalMessage)

      if (!finalText.trim() && !finalReasoning.trim()) {
        log.info("reviewer.empty-final-text", { sessionID: input.sessionID })
        return null
      }

      const reviewPrompt = PROMPT_REVIEWER
        .replace("{history_text}", historyText)
        .replace("{final_text}", finalText || "[No text response]")
        .replace("{final_reasoning}", finalReasoning || "[No reasoning/thinking]")

      log.info("reviewer.calling-llm", {
        sessionID: input.sessionID,
        historyLength: historyText.length,
        finalTextLength: finalText.length,
        promptPreview: reviewPrompt.slice(0, 200),
      })

      // Create a minimal agent for the reviewer call
      const reviewAgent: Agent.Info = {
        name: "reviewer",
        mode: "subagent",
        hidden: true,
        permission: [],
        options: {},
      }

      let raw: string
      try {
        raw = yield* llm
          .stream({
            agent: reviewAgent,
            user: input.user,
            system: ["You are a helpful code reviewer. Respond only with valid JSON."],
            small: true,
            tools: {},
            model: input.model,
            sessionID: input.sessionID,
            retries: 0,
            messages: [{ role: "user", content: reviewPrompt }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((e) => e.text),
            Stream.mkString,
            Effect.timeout("60 seconds"),
            Effect.catch((error: unknown) => {
              log.warn("reviewer.llm-failed", {
                error: String(error),
                sessionID: input.sessionID,
              })
              return Effect.succeed("")
            }),
          )
      } catch (error) {
        log.warn("reviewer.llm-exception", {
          error: String(error),
          sessionID: input.sessionID,
        })
        return null
      }

      log.info("reviewer.raw-response", {
        raw: raw.slice(0, 500),
        rawLength: raw.length,
        sessionID: input.sessionID,
      })

      if (!raw.trim()) {
        log.warn("reviewer.empty-response", { sessionID: input.sessionID })
        return null
      }

      const parsed = extractJsonObject(raw)
      if (!parsed || typeof parsed !== "object") {
        log.warn("reviewer.no-json", {
          raw: raw.slice(0, 500),
          sessionID: input.sessionID,
        })
        return null
      }

      const decoded = Schema.decodeUnknownOption(ReviewResult)(parsed)
      if (Option.isNone(decoded)) {
        log.warn("reviewer.decode-failed", {
          raw: raw.slice(0, 500),
          parsed,
          sessionID: input.sessionID,
        })
        return null
      }

      const result = decoded.value
      log.info("reviewer.decision", {
        need_changes: result.need_changes,
        has_feedback: Boolean(result.feedback),
        feedback_preview: result.feedback?.slice(0, 200),
        has_refined: Boolean(result.refined_response),
        refined_preview: result.refined_response?.slice(0, 200),
        sessionID: input.sessionID,
      })

      return result
    })

    return Service.of({ review })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(LLM.layer),
)

export * as Reviewer from "./reviewer"

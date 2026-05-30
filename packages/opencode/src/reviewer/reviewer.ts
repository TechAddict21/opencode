import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { serviceUse } from "@/effect/service-use"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import * as Log from "@nous-ai/core/util/log"
import * as Stream from "effect/Stream"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { LLMEvent, Usage } from "@nous-ai/llm"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import PROMPT_REVIEWER from "./prompt.txt"
import { extractJsonObject } from "./util"
import { ReviewLog } from "./review-log"

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
  }) => Effect.Effect<{ result: ReviewResult | null; usage?: ReturnType<typeof Session.getUsage> }>
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
        return { result: null, usage: undefined }
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
        return { result: null, usage: undefined }
      }

      // Function replacements: the values are arbitrary message/diff text that
      // may contain `$&`, `$1`, … which String.replace would otherwise treat as
      // special patterns and corrupt. A replacer fn inserts the value literally.
      const reviewPrompt = PROMPT_REVIEWER
        .replace("{history_text}", () => historyText)
        .replace("{final_text}", () => finalText || "[No text response]")
        .replace("{final_reasoning}", () => finalReasoning || "[No reasoning/thinking]")

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

      const started = Date.now()
      let raw = ""
      let rawUsage: Usage | undefined
      let streamError: string | undefined
      yield* llm
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
          Stream.runForEach((e) =>
            Effect.sync(() => {
              if (LLMEvent.is.textDelta(e)) raw += e.text
              else if (LLMEvent.is.stepFinish(e)) {
                if (e.usage) rawUsage = e.usage
              } else if (LLMEvent.is.finish(e)) {
                if (e.usage) rawUsage = e.usage
              }
            }),
          ),
          Effect.timeout("60 seconds"),
          Effect.catch((error: unknown) =>
            Effect.sync(() => {
              streamError = String(error)
              log.warn("reviewer.llm-failed", { error: String(error), sessionID: input.sessionID })
            }),
          ),
        )
      const durationMs = Date.now() - started
      // usage = cost + normalized tokens for the session cumulative total.
      const usage = rawUsage ? Session.getUsage({ model: input.model, usage: rawUsage }) : undefined

      const parsed = raw.trim() ? extractJsonObject(raw) : null
      let result: ReviewResult | null = null
      if (parsed && typeof parsed === "object") {
        result = Option.getOrNull(Schema.decodeUnknownOption(ReviewResult)(parsed))
      }

      // Audit entry into this session's shared review log (same file as the
      // code-review pipeline) — full input/output, tokens, timing, decision.
      yield* ReviewLog.append(input.sessionID, {
        phase: "text-reviewer",
        agent: "reviewer",
        model: `${input.model.providerID}/${input.model.id}`,
        durationMs,
        tokens: usage?.tokens,
        inputChars: reviewPrompt.length,
        input: reviewPrompt,
        output: raw,
        error: streamError,
        parsed: Boolean(result),
        need_changes: result?.need_changes ?? null,
        has_refined: Boolean(result?.refined_response),
      })

      if (!result) {
        log.warn("reviewer.unusable-response", {
          sessionID: input.sessionID,
          hasText: Boolean(raw.trim()),
          error: streamError,
        })
        return { result: null, usage }
      }

      log.info("reviewer.decision", {
        need_changes: result.need_changes,
        has_feedback: Boolean(result.feedback),
        has_refined: Boolean(result.refined_response),
        durationMs,
        sessionID: input.sessionID,
      })

      return { result, usage }
    })

    return Service.of({ review })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(LLM.defaultLayer),
)

export * as Reviewer from "./reviewer"

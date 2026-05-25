import { Schema } from "effect"

export const HookEventType = Schema.Literals([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "Notification",
])

export type HookEventType = typeof HookEventType.Type

export const HookDef = Schema.Struct({
  event: HookEventType,
  command: Schema.String,
  matcher: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number),
})

export type HookDef = typeof HookDef.Type

export const Hooks = Schema.mutable(Schema.Array(HookDef))

export type Hooks = typeof Hooks.Type

export * as ConfigHook from "./hook"

import { Effect, Layer, Context } from "effect"
import * as Log from "@nous-ai/core/util/log"
import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Config } from "@/config/config"
import type { HookEventType } from "@/config/hook"

const log = Log.create({ service: "hook" })

export interface Interface {
  readonly trigger: (
    event: HookEventType,
    input: Record<string, unknown>,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Hook") {}

function matchRegex(pattern: string, value: string): boolean {
  if (!pattern) return true
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

function safeJsonStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch (error) {
    log.warn("failed to stringify hook input", { error: String(error) })
    return JSON.stringify({ error: "Failed to serialize input" })
  }
}

function runHook(command: string, input: Record<string, unknown>, timeout: number): void {
  const json = safeJsonStringify(input)
  const tmpFile = path.join(os.tmpdir(), `nous-hook-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

  try {
    fs.writeFileSync(tmpFile, json)
  } catch (err) {
    log.warn("hook temp file write failed", { command, error: String(err) })
    return
  }

  const proc = spawn("sh", ["-c", command], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOOK_EVENT: input.hook_event_name as string,
      HOOK_INPUT_FILE: tmpFile,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })

  const cleanup = () => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
  }

  const timer = setTimeout(() => {
    proc.kill("SIGKILL")
    log.warn("hook timed out", { command, timeout })
    cleanup()
  }, timeout * 1000)

  proc.on("exit", (code) => {
    clearTimeout(timer)
    cleanup()
    if (code !== 0) {
      log.warn("hook exited with non-zero code", { command, exitCode: code })
    }
  })

  proc.on("error", (error) => {
    clearTimeout(timer)
    cleanup()
    log.warn("hook execution failed", { command, error: error.message })
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const trigger = Effect.fn("Hook.trigger")(function* (
      event: HookEventType,
      input: Record<string, unknown>,
    ) {
      const cfg = yield* config.get()
      const hooks = cfg.hooks ?? []
      const matcherValue =
        typeof input.tool_name === "string"
          ? input.tool_name
          : typeof input.prompt === "string"
            ? input.prompt
            : ""

      const seen = new Set<string>()

      for (const hook of hooks) {
        if (hook.event !== event) continue
        if (!matchRegex(hook.matcher ?? "", matcherValue)) continue
        if (seen.has(hook.command)) continue
        seen.add(hook.command)

        const timeout = hook.timeout ?? 30
        const payload = { ...input, hook_event_name: event }
        runHook(hook.command, payload, timeout)
      }
    })

    return { trigger } satisfies Interface
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Hook from "."

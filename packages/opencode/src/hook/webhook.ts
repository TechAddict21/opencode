import * as Log from "@nous-ai/core/util/log"

const log = Log.create({ service: "hook.webhook" })

let _url: string | undefined
let _sessionId: string | undefined

const WEBHOOK_SKIP = new Set<string>(["PreToolUse"])

export function initialize(url: string | undefined, sessionId: string | undefined): void {
  _url = url?.trim() || undefined
  _sessionId = sessionId?.trim() || undefined
}

export function isActive(): boolean {
  return !!_url
}

export function fire(eventType: string, payload: Record<string, unknown>): void {
  const url = _url
  if (!url) return
  if (WEBHOOK_SKIP.has(eventType)) return

  const fullPayload = {
    event_type: eventType,
    timestamp: Date.now() / 1000,
    ...(_sessionId ? { webhook_session_id: _sessionId } : {}),
    ...payload,
  }

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fullPayload),
  }).catch((error) => {
    log.debug("webhook failed", { url, eventType, error: String(error) })
  })
}

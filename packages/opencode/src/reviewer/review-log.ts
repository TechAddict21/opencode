export * as ReviewLog from "./review-log"

import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@nous-ai/core/global"
import { SessionID } from "@/session/schema"

// Per-session audit trail for the whole code-review pipeline (category
// reviewers / experts + full-stack fixer): one JSONL file per session under
// <log>/review/<sessionID>.jsonl, capturing inputs, outputs, tokens, timing
// and skip reasons so a run can be reconstructed and debugged after the fact.
const dir = path.join(Global.Path.log, "review")

function fileFor(sessionID: string) {
  const safe = sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")
  return path.join(dir, `${safe}.jsonl`)
}

export function location(sessionID: SessionID) {
  return fileFor(sessionID)
}

// Append one structured entry. Best-effort: never throws, never blocks the
// review — a logging failure must not affect the user's session.
export function append(sessionID: SessionID, entry: Record<string, unknown>): Effect.Effect<void> {
  return Effect.promise(async () => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const line = JSON.stringify({ time: new Date().toISOString(), sessionID, ...entry }) + "\n"
      await fs.appendFile(fileFor(sessionID), line, "utf8")
    } catch {
      // swallow — logging must never break the review flow
    }
  })
}

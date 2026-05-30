export * as KnowledgeLog from "./knowledge-log"

import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@nous-ai/core/global"

// Per-session audit trail for the knowledge feeder/completer: one JSONL file
// per session under <log>/knowledge/<sessionID>.jsonl. Mirrors ReviewLog. It
// captures every terminal decision of the feeder (match/miss/inject + bytes)
// and the completer (gap-detected / skip reasons / write) so a run can be
// reconstructed after the fact and the effect of KB changes can be measured.
const dir = path.join(Global.Path.log, "knowledge")

function fileFor(sessionID: string) {
  const safe = sessionID.replace(/[^a-zA-Z0-9._-]/g, "_")
  return path.join(dir, `${safe}.jsonl`)
}

export function location(sessionID: string) {
  return fileFor(sessionID)
}

// Append one structured entry. Best-effort: never throws, never blocks the
// session — a logging failure must not affect the feeder/completer flow.
export function append(sessionID: string, entry: Record<string, unknown>): Effect.Effect<void> {
  return Effect.promise(async () => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const line = JSON.stringify({ time: new Date().toISOString(), sessionID, ...entry }) + "\n"
      await fs.appendFile(fileFor(sessionID), line, "utf8")
    } catch {
      // swallow — logging must never break the knowledge flow
    }
  })
}

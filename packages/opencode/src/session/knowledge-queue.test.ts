import { describe, expect, test } from "bun:test"
import { dedupeQueue, harvestGlobPaths, harvestGrepPaths, parseQueue, type QueueEntry } from "./knowledge-queue"

const q = (path: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  path,
  reason: "overflow",
  sessionID: "ses_test",
  time: "2026-06-10T00:00:00.000Z",
  ...over,
})

describe("parseQueue", () => {
  test("parses valid lines, skips corrupt ones and unknown reasons", () => {
    const lines = [
      JSON.stringify(q("src/a.ts")),
      "garbage",
      JSON.stringify({ path: "src/b.ts", reason: "nonsense", sessionID: "s", time: "t" }),
      JSON.stringify(q("src/c.ts", { reason: "grep-hit", hint: "pattern: foo" })),
    ].join("\n")
    const parsed = parseQueue(lines)
    expect(parsed.map((e) => e.path)).toEqual(["src/a.ts", "src/c.ts"])
    expect(parsed[1].hint).toBe("pattern: foo")
  })
})

describe("dedupeQueue", () => {
  test("keeps first occurrence (FIFO) but adopts a later hint", () => {
    const entries = [q("src/a.ts"), q("src/b.ts"), q("src/a.ts", { reason: "grep-hit", hint: "pattern: x" })]
    const deduped = dedupeQueue(entries)
    expect(deduped).toHaveLength(2)
    expect(deduped[0].path).toBe("src/a.ts")
    expect(deduped[0].reason).toBe("overflow")
    expect(deduped[0].hint).toBe("pattern: x")
  })
})

describe("harvestGrepPaths", () => {
  test("extracts absolute-path header lines only", () => {
    const output = [
      "Found 3 matches",
      "",
      "/Users/me/proj/src/foo.ts:",
      "  Line 12: const x = applyCaching()",
      "  Line 40: applyCaching(again)",
      "",
      "/Users/me/proj/src/bar dir/baz.ts:",
      "  Line 2: hit",
      "(Results truncated: showing 100 of 200 matches (100 hidden). Consider using a more specific path or pattern.)",
    ].join("\n")
    expect(harvestGrepPaths(output)).toEqual(["/Users/me/proj/src/foo.ts", "/Users/me/proj/src/bar dir/baz.ts"])
  })

  test("ignores indented and non-path lines", () => {
    expect(harvestGrepPaths("no matches found\n  Line 1: x:\n")).toEqual([])
  })
})

describe("harvestGlobPaths", () => {
  test("keeps absolute path lines, drops notes and blanks", () => {
    const output = [
      "/Users/me/proj/src/a.ts",
      "/Users/me/proj/src/b.ts",
      "",
      "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)",
    ].join("\n")
    expect(harvestGlobPaths(output)).toEqual(["/Users/me/proj/src/a.ts", "/Users/me/proj/src/b.ts"])
  })

  test("handles 'No files found'", () => {
    expect(harvestGlobPaths("No files found")).toEqual([])
  })
})

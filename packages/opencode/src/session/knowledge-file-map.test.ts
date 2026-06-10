import { describe, expect, test } from "bun:test"
import {
  contentHash,
  parseFileMap,
  serializeFileMap,
  upsertEntries,
  MAX_PURPOSE_CHARS,
  MAX_SYMBOLS,
  type FileMapEntry,
} from "./knowledge-file-map"

const entry = (over: Partial<FileMapEntry> = {}): FileMapEntry => ({
  path: "src/a.ts",
  purpose: "does a",
  symbols: ["a"],
  area: "Area A",
  hash: "abc123def456",
  seen: "2026-06-10T00:00:00.000Z",
  sessions: 1,
  ...over,
})

describe("contentHash", () => {
  test("deterministic and size-sensitive", () => {
    const head = new TextEncoder().encode("hello world")
    expect(contentHash(head, 11)).toBe(contentHash(head, 11))
    expect(contentHash(head, 11)).not.toBe(contentHash(head, 99))
    expect(contentHash(head, 11)).toHaveLength(12)
  })
})

describe("parseFileMap", () => {
  test("round-trips through serialize", () => {
    const map = new Map([["src/a.ts", entry()]])
    const parsed = parseFileMap(serializeFileMap(map))
    expect(parsed.get("src/a.ts")).toEqual(entry())
  })

  test("skips corrupt lines without losing the rest", () => {
    const good = JSON.stringify(entry())
    const parsed = parseFileMap(`not json\n${good}\n{"path":""}\n{"nope":1}\n`)
    expect(parsed.size).toBe(1)
    expect(parsed.get("src/a.ts")?.purpose).toBe("does a")
  })

  test("coerces missing/invalid fields to safe defaults", () => {
    const parsed = parseFileMap(`{"path":"src/x.ts","sessions":"nope","symbols":[1,"ok"]}`)
    const e = parsed.get("src/x.ts")!
    expect(e.purpose).toBe("")
    expect(e.symbols).toEqual(["ok"])
    expect(e.sessions).toBe(1)
  })

  test("caps purpose and symbols", () => {
    const long = "x".repeat(MAX_PURPOSE_CHARS + 50)
    const syms = Array.from({ length: MAX_SYMBOLS + 4 }, (_, i) => `s${i}`)
    const parsed = parseFileMap(JSON.stringify({ path: "src/y.ts", purpose: long, symbols: syms }))
    const e = parsed.get("src/y.ts")!
    expect(e.purpose).toHaveLength(MAX_PURPOSE_CHARS)
    expect(e.symbols).toHaveLength(MAX_SYMBOLS)
  })
})

describe("serializeFileMap", () => {
  test("sorts by path for stable diffs", () => {
    const map = new Map<string, FileMapEntry>([
      ["src/z.ts", entry({ path: "src/z.ts" })],
      ["src/a.ts", entry()],
    ])
    const lines = serializeFileMap(map).trim().split("\n")
    expect(JSON.parse(lines[0]).path).toBe("src/a.ts")
    expect(JSON.parse(lines[1]).path).toBe("src/z.ts")
  })

  test("empty map serializes to empty string", () => {
    expect(serializeFileMap(new Map())).toBe("")
  })
})

describe("upsertEntries", () => {
  test("new entry starts at sessions=1; re-confirm bumps and preserves omitted fields", () => {
    const map = new Map<string, FileMapEntry>()
    upsertEntries(map, [{ path: "src/a.ts", purpose: "does a", symbols: ["a"], area: "Area A", hash: "h1" }], "t1")
    expect(map.get("src/a.ts")?.sessions).toBe(1)

    upsertEntries(map, [{ path: "src/a.ts", purpose: "does a better" }], "t2")
    const e = map.get("src/a.ts")!
    expect(e.sessions).toBe(2)
    expect(e.purpose).toBe("does a better")
    expect(e.area).toBe("Area A")
    expect(e.hash).toBe("h1")
    expect(e.seen).toBe("t2")
  })

  test("ignores empty paths", () => {
    const map = new Map<string, FileMapEntry>()
    upsertEntries(map, [{ path: "  " }], "t1")
    expect(map.size).toBe(0)
  })
})

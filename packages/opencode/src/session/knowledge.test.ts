import { describe, expect, test } from "bun:test"
import { buildIndexPure, matchEntries, matchFileMap, parseCompleterResponse } from "./knowledge"
import type { FileMapEntry } from "./knowledge-file-map"

// ---- parseCompleterResponse -------------------------------------------------

const AREA_BLOCK = (name: string, doc: string, files: string[]) =>
  [
    "## AREA",
    `name: ${name}`,
    `doc: ${doc}`,
    `summary: ${name} summary line`,
    "## DOC",
    `# ${name}`,
    "",
    "Overview text.",
    "",
    "## Key Files",
    ...files.map((f) => `- \`${f}\` — use case`),
    "## END",
  ].join("\n")

describe("parseCompleterResponse", () => {
  test("single area without FILES (legacy shape)", () => {
    const out = parseCompleterResponse(AREA_BLOCK("Storage", "Storage/Storage.md", ["src/db.ts"]))
    expect(out.areas).toHaveLength(1)
    expect(out.areas[0].name).toBe("Storage")
    expect(out.areas[0].doc).toBe("Storage/Storage.md")
    expect(out.areas[0].body).toContain("## Key Files")
    expect(out.files).toHaveLength(0)
    expect(out.skip).toBe(false)
  })

  test("FILES section plus three areas", () => {
    const text = [
      "## FILES",
      "src/a.ts | parses things | parseA, ParseOpts",
      "- `src/b.ts` | writes things |",
      "src/c.ts | no symbols segment",
      "",
      AREA_BLOCK("Area One", "AreaOne/AreaOne.md", ["src/a.ts"]),
      AREA_BLOCK("Area Two", "AreaTwo/AreaTwo.md", ["src/b.ts"]),
      AREA_BLOCK("Area Three", "AreaThree/AreaThree.md", ["src/c.ts"]),
    ].join("\n")
    const out = parseCompleterResponse(text)
    expect(out.files).toEqual([
      { path: "src/a.ts", purpose: "parses things", symbols: ["parseA", "ParseOpts"] },
      { path: "src/b.ts", purpose: "writes things", symbols: [] },
      { path: "src/c.ts", purpose: "no symbols segment", symbols: [] },
    ])
    expect(out.areas.map((a) => a.name)).toEqual(["Area One", "Area Two", "Area Three"])
  })

  test("caps areas at three and counts dropped malformed blocks", () => {
    const good = AREA_BLOCK("A", "A/A.md", ["src/a.ts"])
    const malformed = "## AREA\nname: Broken\n## DOC\nbody without doc/summary fields\n## END"
    const out = parseCompleterResponse([malformed, good, good, good, good].join("\n"))
    expect(out.areas).toHaveLength(3)
    expect(out.droppedAreas).toBe(1)
  })

  test("malformed block among valid ones doesn't sink the rest", () => {
    const text = ["## AREA", "name: OnlyName", "## END", AREA_BLOCK("Valid", "Valid/Valid.md", ["src/v.ts"])].join("\n")
    const out = parseCompleterResponse(text)
    expect(out.areas).toHaveLength(1)
    expect(out.areas[0].name).toBe("Valid")
    expect(out.droppedAreas).toBe(1)
  })

  test("FILES lines with bad shapes are skipped", () => {
    const text = ["## FILES", "just some prose", "src/ok.ts | fine", "path with spaces.ts | nope", "| no path |"].join(
      "\n",
    )
    const out = parseCompleterResponse(text)
    expect(out.files).toEqual([{ path: "src/ok.ts", purpose: "fine", symbols: [] }])
  })

  test("SKIP is flagged", () => {
    const out = parseCompleterResponse("## SKIP")
    expect(out.skip).toBe(true)
    expect(out.areas).toHaveLength(0)
    expect(out.files).toHaveLength(0)
  })
})

// ---- matchEntries over a fixture KB ----------------------------------------

const TREE = [
  "# Drill-Down Tree",
  "",
  "## Storage & Persistence",
  "- **Storage & Persistence/Storage & Persistence.md** — XDG layout, sqlite session db, auth json persistence",
  "",
  "## Code Reviewer",
  "- **Code Reviewer/Code Reviewer.md** — post-turn peer-review pipeline gating responses",
  "",
  "## CLI Updater",
  "- **CLI Updater/CLI Updater.md** — auto-update checking for the cli tool",
].join("\n")

const DOCS = new Map<string, string>([
  [
    "Storage & Persistence/Storage & Persistence.md",
    "# Storage & Persistence\n\nSQLite database and json auth storage.\n\n## Key Files\n- `packages/core/src/global.ts` — xdg paths\n- `src/storage/db.ts` — sqlite access\n",
  ],
  [
    "Code Reviewer/Code Reviewer.md",
    "# Code Reviewer\n\nTriage then specialist reviewers with ledgers.\n\n## Key Files\n- `src/reviewer/triage.ts` — picks reviewers\n",
  ],
  [
    "CLI Updater/CLI Updater.md",
    "# CLI Updater\n\nChecks npm brew curl install methods for updates; caches results in a small database.\n",
  ],
])

const index = () => buildIndexPure(TREE, DOCS, new Map())

describe("matchEntries", () => {
  test("exact source-path query hits its area", () => {
    const m = matchEntries("what is src/storage/db.ts for?", index())
    expect(m[0]).toBe("Storage & Persistence/Storage & Persistence.md")
  })

  test("directory hit routes an unknown file to the documented area", () => {
    const m = matchEntries("add caching to src/storage/cache.ts", index())
    expect(m).toContain("Storage & Persistence/Storage & Persistence.md")
  })

  test("multi-token conceptual query matches", () => {
    const m = matchEntries("where is the sqlite database persistence handled?", index())
    expect(m[0]).toBe("Storage & Persistence/Storage & Persistence.md")
  })

  test("a lone token shared across docs does not select an area", () => {
    // "database" appears in two of three docs — one non-discriminating token
    // hit alone must not clear the text-only floor.
    const m = matchEntries("database", index())
    expect(m).toHaveLength(0)
  })

  test("a lone rare token IS allowed to select (it discriminates)", () => {
    const m = matchEntries("sqlite", index())
    expect(m).toEqual(["Storage & Persistence/Storage & Persistence.md"])
  })

  test("domain noun is no longer stopworded", () => {
    const m = matchEntries("how does the reviewer triage work", index())
    expect(m[0]).toBe("Code Reviewer/Code Reviewer.md")
  })
})

// ---- matchFileMap ------------------------------------------------------------

const FM = (path: string, purpose: string, symbols: string[]): [string, FileMapEntry] => [
  path,
  { path, purpose, symbols, area: "Area", hash: "h", seen: "t", sessions: 1 },
]

describe("matchFileMap", () => {
  const fileMap = new Map<string, FileMapEntry>([
    FM("src/session/knowledge.ts", "knowledge feeder and completer", ["feeder", "completer", "matchEntries"]),
    FM("src/session/prompt.ts", "main prompt loop", ["runLoop"]),
    FM("src/storage/db.ts", "sqlite database access", ["Database"]),
  ])
  const idx = () => buildIndexPure(TREE, DOCS, fileMap)

  test("exact path query wins", () => {
    const hits = matchFileMap("explain src/session/knowledge.ts", idx())
    expect(hits[0]?.path).toBe("src/session/knowledge.ts")
  })

  test("symbol token surfaces its file", () => {
    const hits = matchFileMap("where is the completer triggered?", idx())
    expect(hits.some((h) => h.path === "src/session/knowledge.ts")).toBe(true)
  })

  test("single weak purpose-token overlap does not surface a file", () => {
    const hits = matchFileMap("main", idx())
    expect(hits).toHaveLength(0)
  })
})

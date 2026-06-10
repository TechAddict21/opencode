import { describe, expect, test } from "bun:test"
import { DOC_TRUNC_MARKER, fitDoc, mergeAreaDoc, parseTree, splitForFit, upsertAreaSection } from "./knowledge-base"

const DOC = `# Storage

Overview line about storage.

## Key Files
- \`src/storage/db.ts\` — sqlite access
- \`src/storage/json.ts\` — json persistence

## Notes
Gotcha: locks are per-process.
`

describe("parseTree", () => {
  test("parses area headers with doc bullets and legacy read paths", () => {
    const tree = [
      "# Drill-Down Tree",
      "",
      "## Storage",
      "- **Storage/Storage.md** — how storage works",
      "  → Read: src/db.ts, src/json.ts",
      "",
      "## CLI",
      "- **cli.md** — cli entry",
    ].join("\n")
    const entries = parseTree(tree)
    expect(entries).toHaveLength(2)
    expect(entries[0].entryPath).toBe("Storage/Storage.md")
    expect(entries[0].readPaths).toEqual(["src/db.ts", "src/json.ts"])
    // slash-less doc resolves under its area header
    expect(entries[1].entryPath).toBe("CLI/cli.md")
  })

  test("doc paths with spaces parse (regression: completer derives folders from area names)", () => {
    const tree = [
      "## Storage & Persistence",
      "- **Storage & Persistence/Storage & Persistence.md** — XDG layout and sqlite db",
    ].join("\n")
    const entries = parseTree(tree)
    expect(entries).toHaveLength(1)
    expect(entries[0].entryPath).toBe("Storage & Persistence/Storage & Persistence.md")
    expect(entries[0].description).toBe("XDG layout and sqlite db")
  })
})

describe("splitForFit / fitDoc", () => {
  test("returns doc unchanged when under cap", () => {
    expect(fitDoc(DOC, 10_000)).toBe(DOC)
  })

  test("prioritizes lead + Key Files when trimming", () => {
    const fitted = fitDoc(DOC, DOC.indexOf("## Notes"))
    expect(fitted).toContain("Overview line")
    expect(fitted).toContain("## Key Files")
    expect(fitted).not.toContain("Gotcha")
    expect(fitted).toContain(DOC_TRUNC_MARKER.trim())
  })

  test("never emits a partial Key Files bullet", () => {
    const bullets = Array.from({ length: 50 }, (_, i) => `- \`src/very/long/path/file${i}.ts\` — purpose ${i}`)
    const doc = `# X\n\nlead\n\n## Key Files\n${bullets.join("\n")}\n`
    const fitted = fitDoc(doc, 400)
    for (const line of fitted.split("\n")) {
      if (line.startsWith("- `")) expect(line).toMatch(/`src\/very\/long\/path\/file\d+\.ts` — purpose \d+$/)
    }
    expect(fitted.length).toBeLessThanOrEqual(400)
  })

  test("splitForFit keeps section titles literal", () => {
    const { lead, sections } = splitForFit(DOC)
    expect(lead).toContain("# Storage")
    expect(sections.map((s) => s.title)).toEqual(["## Key Files", "## Notes"])
  })
})

describe("mergeAreaDoc", () => {
  test("carries over old Key Files bullets the new doc omits", () => {
    const newDoc = `# Storage\n\nFresh overview.\n\n## Key Files\n- \`src/storage/db.ts\` — sqlite access (updated)\n`
    const merged = mergeAreaDoc(DOC, newDoc)
    expect(merged).toContain("sqlite access (updated)")
    expect(merged).toContain("`src/storage/json.ts` — json persistence")
  })

  test("appends old Key Files section wholesale when new doc has none", () => {
    const newDoc = `# Storage\n\nOnly an overview now.\n`
    const merged = mergeAreaDoc(DOC, newDoc)
    expect(merged).toContain("## Key Files")
    expect(merged).toContain("`src/storage/db.ts`")
  })

  test("returns new doc untouched when old doc had no Key Files", () => {
    const old = `# Storage\n\nNo key files here.\n`
    const newDoc = `# Storage\n\nNew.\n\n## Key Files\n- \`src/a.ts\` — a\n`
    expect(mergeAreaDoc(old, newDoc)).toBe(newDoc)
  })
})

describe("upsertAreaSection", () => {
  const tree = `# Tree\n\npreamble\n\n## Storage\n- **Storage/Storage.md** — old summary\n\n## CLI\n- **CLI/cli.md** — cli\n`

  test("replaces an existing area section in place", () => {
    const next = upsertAreaSection(tree, "Storage", "- **Storage/Storage.md** — NEW summary")
    expect(next).toContain("NEW summary")
    expect(next).not.toContain("old summary")
    expect(next).toContain("## CLI")
    expect(next).toContain("preamble")
  })

  test("appends a new area at the end", () => {
    const next = upsertAreaSection(tree, "Reviewer", "- **Reviewer/Reviewer.md** — reviews")
    expect(next).toContain("## Reviewer")
    expect(next.indexOf("## Reviewer")).toBeGreaterThan(next.indexOf("## CLI"))
  })
})

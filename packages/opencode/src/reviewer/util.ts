/**
 * Extracts a JSON object from text that may contain markdown or other content.
 * Uses brace depth tracking to find the outermost valid JSON object.
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  let depth = 0
  let start = -1
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") {
      if (depth === 0) start = i
      depth++
    } else if (trimmed[i] === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1))
        } catch {
          // Continue searching for next valid JSON object
        }
      }
    }
  }
  return null
}

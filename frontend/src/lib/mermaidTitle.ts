/**
 * Reads `title:` from a Mermaid YAML frontmatter block:
 *
 *   ---
 *   title: Auth flow
 *   ---
 *   flowchart TD
 *
 * Mirrors `mermaid_frontmatter_title` in src-tauri so lists and the live editor agree.
 */
export function parseMermaidTitle(source: string): string | null {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return null
  }
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '---') {
      return null
    }
    const match = /^title:\s*(.*)$/.exec(trimmed)
    if (match) {
      const value = match[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim()
      return value || null
    }
  }
  return null
}

/** Turns a diagram title into a safe file stem, e.g. `Order: ER` → `Order ER`. */
export function titleToFileStem(title: string) {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Identifies the Mermaid diagram type from the first meaningful line after
 * frontmatter, blank lines, and `%%` comments:
 *
 *   ---
 *   title: Auth flow
 *   ---
 *   flowchart TD
 *
 * → "flowchart". Mirrors `mermaid_diagram_type` in src-tauri so lists and the
 * live editor agree on the normalized names ("flowchart", "er", "sequence", ...).
 */

const DIAGRAM_TYPE_KEYWORDS: Record<string, string> = {
  flowchart: 'flowchart',
  graph: 'flowchart',
  sequenceDiagram: 'sequence',
  classDiagram: 'class',
  'classDiagram-v2': 'class',
  erDiagram: 'er',
  stateDiagram: 'state',
  'stateDiagram-v2': 'state',
  gantt: 'gantt',
  pie: 'pie',
  mindmap: 'mindmap',
  journey: 'journey',
  timeline: 'timeline',
  gitGraph: 'git',
  quadrantChart: 'quadrant',
  requirementDiagram: 'requirement',
  C4Context: 'c4',
  C4Container: 'c4',
  C4Component: 'c4',
  C4Dynamic: 'c4',
  C4Deployment: 'c4',
}

export function parseMermaidDiagramType(source: string): string | null {
  let lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (close === -1) {
      return null
    }
    lines = lines.slice(close + 1)
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) {
      continue
    }
    const keyword = /^[A-Za-z0-9-]+/.exec(trimmed)?.[0] ?? ''
    return DIAGRAM_TYPE_KEYWORDS[keyword] ?? null
  }
  return null
}

/**
 * Pulls the named things out of a Mermaid diagram using Mermaid's own parser.
 *
 * `mermaid.mermaidAPI.getDiagramFromText` returns the parsed `Diagram`, whose
 * `db` is the same object the renderer reads — so the ids we record here are
 * exactly the ids that end up in the rendered SVG (`flowchart-A-0`,
 * `classId-User-2`, `entity-USER-0`, `state-Idle-1`). Sequence diagrams have no
 * per-actor id; their renderer stamps `name="<actor id>"` instead.
 *
 * `Diagram.db` is typed as the near-empty `DiagramDB`, so each branch narrows it
 * to the concrete database class Mermaid ships types for.
 */

import mermaid from 'mermaid'
import type { ClassDB } from 'mermaid/dist/diagrams/class/classDb.js'
import type { ErDB } from 'mermaid/dist/diagrams/er/erDb.js'
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js'
import type { SequenceDB } from 'mermaid/dist/diagrams/sequence/sequenceDb.js'
import type { StateDB } from 'mermaid/dist/diagrams/state/stateDb.js'
import { tokenizeLabel, type SymbolKind } from './symbols'

/** One thing the parser named, before it is attached to a document. */
export type ExtractedSymbol = {
  display: string
  kind: SymbolKind
  owner?: string
  /** CSS selectors for the rendered node, most specific first. */
  selectors: string[]
}

export type MermaidExtraction = {
  /** Mermaid's own diagram type: `flowchart-v2`, `class`, `er`, `sequence`, `stateDiagram`… */
  diagramType: string
  symbols: ExtractedSymbol[]
}

/** Mermaid's DOM ids are `<prefix>-<id>-<counter>`; the counter is render order, so match the stem. */
function nodeSelectors(domId: string | undefined, prefix: string, id: string) {
  const selectors: string[] = []
  if (domId) {
    selectors.push(`#${CSS.escape(domId)}`)
  }
  selectors.push(`[id^=${JSON.stringify(`${prefix}-${id}-`)}]`)
  return selectors
}

function collect() {
  const symbols: ExtractedSymbol[] = []
  const seen = new Set<string>()
  return {
    symbols,
    add(symbol: ExtractedSymbol) {
      const display = symbol.display.trim()
      if (!display) {
        return
      }
      const key = `${symbol.kind}:${symbol.owner ?? ''}:${display}`
      if (seen.has(key)) {
        return
      }
      seen.add(key)
      symbols.push({ ...symbol, display })
    },
  }
}

/** `+String name` parses to the member id `String name`; the name is the last word. */
function memberName(id: string) {
  const parts = id.trim().split(/\s+/)
  return parts[parts.length - 1] ?? id
}

function extractFlowchart(db: FlowDB) {
  const out = collect()
  for (const [id, vertex] of db.getVertices()) {
    const selectors = nodeSelectors(vertex.domId, 'flowchart', id)
    out.add({ display: id, kind: 'node', selectors })
    if (vertex.text && vertex.text !== id) {
      out.add({ display: vertex.text, kind: 'node', selectors })
    }
  }
  return out.symbols
}

function extractClass(db: ClassDB) {
  const out = collect()
  for (const [id, node] of db.getClasses()) {
    const selectors = nodeSelectors(node.domId, 'classId', id)
    out.add({ display: node.label || id, kind: 'class', selectors })
    for (const member of [...node.members, ...node.methods]) {
      out.add({ display: memberName(member.id), kind: 'member', owner: node.label || id, selectors })
    }
  }
  return out.symbols
}

function extractEr(db: ErDB) {
  const out = collect()
  for (const [name, entity] of db.getEntities()) {
    // ER entity nodes carry the rendered id directly, e.g. `entity-USER-0`.
    const selectors = nodeSelectors(entity.id, 'entity', name)
    out.add({ display: entity.label || name, kind: 'entity', selectors })
    for (const attribute of entity.attributes) {
      out.add({ display: attribute.name, kind: 'attribute', owner: entity.label || name, selectors })
    }
  }
  return out.symbols
}

function extractSequence(db: SequenceDB) {
  const out = collect()
  for (const [id, actor] of db.getActors()) {
    // The sequence renderer has no node ids; it stamps `name` on the box and lifeline.
    const selectors = [`[name=${JSON.stringify(id)}]`]
    out.add({ display: id, kind: 'participant', selectors })
    if (actor.description && actor.description !== id) {
      out.add({ display: actor.description, kind: 'participant', selectors })
    }
  }
  return out.symbols
}

function extractState(db: StateDB) {
  const out = collect()
  // `getStates()` has no dom ids; `getData()` is what the renderer consumes.
  const nodes = db.getData().nodes
  const domIdById = new Map(nodes.map((node) => [node.id, node.domId]))
  for (const [id, state] of db.getStates()) {
    if (state.type === 'start' || state.type === 'end' || id.endsWith('_start') || id.endsWith('_end')) {
      continue
    }
    const selectors = nodeSelectors(domIdById.get(id), 'state', id)
    out.add({ display: id, kind: 'state', selectors })
    for (const description of state.descriptions ?? []) {
      out.add({ display: description, kind: 'state', selectors })
    }
  }
  return out.symbols
}

/** Last resort for diagram types we have no reader for: tokenise the source's labels. */
function extractByTokenizing(source: string) {
  const out = collect()
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) {
      continue
    }
    for (const token of tokenizeLabel(trimmed)) {
      out.add({ display: token.display, kind: 'text', owner: token.owner, selectors: [] })
    }
  }
  return out.symbols
}

let isInitialized = false

/**
 * `getDiagramFromText` relies on the diagram registry that `mermaid.initialize`
 * fills in, so make sure the same config the preview uses has been applied.
 */
export function initializeMermaid() {
  if (isInitialized) {
    return
  }
  isInitialized = true
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    // Plain SVG text everywhere: `<foreignObject>` labels neither rasterise to
    // PNG nor expose their text to the highlight pass.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  })
}

/**
 * Parses Mermaid source and returns everything it named. Frontmatter is handled
 * by Mermaid's own preprocessor, so the source is passed through as written.
 */
export async function extractMermaidSymbols(source: string): Promise<MermaidExtraction | null> {
  const text = source.replace(/^\uFEFF/, '').trim()
  if (!text) {
    return null
  }
  initializeMermaid()
  let diagram
  try {
    diagram = await mermaid.mermaidAPI.getDiagramFromText(text)
  } catch {
    return null
  }

  const { db, type } = diagram
  switch (type) {
    case 'flowchart':
    case 'flowchart-v2':
    case 'graph':
      return { diagramType: type, symbols: extractFlowchart(db as unknown as FlowDB) }
    case 'class':
    case 'classDiagram':
      return { diagramType: type, symbols: extractClass(db as unknown as ClassDB) }
    case 'er':
      return { diagramType: type, symbols: extractEr(db as unknown as ErDB) }
    case 'sequence':
      return { diagramType: type, symbols: extractSequence(db as unknown as SequenceDB) }
    case 'stateDiagram':
    case 'state':
      return { diagramType: type, symbols: extractState(db as unknown as StateDB) }
    default:
      return { diagramType: type, symbols: extractByTokenizing(text) }
  }
}

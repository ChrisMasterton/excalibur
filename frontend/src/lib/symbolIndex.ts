/**
 * Builds the per-project symbol index: one pass over a project's diagrams that
 * records every named thing they mention, keyed so the same concept groups
 * across diagram types (`USER`, `User`, `user_account` all land together).
 */

import { extractMermaidSymbols } from './mermaidSymbols'
import { fileStem } from './paths'
import { parseMermaidTitle } from './mermaidTitle'
import {
  normalizeSymbol,
  qualifiedSymbol,
  tokenizeLabel,
  type SymbolDocument,
  type SymbolEntry,
  type SymbolKind,
  type SymbolLocator,
} from './symbols'
import type { DiagramKind, ProjectFile } from '../types'

/** The `customData` Excalibur stamps on elements it converted from Mermaid. */
export type ExcaliburCustomData = {
  symbol: string
  display: string
  kind: SymbolKind
  owner?: string
}

type CustomDataCarrier = {
  id?: unknown
  type?: unknown
  text?: unknown
  originalText?: unknown
  containerId?: unknown
  isDeleted?: unknown
  customData?: { excalibur?: unknown }
}

export const EXCALIBUR_CUSTOM_DATA_KEY = 'excalibur'

const SYMBOL_KINDS = new Set<string>([
  'class',
  'entity',
  'member',
  'attribute',
  'participant',
  'node',
  'state',
  'text',
])

/** Reads Excalibur's own stamp off an element, ignoring anything that is not ours. */
export function readExcaliburCustomData(element: unknown): ExcaliburCustomData | null {
  if (!element || typeof element !== 'object') {
    return null
  }
  const stamped = (element as CustomDataCarrier).customData?.[EXCALIBUR_CUSTOM_DATA_KEY]
  if (!stamped || typeof stamped !== 'object') {
    return null
  }
  const { symbol, display, kind, owner } = stamped as Record<string, unknown>
  if (typeof symbol !== 'string' || typeof display !== 'string' || typeof kind !== 'string') {
    return null
  }
  if (!SYMBOL_KINDS.has(kind)) {
    return null
  }
  return {
    symbol,
    display,
    kind: kind as SymbolKind,
    owner: typeof owner === 'string' ? owner : undefined,
  }
}

function documentFor(file: ProjectFile, contents: string): SymbolDocument {
  const title =
    file.title?.trim() ||
    (file.kind === 'mermaid' ? parseMermaidTitle(contents)?.trim() : '') ||
    fileStem(file.path)
  return { path: file.path, kind: file.kind, title: title || fileStem(file.path) }
}

function pushEntry(
  entries: SymbolEntry[],
  seen: Map<string, SymbolEntry>,
  entry: Omit<SymbolEntry, 'symbol'> & { symbol: string },
) {
  const key = `${entry.symbol}|${entry.kind}|${entry.owner ?? ''}|${entry.display}`
  const existing = seen.get(key)
  if (existing) {
    existing.locators.push(...entry.locators)
    return
  }
  seen.set(key, entry)
  entries.push(entry)
}

async function indexMermaidFile(file: ProjectFile, contents: string): Promise<SymbolEntry[]> {
  const extraction = await extractMermaidSymbols(contents)
  if (!extraction) {
    return []
  }
  const doc = documentFor(file, contents)
  const entries: SymbolEntry[] = []
  const seen = new Map<string, SymbolEntry>()

  for (const symbol of extraction.symbols) {
    const locator: SymbolLocator = {
      target: 'mermaid',
      selectors: symbol.selectors,
      text: symbol.display,
    }
    pushEntry(entries, seen, {
      symbol: normalizeSymbol(symbol.display),
      display: symbol.display,
      kind: symbol.kind,
      owner: symbol.owner,
      doc,
      diagramType: extraction.diagramType,
      locators: [locator],
    })
    if (symbol.owner) {
      // Members are reachable both on their own and as `Owner.member`.
      pushEntry(entries, seen, {
        symbol: qualifiedSymbol(symbol.owner, symbol.display),
        display: `${symbol.owner}.${symbol.display}`,
        kind: symbol.kind,
        owner: symbol.owner,
        doc,
        diagramType: extraction.diagramType,
        locators: [locator],
      })
    }
  }
  return entries
}

type ExcalidrawSceneFile = { elements?: unknown[] }

function labelOf(element: CustomDataCarrier) {
  const text = typeof element.originalText === 'string' ? element.originalText : element.text
  return typeof text === 'string' ? text : ''
}

function indexExcalidrawFile(file: ProjectFile, contents: string): SymbolEntry[] {
  let scene: ExcalidrawSceneFile
  try {
    scene = JSON.parse(contents) as ExcalidrawSceneFile
  } catch {
    return []
  }
  const doc = documentFor(file, contents)
  const entries: SymbolEntry[] = []
  const seen = new Map<string, SymbolEntry>()
  const elements = (scene.elements ?? []) as CustomDataCarrier[]

  for (const element of elements) {
    if (element.isDeleted === true || typeof element.id !== 'string') {
      continue
    }
    const elementId = element.id
    // A converted drawing carries the exact symbol; only guess for hand-drawn ones.
    const stamped = readExcaliburCustomData(element)
    if (stamped) {
      pushEntry(entries, seen, {
        symbol: stamped.symbol,
        display: stamped.display,
        kind: stamped.kind,
        owner: stamped.owner,
        doc,
        diagramType: 'excalidraw',
        locators: [{ target: 'excalidraw', elementId }],
      })
      continue
    }
    if (element.type !== 'text') {
      continue
    }
    // Highlighting the container reads better than highlighting its label alone.
    const target = typeof element.containerId === 'string' ? element.containerId : elementId
    for (const token of tokenizeLabel(labelOf(element))) {
      pushEntry(entries, seen, {
        symbol: token.owner ? qualifiedSymbol(token.owner, token.display) : normalizeSymbol(token.display),
        display: token.owner ? `${token.owner}.${token.display}` : token.display,
        kind: 'text',
        owner: token.owner,
        doc,
        diagramType: 'excalidraw',
        locators: [{ target: 'excalidraw', elementId: target }],
      })
    }
  }
  return entries
}

export function indexFile(file: ProjectFile, contents: string): Promise<SymbolEntry[]> {
  return file.kind === 'mermaid'
    ? indexMermaidFile(file, contents)
    : Promise.resolve(indexExcalidrawFile(file, contents))
}

/** One document that mentions a symbol, plus every entry in it that matched. */
export type SymbolDocumentHit = {
  doc: SymbolDocument
  entries: SymbolEntry[]
  /** Number of places in that document the symbol turns up. */
  count: number
}

export type SymbolSearchResult = {
  symbol: string
  display: string
  kind: SymbolKind
  owner?: string
  docs: SymbolDocumentHit[]
}

/** Groups matching entries into symbol → documents, ordered by how widely used they are. */
export function searchEntries(entries: readonly SymbolEntry[], query: string, limit = 40) {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return []
  }
  const bySymbol = new Map<string, SymbolSearchResult>()

  for (const entry of entries) {
    if (!entry.display.toLowerCase().includes(trimmed)) {
      continue
    }
    let result = bySymbol.get(entry.symbol)
    if (!result) {
      result = {
        symbol: entry.symbol,
        display: entry.display,
        kind: entry.kind,
        owner: entry.owner,
        docs: [],
      }
      bySymbol.set(entry.symbol, result)
    }
    let hit = result.docs.find((candidate) => candidate.doc.path === entry.doc.path)
    if (!hit) {
      hit = { doc: entry.doc, entries: [], count: 0 }
      result.docs.push(hit)
    }
    hit.entries.push(entry)
    hit.count += entry.locators.length
  }

  const rank = (result: SymbolSearchResult) => {
    const exact = result.display.toLowerCase() === trimmed ? 0 : 1
    const startsWith = result.display.toLowerCase().startsWith(trimmed) ? 0 : 1
    return [exact, startsWith, -result.docs.length, result.display.toLowerCase()] as const
  }

  return [...bySymbol.values()]
    .sort((a, b) => {
      const left = rank(a)
      const right = rank(b)
      for (let index = 0; index < 3; index += 1) {
        const difference = (left[index] as number) - (right[index] as number)
        if (difference !== 0) {
          return difference
        }
      }
      return String(left[3]).localeCompare(String(right[3]))
    })
    .slice(0, limit)
}

/** Everything the highlight pass needs once a document is on screen. */
export type SymbolHighlight = {
  path: string
  kind: DiagramKind
  display: string
  locators: SymbolLocator[]
}

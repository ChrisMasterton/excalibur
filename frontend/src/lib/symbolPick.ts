/**
 * Turns something the user clicked into the symbol it stands for.
 *
 * This is the index's extraction pass run backwards, against the document that
 * is actually on screen: Mermaid nodes are matched with the same selectors
 * `mermaidHighlight` uses to light them up, and Excalidraw elements are read
 * from the `customData` Excalibur stamps on conversions, falling back to the
 * same label tokenizer the index uses for hand-drawn text.
 */

import { symbolHighlightTarget } from './mermaidHighlight'
import type { ExtractedSymbol } from './mermaidSymbols'
import { readExcaliburCustomData } from './symbolIndex'
import { normalizeSymbol, tokenizeLabel, type SymbolKind } from './symbols'

/** One symbol the user pointed at, in the shape the references lookup needs. */
export type PickedSymbol = {
  /** Normalised grouping key, the same one `SymbolEntry.symbol` carries. */
  symbol: string
  display: string
  kind: SymbolKind
  owner?: string
}

/** Elements a click could resolve through, from the clicked node up to the SVG. */
function ancestorChain(target: Element) {
  const chain: Element[] = []
  for (let node: Element | null = target; node; node = node.parentElement) {
    chain.push(node)
    if (node.tagName.toLowerCase() === 'svg') {
      break
    }
  }
  return chain
}

function matchesSelector(element: Element, selector: string) {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/**
 * A node can carry several symbols (a class box also owns its members), so the
 * one whose label is what the user actually read wins, then the unowned one.
 */
function bestCandidate(candidates: readonly ExtractedSymbol[], clickedText: string): ExtractedSymbol | null {
  if (!candidates.length) {
    return null
  }
  const wanted = clickedText.trim().toLowerCase()
  return (
    candidates.find((symbol) => symbol.display.trim().toLowerCase() === wanted) ??
    candidates.find((symbol) => !symbol.owner) ??
    candidates[0]
  )
}

function toPicked(symbol: ExtractedSymbol): PickedSymbol {
  // Always the unqualified key: `USER`, `User` and `user_account` are one symbol.
  return {
    symbol: normalizeSymbol(symbol.display),
    display: symbol.display,
    kind: symbol.kind,
    owner: symbol.owner,
  }
}

/**
 * Resolves a clicked element inside a rendered Mermaid diagram against the
 * symbols its source declares. Returns null for empty space, edges, and labels
 * that belong to nothing named.
 */
export function pickMermaidSymbol(target: Element, symbols: readonly ExtractedSymbol[]): PickedSymbol | null {
  const chain = ancestorChain(target)
  const clickedText = symbolHighlightTarget(target).textContent ?? ''

  const bySelector = symbols.filter((symbol) =>
    symbol.selectors.some((selector) => chain.some((element) => matchesSelector(element, selector))),
  )
  const selected = bestCandidate(bySelector, clickedText)
  if (selected) {
    return toPicked(selected)
  }

  // Diagram types whose renderer labels nothing still match on the rendered text.
  const wanted = clickedText.trim().toLowerCase()
  if (!wanted) {
    return null
  }
  const byText = symbols.filter((symbol) => symbol.display.trim().toLowerCase() === wanted)
  const matched = bestCandidate(byText, clickedText)
  return matched ? toPicked(matched) : null
}

type LabelledElement = {
  type?: unknown
  text?: unknown
  originalText?: unknown
}

/**
 * Resolves one Excalidraw scene element: the exact symbol when Excalibur
 * converted it, otherwise the first identifier-ish word in its label.
 */
export function pickExcalidrawSymbol(element: unknown): PickedSymbol | null {
  const stamped = readExcaliburCustomData(element)
  if (stamped) {
    return { symbol: stamped.symbol, display: stamped.display, kind: stamped.kind, owner: stamped.owner }
  }
  if (!element || typeof element !== 'object') {
    return null
  }
  const carrier = element as LabelledElement
  if (carrier.type !== 'text') {
    return null
  }
  const label = typeof carrier.originalText === 'string' ? carrier.originalText : carrier.text
  if (typeof label !== 'string') {
    return null
  }
  const tokens = tokenizeLabel(label)
  const token = tokens.find((candidate) => !candidate.owner) ?? tokens[0]
  if (!token) {
    return null
  }
  return { symbol: normalizeSymbol(token.display), display: token.display, kind: 'text', owner: token.owner }
}

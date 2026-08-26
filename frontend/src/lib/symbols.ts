/**
 * The vocabulary the project symbol index is built from.
 *
 * A *symbol* is one named thing in a project — `User` is the same concept whether
 * it turns up as an ER entity `USER`, a class `User`, or a sequence participant
 * `User`. `symbol` is the normalised key those spellings share; `display` keeps
 * whatever the diagram actually wrote.
 */

import type { DiagramKind } from '../types'

export type SymbolKind =
  | 'class'
  | 'entity'
  | 'member'
  | 'attribute'
  | 'participant'
  | 'node'
  | 'state'
  | 'text'

/** How a match is found again in the rendered document. */
export type SymbolLocator =
  | {
      target: 'mermaid'
      /** CSS selectors to try, most specific first (ids the parser used). */
      selectors: string[]
      /** Rendered label, for the fallback that matches on text. */
      text: string
    }
  | { target: 'excalidraw'; elementId: string }

export type SymbolDocument = {
  path: string
  kind: DiagramKind
  /** Frontmatter title, else the file stem. */
  title: string
  /** Normalized Mermaid diagram type ("flowchart", "er", "sequence", ...). */
  diagramType?: string | null
}

export type SymbolEntry = {
  /** Normalised grouping key, e.g. `useraccount` for `USER_ACCOUNT` and `UserAccount`. */
  symbol: string
  /** The text as the diagram wrote it. */
  display: string
  kind: SymbolKind
  /** Owning class/entity for members and attributes. */
  owner?: string
  doc: SymbolDocument
  /** Mermaid diagram type (`classDiagram`, `erDiagram`, …) or `excalidraw`. */
  diagramType: string
  locators: SymbolLocator[]
}

export const SYMBOL_KIND_LABELS: Record<SymbolKind, string> = {
  class: 'class',
  entity: 'entity',
  member: 'member',
  attribute: 'attribute',
  participant: 'participant',
  node: 'node',
  state: 'state',
  text: 'text',
}

/** One-line description of what a symbol is, e.g. `member of User`. */
export function symbolKindHint(kind: SymbolKind, owner?: string) {
  return owner ? `${SYMBOL_KIND_LABELS[kind]} of ${owner}` : SYMBOL_KIND_LABELS[kind]
}

/**
 * The key symbols group by: case, spaces, underscores and hyphens are noise, so
 * `USER`, `User`, `user_account` and `UserAccount` all collapse together. Dots
 * survive so `User.name` stays distinct from a class called `Username`.
 */
export function normalizeSymbol(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_\-()[\]{}"'`]+/g, '')
}

/** `owner.member`, used as the qualified key for class members and entity attributes. */
export function qualifiedSymbol(owner: string, member: string) {
  return `${normalizeSymbol(owner)}.${normalizeSymbol(member)}`
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'end', 'for',
  'from', 'has', 'have', 'if', 'in', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'so', 'start',
  'than', 'that', 'the', 'then', 'this', 'to', 'up', 'was', 'when', 'while', 'why', 'with',
  'yes', 'you', 'done', 'ok', 'else', 'true', 'false', 'null',
])

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Is this token plausibly a name rather than prose? Diagram labels are mostly
 * short, so the test is deliberately generous: anything capitalised, CamelCase,
 * snake_case, or ALLCAPS counts; bare lowercase prose does not.
 */
export function isIdentifierLike(token: string) {
  if (!IDENTIFIER.test(token) || token.length < 2) {
    return false
  }
  if (STOP_WORDS.has(token.toLowerCase())) {
    return false
  }
  return /[A-Z]/.test(token) || token.includes('_')
}

export type LabelToken = { display: string; owner?: string }

/**
 * Pulls the identifier-ish parts out of a free-text label. Handles the shapes
 * diagrams actually use: `Type.member`, `name: Type`, `create(user)` and plain
 * `CamelCase` / `snake_case` words; prose is dropped.
 */
export function tokenizeLabel(label: string): LabelToken[] {
  const tokens: LabelToken[] = []
  const seen = new Set<string>()

  const push = (display: string, owner?: string, force = false) => {
    const trimmed = display.trim()
    if (!(force ? IDENTIFIER.test(trimmed) && trimmed.length >= 2 : isIdentifierLike(trimmed))) {
      return
    }
    const key = `${owner ? `${owner}.` : ''}${trimmed}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    tokens.push(owner ? { display: trimmed, owner } : { display: trimmed })
  }

  for (const raw of label.split(/[\n,;|/\\]+/)) {
    const chunk = raw.trim()
    // `Type.member`: the dot separates owner from member.
    const dotted = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(chunk)
    if (dotted) {
      push(dotted[1])
      push(dotted[2], dotted[1])
      continue
    }
    // `name: Type` — a field declaration, so the field name counts even in lower case.
    const declared = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_]*)$/.exec(chunk)
    if (declared) {
      push(declared[1], undefined, true)
      push(declared[2])
      continue
    }
    for (const word of chunk.split(/[^A-Za-z0-9_]+/)) {
      push(word)
    }
  }
  return tokens
}

/** Case-insensitive substring match on the text the diagram displayed. */
export function matchesQuery(entry: SymbolEntry, query: string) {
  return entry.display.toLowerCase().includes(query)
}

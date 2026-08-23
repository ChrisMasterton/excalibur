import { useCallback, useMemo, useState } from 'react'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import type { SymbolIndexApi } from './useSymbolIndex'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import type { PickedSymbol } from '../lib/symbolPick'
import type { OpenDocument } from '../types'

type UseSymbolReferencesOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  symbolIndex: SymbolIndexApi
  activeDocument: OpenDocument | null
  /** Opens a document and marks the matches on it (`useDocumentActions`). */
  revealSymbol: (hit: SymbolDocumentHit) => Promise<void>
  clearHighlight: () => void
}

export type SymbolReferencesApi = ReturnType<typeof useSymbolReferences>

/**
 * "What else mentions this?" — the panel behind a click on a diagram.
 *
 * Clicks are resolved by whichever engine owns the surface, then the project
 * symbol index answers which documents name the same symbol. The project is
 * pinned when the symbol is picked, so flipping through the results (which
 * changes the active tab) never re-scopes the list underneath the user.
 */
export function useSymbolReferences({
  excalidraw,
  mermaid,
  symbolIndex,
  activeDocument,
  revealSymbol,
  clearHighlight,
}: UseSymbolReferencesOptions) {
  const [reference, setReference] = useState<{ symbol: PickedSymbol; projectPath: string | null } | null>(null)

  const { ensureIndex, findProject, documentsForSymbol, status } = symbolIndex
  const { resolveSymbolAt: resolveExcalidrawSymbol, hasHighlight: hasExcalidrawHighlight } = excalidraw
  const { resolveSymbolAt: resolveMermaidSymbol, hasHighlight: hasMermaidHighlight } = mermaid
  const activePath = activeDocument?.path ?? null

  const close = useCallback(() => setReference(null), [])

  /** Opens the panel for a symbol. An unresolvable click is simply ignored. */
  const show = useCallback(
    (symbol: PickedSymbol | null) => {
      if (!symbol) {
        return
      }
      ensureIndex()
      setReference({ symbol, projectPath: findProject(activePath)?.path ?? null })
    },
    [activePath, ensureIndex, findProject],
  )

  const handleMermaidClick = useCallback(
    (target: Element) => {
      void resolveMermaidSymbol(target).then(show)
    },
    [resolveMermaidSymbol, show],
  )

  const handleExcalidrawClick = useCallback(
    (clientX: number, clientY: number) => {
      show(resolveExcalidrawSymbol(clientX, clientY))
    },
    [resolveExcalidrawSymbol, show],
  )

  const documents = useMemo(
    () => (reference ? documentsForSymbol(reference.projectPath, reference.symbol.symbol) : []),
    [documentsForSymbol, reference],
  )

  const projectName = useMemo(
    () => (reference?.projectPath ? findProject(reference.projectPath)?.name ?? null : null),
    [findProject, reference],
  )

  const select = useCallback((hit: SymbolDocumentHit) => void revealSymbol(hit), [revealSymbol])

  /**
   * Escape peels one layer at a time: the marks on the diagram first, then the
   * panel, so a symbol can be inspected without losing the list.
   */
  const handleEscape = useCallback(() => {
    if (hasExcalidrawHighlight || hasMermaidHighlight) {
      clearHighlight()
      return
    }
    close()
  }, [clearHighlight, close, hasExcalidrawHighlight, hasMermaidHighlight])

  return {
    symbol: reference?.symbol ?? null,
    /** Null when the document is in no registered project, so nothing can be listed. */
    projectName,
    inProject: Boolean(reference?.projectPath),
    documents,
    isIndexing: status.isIndexing,
    activePath,
    handleMermaidClick,
    handleExcalidrawClick,
    handleEscape,
    select,
    close,
  }
}

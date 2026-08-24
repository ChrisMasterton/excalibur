import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import type { SymbolIndexApi } from './useSymbolIndex'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import type { SymbolEntry } from '../lib/symbols'
import type { PickedSymbol } from '../lib/symbolPick'
import type { OpenDocument } from '../types'

type UseSymbolReferencesOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  symbolIndex: SymbolIndexApi
  activeDocument: OpenDocument | null
  /** Opens the document behind a hit, without highlighting it (`useDocumentActions`). */
  openSymbolDocument: (hit: SymbolDocumentHit) => Promise<OpenDocument | null>
  /** Marks a symbol's matches on a document that is already open (`useDocumentActions`). */
  highlightSymbolHit: (document: OpenDocument, entries: readonly SymbolEntry[], focus: boolean) => void
  /** Opens a "Find in project" hit and zooms to it (`useDocumentActions`). */
  revealSymbol: (hit: SymbolDocumentHit) => Promise<void>
  clearHighlight: () => void
}

/** The symbol being followed, and the project the walk is scoped to. */
type ActiveSymbol = {
  symbol: PickedSymbol
  projectPath: string | null
  /** Bumped on every pick, so re-picking the same symbol re-applies its marks. */
  token: number
}

export type SymbolReferencesApi = ReturnType<typeof useSymbolReferences>

/**
 * "What else mentions this?" — the panel behind a click on a diagram, and the
 * *active symbol* it pins for as long as it stays open.
 *
 * Clicks are resolved by whichever engine owns the surface, then the project
 * symbol index answers which documents name the same symbol. The project is
 * pinned when the symbol is picked, so flipping through the results (which
 * changes the active tab) never re-scopes the list underneath the user.
 *
 * While a symbol is active it follows the user around: whenever the active
 * document changes — a tab click, `Ctrl+Tab`, `Cmd/Ctrl+1…9`, the sidebar, a
 * row in this panel — its matches are marked on whatever is now on screen, and
 * documents that do not mention it simply show nothing. Only a row chosen here
 * pans and zooms to a match; a plain tab switch leaves that tab's own viewport
 * exactly where it was.
 */
export function useSymbolReferences({
  excalidraw,
  mermaid,
  symbolIndex,
  activeDocument,
  openSymbolDocument,
  highlightSymbolHit,
  revealSymbol,
  clearHighlight,
}: UseSymbolReferencesOptions) {
  const [reference, setReference] = useState<ActiveSymbol | null>(null)
  const tokenRef = useRef(0)

  const { ensureIndex, findProject, documentsForSymbol, status } = symbolIndex
  const { resolveSymbolAt: resolveExcalidrawSymbol, hasHighlight: hasExcalidrawHighlight } = excalidraw
  const { resolveSymbolAt: resolveMermaidSymbol, hasHighlight: hasMermaidHighlight } = mermaid
  const { clearHighlight: clearMermaidHighlight } = mermaid
  const activePath = activeDocument?.path ?? null

  /** The walk ends here: the panel goes, and so do the marks in every document. */
  const close = useCallback(() => {
    setReference(null)
    clearHighlight()
  }, [clearHighlight])

  /** Opens the panel for a symbol. An unresolvable click is simply ignored. */
  const show = useCallback(
    (symbol: PickedSymbol | null) => {
      if (!symbol) {
        return
      }
      ensureIndex()
      tokenRef.current += 1
      setReference({
        symbol,
        projectPath: findProject(activePath)?.path ?? null,
        token: tokenRef.current,
      })
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

  /**
   * A press in the preview drops the marks a "Find in project" hit left behind,
   * but never the active symbol's — those are the point of the walk.
   */
  const handlePreviewPointerDown = useCallback(() => {
    if (!reference) {
      clearMermaidHighlight()
    }
  }, [clearMermaidHighlight, reference])

  const documents = useMemo(
    () => (reference ? documentsForSymbol(reference.projectPath, reference.symbol.symbol) : []),
    [documentsForSymbol, reference],
  )

  const projectName = useMemo(
    () => (reference?.projectPath ? findProject(reference.projectPath)?.name ?? null : null),
    [findProject, reference],
  )

  /** What the document on screen has to show for the active symbol, if anything. */
  const activeHit = useMemo(
    () => documents.find((hit) => hit.doc.path === activePath) ?? null,
    [activePath, documents],
  )

  /** Path of a document chosen deliberately, so its marks are worth panning to. */
  const focusPathRef = useRef<string | null>(null)
  /** The (document, symbol) pair whose marks are already on screen. */
  const appliedRef = useRef<string | null>(null)

  /**
   * The whole walk, in one subscription: any activation path ends in a new
   * `activeDocument`, and this puts the active symbol's marks on it.
   */
  useEffect(() => {
    if (!reference || !activeDocument) {
      appliedRef.current = null
      return
    }
    const signature = `${activeDocument.id}|${reference.token}|${activeHit ? 'hit' : 'miss'}`
    if (appliedRef.current === signature) {
      return
    }
    appliedRef.current = signature
    clearHighlight()
    if (!activeHit) {
      return
    }
    const focus = focusPathRef.current === activeDocument.path
    focusPathRef.current = null
    highlightSymbolHit(activeDocument, activeHit.entries, focus)
  }, [activeDocument, activeHit, clearHighlight, highlightSymbolHit, reference])

  /**
   * A row in the panel: activate that document and, because it was chosen rather
   * than merely arrived at, zoom to the match. The highlight itself is left to
   * the subscription above, which fires as soon as the document is on screen.
   */
  const select = useCallback(
    (hit: SymbolDocumentHit) => {
      const wasActive = activeDocument?.path === hit.doc.path
      focusPathRef.current = hit.doc.path
      void openSymbolDocument(hit).then((document) => {
        if (!document) {
          focusPathRef.current = null
          return
        }
        // Already the document on screen: nothing changes, so zoom to it here.
        if (wasActive) {
          focusPathRef.current = null
          highlightSymbolHit(document, hit.entries, true)
        }
      })
    },
    [activeDocument, highlightSymbolHit, openSymbolDocument],
  )

  /** A "Find in project" hit starts its own thread: the current walk ends first. */
  const revealSearchHit = useCallback(
    (hit: SymbolDocumentHit) => {
      close()
      void revealSymbol(hit)
    },
    [close, revealSymbol],
  )

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
    handlePreviewPointerDown,
    handleEscape,
    select,
    revealSearchHit,
    close,
  }
}

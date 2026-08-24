import { useCallback } from 'react'
import type { DocumentTabsApi } from './useDocumentTabs'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import type { ExcalidrawDocumentCache } from './useOpenDocuments'
import { excalidrawSnapshotFromContents } from '../lib/documents'
import { convertMermaidToExcalidrawScene } from '../lib/mermaidConvert'
import { baseName } from '../lib/paths'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import type { SymbolEntry } from '../lib/symbols'
import { api, errorMessage } from '../lib/tauri'
import type { DocumentMode, OpenDocument } from '../types'

type UseDocumentActionsOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  tabs: DocumentTabsApi
  refreshRecents: () => void
  setDocumentMode: (id: string, mode: DocumentMode) => void
  findByPath: (path: string) => OpenDocument | null
  readExcalidrawCache: (id: string) => ExcalidrawDocumentCache | null
  writeExcalidrawCache: (id: string, cache: ExcalidrawDocumentCache) => void
}

/**
 * Commands that put something new into a tab: the open dialogs, a blank drawing,
 * an autosave backup, and the Mermaid → Excalidraw conversion. They are the places
 * where a live editor and the tab list have to agree, so they sit above both.
 */
export function useDocumentActions({
  excalidraw,
  mermaid,
  tabs,
  refreshRecents,
  setDocumentMode,
  findByPath,
  readExcalidrawCache,
  writeExcalidrawCache,
}: UseDocumentActionsOptions) {
  const {
    activateDocument,
    createDocument,
    createDocumentFrom,
    openDiagramPath,
    openLoadedFile,
    snapshotLiveDocuments,
  } = tabs
  const { setMessage: setExcalidrawMessage, releaseDocument: releaseExcalidrawDocument } = excalidraw
  const { setMessage: setMermaidMessage, setConverting } = mermaid
  const { clearRecoverableAutosave, recoverableAutosave, requestFitToContent, clearPendingContents } = excalidraw
  const { highlightElements: highlightExcalidrawElements } = excalidraw
  const { prepareConversion, highlightSymbol: highlightMermaidSymbol } = mermaid

  const handleNewExcalidraw = useCallback(() => {
    activateDocument(createDocument('excalidraw').id, 'Started a new drawing.')
  }, [activateDocument, createDocument])

  const handleOpenExcalidraw = useCallback(async () => {
    try {
      const response = await api.openExcalidrawFile()
      if (response) {
        openLoadedFile('excalidraw', response)
        refreshRecents()
      }
    } catch (error) {
      console.error('[excalibur] open_excalidraw_file failed', error)
      setExcalidrawMessage(errorMessage(error, 'Unable to open drawing.'))
    }
  }, [openLoadedFile, refreshRecents, setExcalidrawMessage])

  const handleOpenMermaid = useCallback(async () => {
    try {
      const response = await api.openMermaidFile()
      if (response) {
        openLoadedFile('mermaid', response)
        refreshRecents()
      }
    } catch (error) {
      setMermaidMessage(errorMessage(error, 'Unable to open Mermaid file.'))
    }
  }, [openLoadedFile, refreshRecents, setMermaidMessage])

  const handleRecoverExcalidraw = useCallback(() => {
    if (!recoverableAutosave) {
      return
    }
    const scene = excalidrawSnapshotFromContents(recoverableAutosave.contents)
    const message = recoverableAutosave.path
      ? `Recovered autosave backup for ${baseName(recoverableAutosave.path)}.`
      : 'Recovered autosave backup.'
    const existing = recoverableAutosave.path ? findByPath(recoverableAutosave.path) : null

    if (existing) {
      // Same file: put the backup into the tab that already has it, still unsaved.
      snapshotLiveDocuments()
      const cache = readExcalidrawCache(existing.id)
      writeExcalidrawCache(existing.id, {
        scene,
        persistedScene: cache?.persistedScene ?? null,
        saveDirectory: cache?.saveDirectory ?? null,
        // The tab is already on screen; leave it looking where it was.
        viewport: cache?.viewport ?? null,
      })
      // Force the canvas to reload the tab now that its cache holds the backup.
      releaseExcalidrawDocument(existing.id)
      // A backup is unsaved work, so the tab is put back into edit mode for it.
      setDocumentMode(existing.id, 'edit')
      activateDocument(existing.id, message)
      clearRecoverableAutosave()
      return
    }

    const recovered = createDocumentFrom({
      kind: 'excalidraw',
      path: recoverableAutosave.path,
      name: recoverableAutosave.name,
      dirty: true,
      mode: 'edit',
      excalidraw: { scene, persistedScene: null, saveDirectory: null, viewport: null },
    })
    activateDocument(recovered.id, message)
    clearRecoverableAutosave()
  }, [
    activateDocument,
    clearRecoverableAutosave,
    createDocumentFrom,
    findByPath,
    readExcalidrawCache,
    recoverableAutosave,
    releaseExcalidrawDocument,
    setDocumentMode,
    snapshotLiveDocuments,
    writeExcalidrawCache,
  ])

  const handleConvertMermaidToExcalidraw = useCallback(async () => {
    const request = prepareConversion()
    if (!request) {
      return
    }

    setConverting(true)
    setMermaidMessage('')
    try {
      const serialized = await convertMermaidToExcalidrawScene(request.text)
      // The conversion becomes its own unsaved tab; the Mermaid source keeps its own.
      const converted = createDocumentFrom(
        {
          kind: 'excalidraw',
          name: request.name,
          dirty: true,
          // A conversion is brand new, unsaved work: it opens ready to edit.
          mode: 'edit',
          excalidraw: {
            scene: excalidrawSnapshotFromContents(serialized),
            persistedScene: null,
            saveDirectory: request.saveDirectory,
            // A fresh conversion is fitted to its contents instead.
            viewport: null,
          },
        },
        'excalidraw',
      )
      requestFitToContent()
      activateDocument(converted.id, 'Converted from Mermaid. Save to write an .excalidraw file.')
      setMermaidMessage('Converted to Excalidraw.')
    } catch (error) {
      console.error('[excalibur] mermaid conversion failed', error)
      clearPendingContents()
      setMermaidMessage(errorMessage(error, 'Unable to convert Mermaid to Excalidraw.'))
    } finally {
      setConverting(false)
    }
  }, [
    activateDocument,
    clearPendingContents,
    createDocumentFrom,
    prepareConversion,
    requestFitToContent,
    setConverting,
    setMermaidMessage,
  ])

  /**
   * Marks a symbol's matches on the document that is already holding them, in
   * whichever engine owns that document. `focus` pans and zooms to the marks:
   * asked for when a document was chosen deliberately, refused when the highlight
   * is only following the active symbol onto a tab the user switched to.
   */
  const highlightSymbolHit = useCallback(
    (document: OpenDocument, entries: readonly SymbolEntry[], focus: boolean) => {
      const locators = entries.flatMap((entry) => entry.locators)
      if (document.kind === 'excalidraw') {
        highlightExcalidrawElements(
          locators.flatMap((locator) => (locator.target === 'excalidraw' ? [locator.elementId] : [])),
          focus,
        )
        return
      }
      highlightMermaidSymbol(
        document.id,
        locators.filter((locator) => locator.target === 'mermaid'),
        entries[0]?.display ?? '',
        focus,
      )
    },
    [highlightExcalidrawElements, highlightMermaidSymbol],
  )

  /**
   * Opens (or re-activates) the document behind a symbol hit, without pushing it
   * into Recent. Goes through the tab layer like any other open; null means the
   * file could not be read, and the workspace has already said so.
   */
  const openSymbolDocument = useCallback(
    async (hit: SymbolDocumentHit): Promise<OpenDocument | null> => {
      try {
        return await openDiagramPath(hit.doc.kind, hit.doc.path, { trackRecent: false })
      } catch (error) {
        console.error('[excalibur] unable to open symbol', hit.doc.path, error)
        const message = errorMessage(error, `Unable to open ${baseName(hit.doc.path)}.`)
        if (hit.doc.kind === 'excalidraw') {
          setExcalidrawMessage(message)
        } else {
          setMermaidMessage(message)
        }
        return null
      }
    },
    [openDiagramPath, setExcalidrawMessage, setMermaidMessage],
  )

  /** Opens the document a "Find in project" hit points at and zooms to the matches. */
  const revealSymbol = useCallback(
    async (hit: SymbolDocumentHit) => {
      const document = await openSymbolDocument(hit)
      if (document) {
        highlightSymbolHit(document, hit.entries, true)
      }
    },
    [highlightSymbolHit, openSymbolDocument],
  )

  return {
    handleNewExcalidraw,
    handleOpenExcalidraw,
    handleOpenMermaid,
    handleRecoverExcalidraw,
    handleConvertMermaidToExcalidraw,
    highlightSymbolHit,
    openSymbolDocument,
    revealSymbol,
  }
}

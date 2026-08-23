import { useCallback } from 'react'
import type { DocumentTabsApi } from './useDocumentTabs'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import type { ExcalidrawDocumentCache } from './useOpenDocuments'
import { excalidrawSnapshotFromContents } from '../lib/documents'
import { convertMermaidToExcalidrawScene } from '../lib/mermaidConvert'
import { baseName } from '../lib/paths'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import { api, errorMessage } from '../lib/tauri'
import type { OpenDocument } from '../types'

type UseDocumentActionsOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  tabs: DocumentTabsApi
  refreshRecents: () => void
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
      })
      // Force the canvas to reload the tab now that its cache holds the backup.
      releaseExcalidrawDocument(existing.id)
      activateDocument(existing.id, message)
      clearRecoverableAutosave()
      return
    }

    const recovered = createDocumentFrom({
      kind: 'excalidraw',
      path: recoverableAutosave.path,
      name: recoverableAutosave.name,
      dirty: true,
      excalidraw: { scene, persistedScene: null, saveDirectory: null },
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
          excalidraw: {
            scene: excalidrawSnapshotFromContents(serialized),
            persistedScene: null,
            saveDirectory: request.saveDirectory,
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
   * Opens (or re-activates) the document a "Find in project" hit points at and
   * highlights the matches on it. Goes through the tab layer like any other open.
   */
  const revealSymbol = useCallback(
    async (hit: SymbolDocumentHit) => {
      const locators = hit.entries.flatMap((entry) => entry.locators)
      const display = hit.entries[0]?.display ?? ''
      try {
        const document = await openDiagramPath(hit.doc.kind, hit.doc.path, { trackRecent: false })
        if (hit.doc.kind === 'excalidraw') {
          highlightExcalidrawElements(
            locators.flatMap((locator) => (locator.target === 'excalidraw' ? [locator.elementId] : [])),
          )
          return
        }
        highlightMermaidSymbol(
          document.id,
          locators.filter((locator) => locator.target === 'mermaid'),
          display,
        )
      } catch (error) {
        console.error('[excalibur] unable to open symbol', hit.doc.path, error)
        const message = errorMessage(error, `Unable to open ${baseName(hit.doc.path)}.`)
        if (hit.doc.kind === 'excalidraw') {
          setExcalidrawMessage(message)
        } else {
          setMermaidMessage(message)
        }
      }
    },
    [
      highlightExcalidrawElements,
      highlightMermaidSymbol,
      openDiagramPath,
      setExcalidrawMessage,
      setMermaidMessage,
    ],
  )

  return {
    handleNewExcalidraw,
    handleOpenExcalidraw,
    handleOpenMermaid,
    handleRecoverExcalidraw,
    handleConvertMermaidToExcalidraw,
    revealSymbol,
  }
}

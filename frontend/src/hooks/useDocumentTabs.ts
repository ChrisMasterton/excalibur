import { useCallback, useEffect, useRef } from 'react'
import {
  documentDisplayName,
  readStoredOpenDocuments,
  writeStoredOpenDocuments,
  type NewDocumentInput,
} from './useOpenDocuments'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import {
  documentInputForFile,
  getExitUnsavedChangesMessage,
  getUnsavedChangesMessage,
  isDiagramPath,
  kindLabel,
} from '../lib/documents'
import { INITIAL_MERMAID_TEXT } from '../lib/mermaidHistory'
import { baseName } from '../lib/paths'
import { api, errorMessage } from '../lib/tauri'
import type { DiagramKind, OpenDocument, OpenFileResponse } from '../types'

type OpenPathOptions = { trackRecent?: boolean; activate?: boolean }

type UseDocumentTabsOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  setWorkspace: (kind: DiagramKind) => void
  notify: (message: string) => void
  refreshRecents: () => void
  /** The tab list and the store behind it (`useOpenDocuments`). */
  documents: OpenDocument[]
  activeId: string | null
  getDocuments: () => OpenDocument[]
  getDocument: (id: string | null) => OpenDocument | null
  findByPath: (path: string) => OpenDocument | null
  openDocument: (input: NewDocumentInput) => OpenDocument
  replaceDocument: (id: string, input: NewDocumentInput) => OpenDocument
  findPristineDocument: (kind?: DiagramKind) => OpenDocument | null
  closeDocuments: (ids: string[]) => OpenDocument | null
  setActiveId: (id: string | null) => void
}

export type DocumentTabsApi = ReturnType<typeof useDocumentTabs>

/**
 * The open tabs as the app works with them: activating one (which hands the live
 * editors over), opening files into tabs, closing with the unsaved-changes prompt,
 * and restoring last session's tabs on launch.
 */
export function useDocumentTabs({
  excalidraw,
  mermaid,
  setWorkspace,
  notify,
  refreshRecents,
  documents,
  activeId,
  getDocuments,
  getDocument,
  findByPath,
  openDocument,
  replaceDocument,
  findPristineDocument,
  closeDocuments,
  setActiveId,
}: UseDocumentTabsOptions) {
  const lastActiveByKindRef = useRef<Record<DiagramKind, string | null>>({ excalidraw: null, mermaid: null })
  const pendingOpenFile = useRef<string | null>(null)
  const hasRestoredDocumentsRef = useRef(false)
  const startedRestoreRef = useRef(false)

  const {
    captureIntoCache: captureExcalidraw,
    loadDocument: loadExcalidrawDocument,
    releaseDocument: releaseExcalidrawDocument,
    detachDocument: detachExcalidrawDocument,
  } = excalidraw
  const {
    captureIntoCache: captureMermaid,
    loadDocument: loadMermaidDocument,
    releaseDocument: releaseMermaidDocument,
    detachDocument: detachMermaidDocument,
  } = mermaid

  /** Copies whatever the live editors hold back into their tabs before switching. */
  const snapshotLiveDocuments = useCallback(() => {
    captureExcalidraw()
    captureMermaid()
  }, [captureExcalidraw, captureMermaid])

  const activateDocument = useCallback(
    (id: string, message = '') => {
      const document = getDocument(id)
      if (!document) {
        return
      }
      snapshotLiveDocuments()
      setActiveId(id)
      lastActiveByKindRef.current[document.kind] = id
      setWorkspace(document.kind)
      if (document.kind === 'excalidraw') {
        loadExcalidrawDocument(document, message)
      } else {
        loadMermaidDocument(document, message)
      }
    },
    [
      getDocument,
      loadExcalidrawDocument,
      loadMermaidDocument,
      setActiveId,
      setWorkspace,
      snapshotLiveDocuments,
    ],
  )

  const createDocument = useCallback(
    (kind: DiagramKind) =>
      kind === 'excalidraw'
        ? openDocument({
            kind,
            name: '',
            excalidraw: { scene: null, persistedScene: null, saveDirectory: null },
          })
        : openDocument({
            kind,
            name: '',
            mermaid: {
              history: { text: INITIAL_MERMAID_TEXT, past: [], future: [] },
              persistedText: INITIAL_MERMAID_TEXT,
            },
          }),
    [openDocument],
  )

  /**
   * Creates a tab, taking over an untouched blank one instead of leaving it beside the
   * document being opened. `recycleKind` looks past the active tab for a blank tab of
   * that kind (conversions reuse an empty drawing while keeping their Mermaid source).
   */
  const createDocumentFrom = useCallback(
    (input: NewDocumentInput, recycleKind?: DiagramKind) => {
      // The live editors must be in the caches before a tab can be judged blank.
      snapshotLiveDocuments()
      const pristine = findPristineDocument(recycleKind)
      if (!pristine) {
        return openDocument(input)
      }
      releaseExcalidrawDocument(pristine.id)
      releaseMermaidDocument(pristine.id)
      if (lastActiveByKindRef.current[pristine.kind] === pristine.id) {
        lastActiveByKindRef.current[pristine.kind] = null
      }
      return replaceDocument(pristine.id, input)
    },
    [
      findPristineDocument,
      openDocument,
      releaseExcalidrawDocument,
      releaseMermaidDocument,
      replaceDocument,
      snapshotLiveDocuments,
    ],
  )

  /** Creates the tab for a file that was just read from disk (no editor work). */
  const addDocumentForFile = useCallback(
    (kind: DiagramKind, file: OpenFileResponse) => createDocumentFrom(documentInputForFile(kind, file)),
    [createDocumentFrom],
  )

  const openLoadedFile = useCallback(
    (kind: DiagramKind, file: OpenFileResponse, activate = true) => {
      const document = findByPath(file.path) ?? addDocumentForFile(kind, file)
      if (activate) {
        activateDocument(document.id, `Opened ${baseName(file.path)}.`)
      }
      return document
    },
    [activateDocument, addDocumentForFile, findByPath],
  )

  const openDiagramPath = useCallback(
    async (kind: DiagramKind, path: string, options: OpenPathOptions = {}) => {
      const existing = findByPath(path)
      if (existing) {
        if (options.activate ?? true) {
          activateDocument(existing.id)
        }
        return existing
      }
      const trackRecent = options.trackRecent ?? true
      const file =
        kind === 'excalidraw'
          ? await api.loadExcalidrawPath(path, trackRecent)
          : await api.loadMermaidPath(path, trackRecent)
      const document = openLoadedFile(kind, file, options.activate ?? true)
      if (trackRecent) {
        refreshRecents()
      }
      return document
    },
    [activateDocument, findByPath, openLoadedFile, refreshRecents],
  )

  const openDiagram = useCallback(
    (kind: DiagramKind, path: string) => {
      void openDiagramPath(kind, path).catch((error) => {
        console.error('[excalibur] unable to open diagram', path, error)
        notify(errorMessage(error, `Unable to open ${baseName(path)}.`))
      })
    },
    [notify, openDiagramPath],
  )

  const handleWorkspaceChange = useCallback(
    (kind: DiagramKind) => {
      const openList = getDocuments()
      const preferredId = lastActiveByKindRef.current[kind]
      const target =
        openList.find((document) => document.id === preferredId && document.kind === kind) ??
        [...openList].reverse().find((document) => document.kind === kind) ??
        createDocument(kind)
      activateDocument(target.id)
    },
    [activateDocument, createDocument, getDocuments],
  )

  const closeDocumentIds = useCallback(
    (ids: string[]) => {
      const closing = ids
        .map((id) => getDocument(id))
        .filter((document): document is OpenDocument => Boolean(document))
      if (!closing.length) {
        return
      }
      for (const document of closing) {
        if (
          document.dirty &&
          !window.confirm(
            getUnsavedChangesMessage(
              `${kindLabel(document.kind)} (${documentDisplayName(document)})`,
              'close this tab',
            ),
          )
        ) {
          return
        }
      }

      snapshotLiveDocuments()
      for (const document of closing) {
        detachExcalidrawDocument(document)
        detachMermaidDocument(document)
        if (lastActiveByKindRef.current[document.kind] === document.id) {
          lastActiveByKindRef.current[document.kind] = null
        }
      }

      const nextActive = closeDocuments(closing.map((document) => document.id))
      if (nextActive) {
        activateDocument(nextActive.id)
        return
      }
      activateDocument(createDocument(closing[closing.length - 1].kind).id)
    },
    [
      activateDocument,
      closeDocuments,
      createDocument,
      detachExcalidrawDocument,
      detachMermaidDocument,
      getDocument,
      snapshotLiveDocuments,
    ],
  )

  const closeOtherDocuments = useCallback(
    (id: string) => {
      closeDocumentIds(
        getDocuments()
          .filter((document) => document.id !== id)
          .map((document) => document.id),
      )
    },
    [closeDocumentIds, getDocuments],
  )

  const closeAllDocuments = useCallback(() => {
    closeDocumentIds(getDocuments().map((document) => document.id))
  }, [closeDocumentIds, getDocuments])

  const closeActiveDocument = useCallback(() => {
    if (activeId) {
      closeDocumentIds([activeId])
    }
  }, [activeId, closeDocumentIds])

  /** The tab `Ctrl+Tab` (or `Ctrl+Shift+Tab`) should move to, if cycling applies. */
  const getCycleTargetId = useCallback(
    (step: number) => {
      const openList = getDocuments()
      if (openList.length < 2) {
        return null
      }
      const index = openList.findIndex((document) => document.id === activeId)
      return openList[(index + step + openList.length) % openList.length].id
    },
    [activeId, getDocuments],
  )

  /** The tab `Cmd/Ctrl+1`…`9` should jump to, if there is one. */
  const getDocumentIdAt = useCallback(
    (index: number) => getDocuments()[index]?.id ?? null,
    [getDocuments],
  )

  /** Opens a file the OS handed us, queueing it while the previous session is still restoring. */
  const openFileFromEvent = useCallback(
    (path: string) => {
      if (!hasRestoredDocumentsRef.current) {
        pendingOpenFile.current = path
        return
      }
      openDiagram(isDiagramPath(path) ?? 'excalidraw', path)
    },
    [openDiagram],
  )

  /** Warns about unsaved work across every tab. False means "stay in the app". */
  const confirmExit = useCallback(() => {
    const dirty = getDocuments().filter((document) => document.dirty)
    const hasExcalidrawChanges = dirty.some((document) => document.kind === 'excalidraw')
    const hasMermaidChanges = dirty.some((document) => document.kind === 'mermaid')
    if (dirty.length && !window.confirm(getExitUnsavedChangesMessage(hasExcalidrawChanges, hasMermaidChanges))) {
      return false
    }
    return true
  }, [getDocuments])

  /** Reopens last session's tabs, then whatever file the OS asked us to open. */
  const restoreStartupDocuments = useCallback(async () => {
    const stored = readStoredOpenDocuments()
    const loaded = await Promise.all(
      stored.documents.map(async (entry) => {
        try {
          const file =
            entry.kind === 'excalidraw'
              ? await api.loadExcalidrawPath(entry.path, false)
              : await api.loadMermaidPath(entry.path, false)
          return { kind: entry.kind, file }
        } catch (error) {
          console.warn('[excalibur] skipping unavailable document', entry.path, error)
          return null
        }
      }),
    )
    const restored = loaded.map((item) => (item ? addDocumentForFile(item.kind, item.file) : null))
    const target =
      restored[stored.activeIndex] ?? restored.find((document): document is OpenDocument => Boolean(document)) ?? null

    let startupPath = pendingOpenFile.current
    pendingOpenFile.current = null
    if (!startupPath) {
      startupPath = await api.takePendingFile().catch(() => null)
    }
    hasRestoredDocumentsRef.current = true

    if (startupPath) {
      openDiagram(isDiagramPath(startupPath) ?? 'excalidraw', startupPath)
      return
    }
    activateDocument((target ?? createDocument('excalidraw')).id)
  }, [activateDocument, addDocumentForFile, createDocument, openDiagram])

  useEffect(() => {
    if (startedRestoreRef.current) {
      return
    }
    startedRestoreRef.current = true
    void restoreStartupDocuments()
  }, [restoreStartupDocuments])

  useEffect(() => {
    if (!hasRestoredDocumentsRef.current) {
      return
    }
    writeStoredOpenDocuments(documents, activeId)
  }, [activeId, documents])

  const hasUnsavedDocuments = documents.some((document) => document.dirty)

  return {
    hasUnsavedDocuments,
    snapshotLiveDocuments,
    activateDocument,
    createDocument,
    createDocumentFrom,
    openLoadedFile,
    openDiagramPath,
    openDiagram,
    handleWorkspaceChange,
    closeDocumentIds,
    closeOtherDocuments,
    closeAllDocuments,
    closeActiveDocument,
    getCycleTargetId,
    getDocumentIdAt,
    openFileFromEvent,
    confirmExit,
  }
}

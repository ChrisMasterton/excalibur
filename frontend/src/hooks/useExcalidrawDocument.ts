import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, serializeAsJSON, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawChangeHandler } from '../components/ExcalidrawWorkspace'
import {
  EXCALIDRAW_AUTOSAVE_KEY,
  EXCALIDRAW_RECOVERY_KEY,
  clearStoredExcalidrawAutosave,
  readStoredExcalidrawAutosave,
  writeStoredExcalidrawAutosave,
} from '../lib/autosave'
import { EMPTY_EXCALIDRAW_CONTENTS } from '../lib/documents'
import { baseName, fileStem } from '../lib/paths'
import { pickExcalidrawSymbol, type PickedSymbol } from '../lib/symbolPick'
import { api, errorMessage } from '../lib/tauri'
import { ensureExcalidrawFontsLoaded, refitBoundText } from '../lib/textRefit'
import type {
  DiagramKind,
  ExcalidrawAutosave,
  ExcalidrawData,
  ExcalidrawSceneSnapshot,
  OpenDocument,
} from '../types'
import type { DocumentPatch, ExcalidrawDocumentCache } from './useOpenDocuments'

type ExcalidrawPersistedState = ExcalidrawSceneSnapshot & {
  path: string | null
}

/**
 * What counts as "saved" once the contents land on the canvas:
 * `clean` = the contents came from disk, `keep` = leave the current baseline alone,
 * `{ snapshot }` = an explicit baseline (a restored tab; null for a never-saved one).
 */
export type ExcalidrawBaseline = 'clean' | 'keep' | { snapshot: ExcalidrawSceneSnapshot | null }

export type ApplyExcalidrawContentsRequest = {
  /** Tab the canvas will be holding once these contents are applied. */
  documentId: string
  contents: string
  path: string | null
  /** Display name (already a file stem). */
  name?: string | null
  message: string
  baseline: ExcalidrawBaseline
  /** Zoom the canvas to the loaded content once it is visible. */
  fitToContent?: boolean
}

type ExcalidrawChangeArgs = Parameters<ExcalidrawChangeHandler>

type UseExcalidrawDocumentOptions = {
  /** True while the canvas is the visible workspace (it is hidden, never unmounted). */
  isVisible: boolean
  /** Changes the canvas's available width, so it has to re-measure. */
  isSidebarCollapsed: boolean
  setWorkspace: (kind: DiagramKind) => void
  patchDocument: (id: string | null, patch: DocumentPatch) => void
  readCache: (id: string) => ExcalidrawDocumentCache | null
  writeCache: (id: string, cache: ExcalidrawDocumentCache) => void
  refreshRecents: () => void
  refreshProjectFiles: () => void
  showSaveFeedback: (kind: DiagramKind) => void
}

export type ExcalidrawDocumentApi = ReturnType<typeof useExcalidrawDocument>

/**
 * The one live Excalidraw canvas: what it holds, whether that differs from disk,
 * the autosave/recovery slots, and every action the Excalidraw toolbar can trigger.
 *
 * Tab-level concerns (which document the canvas should hold next) live in
 * `useDocumentTabs`; this hook only tracks the tab it is currently mirroring.
 */
export function useExcalidrawDocument({
  isVisible,
  isSidebarCollapsed,
  setWorkspace,
  patchDocument,
  readCache,
  writeCache,
  refreshRecents,
  refreshProjectFiles,
  showSaveFeedback,
}: UseExcalidrawDocumentOptions) {
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [isRefittingText, setIsRefittingText] = useState(false)
  const [recoverableAutosave, setRecoverableAutosave] = useState<ExcalidrawAutosave | null>(() =>
    readStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY),
  )
  /** Elements a "Find in project" hit asked us to select; `token` re-triggers a repeat request. */
  const [highlight, setHighlight] = useState<{ elementIds: string[]; token: number } | null>(null)
  const highlightTokenRef = useRef(0)

  const pendingFitToContentRef = useRef(false)
  const pendingContentsRef = useRef<ApplyExcalidrawContentsRequest | null>(null)
  const pathRef = useRef<string | null>(null)
  const nameRef = useRef('')
  const saveDirectoryRef = useRef<string | null>(null)
  const sceneSnapshotRef = useRef<ExcalidrawSceneSnapshot | null>(null)
  const persistedRef = useRef<ExcalidrawPersistedState | null>(null)
  const ignoreEmptyChangeUntilRef = useRef(0)
  const suppressEmptyChangeTimerRef = useRef<number | null>(null)
  const autosaveSnapshotRef = useRef<ExcalidrawAutosave | null>(
    readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY),
  )
  /** Which tab the canvas is currently holding. */
  const liveIdRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (suppressEmptyChangeTimerRef.current !== null) {
        window.clearTimeout(suppressEmptyChangeTimerRef.current)
      }
    }
  }, [])

  // The canvas is hidden (not unmounted) while Mermaid is active, so let it re-measure when it comes back.
  useEffect(() => {
    if (!excalidrawApi || !isVisible) {
      return
    }
    excalidrawApi.refresh()
    if (pendingFitToContentRef.current) {
      pendingFitToContentRef.current = false
      // The canvas learns its size from a ResizeObserver after it becomes visible,
      // so poll briefly for real dimensions before fitting.
      let attempts = 0
      let timer = 0
      const fitWhenSized = () => {
        const { width, height } = excalidrawApi.getAppState()
        if ((width > 0 && height > 0) || attempts >= 20) {
          excalidrawApi.scrollToContent(undefined, { fitToContent: true })
          return
        }
        attempts += 1
        timer = window.setTimeout(fitWhenSized, 30)
      }
      timer = window.setTimeout(fitWhenSized, 30)
      return () => window.clearTimeout(timer)
    }
  }, [excalidrawApi, isSidebarCollapsed, isVisible])

  const setDocument = useCallback(
    (nextPath: string | null, nextName: string) => {
      pathRef.current = nextPath
      nameRef.current = nextName
      setPath(nextPath)
      setName(nextName)
      patchDocument(liveIdRef.current, { path: nextPath, name: nextName })
    },
    [patchDocument],
  )

  const markDirty = useCallback(
    (isDirty: boolean) => {
      setDirty(isDirty)
      patchDocument(liveIdRef.current, { dirty: isDirty })
    },
    [patchDocument],
  )

  const setRecoverableAutosaveSlot = useCallback((autosave: ExcalidrawAutosave | null) => {
    setRecoverableAutosave(autosave)
    if (autosave) {
      writeStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY, autosave)
      return
    }
    clearStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY)
  }, [])

  const setCurrentAutosave = useCallback((autosave: ExcalidrawAutosave | null) => {
    autosaveSnapshotRef.current = autosave
    if (autosave) {
      writeStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY, autosave)
      return
    }
    clearStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY)
  }, [])

  const setPersistedState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot, nextPath: string | null) => {
      persistedRef.current = { ...snapshot, path: nextPath }
      markDirty(false)
    },
    [markDirty],
  )

  const updateDirtyState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot | null) => {
      const persisted = persistedRef.current
      if (!persisted) {
        markDirty(snapshot?.hasContent ?? false)
        return
      }
      markDirty((snapshot?.contents ?? '') !== persisted.contents)
    },
    [markDirty],
  )

  const applyContents = useCallback(
    (request: ApplyExcalidrawContentsRequest) => {
      const { documentId, contents, path: nextPath, name: nextName, message: nextMessage, baseline, fitToContent } = request

      if (!excalidrawApi) {
        pendingContentsRef.current = request
        setWorkspace('excalidraw')
        return
      }

      try {
        const parsed = JSON.parse(contents) as Partial<ExcalidrawData> & { data?: Partial<ExcalidrawData> }
        const raw = parsed.data && parsed.data.elements ? parsed.data : parsed

        const sanitizedElements = (raw.elements ?? []).map((el) => {
          const element = { ...(el as Record<string, unknown>) }
          if (!Array.isArray(element.groupIds)) {
            element.groupIds = []
          }
          if (!Array.isArray(element.boundElements)) {
            element.boundElements = element.boundElements ?? null
          }
          return element
        })

        const normalizedName = nextName ?? ''
        const snapshot = {
          contents,
          hasContent: sanitizedElements.some((element) => element.isDeleted !== true),
        }

        sceneSnapshotRef.current = snapshot
        if (snapshot.hasContent) {
          // Excalidraw can emit a transient empty change right after updateScene; don't treat it as a wipe.
          ignoreEmptyChangeUntilRef.current = Date.now() + 3000
          if (suppressEmptyChangeTimerRef.current !== null) {
            window.clearTimeout(suppressEmptyChangeTimerRef.current)
          }
          suppressEmptyChangeTimerRef.current = window.setTimeout(() => {
            ignoreEmptyChangeUntilRef.current = 0
            suppressEmptyChangeTimerRef.current = null
          }, 3000)
        }
        // From here on the canvas belongs to this tab, so live state mirrors into it.
        liveIdRef.current = documentId
        setDocument(nextPath, normalizedName)

        excalidrawApi.updateScene({
          elements: sanitizedElements as never[],
          appState: (raw.appState ?? {}) as never,
        })
        const files = raw.files ? Object.values(raw.files) : []
        if (files.length) {
          excalidrawApi.addFiles(files)
        }

        if (snapshot.hasContent) {
          setCurrentAutosave({ contents, path: nextPath, name: normalizedName, updatedAt: Date.now() })
        } else {
          setCurrentAutosave(null)
        }
        if (baseline === 'clean') {
          setPersistedState(snapshot, nextPath)
        } else {
          if (baseline !== 'keep') {
            persistedRef.current = baseline.snapshot ? { ...baseline.snapshot, path: nextPath } : null
          }
          updateDirtyState(snapshot)
        }
        setMessage(nextMessage)
        if (fitToContent) {
          pendingFitToContentRef.current = true
        }
        setWorkspace('excalidraw')
      } catch (error) {
        console.error('[excalibur] applyExcalidrawContents: FAILED', error)
        setMessage('Failed to parse .excalidraw file.')
      }
    },
    [excalidrawApi, setCurrentAutosave, setDocument, setPersistedState, setWorkspace, updateDirtyState],
  )

  const flushPendingContents = useCallback(() => {
    if (!excalidrawApi || !pendingContentsRef.current) {
      return false
    }
    const pendingContents = pendingContentsRef.current
    pendingContentsRef.current = null
    applyContents(pendingContents)
    return true
  }, [applyContents, excalidrawApi])

  useEffect(() => {
    flushPendingContents()
  }, [flushPendingContents])

  const handleChange = useCallback(
    (...[elements, appState, files]: ExcalidrawChangeArgs) => {
      const hasContent = elements.some((element) => !element.isDeleted)
      if (
        !hasContent &&
        Date.now() < ignoreEmptyChangeUntilRef.current &&
        sceneSnapshotRef.current?.hasContent
      ) {
        return
      }

      const snapshot = {
        contents: serializeAsJSON(elements, appState, files, 'local'),
        hasContent,
      }
      sceneSnapshotRef.current = snapshot

      if (!hasContent) {
        setCurrentAutosave(null)
      } else {
        setCurrentAutosave({
          contents: snapshot.contents,
          path: pathRef.current,
          name: nameRef.current.trim(),
          updatedAt: Date.now(),
        })
      }
      updateDirtyState(snapshot)
    },
    [setCurrentAutosave, updateDirtyState],
  )

  /** Copies whatever the canvas holds back into its tab, before another tab takes over. */
  const captureIntoCache = useCallback(() => {
    const liveId = liveIdRef.current
    if (liveId) {
      writeCache(liveId, {
        scene: sceneSnapshotRef.current,
        persistedScene: persistedRef.current,
        saveDirectory: saveDirectoryRef.current,
      })
    }
  }, [writeCache])

  const loadDocument = useCallback(
    (document: OpenDocument, nextMessage: string) => {
      if (liveIdRef.current === document.id) {
        setMessage(nextMessage)
        return
      }
      const cache = readCache(document.id)
      saveDirectoryRef.current = cache?.saveDirectory ?? null
      applyContents({
        documentId: document.id,
        contents: cache?.scene?.contents ?? EMPTY_EXCALIDRAW_CONTENTS,
        path: document.path,
        name: document.name,
        message: nextMessage,
        baseline: { snapshot: cache?.persistedScene ?? null },
      })
    },
    [applyContents, readCache],
  )

  /** Forgets that the canvas holds this tab, so it is reloaded from its cache next time. */
  const releaseDocument = useCallback((id: string) => {
    if (liveIdRef.current === id) {
      liveIdRef.current = null
    }
  }, [])

  /** Clears the canvas's live state because its tab is being closed. */
  const detachDocument = useCallback(
    (document: OpenDocument) => {
      if (document.id !== liveIdRef.current) {
        return
      }
      // Losing unsaved canvas work is the one place a backup still earns its keep.
      if (document.dirty && autosaveSnapshotRef.current) {
        setRecoverableAutosaveSlot(autosaveSnapshotRef.current)
      }
      liveIdRef.current = null
      sceneSnapshotRef.current = null
      persistedRef.current = null
      saveDirectoryRef.current = null
      setCurrentAutosave(null)
    },
    [setCurrentAutosave, setRecoverableAutosaveSlot],
  )

  /** Follows a live document whose file was renamed or moved underneath it. */
  const relocateDocument = useCallback(
    (id: string, nextPath: string) => {
      if (id !== liveIdRef.current) {
        return
      }
      setDocument(nextPath, fileStem(nextPath))
      if (persistedRef.current) {
        persistedRef.current = { ...persistedRef.current, path: nextPath }
      }
    },
    [setDocument],
  )

  const getLiveId = useCallback(() => liveIdRef.current, [])

  /**
   * Selects the given elements and zooms to them. Applied once the canvas is
   * visible and sized, so it survives being called while Mermaid is on screen.
   */
  const highlightElements = useCallback((elementIds: string[]) => {
    highlightTokenRef.current += 1
    setHighlight(elementIds.length ? { elementIds, token: highlightTokenRef.current } : null)
  }, [])

  const clearHighlight = useCallback(() => {
    setHighlight(null)
    excalidrawApi?.updateScene({
      appState: { selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [excalidrawApi])

  useEffect(() => {
    if (!excalidrawApi || !isVisible || !highlight) {
      return
    }
    const wanted = new Set(highlight.elementIds)
    const targets = excalidrawApi.getSceneElements().filter((element) => wanted.has(element.id))
    if (!targets.length) {
      return
    }
    excalidrawApi.updateScene({
      appState: { selectedElementIds: Object.fromEntries(targets.map((element) => [element.id, true])) },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    // The canvas learns its size from a ResizeObserver, so wait for real dimensions.
    let attempts = 0
    let timer = 0
    const scrollWhenSized = () => {
      const { width, height } = excalidrawApi.getAppState()
      if ((width > 0 && height > 0) || attempts >= 20) {
        excalidrawApi.scrollToContent(targets, { fitToContent: true, animate: true })
        return
      }
      attempts += 1
      timer = window.setTimeout(scrollWhenSized, 30)
    }
    scrollWhenSized()
    return () => window.clearTimeout(timer)
  }, [excalidrawApi, highlight, isVisible])

  /**
   * Which symbol sits under a screen point on the canvas. Text elements and the
   * bound labels of containers are what carry names, so those are what is hit
   * tested; the smallest box wins, which is the label rather than its group.
   * Rotation is ignored - a plain bounding box is precise enough for a click.
   */
  const resolveSymbolAt = useCallback(
    (clientX: number, clientY: number): PickedSymbol | null => {
      if (!excalidrawApi) {
        return null
      }
      const appState = excalidrawApi.getAppState()
      const point = viewportCoordsToSceneCoords({ clientX, clientY }, appState)
      const elements = excalidrawApi.getSceneElements()
      const byId = new Map(elements.map((element) => [element.id, element]))
      const hits = elements
        .filter(
          (element) =>
            point.x >= element.x &&
            point.x <= element.x + element.width &&
            point.y >= element.y &&
            point.y <= element.y + element.height,
        )
        .sort((a, b) => a.width * a.height - b.width * b.height)

      for (const element of hits) {
        const picked = pickExcalidrawSymbol(element)
        if (picked) {
          return picked
        }
        const boundLabelId = element.boundElements?.find((bound) => bound.type === 'text')?.id
        const label = boundLabelId ? byId.get(boundLabelId) : undefined
        const fromLabel = label ? pickExcalidrawSymbol(label) : null
        if (fromLabel) {
          return fromLabel
        }
      }
      return null
    },
    [excalidrawApi],
  )

  /** Fit the canvas to its contents the next time it becomes visible. */
  const requestFitToContent = useCallback(() => {
    pendingFitToContentRef.current = true
  }, [])

  const clearPendingContents = useCallback(() => {
    pendingContentsRef.current = null
  }, [])

  const clearRecoverableAutosave = useCallback(() => {
    setRecoverableAutosaveSlot(null)
  }, [setRecoverableAutosaveSlot])

  const handleSave = useCallback(async () => {
    if (!excalidrawApi) {
      return
    }
    const hasContent = excalidrawApi.getSceneElements().some((element) => !element.isDeleted)
    const serialized = serializeAsJSON(
      excalidrawApi.getSceneElements(),
      excalidrawApi.getAppState(),
      excalidrawApi.getFiles(),
      'local',
    )
    try {
      const response = await api.saveExcalidrawFile({
        path: pathRef.current,
        name: nameRef.current.trim() || undefined,
        directory: saveDirectoryRef.current,
        contents: serialized,
      })
      const snapshot = { contents: serialized, hasContent }
      sceneSnapshotRef.current = snapshot
      saveDirectoryRef.current = null
      const nextName = fileStem(response.path)
      setDocument(response.path, nextName)
      if (hasContent) {
        setCurrentAutosave({ contents: serialized, path: response.path, name: nextName, updatedAt: Date.now() })
      } else {
        setCurrentAutosave(null)
      }
      setPersistedState(snapshot, response.path)
      setMessage(`Saved ${baseName(response.path)}.`)
      showSaveFeedback('excalidraw')
      refreshRecents()
      refreshProjectFiles()
    } catch (error) {
      if (errorMessage(error, '') !== 'Save cancelled') {
        console.error('[excalibur] save_excalidraw_file failed', error)
        setMessage(errorMessage(error, 'Unable to save drawing.'))
      }
    }
  }, [
    excalidrawApi,
    refreshProjectFiles,
    refreshRecents,
    setCurrentAutosave,
    setDocument,
    setPersistedState,
    showSaveFeedback,
  ])

  const handleExportPng = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    setMessage('')
    excalidrawApi.updateScene({
      appState: { openDialog: { name: 'imageExport' } },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [excalidrawApi])

  const handleFitToWindow = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    if (!excalidrawApi.getSceneElements().some((element) => !element.isDeleted)) {
      setMessage('Nothing on the canvas to fit yet.')
      return
    }
    excalidrawApi.scrollToContent(undefined, { fitToContent: true, animate: true })
  }, [excalidrawApi])

  const handleRefitText = useCallback(async () => {
    if (!excalidrawApi) {
      return
    }
    setIsRefittingText(true)
    try {
      const elements = excalidrawApi.getSceneElementsIncludingDeleted()
      await ensureExcalidrawFontsLoaded(elements)
      const result = refitBoundText(elements)
      if (result.changed === 0) {
        setMessage('Text already fits its containers.')
        return
      }
      excalidrawApi.updateScene({
        elements: result.elements as never[],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      setMessage(`Refit ${result.changed} text ${result.changed === 1 ? 'label' : 'labels'}.`)
    } catch (error) {
      console.error('[excalibur] refit text failed', error)
      setMessage('Unable to refit text.')
    } finally {
      setIsRefittingText(false)
    }
  }, [excalidrawApi])

  const handleRename = useCallback(
    async (nextName: string) => {
      const currentPath = pathRef.current
      if (!currentPath) {
        setDocument(null, nextName)
        if (autosaveSnapshotRef.current) {
          setCurrentAutosave({ ...autosaveSnapshotRef.current, name: nextName, updatedAt: Date.now() })
        }
        return
      }
      try {
        const nextPath = await api.renameFile(currentPath, nextName)
        setDocument(nextPath, fileStem(nextPath))
        if (persistedRef.current) {
          persistedRef.current = { ...persistedRef.current, path: nextPath }
        }
        if (autosaveSnapshotRef.current) {
          setCurrentAutosave({ ...autosaveSnapshotRef.current, path: nextPath, name: fileStem(nextPath), updatedAt: Date.now() })
        }
        setMessage(`Renamed to ${baseName(nextPath)}.`)
        refreshRecents()
        refreshProjectFiles()
      } catch (error) {
        setMessage(errorMessage(error, 'Unable to rename file.'))
        throw error
      }
    },
    [refreshProjectFiles, refreshRecents, setCurrentAutosave, setDocument],
  )

  return {
    api: excalidrawApi,
    setApi: setExcalidrawApi,
    path,
    name,
    message,
    dirty,
    isRefittingText,
    recoverableAutosave,
    setMessage,
    getLiveId,
    captureIntoCache,
    loadDocument,
    releaseDocument,
    detachDocument,
    relocateDocument,
    clearRecoverableAutosave,
    highlightElements,
    clearHighlight,
    hasHighlight: highlight !== null,
    resolveSymbolAt,
    requestFitToContent,
    clearPendingContents,
    handleChange,
    handleSave,
    handleExportPng,
    handleFitToWindow,
    handleRefitText,
    handleRename,
  }
}

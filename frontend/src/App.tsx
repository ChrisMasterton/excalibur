import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import mermaid from 'mermaid'
import './App.css'
import { ExcalidrawWorkspace } from './components/ExcalidrawWorkspace'
import { MermaidWorkspace } from './components/MermaidWorkspace'
import { ProjectsPanel } from './components/ProjectsPanel'
import { RecentList } from './components/RecentList'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar, type SidebarPanel } from './components/Sidebar'
import {
  EXCALIDRAW_AUTOSAVE_KEY,
  EXCALIDRAW_RECOVERY_KEY,
  clearStoredExcalidrawAutosave,
  readStoredExcalidrawAutosave,
  writeStoredExcalidrawAutosave,
} from './lib/autosave'
import {
  SUPPORTED_IMAGE_MIME_TYPES,
  createImageFileId,
  fileToImageImportPayload,
  getFirstSupportedImageFile,
  getImageDisplaySize,
  isSupportedImagePath,
  loadImageDimensions,
  normalizeImageMimeType,
} from './lib/images'
import { convertMermaidToExcalidrawScene } from './lib/mermaidConvert'
import { INITIAL_MERMAID_TEXT, mermaidHistoryReducer } from './lib/mermaidHistory'
import { parseMermaidTitle, titleToFileStem } from './lib/mermaidTitle'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './lib/settings'
import { baseName, dirName, extension, fileStem } from './lib/paths'
import { api, errorMessage } from './lib/tauri'
import { ensureExcalidrawFontsLoaded, refitBoundText } from './lib/textRefit'
import type {
  CanvasClientPosition,
  DiagramKind,
  ExcalidrawAutosave,
  ExcalidrawData,
  ExcalidrawSceneSnapshot,
  ImageImportPayload,
  OpenFileResponse,
  ProjectFile,
  ProjectItem,
  RecentItem,
} from './types'

type ExcalidrawPersistedState = ExcalidrawSceneSnapshot & {
  path: string | null
}

type MermaidPersistedState = {
  path: string | null
  text: string
}

type ApplyExcalidrawContentsRequest = {
  contents: string
  path: string | null
  name?: string | null
  message: string
  markDocumentClean?: boolean
  /** Forget the previous document's saved state (used when converting). */
  resetPersistedState?: boolean
  refreshRecentsOnSuccess?: boolean
  /** Zoom the canvas to the loaded content once it is visible. */
  fitToContent?: boolean
}

type ExcalidrawChangeArgs = Parameters<React.ComponentProps<typeof ExcalidrawWorkspace>['onChange']>

const SAVE_FEEDBACK_HOLD_MS = 100
const SIDEBAR_PANEL_KEY = 'excalibur.sidebar.panel'
const MERMAID_EDITOR_COLLAPSED_KEY = 'excalibur.mermaid.editorCollapsed'

function readStoredFlag(key: string, fallback: boolean) {
  const raw = window.localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}

function getUnsavedChangesMessage(documentName: string, action: string) {
  return `You have unsaved ${documentName} changes. Save them before you ${action}. Select OK to continue without saving, or Cancel to go back.`
}

function getExitUnsavedChangesMessage(hasExcalidrawChanges: boolean, hasMermaidChanges: boolean) {
  if (hasExcalidrawChanges && hasMermaidChanges) {
    return 'You have unsaved changes in Excalidraw and Mermaid. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  if (hasExcalidrawChanges) {
    return 'You have unsaved Excalidraw changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  return 'You have unsaved Mermaid changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
}

function isDiagramPath(path: string): DiagramKind | null {
  const ext = extension(path)
  if (ext === 'excalidraw') return 'excalidraw'
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid'
  return null
}

function App() {
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [workspace, setWorkspace] = useState<DiagramKind>('excalidraw')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>(() =>
    window.localStorage.getItem(SIDEBAR_PANEL_KEY) === 'projects' ? 'projects' : 'recent',
  )
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsRefreshToken, setProjectsRefreshToken] = useState(0)
  const [saveButtonFeedback, setSaveButtonFeedback] = useState<Record<DiagramKind, boolean>>({
    excalidraw: false,
    mermaid: false,
  })
  const saveFeedbackTimersRef = useRef<Record<DiagramKind, number | null>>({
    excalidraw: null,
    mermaid: null,
  })

  const [excalidrawPath, setExcalidrawPath] = useState<string | null>(null)
  const [excalidrawName, setExcalidrawName] = useState('')
  const [excalidrawMessage, setExcalidrawMessage] = useState('')
  const [hasUnsavedExcalidrawChanges, setHasUnsavedExcalidrawChanges] = useState(false)
  const [isRefittingText, setIsRefittingText] = useState(false)
  const [recoverableAutosave, setRecoverableAutosave] = useState<ExcalidrawAutosave | null>(() =>
    readStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY),
  )

  const [mermaidPath, setMermaidPath] = useState<string | null>(null)
  const [mermaidName, setMermaidName] = useState('')
  const [hasUnsavedMermaidChanges, setHasUnsavedMermaidChanges] = useState(false)
  const [mermaidHistory, dispatchMermaid] = useReducer(mermaidHistoryReducer, {
    text: INITIAL_MERMAID_TEXT,
    past: [],
    future: [],
  })
  const mermaidText = mermaidHistory.text
  const mermaidTitle = useMemo(() => parseMermaidTitle(mermaidText), [mermaidText])
  const [mermaidMessage, setMermaidMessage] = useState('')
  const [mermaidSvg, setMermaidSvg] = useState('')
  const [mermaidError, setMermaidError] = useState('')
  const [isConvertingMermaid, setIsConvertingMermaid] = useState(false)
  const [isMermaidEditorCollapsed, setIsMermaidEditorCollapsed] = useState(() =>
    readStoredFlag(MERMAID_EDITOR_COLLAPSED_KEY, false),
  )

  const pendingOpenFile = useRef<string | null>(null)
  const pendingFitToContentRef = useRef(false)
  const pendingExcalidrawContentsRef = useRef<ApplyExcalidrawContentsRequest | null>(null)
  const canvasFrameRef = useRef<HTMLDivElement | null>(null)
  const excalidrawPathRef = useRef<string | null>(null)
  const excalidrawNameRef = useRef('')
  const excalidrawSaveDirectoryRef = useRef<string | null>(null)
  const excalidrawSceneSnapshotRef = useRef<ExcalidrawSceneSnapshot | null>(null)
  const excalidrawPersistedRef = useRef<ExcalidrawPersistedState | null>(null)
  const ignoreEmptyExcalidrawChangeUntilRef = useRef(0)
  const suppressEmptyChangeTimerRef = useRef<number | null>(null)
  const autosaveSnapshotRef = useRef<ExcalidrawAutosave | null>(
    readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY),
  )
  const mermaidPathRef = useRef<string | null>(null)
  const mermaidPersistedRef = useRef<MermaidPersistedState>({ path: null, text: INITIAL_MERMAID_TEXT })
  const isQuittingRef = useRef(false)
  const hasUnsavedExcalidrawChangesRef = useRef(false)
  const hasUnsavedMermaidChangesRef = useRef(false)

  // ---------------------------------------------------------------------------
  // Sidebar data
  // ---------------------------------------------------------------------------

  const refreshRecents = useCallback(async () => {
    try {
      setRecents(await api.listRecents())
    } catch (error) {
      console.error('[excalibur] list_recents failed', error)
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects())
      setProjectsRefreshToken((token) => token + 1)
    } catch (error) {
      console.error('[excalibur] list_projects failed', error)
    }
  }, [])

  useEffect(() => {
    void refreshRecents()
    void refreshProjects()
    api
      .loadSettings()
      .then((raw) => setSettings(normalizeSettings(raw)))
      .catch((error) => console.error('[excalibur] load_settings failed', error))
  }, [refreshProjects, refreshRecents])

  const handleSettingsChange = useCallback((next: Settings) => {
    const normalized = normalizeSettings(next)
    setSettings(normalized)
    api.saveSettings(normalized).catch((error) => console.error('[excalibur] save_settings failed', error))
  }, [])

  const closeSettings = useCallback(() => setIsSettingsOpen(false), [])

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PANEL_KEY, sidebarPanel)
  }, [sidebarPanel])

  useEffect(() => {
    window.localStorage.setItem(MERMAID_EDITOR_COLLAPSED_KEY, String(isMermaidEditorCollapsed))
  }, [isMermaidEditorCollapsed])

  useEffect(() => {
    const saveFeedbackTimers = saveFeedbackTimersRef.current
    return () => {
      for (const timer of Object.values(saveFeedbackTimers)) {
        if (timer !== null) {
          window.clearTimeout(timer)
        }
      }
      if (suppressEmptyChangeTimerRef.current !== null) {
        window.clearTimeout(suppressEmptyChangeTimerRef.current)
      }
    }
  }, [])

  // The canvas is hidden (not unmounted) while Mermaid is active, so let it re-measure when it comes back.
  useEffect(() => {
    if (!excalidrawApi || workspace !== 'excalidraw') {
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
  }, [excalidrawApi, isSidebarCollapsed, workspace])

  const showSaveButtonFeedback = useCallback((kind: DiagramKind) => {
    const activeTimer = saveFeedbackTimersRef.current[kind]
    if (activeTimer !== null) {
      window.clearTimeout(activeTimer)
    }
    setSaveButtonFeedback((current) => ({ ...current, [kind]: true }))
    saveFeedbackTimersRef.current[kind] = window.setTimeout(() => {
      setSaveButtonFeedback((current) => ({ ...current, [kind]: false }))
      saveFeedbackTimersRef.current[kind] = null
    }, SAVE_FEEDBACK_HOLD_MS)
  }, [])

  // ---------------------------------------------------------------------------
  // Excalidraw document state
  // ---------------------------------------------------------------------------

  const setExcalidrawDocument = useCallback((path: string | null, name: string) => {
    excalidrawPathRef.current = path
    excalidrawNameRef.current = name
    setExcalidrawPath(path)
    setExcalidrawName(name)
  }, [])

  const setRecoverableExcalidrawAutosave = useCallback((autosave: ExcalidrawAutosave | null) => {
    setRecoverableAutosave(autosave)
    if (autosave) {
      writeStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY, autosave)
      return
    }
    clearStoredExcalidrawAutosave(EXCALIDRAW_RECOVERY_KEY)
  }, [])

  const setCurrentExcalidrawAutosave = useCallback((autosave: ExcalidrawAutosave | null) => {
    autosaveSnapshotRef.current = autosave
    if (autosave) {
      writeStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY, autosave)
      return
    }
    clearStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY)
  }, [])

  const setExcalidrawPersistedState = useCallback((snapshot: ExcalidrawSceneSnapshot, path: string | null) => {
    excalidrawPersistedRef.current = { ...snapshot, path }
    setHasUnsavedExcalidrawChanges(false)
  }, [])

  const clearExcalidrawPersistedState = useCallback(() => {
    excalidrawPersistedRef.current = null
    setHasUnsavedExcalidrawChanges(false)
  }, [])

  const updateExcalidrawDirtyState = useCallback((snapshot: ExcalidrawSceneSnapshot | null) => {
    const persisted = excalidrawPersistedRef.current
    if (!persisted) {
      setHasUnsavedExcalidrawChanges(snapshot?.hasContent ?? false)
      return
    }
    setHasUnsavedExcalidrawChanges((snapshot?.contents ?? '') !== persisted.contents)
  }, [])

  const setMermaidDocument = useCallback((path: string | null, name: string) => {
    mermaidPathRef.current = path
    setMermaidPath(path)
    setMermaidName(name)
  }, [])

  const setMermaidPersistedState = useCallback((text: string, path: string | null) => {
    mermaidPersistedRef.current = { text, path }
    setHasUnsavedMermaidChanges(false)
  }, [])

  const updateMermaidDirtyState = useCallback((text: string) => {
    setHasUnsavedMermaidChanges(text !== mermaidPersistedRef.current.text)
  }, [])

  const confirmExcalidrawAction = useCallback(
    (action: string) => {
      if (!hasUnsavedExcalidrawChanges) {
        return true
      }
      return window.confirm(getUnsavedChangesMessage('Excalidraw', action))
    },
    [hasUnsavedExcalidrawChanges],
  )

  const confirmMermaidAction = useCallback(
    (action: string) => {
      if (!hasUnsavedMermaidChanges) {
        return true
      }
      return window.confirm(getUnsavedChangesMessage('Mermaid', action))
    },
    [hasUnsavedMermaidChanges],
  )

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      flowchart: { htmlLabels: false },
    })
  }, [])

  useEffect(() => {
    hasUnsavedExcalidrawChangesRef.current = hasUnsavedExcalidrawChanges
    hasUnsavedMermaidChangesRef.current = hasUnsavedMermaidChanges
  }, [hasUnsavedExcalidrawChanges, hasUnsavedMermaidChanges])

  useEffect(() => {
    let isActive = true
    const render = async () => {
      try {
        setMermaidError('')
        const cleanedText = mermaidText.replace(/^\uFEFF/, '').trim()
        if (!cleanedText) {
          setMermaidSvg('')
          return
        }
        const { svg } = await mermaid.render(`m-${Date.now()}`, cleanedText)
        if (isActive) {
          setMermaidSvg(svg)
        }
      } catch {
        if (isActive) {
          setMermaidError('Unable to render diagram. Check syntax.')
        }
      }
    }
    void render()
    return () => {
      isActive = false
    }
  }, [mermaidText])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedExcalidrawChanges && !hasUnsavedMermaidChanges) {
        return
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedExcalidrawChanges, hasUnsavedMermaidChanges])

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (isQuittingRef.current) {
          return
        }
        const hasExcalidrawChanges = hasUnsavedExcalidrawChangesRef.current
        const hasMermaidChanges = hasUnsavedMermaidChangesRef.current
        if (
          (hasExcalidrawChanges || hasMermaidChanges) &&
          !window.confirm(getExitUnsavedChangesMessage(hasExcalidrawChanges, hasMermaidChanges))
        ) {
          return
        }
        isQuittingRef.current = true
        try {
          await api.exitApp()
        } catch (error) {
          isQuittingRef.current = false
          console.error('[excalibur] close request failed to exit app', error)
        }
      })
      .then((cleanup) => {
        if (!isActive) {
          cleanup()
          return
        }
        unlisten = cleanup
      })

    return () => {
      isActive = false
      unlisten?.()
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Excalidraw load / save
  // ---------------------------------------------------------------------------

  const applyExcalidrawContents = useCallback(
    (request: ApplyExcalidrawContentsRequest) => {
      const {
        contents,
        path,
        name,
        message,
        markDocumentClean,
        resetPersistedState,
        refreshRecentsOnSuccess,
        fitToContent,
      } = request

      if (!excalidrawApi) {
        pendingExcalidrawContentsRef.current = request
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

        const normalizedName = name ? fileStem(name) : ''
        const snapshot = {
          contents,
          hasContent: sanitizedElements.some((element) => element.isDeleted !== true),
        }

        excalidrawSceneSnapshotRef.current = snapshot
        if (snapshot.hasContent) {
          // Excalidraw can emit a transient empty change right after updateScene; don't treat it as a wipe.
          ignoreEmptyExcalidrawChangeUntilRef.current = Date.now() + 3000
          if (suppressEmptyChangeTimerRef.current !== null) {
            window.clearTimeout(suppressEmptyChangeTimerRef.current)
          }
          suppressEmptyChangeTimerRef.current = window.setTimeout(() => {
            ignoreEmptyExcalidrawChangeUntilRef.current = 0
            suppressEmptyChangeTimerRef.current = null
          }, 3000)
        }
        setExcalidrawDocument(path, normalizedName)

        excalidrawApi.updateScene({
          elements: sanitizedElements as never[],
          appState: (raw.appState ?? {}) as never,
        })
        const files = raw.files ? Object.values(raw.files) : []
        if (files.length) {
          excalidrawApi.addFiles(files)
        }

        if (snapshot.hasContent) {
          setCurrentExcalidrawAutosave({ contents, path, name: normalizedName, updatedAt: Date.now() })
        } else {
          setCurrentExcalidrawAutosave(null)
        }
        if (markDocumentClean) {
          setExcalidrawPersistedState(snapshot, path)
        } else {
          if (resetPersistedState) {
            excalidrawPersistedRef.current = null
          }
          updateExcalidrawDirtyState(snapshot)
        }
        setExcalidrawMessage(message)
        if (fitToContent) {
          pendingFitToContentRef.current = true
        }
        setWorkspace('excalidraw')
        if (refreshRecentsOnSuccess) {
          void refreshRecents()
        }
      } catch (error) {
        console.error('[excalibur] applyExcalidrawContents: FAILED', error)
        setExcalidrawMessage('Failed to parse .excalidraw file.')
      }
    },
    [
      excalidrawApi,
      refreshRecents,
      setCurrentExcalidrawAutosave,
      setExcalidrawDocument,
      setExcalidrawPersistedState,
      updateExcalidrawDirtyState,
    ],
  )

  const applyExcalidrawFile = useCallback(
    (file: OpenFileResponse) => {
      excalidrawSaveDirectoryRef.current = null
      applyExcalidrawContents({
        contents: file.contents,
        path: file.path,
        name: file.name,
        message: `Opened ${baseName(file.path)}.`,
        markDocumentClean: true,
        refreshRecentsOnSuccess: true,
      })
    },
    [applyExcalidrawContents],
  )

  const flushPendingExcalidrawContents = useCallback(() => {
    if (!excalidrawApi || !pendingExcalidrawContentsRef.current) {
      return false
    }
    const pendingContents = pendingExcalidrawContentsRef.current
    pendingExcalidrawContentsRef.current = null
    applyExcalidrawContents(pendingContents)
    return true
  }, [applyExcalidrawContents, excalidrawApi])

  const handleExcalidrawChange = useCallback(
    (...[elements, appState, files]: ExcalidrawChangeArgs) => {
      const hasContent = elements.some((element) => !element.isDeleted)
      if (
        !hasContent &&
        Date.now() < ignoreEmptyExcalidrawChangeUntilRef.current &&
        excalidrawSceneSnapshotRef.current?.hasContent
      ) {
        return
      }

      const snapshot = {
        contents: serializeAsJSON(elements, appState, files, 'local'),
        hasContent,
      }
      excalidrawSceneSnapshotRef.current = snapshot

      if (!hasContent) {
        setCurrentExcalidrawAutosave(null)
      } else {
        setCurrentExcalidrawAutosave({
          contents: snapshot.contents,
          path: excalidrawPathRef.current,
          name: excalidrawNameRef.current.trim(),
          updatedAt: Date.now(),
        })
      }
      updateExcalidrawDirtyState(snapshot)
    },
    [setCurrentExcalidrawAutosave, updateExcalidrawDirtyState],
  )

  const handleOpenExcalidraw = useCallback(async () => {
    if (!confirmExcalidrawAction('load another document')) {
      return
    }
    try {
      const response = await api.openExcalidrawFile()
      if (response) {
        applyExcalidrawFile(response)
      }
    } catch (error) {
      console.error('[excalibur] open_excalidraw_file failed', error)
      setExcalidrawMessage(errorMessage(error, 'Unable to open drawing.'))
    }
  }, [applyExcalidrawFile, confirmExcalidrawAction])

  const handleSaveExcalidraw = useCallback(async () => {
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
        path: excalidrawPathRef.current,
        name: excalidrawNameRef.current.trim() || undefined,
        directory: excalidrawSaveDirectoryRef.current,
        contents: serialized,
      })
      const snapshot = { contents: serialized, hasContent }
      excalidrawSceneSnapshotRef.current = snapshot
      excalidrawSaveDirectoryRef.current = null
      const nextName = fileStem(response.path)
      setExcalidrawDocument(response.path, nextName)
      if (hasContent) {
        setCurrentExcalidrawAutosave({ contents: serialized, path: response.path, name: nextName, updatedAt: Date.now() })
      } else {
        setCurrentExcalidrawAutosave(null)
      }
      setExcalidrawPersistedState(snapshot, response.path)
      setExcalidrawMessage(`Saved ${baseName(response.path)}.`)
      showSaveButtonFeedback('excalidraw')
      void refreshRecents()
      setProjectsRefreshToken((token) => token + 1)
    } catch (error) {
      if (errorMessage(error, '') !== 'Save cancelled') {
        console.error('[excalibur] save_excalidraw_file failed', error)
        setExcalidrawMessage(errorMessage(error, 'Unable to save drawing.'))
      }
    }
  }, [
    excalidrawApi,
    refreshRecents,
    setCurrentExcalidrawAutosave,
    setExcalidrawDocument,
    setExcalidrawPersistedState,
    showSaveButtonFeedback,
  ])

  const handleExportExcalidrawPng = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    setExcalidrawMessage('')
    excalidrawApi.updateScene({
      appState: { openDialog: { name: 'imageExport' } },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [excalidrawApi])

  const handleFitExcalidrawToWindow = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    if (!excalidrawApi.getSceneElements().some((element) => !element.isDeleted)) {
      setExcalidrawMessage('Nothing on the canvas to fit yet.')
      return
    }
    excalidrawApi.scrollToContent(undefined, { fitToContent: true, animate: true })
  }, [excalidrawApi])

  const handleRefitExcalidrawText = useCallback(async () => {
    if (!excalidrawApi) {
      return
    }
    setIsRefittingText(true)
    try {
      const elements = excalidrawApi.getSceneElementsIncludingDeleted()
      await ensureExcalidrawFontsLoaded(elements)
      const result = refitBoundText(elements)
      if (result.changed === 0) {
        setExcalidrawMessage('Text already fits its containers.')
        return
      }
      excalidrawApi.updateScene({
        elements: result.elements as never[],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      setExcalidrawMessage(`Refit ${result.changed} text ${result.changed === 1 ? 'label' : 'labels'}.`)
    } catch (error) {
      console.error('[excalibur] refit text failed', error)
      setExcalidrawMessage('Unable to refit text.')
    } finally {
      setIsRefittingText(false)
    }
  }, [excalidrawApi])

  const handleNewExcalidraw = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    if (!confirmExcalidrawAction('create a new document')) {
      return
    }
    const autosave = autosaveSnapshotRef.current ?? readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY)
    if (autosave) {
      setRecoverableExcalidrawAutosave(autosave)
    }
    excalidrawSceneSnapshotRef.current = null
    excalidrawSaveDirectoryRef.current = null
    setCurrentExcalidrawAutosave(null)
    clearExcalidrawPersistedState()
    setExcalidrawDocument(null, '')
    excalidrawApi.resetScene()
    setExcalidrawMessage(autosave ? 'Started a new drawing. Recover backup if that was accidental.' : 'Started a new drawing.')
  }, [
    clearExcalidrawPersistedState,
    confirmExcalidrawAction,
    excalidrawApi,
    setCurrentExcalidrawAutosave,
    setExcalidrawDocument,
    setRecoverableExcalidrawAutosave,
  ])

  const handleRecoverExcalidraw = useCallback(() => {
    if (!recoverableAutosave) {
      return
    }
    applyExcalidrawContents({
      contents: recoverableAutosave.contents,
      path: recoverableAutosave.path,
      name: recoverableAutosave.name,
      message: recoverableAutosave.path
        ? `Recovered autosave backup for ${baseName(recoverableAutosave.path)}.`
        : 'Recovered autosave backup.',
      markDocumentClean: false,
    })
  }, [applyExcalidrawContents, recoverableAutosave])

  const loadExcalidrawPath = useCallback(
    async (path: string) => {
      if (!confirmExcalidrawAction('load another document')) {
        return
      }
      try {
        applyExcalidrawFile(await api.loadExcalidrawPath(path))
      } catch (error) {
        console.error('[excalibur] load_excalidraw_path failed', error)
        setExcalidrawMessage(errorMessage(error, `Unable to open ${baseName(path)}.`))
        setWorkspace('excalidraw')
      }
    },
    [applyExcalidrawFile, confirmExcalidrawAction],
  )

  const handleRenameExcalidraw = useCallback(
    async (name: string) => {
      const currentPath = excalidrawPathRef.current
      if (!currentPath) {
        setExcalidrawDocument(null, name)
        if (autosaveSnapshotRef.current) {
          setCurrentExcalidrawAutosave({ ...autosaveSnapshotRef.current, name, updatedAt: Date.now() })
        }
        return
      }
      try {
        const nextPath = await api.renameFile(currentPath, name)
        setExcalidrawDocument(nextPath, fileStem(nextPath))
        if (excalidrawPersistedRef.current) {
          excalidrawPersistedRef.current = { ...excalidrawPersistedRef.current, path: nextPath }
        }
        if (autosaveSnapshotRef.current) {
          setCurrentExcalidrawAutosave({ ...autosaveSnapshotRef.current, path: nextPath, name: fileStem(nextPath), updatedAt: Date.now() })
        }
        setExcalidrawMessage(`Renamed to ${baseName(nextPath)}.`)
        void refreshRecents()
        setProjectsRefreshToken((token) => token + 1)
      } catch (error) {
        setExcalidrawMessage(errorMessage(error, 'Unable to rename file.'))
        throw error
      }
    },
    [refreshRecents, setCurrentExcalidrawAutosave, setExcalidrawDocument],
  )

  // ---------------------------------------------------------------------------
  // Image import
  // ---------------------------------------------------------------------------

  const isClientPointInCanvasFrame = useCallback((position: CanvasClientPosition) => {
    const frame = canvasFrameRef.current
    if (!frame) {
      return false
    }
    const rect = frame.getBoundingClientRect()
    return (
      position.clientX >= rect.left &&
      position.clientX <= rect.right &&
      position.clientY >= rect.top &&
      position.clientY <= rect.bottom
    )
  }, [])

  const importImagePayloadToCanvas = useCallback(
    async (payload: ImageImportPayload, position: CanvasClientPosition | null) => {
      if (!excalidrawApi) {
        setExcalidrawMessage('Canvas is still starting up. Try dropping the image again.')
        return false
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMimeType(payload.mimeType))) {
        setExcalidrawMessage('Drop a PNG, JPEG, or WebP image to import it.')
        return false
      }

      const appState = excalidrawApi.getAppState()
      const scenePosition = viewportCoordsToSceneCoords(
        position ?? {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        appState,
      )
      const imageDimensions = await loadImageDimensions(payload.dataUrl)
      const displaySize = getImageDisplaySize(imageDimensions.width, imageDimensions.height, appState)
      const fileId = createImageFileId()
      const [imageElement] = convertToExcalidrawElements(
        [
          {
            type: 'image',
            x: scenePosition.x - displaySize.width / 2,
            y: scenePosition.y - displaySize.height / 2,
            width: displaySize.width,
            height: displaySize.height,
            fileId,
            status: 'saved',
            scale: [1, 1],
          },
        ],
        { regenerateIds: true },
      )
      if (!imageElement) {
        setExcalidrawMessage('Unable to import image.')
        return false
      }

      excalidrawApi.updateScene({
        elements: [...excalidrawApi.getSceneElementsIncludingDeleted(), imageElement],
        appState: { selectedElementIds: { [imageElement.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      excalidrawApi.addFiles([
        {
          id: fileId,
          mimeType: normalizeImageMimeType(payload.mimeType) as BinaryFileData['mimeType'],
          dataURL: payload.dataUrl as BinaryFileData['dataURL'],
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ])
      setWorkspace('excalidraw')
      setExcalidrawMessage(`Imported ${payload.sourcePath ? baseName(payload.sourcePath) : payload.name}.`)
      return true
    },
    [excalidrawApi],
  )

  const importNativeImagePath = useCallback(
    async (path: string, position: CanvasClientPosition | null) => {
      try {
        const response = await api.loadImageFile(path)
        return await importImagePayloadToCanvas(
          {
            name: response.name ?? baseName(response.path),
            mimeType: response.mime_type,
            dataUrl: response.data_url,
            sourcePath: response.path,
          },
          position,
        )
      } catch (error) {
        console.error('[excalibur] load_image_file failed', error)
        setExcalidrawMessage('Drop a PNG, JPEG, or WebP image to import it.')
        return false
      }
    },
    [importImagePayloadToCanvas],
  )

  const handleCanvasImageDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!getFirstSupportedImageFile(event.dataTransfer.files)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleCanvasImageDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      const file = getFirstSupportedImageFile(event.dataTransfer.files)
      if (!file) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const position = { clientX: event.clientX, clientY: event.clientY }
      try {
        await importImagePayloadToCanvas(await fileToImageImportPayload(file), position)
      } catch (error) {
        console.error('[excalibur] image drop failed', error)
        setExcalidrawMessage('Drop a PNG, JPEG, or WebP image to import it.')
      }
    },
    [importImagePayloadToCanvas],
  )

  // ---------------------------------------------------------------------------
  // Mermaid document
  // ---------------------------------------------------------------------------

  const applyMermaidFile = useCallback(
    (response: OpenFileResponse) => {
      const nextName = fileStem(response.path)
      setMermaidDocument(response.path, nextName)
      dispatchMermaid({ type: 'reset', text: response.contents })
      setMermaidPersistedState(response.contents, response.path)
      setMermaidMessage(`Opened ${baseName(response.path)}.`)
      setWorkspace('mermaid')
      void refreshRecents()
    },
    [refreshRecents, setMermaidDocument, setMermaidPersistedState],
  )

  const handleOpenMermaid = useCallback(async () => {
    if (!confirmMermaidAction('load another document')) {
      return
    }
    try {
      const response = await api.openMermaidFile()
      if (response) {
        applyMermaidFile(response)
      }
    } catch (error) {
      setMermaidMessage(errorMessage(error, 'Unable to open Mermaid file.'))
    }
  }, [applyMermaidFile, confirmMermaidAction])

  const loadMermaidPath = useCallback(
    async (path: string) => {
      if (!confirmMermaidAction('load another document')) {
        return
      }
      try {
        applyMermaidFile(await api.loadMermaidPath(path))
      } catch (error) {
        setMermaidMessage(errorMessage(error, `Unable to open ${baseName(path)}.`))
        setWorkspace('mermaid')
      }
    },
    [applyMermaidFile, confirmMermaidAction],
  )

  const handleSaveMermaid = useCallback(async () => {
    const nextName = mermaidName.trim()
    try {
      const response = await api.saveMermaidFile({
        path: mermaidPath,
        name: nextName || undefined,
        contents: mermaidText,
      })
      setMermaidDocument(response.path, fileStem(response.path))
      setMermaidPersistedState(mermaidText, response.path)
      setMermaidMessage(`Saved ${baseName(response.path)}.`)
      showSaveButtonFeedback('mermaid')
      void refreshRecents()
      setProjectsRefreshToken((token) => token + 1)
    } catch (error) {
      if (errorMessage(error, '') !== 'Save cancelled') {
        setMermaidMessage(errorMessage(error, 'Unable to save Mermaid file.'))
      }
    }
  }, [mermaidName, mermaidPath, mermaidText, refreshRecents, setMermaidDocument, setMermaidPersistedState, showSaveButtonFeedback])

  const handleRenameMermaid = useCallback(
    async (name: string) => {
      const currentPath = mermaidPathRef.current
      if (!currentPath) {
        setMermaidDocument(null, name)
        return
      }
      try {
        const nextPath = await api.renameFile(currentPath, name)
        setMermaidDocument(nextPath, fileStem(nextPath))
        mermaidPersistedRef.current = { ...mermaidPersistedRef.current, path: nextPath }
        setMermaidMessage(`Renamed to ${baseName(nextPath)}.`)
        void refreshRecents()
        setProjectsRefreshToken((token) => token + 1)
      } catch (error) {
        setMermaidMessage(errorMessage(error, 'Unable to rename file.'))
        throw error
      }
    },
    [refreshRecents, setMermaidDocument],
  )

  const handleConvertMermaidToExcalidraw = useCallback(async () => {
    const cleanedText = mermaidText.replace(/^\uFEFF/, '').trim()
    if (!cleanedText) {
      setMermaidMessage('Nothing to convert yet.')
      return
    }
    if (mermaidError) {
      setMermaidMessage('Fix Mermaid syntax before converting.')
      return
    }
    if (!confirmExcalidrawAction('replace the current Excalidraw document')) {
      return
    }

    const autosave = autosaveSnapshotRef.current ?? readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY)
    if (autosave) {
      setRecoverableExcalidrawAutosave(autosave)
    }

    setIsConvertingMermaid(true)
    setMermaidMessage('')
    try {
      const serialized = await convertMermaidToExcalidrawScene(cleanedText)

      excalidrawSaveDirectoryRef.current = mermaidPath ? dirName(mermaidPath) : null
      applyExcalidrawContents({
        contents: serialized,
        path: null,
        name: mermaidName.trim() || (mermaidTitle ? titleToFileStem(mermaidTitle) : '') || 'diagram',
        message: 'Converted from Mermaid. Save to write an .excalidraw file.',
        markDocumentClean: false,
        resetPersistedState: true,
        fitToContent: true,
      })
      setMermaidMessage('Converted to Excalidraw.')
    } catch (error) {
      console.error('[excalibur] mermaid conversion failed', error)
      pendingExcalidrawContentsRef.current = null
      setMermaidMessage(errorMessage(error, 'Unable to convert Mermaid to Excalidraw.'))
    } finally {
      setIsConvertingMermaid(false)
    }
  }, [
    applyExcalidrawContents,
    confirmExcalidrawAction,
    mermaidError,
    mermaidName,
    mermaidPath,
    mermaidText,
    mermaidTitle,
    setRecoverableExcalidrawAutosave,
  ])

  const handleMermaidTextChange = useCallback(
    (text: string) => {
      dispatchMermaid({ type: 'set', text })
      updateMermaidDirtyState(text)
    },
    [updateMermaidDirtyState],
  )

  const handleMermaidKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const isModifier = event.metaKey || event.ctrlKey
      if (isModifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          const nextText = mermaidHistory.future[0]
          if (nextText !== undefined) {
            updateMermaidDirtyState(nextText)
          }
          dispatchMermaid({ type: 'redo' })
        } else {
          const nextText = mermaidHistory.past[mermaidHistory.past.length - 1]
          if (nextText !== undefined) {
            updateMermaidDirtyState(nextText)
          }
          dispatchMermaid({ type: 'undo' })
        }
        return
      }
      if (isModifier && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const nextText = mermaidHistory.future[0]
        if (nextText !== undefined) {
          updateMermaidDirtyState(nextText)
        }
        dispatchMermaid({ type: 'redo' })
        return
      }
      if (event.key === 'Tab' && !isModifier) {
        event.preventDefault()
        const target = event.currentTarget
        const { selectionStart, selectionEnd, value } = target
        const nextText = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
        handleMermaidTextChange(nextText)
        requestAnimationFrame(() => {
          target.selectionStart = target.selectionEnd = selectionStart + 2
        })
      }
    },
    [handleMermaidTextChange, mermaidHistory.future, mermaidHistory.past, updateMermaidDirtyState],
  )

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  const notify = useCallback(
    (message: string) => {
      if (workspace === 'excalidraw') {
        setExcalidrawMessage(message)
      } else {
        setMermaidMessage(message)
      }
    },
    [workspace],
  )

  const openDiagram = useCallback(
    (kind: DiagramKind, path: string) => {
      if (kind === 'excalidraw') {
        void loadExcalidrawPath(path)
      } else {
        void loadMermaidPath(path)
      }
    },
    [loadExcalidrawPath, loadMermaidPath],
  )

  /** Keeps open documents pointing at files that were moved or renamed underneath them. */
  const relocateOpenDocuments = useCallback(
    (oldPrefix: string, newPrefix: string) => {
      const relocate = (path: string | null) =>
        path && (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) ? `${newPrefix}${path.slice(oldPrefix.length)}` : null

      const nextExcalidraw = relocate(excalidrawPathRef.current)
      if (nextExcalidraw) {
        setExcalidrawDocument(nextExcalidraw, fileStem(nextExcalidraw))
        if (excalidrawPersistedRef.current) {
          excalidrawPersistedRef.current = { ...excalidrawPersistedRef.current, path: nextExcalidraw }
        }
      }
      const nextMermaid = relocate(mermaidPathRef.current)
      if (nextMermaid) {
        setMermaidDocument(nextMermaid, fileStem(nextMermaid))
        mermaidPersistedRef.current = { ...mermaidPersistedRef.current, path: nextMermaid }
      }
    },
    [setExcalidrawDocument, setMermaidDocument],
  )

  const handleAddProject = useCallback(async () => {
    try {
      const project = await api.addProjectFolder()
      if (!project) {
        return null
      }
      await refreshProjects()
      setSidebarPanel('projects')
      return project
    } catch (error) {
      notify(errorMessage(error, 'Unable to add project.'))
      return null
    }
  }, [notify, refreshProjects])

  const handleRemoveProject = useCallback(
    async (project: ProjectItem) => {
      setProjects(await api.removeProject(project.path))
    },
    [],
  )

  const handleRenameProject = useCallback(
    async (project: ProjectItem, name: string) => {
      const updated = await api.renameProject(project.path, name)
      relocateOpenDocuments(project.path, updated.path)
      await refreshProjects()
      void refreshRecents()
    },
    [refreshProjects, refreshRecents, relocateOpenDocuments],
  )

  const moveFileToProject = useCallback(
    async (path: string, project: ProjectItem) => {
      try {
        const nextPath = await api.moveFileToProject(path, project.path)
        relocateOpenDocuments(path, nextPath)
        notify(`Moved ${baseName(nextPath)} to ${project.name}.`)
        void refreshRecents()
        setProjectsRefreshToken((token) => token + 1)
      } catch (error) {
        notify(errorMessage(error, 'Unable to move file.'))
      }
    },
    [notify, refreshRecents, relocateOpenDocuments],
  )

  const moveFileToNewProject = useCallback(
    async (path: string) => {
      const project = await handleAddProject()
      if (project) {
        await moveFileToProject(path, project)
      }
    },
    [handleAddProject, moveFileToProject],
  )

  const handleRemoveRecent = useCallback(async (item: RecentItem) => {
    setRecents(await api.removeRecent(item.kind, item.path))
  }, [])

  // ---------------------------------------------------------------------------
  // Native events: file drops, file associations, startup file
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null
    const currentWindow = getCurrentWindow()

    currentWindow
      .onDragDropEvent(async (event) => {
        if (!isActive || event.payload.type !== 'drop') {
          return
        }
        const paths = event.payload.paths

        const imagePath = paths.find(isSupportedImagePath)
        if (imagePath) {
          const scaleFactor = await currentWindow.scaleFactor().catch(() => window.devicePixelRatio || 1)
          const logicalPosition = event.payload.position.toLogical(scaleFactor)
          const position = { clientX: logicalPosition.x, clientY: logicalPosition.y }
          if (isClientPointInCanvasFrame(position)) {
            await importNativeImagePath(imagePath, position)
          }
          return
        }

        const diagramPath = paths.find((path) => isDiagramPath(path))
        if (diagramPath) {
          openDiagram(isDiagramPath(diagramPath)!, diagramPath)
          return
        }

        // Anything else without an extension is probably a folder: offer it as a project.
        const folderPath = paths.find((path) => !extension(path))
        if (folderPath) {
          try {
            await api.addProjectPath(folderPath)
            await refreshProjects()
            setSidebarPanel('projects')
          } catch (error) {
            console.warn('[excalibur] dropped path is not a project folder', error)
          }
        }
      })
      .then((cleanup) => {
        if (!isActive) {
          cleanup()
          return
        }
        unlisten = cleanup
      })

    return () => {
      isActive = false
      unlisten?.()
    }
  }, [importNativeImagePath, isClientPointInCanvasFrame, openDiagram, refreshProjects])

  useEffect(() => {
    const unlisten = listen<string>('open-file', (event) => {
      if (excalidrawApi) {
        void loadExcalidrawPath(event.payload)
      } else {
        pendingOpenFile.current = event.payload
      }
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [excalidrawApi, loadExcalidrawPath])

  useEffect(() => {
    if (!excalidrawApi) return
    if (flushPendingExcalidrawContents()) {
      return
    }
    if (pendingOpenFile.current) {
      const path = pendingOpenFile.current
      pendingOpenFile.current = null
      void loadExcalidrawPath(path)
      return
    }
    api.takePendingFile().then((path) => {
      if (path) {
        void loadExcalidrawPath(path)
      }
    })
  }, [excalidrawApi, flushPendingExcalidrawContents, loadExcalidrawPath])

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (Excalidraw's own open/save are disabled in favour of ours)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === ',') {
        event.preventDefault()
        setIsSettingsOpen(true)
        return
      }
      if (key === 's') {
        event.preventDefault()
        if (workspace === 'excalidraw') {
          void handleSaveExcalidraw()
        } else {
          void handleSaveMermaid()
        }
      } else if (key === 'o') {
        event.preventDefault()
        if (workspace === 'excalidraw') {
          void handleOpenExcalidraw()
        } else {
          void handleOpenMermaid()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleOpenExcalidraw, handleOpenMermaid, handleSaveExcalidraw, handleSaveMermaid, workspace])

  // ---------------------------------------------------------------------------

  const activePaths: Record<DiagramKind, string | null> = { excalidraw: excalidrawPath, mermaid: mermaidPath }

  return (
    <div className={`app-shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={isSidebarCollapsed}
        onCollapsedChange={setIsSidebarCollapsed}
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
        panel={sidebarPanel}
        onPanelChange={setSidebarPanel}
        dirty={{ excalidraw: hasUnsavedExcalidrawChanges, mermaid: hasUnsavedMermaidChanges }}
        onOpenSettings={() => setIsSettingsOpen(true)}
      >
        {sidebarPanel === 'recent' ? (
          <RecentList
            recents={recents}
            projects={projects}
            activePaths={activePaths}
            onOpen={(item) => openDiagram(item.kind, item.path)}
            onMoveToProject={(item, project) => void moveFileToProject(item.path, project)}
            onMoveToNewProject={(item) => void moveFileToNewProject(item.path)}
            onRemove={(item) => void handleRemoveRecent(item)}
          />
        ) : (
          <ProjectsPanel
            projects={projects}
            refreshToken={projectsRefreshToken}
            activePaths={activePaths}
            onAddProject={() => void handleAddProject()}
            onRemoveProject={(project) => void handleRemoveProject(project)}
            onRenameProject={handleRenameProject}
            onOpenFile={(file: ProjectFile) => openDiagram(file.kind, file.path)}
            onMoveFile={(file, project) => void moveFileToProject(file.path, project)}
            onMoveFileToNewProject={(file) => void moveFileToNewProject(file.path)}
            onError={notify}
          />
        )}
      </Sidebar>

      <main className="workspace">
        <ExcalidrawWorkspace
          hidden={workspace !== 'excalidraw'}
          title={excalidrawName}
          path={excalidrawPath}
          dirty={hasUnsavedExcalidrawChanges}
          message={excalidrawMessage}
          hasRecovery={Boolean(recoverableAutosave)}
          saveFeedback={saveButtonFeedback.excalidraw}
          isRefitting={isRefittingText}
          apiReady={Boolean(excalidrawApi)}
          canvasFrameRef={canvasFrameRef}
          onRename={handleRenameExcalidraw}
          onNew={handleNewExcalidraw}
          onOpen={() => void handleOpenExcalidraw()}
          onSave={() => void handleSaveExcalidraw()}
          onExportPng={handleExportExcalidrawPng}
          onFitToWindow={handleFitExcalidrawToWindow}
          onRefitText={() => void handleRefitExcalidrawText()}
          onRecover={handleRecoverExcalidraw}
          onDragOver={handleCanvasImageDragOver}
          onDrop={(event) => void handleCanvasImageDrop(event)}
          onApi={setExcalidrawApi}
          onChange={handleExcalidrawChange}
        />
        <MermaidWorkspace
          hidden={workspace !== 'mermaid'}
          title={mermaidName}
          path={mermaidPath}
          dirty={hasUnsavedMermaidChanges}
          message={mermaidMessage}
          subtitle={mermaidTitle}
          settings={settings}
          saveFeedback={saveButtonFeedback.mermaid}
          isConverting={isConvertingMermaid}
          editorCollapsed={isMermaidEditorCollapsed}
          text={mermaidText}
          svg={mermaidSvg}
          error={mermaidError}
          onRename={handleRenameMermaid}
          onOpen={() => void handleOpenMermaid()}
          onSave={() => void handleSaveMermaid()}
          onConvert={() => void handleConvertMermaidToExcalidraw()}
          onToggleEditor={() => setIsMermaidEditorCollapsed((current) => !current)}
          onTextChange={handleMermaidTextChange}
          onKeyDown={handleMermaidKeyDown}
        />
      </main>
      <SettingsDialog open={isSettingsOpen} settings={settings} onChange={handleSettingsChange} onClose={closeSettings} />
    </div>
  )
}

export default App

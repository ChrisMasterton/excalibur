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
import { DocumentTabs } from './components/DocumentTabs'
import { ExcalidrawWorkspace } from './components/ExcalidrawWorkspace'
import { MermaidWorkspace } from './components/MermaidWorkspace'
import { ProjectsPanel } from './components/ProjectsPanel'
import { RecentList } from './components/RecentList'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar, type SidebarPanel } from './components/Sidebar'
import {
  documentDisplayName,
  readStoredOpenDocuments,
  useOpenDocuments,
  writeStoredOpenDocuments,
  type NewDocumentInput,
} from './hooks/useOpenDocuments'
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
  OpenDocument,
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

/**
 * What counts as "saved" once the contents land on the canvas:
 * `clean` = the contents came from disk, `keep` = leave the current baseline alone,
 * `{ snapshot }` = an explicit baseline (a restored tab; null for a never-saved one).
 */
type ExcalidrawBaseline = 'clean' | 'keep' | { snapshot: ExcalidrawSceneSnapshot | null }

type ApplyExcalidrawContentsRequest = {
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

type OpenPathOptions = { trackRecent?: boolean; activate?: boolean }

type ExcalidrawChangeArgs = Parameters<React.ComponentProps<typeof ExcalidrawWorkspace>['onChange']>

const SAVE_FEEDBACK_HOLD_MS = 100
const SIDEBAR_PANEL_KEY = 'excalibur.sidebar.panel'
const MERMAID_EDITOR_COLLAPSED_KEY = 'excalibur.mermaid.editorCollapsed'
const EMPTY_EXCALIDRAW_CONTENTS = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'local',
  elements: [],
  appState: {},
  files: {},
})

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

function kindLabel(kind: DiagramKind) {
  return kind === 'excalidraw' ? 'Excalidraw' : 'Mermaid'
}

/** Cheap scene summary for a tab that has not been put on the canvas yet. */
function excalidrawSnapshotFromContents(contents: string): ExcalidrawSceneSnapshot {
  try {
    const parsed = JSON.parse(contents) as Partial<ExcalidrawData> & { data?: Partial<ExcalidrawData> }
    const raw = parsed.data && parsed.data.elements ? parsed.data : parsed
    const elements = (raw.elements ?? []) as Array<{ isDeleted?: boolean }>
    return { contents, hasContent: elements.some((element) => element.isDeleted !== true) }
  } catch {
    return { contents, hasContent: false }
  }
}

/** Tab contents for a file that was just read from disk. */
function documentInputForFile(kind: DiagramKind, file: OpenFileResponse): NewDocumentInput {
  if (kind === 'excalidraw') {
    const snapshot = excalidrawSnapshotFromContents(file.contents)
    return {
      kind,
      path: file.path,
      name: file.name ? fileStem(file.name) : fileStem(file.path),
      excalidraw: { scene: snapshot, persistedScene: snapshot, saveDirectory: null },
    }
  }
  return {
    kind,
    path: file.path,
    name: fileStem(file.path),
    title: parseMermaidTitle(file.contents),
    mermaid: {
      history: { text: file.contents, past: [], future: [] },
      persistedText: file.contents,
    },
  }
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

  const {
    documents,
    activeId,
    activeDocument,
    openPaths,
    getDocuments,
    getDocument,
    findByPath,
    openDocument,
    replaceDocument,
    findPristineDocument,
    patchDocument,
    closeDocuments,
    readExcalidrawCache,
    writeExcalidrawCache,
    readMermaidCache,
    writeMermaidCache,
    setActiveId,
  } = useOpenDocuments()

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
  const mermaidHistoryRef = useRef(mermaidHistory)
  const isQuittingRef = useRef(false)
  /** Which tab each live editor is currently holding. */
  const liveExcalidrawIdRef = useRef<string | null>(null)
  const liveMermaidIdRef = useRef<string | null>(null)
  const lastActiveByKindRef = useRef<Record<DiagramKind, string | null>>({ excalidraw: null, mermaid: null })
  const hasRestoredDocumentsRef = useRef(false)
  const startedRestoreRef = useRef(false)
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    mermaidHistoryRef.current = mermaidHistory
  }, [mermaidHistory])

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

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

  /** Status message for whichever workspace the user is looking at. */
  const notify = useCallback((message: string) => {
    if (workspaceRef.current === 'excalidraw') {
      setExcalidrawMessage(message)
    } else {
      setMermaidMessage(message)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Live document state (mirrored into the active tab)
  // ---------------------------------------------------------------------------

  const setExcalidrawDocument = useCallback(
    (path: string | null, name: string) => {
      excalidrawPathRef.current = path
      excalidrawNameRef.current = name
      setExcalidrawPath(path)
      setExcalidrawName(name)
      patchDocument(liveExcalidrawIdRef.current, { path, name })
    },
    [patchDocument],
  )

  const markExcalidrawDirty = useCallback(
    (dirty: boolean) => {
      setHasUnsavedExcalidrawChanges(dirty)
      patchDocument(liveExcalidrawIdRef.current, { dirty })
    },
    [patchDocument],
  )

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

  const setExcalidrawPersistedState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot, path: string | null) => {
      excalidrawPersistedRef.current = { ...snapshot, path }
      markExcalidrawDirty(false)
    },
    [markExcalidrawDirty],
  )

  const updateExcalidrawDirtyState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot | null) => {
      const persisted = excalidrawPersistedRef.current
      if (!persisted) {
        markExcalidrawDirty(snapshot?.hasContent ?? false)
        return
      }
      markExcalidrawDirty((snapshot?.contents ?? '') !== persisted.contents)
    },
    [markExcalidrawDirty],
  )

  const setMermaidDocument = useCallback(
    (path: string | null, name: string) => {
      mermaidPathRef.current = path
      setMermaidPath(path)
      setMermaidName(name)
      patchDocument(liveMermaidIdRef.current, { path, name })
    },
    [patchDocument],
  )

  const markMermaidDirty = useCallback(
    (dirty: boolean) => {
      setHasUnsavedMermaidChanges(dirty)
      patchDocument(liveMermaidIdRef.current, { dirty })
    },
    [patchDocument],
  )

  const setMermaidPersistedState = useCallback(
    (text: string, path: string | null) => {
      mermaidPersistedRef.current = { text, path }
      markMermaidDirty(false)
    },
    [markMermaidDirty],
  )

  const updateMermaidDirtyState = useCallback(
    (text: string) => {
      markMermaidDirty(text !== mermaidPersistedRef.current.text)
    },
    [markMermaidDirty],
  )

  // Keep the Mermaid tab labelled with the title from its frontmatter.
  useEffect(() => {
    patchDocument(liveMermaidIdRef.current, { title: mermaidTitle })
  }, [mermaidTitle, patchDocument])

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      flowchart: { htmlLabels: false },
    })
  }, [])

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

  const hasUnsavedDocuments = documents.some((document) => document.dirty)

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedDocuments) {
        return
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedDocuments])

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (isQuittingRef.current) {
          return
        }
        const dirty = getDocuments().filter((document) => document.dirty)
        const hasExcalidrawChanges = dirty.some((document) => document.kind === 'excalidraw')
        const hasMermaidChanges = dirty.some((document) => document.kind === 'mermaid')
        if (
          dirty.length &&
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
  }, [getDocuments])

  // ---------------------------------------------------------------------------
  // Excalidraw canvas
  // ---------------------------------------------------------------------------

  const applyExcalidrawContents = useCallback(
    (request: ApplyExcalidrawContentsRequest) => {
      const { documentId, contents, path, name, message, baseline, fitToContent } = request

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

        const normalizedName = name ?? ''
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
        // From here on the canvas belongs to this tab, so live state mirrors into it.
        liveExcalidrawIdRef.current = documentId
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
        if (baseline === 'clean') {
          setExcalidrawPersistedState(snapshot, path)
        } else {
          if (baseline !== 'keep') {
            excalidrawPersistedRef.current = baseline.snapshot ? { ...baseline.snapshot, path } : null
          }
          updateExcalidrawDirtyState(snapshot)
        }
        setExcalidrawMessage(message)
        if (fitToContent) {
          pendingFitToContentRef.current = true
        }
        setWorkspace('excalidraw')
      } catch (error) {
        console.error('[excalibur] applyExcalidrawContents: FAILED', error)
        setExcalidrawMessage('Failed to parse .excalidraw file.')
      }
    },
    [
      excalidrawApi,
      setCurrentExcalidrawAutosave,
      setExcalidrawDocument,
      setExcalidrawPersistedState,
      updateExcalidrawDirtyState,
    ],
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

  // ---------------------------------------------------------------------------
  // Tabs: snapshot the live editors, load a tab back into them, activate
  // ---------------------------------------------------------------------------

  /** Copies whatever the live editors hold back into their tabs before switching. */
  const snapshotLiveDocuments = useCallback(() => {
    const excalidrawId = liveExcalidrawIdRef.current
    if (excalidrawId) {
      writeExcalidrawCache(excalidrawId, {
        scene: excalidrawSceneSnapshotRef.current,
        persistedScene: excalidrawPersistedRef.current,
        saveDirectory: excalidrawSaveDirectoryRef.current,
      })
    }
    const mermaidId = liveMermaidIdRef.current
    if (mermaidId) {
      writeMermaidCache(mermaidId, {
        history: mermaidHistoryRef.current,
        persistedText: mermaidPersistedRef.current.text,
      })
    }
  }, [writeExcalidrawCache, writeMermaidCache])

  const loadExcalidrawDocument = useCallback(
    (document: OpenDocument, message: string) => {
      if (liveExcalidrawIdRef.current === document.id) {
        setExcalidrawMessage(message)
        return
      }
      const cache = readExcalidrawCache(document.id)
      excalidrawSaveDirectoryRef.current = cache?.saveDirectory ?? null
      applyExcalidrawContents({
        documentId: document.id,
        contents: cache?.scene?.contents ?? EMPTY_EXCALIDRAW_CONTENTS,
        path: document.path,
        name: document.name,
        message,
        baseline: { snapshot: cache?.persistedScene ?? null },
      })
    },
    [applyExcalidrawContents, readExcalidrawCache],
  )

  const loadMermaidDocument = useCallback(
    (document: OpenDocument, message: string) => {
      if (liveMermaidIdRef.current === document.id) {
        setMermaidMessage(message)
        return
      }
      const cache = readMermaidCache(document.id) ?? {
        history: { text: INITIAL_MERMAID_TEXT, past: [], future: [] },
        persistedText: INITIAL_MERMAID_TEXT,
      }
      liveMermaidIdRef.current = document.id
      mermaidHistoryRef.current = cache.history
      dispatchMermaid({ type: 'restore', state: cache.history })
      mermaidPersistedRef.current = { path: document.path, text: cache.persistedText }
      setMermaidDocument(document.path, document.name)
      markMermaidDirty(cache.history.text !== cache.persistedText)
      setMermaidMessage(message)
    },
    [markMermaidDirty, readMermaidCache, setMermaidDocument],
  )

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
    [getDocument, loadExcalidrawDocument, loadMermaidDocument, setActiveId, snapshotLiveDocuments],
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
      if (pristine.id === liveExcalidrawIdRef.current) {
        liveExcalidrawIdRef.current = null
      }
      if (pristine.id === liveMermaidIdRef.current) {
        liveMermaidIdRef.current = null
      }
      if (lastActiveByKindRef.current[pristine.kind] === pristine.id) {
        lastActiveByKindRef.current[pristine.kind] = null
      }
      return replaceDocument(pristine.id, input)
    },
    [findPristineDocument, openDocument, replaceDocument, snapshotLiveDocuments],
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
        void refreshRecents()
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

  // ---------------------------------------------------------------------------
  // Closing tabs
  // ---------------------------------------------------------------------------

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
        if (document.id === liveExcalidrawIdRef.current) {
          // Losing unsaved canvas work is the one place a backup still earns its keep.
          if (document.dirty && autosaveSnapshotRef.current) {
            setRecoverableExcalidrawAutosave(autosaveSnapshotRef.current)
          }
          liveExcalidrawIdRef.current = null
          excalidrawSceneSnapshotRef.current = null
          excalidrawPersistedRef.current = null
          excalidrawSaveDirectoryRef.current = null
          setCurrentExcalidrawAutosave(null)
        }
        if (document.id === liveMermaidIdRef.current) {
          liveMermaidIdRef.current = null
        }
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
      getDocument,
      setCurrentExcalidrawAutosave,
      setRecoverableExcalidrawAutosave,
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

  // ---------------------------------------------------------------------------
  // Excalidraw actions
  // ---------------------------------------------------------------------------

  const handleOpenExcalidraw = useCallback(async () => {
    try {
      const response = await api.openExcalidrawFile()
      if (response) {
        openLoadedFile('excalidraw', response)
        void refreshRecents()
      }
    } catch (error) {
      console.error('[excalibur] open_excalidraw_file failed', error)
      setExcalidrawMessage(errorMessage(error, 'Unable to open drawing.'))
    }
  }, [openLoadedFile, refreshRecents])

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
    activateDocument(createDocument('excalidraw').id, 'Started a new drawing.')
  }, [activateDocument, createDocument])

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
      if (liveExcalidrawIdRef.current === existing.id) {
        // Force the canvas to reload the tab now that its cache holds the backup.
        liveExcalidrawIdRef.current = null
      }
      activateDocument(existing.id, message)
      setRecoverableExcalidrawAutosave(null)
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
    setRecoverableExcalidrawAutosave(null)
  }, [
    activateDocument,
    createDocumentFrom,
    findByPath,
    readExcalidrawCache,
    recoverableAutosave,
    setRecoverableExcalidrawAutosave,
    snapshotLiveDocuments,
    writeExcalidrawCache,
  ])

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

  const handleOpenMermaid = useCallback(async () => {
    try {
      const response = await api.openMermaidFile()
      if (response) {
        openLoadedFile('mermaid', response)
        void refreshRecents()
      }
    } catch (error) {
      setMermaidMessage(errorMessage(error, 'Unable to open Mermaid file.'))
    }
  }, [openLoadedFile, refreshRecents])

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

    setIsConvertingMermaid(true)
    setMermaidMessage('')
    try {
      const serialized = await convertMermaidToExcalidrawScene(cleanedText)
      // The conversion becomes its own unsaved tab; the Mermaid source keeps its own.
      const converted = createDocumentFrom(
        {
          kind: 'excalidraw',
          name: mermaidName.trim() || (mermaidTitle ? titleToFileStem(mermaidTitle) : '') || 'diagram',
          dirty: true,
          excalidraw: {
            scene: excalidrawSnapshotFromContents(serialized),
            persistedScene: null,
            saveDirectory: mermaidPath ? dirName(mermaidPath) : null,
          },
        },
        'excalidraw',
      )
      pendingFitToContentRef.current = true
      activateDocument(converted.id, 'Converted from Mermaid. Save to write an .excalidraw file.')
      setMermaidMessage('Converted to Excalidraw.')
    } catch (error) {
      console.error('[excalibur] mermaid conversion failed', error)
      pendingExcalidrawContentsRef.current = null
      setMermaidMessage(errorMessage(error, 'Unable to convert Mermaid to Excalidraw.'))
    } finally {
      setIsConvertingMermaid(false)
    }
  }, [
    activateDocument,
    createDocumentFrom,
    mermaidError,
    mermaidName,
    mermaidPath,
    mermaidText,
    mermaidTitle,
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

  /** Opens every diagram in a project folder as a tab, without flooding Recent. */
  const handleOpenAllProjectFiles = useCallback(
    async (project: ProjectItem) => {
      try {
        const files = await api.listProjectFiles(project.path)
        const pending = files.filter((file) => !findByPath(file.path))
        if (!pending.length) {
          notify(`Every diagram in ${project.name} is already open.`)
          return
        }
        const loaded = await Promise.all(
          pending.map(async (file) => {
            try {
              const response =
                file.kind === 'excalidraw'
                  ? await api.loadExcalidrawPath(file.path, false)
                  : await api.loadMermaidPath(file.path, false)
              return { kind: file.kind, response }
            } catch (error) {
              console.warn('[excalibur] unable to open project file', file.path, error)
              return null
            }
          }),
        )
        const opened = loaded
          .filter((item): item is { kind: DiagramKind; response: OpenFileResponse } => Boolean(item))
          .map((item) => openLoadedFile(item.kind, item.response, false))
        if (!opened.length) {
          notify(`Unable to open the diagrams in ${project.name}.`)
          return
        }
        activateDocument(
          opened[0].id,
          `Opened ${opened.length} ${opened.length === 1 ? 'diagram' : 'diagrams'} from ${project.name}.`,
        )
      } catch (error) {
        notify(errorMessage(error, `Unable to open the diagrams in ${project.name}.`))
      }
    },
    [activateDocument, findByPath, notify, openLoadedFile],
  )

  /** Keeps open documents pointing at files that were moved or renamed underneath them. */
  const relocateOpenDocuments = useCallback(
    (oldPrefix: string, newPrefix: string) => {
      const relocate = (path: string | null) =>
        path && (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) ? `${newPrefix}${path.slice(oldPrefix.length)}` : null

      for (const document of getDocuments()) {
        const nextPath = relocate(document.path)
        if (!nextPath) {
          continue
        }
        patchDocument(document.id, { path: nextPath, name: fileStem(nextPath) })
        if (document.id === liveExcalidrawIdRef.current) {
          setExcalidrawDocument(nextPath, fileStem(nextPath))
          if (excalidrawPersistedRef.current) {
            excalidrawPersistedRef.current = { ...excalidrawPersistedRef.current, path: nextPath }
          }
        }
        if (document.id === liveMermaidIdRef.current) {
          setMermaidDocument(nextPath, fileStem(nextPath))
          mermaidPersistedRef.current = { ...mermaidPersistedRef.current, path: nextPath }
        }
      }
    },
    [getDocuments, patchDocument, setExcalidrawDocument, setMermaidDocument],
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
      if (!hasRestoredDocumentsRef.current) {
        pendingOpenFile.current = event.payload
        return
      }
      openDiagram(isDiagramPath(event.payload) ?? 'excalidraw', event.payload)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [openDiagram])

  useEffect(() => {
    flushPendingExcalidrawContents()
  }, [flushPendingExcalidrawContents])

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

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (Excalidraw's own open/save are disabled in favour of ours)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'tab') {
        // Cmd+Tab belongs to the OS; only Ctrl+Tab cycles documents.
        if (!event.ctrlKey) {
          return
        }
        const openList = getDocuments()
        if (openList.length < 2) {
          return
        }
        event.preventDefault()
        const index = openList.findIndex((document) => document.id === activeId)
        const step = event.shiftKey ? -1 : 1
        const next = (index + step + openList.length) % openList.length
        activateDocument(openList[next].id)
        return
      }
      if (key >= '1' && key <= '9') {
        const target = getDocuments()[Number(key) - 1]
        if (target) {
          event.preventDefault()
          activateDocument(target.id)
        }
        return
      }
      if (key === ',') {
        event.preventDefault()
        setIsSettingsOpen(true)
        return
      }
      if (key === 'w') {
        event.preventDefault()
        if (activeId) {
          closeDocumentIds([activeId])
        }
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
  }, [
    activateDocument,
    activeId,
    closeDocumentIds,
    getDocuments,
    handleOpenExcalidraw,
    handleOpenMermaid,
    handleSaveExcalidraw,
    handleSaveMermaid,
    workspace,
  ])

  // ---------------------------------------------------------------------------

  const activePath = activeDocument?.path ?? null

  return (
    <div className={`app-shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={isSidebarCollapsed}
        onCollapsedChange={setIsSidebarCollapsed}
        workspace={workspace}
        onWorkspaceChange={handleWorkspaceChange}
        panel={sidebarPanel}
        onPanelChange={setSidebarPanel}
        dirty={{ excalidraw: hasUnsavedExcalidrawChanges, mermaid: hasUnsavedMermaidChanges }}
        onOpenSettings={() => setIsSettingsOpen(true)}
      >
        {sidebarPanel === 'recent' ? (
          <RecentList
            recents={recents}
            projects={projects}
            openPaths={openPaths}
            activePath={activePath}
            onOpen={(item) => openDiagram(item.kind, item.path)}
            onMoveToProject={(item, project) => void moveFileToProject(item.path, project)}
            onMoveToNewProject={(item) => void moveFileToNewProject(item.path)}
            onRemove={(item) => void handleRemoveRecent(item)}
          />
        ) : (
          <ProjectsPanel
            projects={projects}
            refreshToken={projectsRefreshToken}
            openPaths={openPaths}
            activePath={activePath}
            onAddProject={() => void handleAddProject()}
            onRemoveProject={(project) => void handleRemoveProject(project)}
            onRenameProject={handleRenameProject}
            onOpenFile={(file: ProjectFile) => openDiagram(file.kind, file.path)}
            onOpenAllFiles={(project) => void handleOpenAllProjectFiles(project)}
            onMoveFile={(file, project) => void moveFileToProject(file.path, project)}
            onMoveFileToNewProject={(file) => void moveFileToNewProject(file.path)}
            onError={notify}
          />
        )}
      </Sidebar>

      <main className="workspace">
        <DocumentTabs
          documents={documents}
          activeId={activeId}
          onActivate={activateDocument}
          onClose={(id) => closeDocumentIds([id])}
          onCloseOthers={closeOtherDocuments}
          onCloseAll={closeAllDocuments}
        />
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

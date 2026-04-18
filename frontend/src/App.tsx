import { type ComponentProps, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Excalidraw, convertToExcalidrawElements, serializeAsJSON } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import mermaid from 'mermaid'
import './App.css'

type MermaidHistoryState = {
  text: string
  past: string[]
  future: string[]
}

type MermaidHistoryAction =
  | { type: 'set'; text: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; text: string }

function mermaidHistoryReducer(
  state: MermaidHistoryState,
  action: MermaidHistoryAction,
): MermaidHistoryState {
  switch (action.type) {
    case 'set': {
      const past = state.past.length >= 100 ? state.past.slice(1) : state.past
      return { text: action.text, past: [...past, state.text], future: [] }
    }
    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return { text: previous, past: state.past.slice(0, -1), future: [state.text, ...state.future] }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { text: next, past: [...state.past, state.text], future: state.future.slice(1) }
    }
    case 'reset':
      return { text: action.text, past: [], future: [] }
    default:
      return state
  }
}

type ExcalidrawData = {
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, BinaryFileData>
}

type RecentItem = {
  kind: 'excalidraw' | 'mermaid'
  path: string
  name?: string | null
  updated_at: number
}

type OpenFileResponse = {
  path: string
  name?: string | null
  contents: string
}

type SaveFileResponse = {
  path: string
}

type ExcalidrawAutosave = {
  contents: string
  path: string | null
  name: string
  updatedAt: number
}

type ExcalidrawSceneSnapshot = {
  contents: string
  hasContent: boolean
}

type ExcalidrawPersistedState = ExcalidrawSceneSnapshot & {
  path: string | null
  name: string
}

type MermaidPersistedState = {
  path: string | null
  name: string
  text: string
}

type ExcalidrawChangeHandler = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>

type ApplyExcalidrawContentsRequest = {
  contents: string
  path: string | null
  name?: string | null
  message: string
  markDocumentClean?: boolean
  refreshRecentsOnSuccess?: boolean
}

const EXCALIDRAW_AUTOSAVE_KEY = 'excalibur.excalidraw.autosave.current'
const EXCALIDRAW_RECOVERY_KEY = 'excalibur.excalidraw.autosave.recovery'
const INITIAL_MERMAID_TEXT = 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Refine]'

function normalizeExcalidrawName(name?: string | null) {
  return name?.replace(/\.[^/.]+$/, '') ?? ''
}

function getUnsavedChangesMessage(documentName: string, action: string) {
  return `You have unsaved ${documentName} changes. Save them before you ${action}. Select OK to continue without saving, or Cancel to go back.`
}

function getExitUnsavedChangesMessage(
  hasExcalidrawChanges: boolean,
  hasMermaidChanges: boolean,
) {
  if (hasExcalidrawChanges && hasMermaidChanges) {
    return 'You have unsaved changes in Excalidraw and Mermaid. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  if (hasExcalidrawChanges) {
    return 'You have unsaved Excalidraw changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  return 'You have unsaved Mermaid changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
}

function readStoredExcalidrawAutosave(storageKey: string): ExcalidrawAutosave | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as ExcalidrawAutosave
  } catch {
    window.localStorage.removeItem(storageKey)
    return null
  }
}

function writeStoredExcalidrawAutosave(storageKey: string, autosave: ExcalidrawAutosave) {
  window.localStorage.setItem(storageKey, JSON.stringify(autosave))
}

function clearStoredExcalidrawAutosave(storageKey: string) {
  window.localStorage.removeItem(storageKey)
}

function App() {
  const [excalidrawApi, setExcalidrawApiInternal] = useState<ExcalidrawImperativeAPI | null>(null)
  const [tab, setTab] = useState<'excalidraw' | 'mermaid'>('excalidraw')
  const [recents, setRecents] = useState<RecentItem[]>([])

  const setExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI | null) => {
    console.log('[excalibur] setExcalidrawApi called:', api ? 'API instance received' : 'null')
    setExcalidrawApiInternal(api)
  }, [])

  const [excalidrawPath, setExcalidrawPath] = useState<string | null>(null)
  const [excalidrawName, setExcalidrawName] = useState('')
  const [excalidrawMessage, setExcalidrawMessage] = useState('')
  const [hasUnsavedExcalidrawChanges, setHasUnsavedExcalidrawChanges] = useState(false)
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
  const [mermaidMessage, setMermaidMessage] = useState('')
  const [mermaidSvg, setMermaidSvg] = useState('')
  const [mermaidError, setMermaidError] = useState('')
  const [isConvertingMermaid, setIsConvertingMermaid] = useState(false)

  const refreshRecents = useCallback(async () => {
    const data = await invoke<RecentItem[]>('list_recents')
    setRecents(data)
  }, [])

  useEffect(() => {
    console.log('[excalibur] App mounted')
    return () => console.log('[excalibur] App unmounted')
  }, [])

  useEffect(() => {
    let isActive = true
    invoke<RecentItem[]>('list_recents').then((data) => {
      if (isActive) {
        setRecents(data)
      }
    })
    return () => {
      isActive = false
    }
  }, [])

  // Pending file path for the startup race condition (event arrives before excalidrawApi is ready)
  const pendingOpenFile = useRef<string | null>(null)
  const pendingExcalidrawContentsRef = useRef<ApplyExcalidrawContentsRequest | null>(null)
  const excalidrawPathRef = useRef<string | null>(null)
  const excalidrawNameRef = useRef('')
  const excalidrawSceneSnapshotRef = useRef<ExcalidrawSceneSnapshot | null>(null)
  const excalidrawPersistedRef = useRef<ExcalidrawPersistedState | null>(null)
  const autosaveSnapshotRef = useRef<ExcalidrawAutosave | null>(
    readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY),
  )
  const mermaidPersistedRef = useRef<MermaidPersistedState>({
    path: null,
    name: '',
    text: INITIAL_MERMAID_TEXT,
  })
  const hasUnsavedExcalidrawChangesRef = useRef(false)
  const hasUnsavedMermaidChangesRef = useRef(false)

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

  const setExcalidrawPersistedState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot, path: string | null, name: string) => {
      excalidrawPersistedRef.current = {
        ...snapshot,
        path,
        name: name.trim(),
      }
      setHasUnsavedExcalidrawChanges(false)
    },
    [],
  )

  const clearExcalidrawPersistedState = useCallback(() => {
    excalidrawPersistedRef.current = null
    setHasUnsavedExcalidrawChanges(false)
  }, [])

  const updateExcalidrawDirtyState = useCallback(
    (snapshot: ExcalidrawSceneSnapshot | null, name: string) => {
      const persisted = excalidrawPersistedRef.current
      const trimmedName = name.trim()

      if (!persisted) {
        setHasUnsavedExcalidrawChanges((snapshot?.hasContent ?? false) || trimmedName.length > 0)
        return
      }

      setHasUnsavedExcalidrawChanges(
        (snapshot?.contents ?? '') !== persisted.contents || trimmedName !== persisted.name,
      )
    },
    [],
  )

  const setMermaidPersistedState = useCallback((text: string, name: string, path: string | null) => {
    mermaidPersistedRef.current = {
      text,
      name: name.trim(),
      path,
    }
    setHasUnsavedMermaidChanges(false)
  }, [])

  const updateMermaidDirtyState = useCallback((text: string, name: string, path: string | null) => {
    const persisted = mermaidPersistedRef.current
    setHasUnsavedMermaidChanges(
      text !== persisted.text || name.trim() !== persisted.name || path !== persisted.path,
    )
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
        // Strip BOM and leading/trailing whitespace
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
    render()
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
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [hasUnsavedExcalidrawChanges, hasUnsavedMermaidChanges])

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null

    getCurrentWindow()
      .onCloseRequested((event) => {
        const hasExcalidrawChanges = hasUnsavedExcalidrawChangesRef.current
        const hasMermaidChanges = hasUnsavedMermaidChangesRef.current

        if (!hasExcalidrawChanges && !hasMermaidChanges) {
          return
        }

        if (!window.confirm(getExitUnsavedChangesMessage(hasExcalidrawChanges, hasMermaidChanges))) {
          event.preventDefault()
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

  const applyExcalidrawContents = useCallback(
    ({
      contents,
      path,
      name,
      message,
      markDocumentClean,
      refreshRecentsOnSuccess,
    }: ApplyExcalidrawContentsRequest) => {
      console.log('[excalibur] applyExcalidrawFile: START', {
        path,
        name,
        contentLength: contents.length,
      })

      if (!excalidrawApi) {
        console.warn('[excalibur] applyExcalidrawFile: excalidrawApi is null, aborting')
        return
      }
      console.log('[excalibur] applyExcalidrawFile: excalidrawApi is available')

      try {
        console.log('[excalibur] applyExcalidrawFile: parsing JSON...')
        const parsed = JSON.parse(contents) as Partial<ExcalidrawData> & {
          data?: Partial<ExcalidrawData>
        }
        console.log('[excalibur] applyExcalidrawFile: JSON parsed successfully', {
          hasData: !!parsed.data,
          hasElements: !!(parsed.elements || parsed.data?.elements),
          topLevelKeys: Object.keys(parsed),
        })

        const raw = parsed.data && parsed.data.elements ? parsed.data : parsed
        console.log('[excalibur] applyExcalidrawFile: extracted raw data', {
          elementCount: raw.elements?.length ?? 0,
          hasAppState: !!raw.appState,
          fileCount: raw.files ? Object.keys(raw.files).length : 0,
        })

        // Sanitize elements to ensure required array properties exist
        const sanitizedElements = (raw.elements ?? []).map((el, index) => {
          const element = el as Record<string, unknown>
          const sanitized = { ...element }
          if (!Array.isArray(sanitized.groupIds)) {
            console.warn(`[excalibur] applyExcalidrawFile: element ${index} missing groupIds, defaulting to []`)
            sanitized.groupIds = []
          }
          if (!Array.isArray(sanitized.boundElements)) {
            sanitized.boundElements = sanitized.boundElements ?? null
          }
          return sanitized
        })

        const normalizedName = normalizeExcalidrawName(name)
        const snapshot = {
          contents,
          hasContent: sanitizedElements.some((element) => element.isDeleted !== true),
        }

        excalidrawSceneSnapshotRef.current = snapshot
        setExcalidrawDocument(path, normalizedName)

        console.log('[excalibur] applyExcalidrawFile: calling updateScene...')
        excalidrawApi.updateScene({
          elements: sanitizedElements as never[],
          appState: (raw.appState ?? {}) as never,
        })
        console.log('[excalibur] applyExcalidrawFile: updateScene completed')

        const files = raw.files ? Object.values(raw.files) : []
        if (files.length) {
          console.log('[excalibur] applyExcalidrawFile: calling addFiles with', files.length, 'files')
          excalidrawApi.addFiles(files)
          console.log('[excalibur] applyExcalidrawFile: addFiles completed')
        }

        console.log('[excalibur] applyExcalidrawFile: updating React state...')
        if (snapshot.hasContent) {
          setCurrentExcalidrawAutosave({
            contents,
            path,
            name: normalizedName,
            updatedAt: Date.now(),
          })
        } else {
          setCurrentExcalidrawAutosave(null)
        }
        if (markDocumentClean) {
          setExcalidrawPersistedState(snapshot, path, normalizedName)
        } else {
          updateExcalidrawDirtyState(snapshot, normalizedName)
        }
        setExcalidrawMessage(message)
        setTab('excalidraw')
        if (refreshRecentsOnSuccess) {
          console.log('[excalibur] applyExcalidrawFile: refreshing recents...')
          refreshRecents()
        }
        console.log('[excalibur] applyExcalidrawFile: COMPLETE SUCCESS')
      } catch (error) {
        console.error('[excalibur] applyExcalidrawFile: FAILED', error)
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
      applyExcalidrawContents({
        contents: file.contents,
        path: file.path,
        name: file.name,
        message: `Loaded ${file.path}.`,
        markDocumentClean: true,
        refreshRecentsOnSuccess: true,
      })
    },
    [applyExcalidrawContents],
  )

  const handleExcalidrawChange = useCallback(
    (...[elements, appState, files]: Parameters<ExcalidrawChangeHandler>) => {
      const hasContent = elements.some((element) => !element.isDeleted)
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
      updateExcalidrawDirtyState(snapshot, excalidrawNameRef.current)
    },
    [setCurrentExcalidrawAutosave, updateExcalidrawDirtyState],
  )

  const handleOpenExcalidraw = useCallback(async () => {
    console.log('[excalibur] handleOpenExcalidraw: invoking open_excalidraw_file...')
    if (!confirmExcalidrawAction('load another document')) {
      return
    }
    try {
      const response = await invoke<OpenFileResponse | null>('open_excalidraw_file')
      console.log('[excalibur] handleOpenExcalidraw: invoke returned', {
        hasResponse: !!response,
        path: response?.path,
        contentLength: response?.contents?.length ?? 0,
      })
      if (!response) {
        console.log('[excalibur] handleOpenExcalidraw: no response (user cancelled?), returning')
        return
      }
      applyExcalidrawFile(response)
    } catch (error) {
      console.error('[excalibur] handleOpenExcalidraw: invoke FAILED', error)
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
    const response = await invoke<SaveFileResponse>('save_excalidraw_file', {
      request: {
        path: excalidrawPath,
        name: excalidrawName.trim() || undefined,
        contents: serialized,
      },
    })
    const nextName = excalidrawNameRef.current.trim()
    const snapshot = {
      contents: serialized,
      hasContent,
    }

    excalidrawSceneSnapshotRef.current = snapshot
    setExcalidrawDocument(response.path, nextName)
    if (hasContent) {
      setCurrentExcalidrawAutosave({
        contents: serialized,
        path: response.path,
        name: nextName,
        updatedAt: Date.now(),
      })
    } else {
      setCurrentExcalidrawAutosave(null)
    }
    setExcalidrawPersistedState(snapshot, response.path, nextName)
    setExcalidrawMessage(`Saved to ${response.path}.`)
    refreshRecents()
  }, [
    excalidrawApi,
    excalidrawName,
    excalidrawPath,
    refreshRecents,
    setCurrentExcalidrawAutosave,
    setExcalidrawDocument,
    setExcalidrawPersistedState,
  ])

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
    setCurrentExcalidrawAutosave(null)
    clearExcalidrawPersistedState()
    setExcalidrawDocument(null, '')
    excalidrawApi.resetScene()
    setExcalidrawMessage(
      autosave
        ? 'Started a new diagram. Recover backup if that was accidental.'
        : 'Started a new diagram.',
    )
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
        ? `Recovered autosave backup for ${recoverableAutosave.path}.`
        : 'Recovered autosave backup.',
      markDocumentClean: false,
    })
  }, [applyExcalidrawContents, recoverableAutosave])

  const loadExcalidrawPath = useCallback(
    async (path: string) => {
      if (!confirmExcalidrawAction('load another document')) {
        return
      }
      console.log('[excalibur] loadExcalidrawPath: invoking load_excalidraw_path for', path)
      try {
        const response = await invoke<OpenFileResponse>('load_excalidraw_path', { path })
        console.log('[excalibur] loadExcalidrawPath: invoke returned', {
          path: response.path,
          contentLength: response.contents?.length ?? 0,
        })
        applyExcalidrawFile(response)
      } catch (error) {
        console.error('[excalibur] loadExcalidrawPath: invoke FAILED', error)
      }
    },
    [applyExcalidrawFile, confirmExcalidrawAction],
  )

  // Listen for open-file events from the backend (file association / deep-link)
  useEffect(() => {
    const unlisten = listen<string>('open-file', (event) => {
      console.log('[excalibur] open-file event received:', event.payload)
      if (excalidrawApi) {
        loadExcalidrawPath(event.payload)
      } else {
        pendingOpenFile.current = event.payload
      }
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [excalidrawApi, loadExcalidrawPath])

  // When excalidrawApi becomes available, load any pending file (from event or startup)
  useEffect(() => {
    if (!excalidrawApi) return

    if (pendingExcalidrawContentsRef.current) {
      const pendingContents = pendingExcalidrawContentsRef.current
      pendingExcalidrawContentsRef.current = null
      applyExcalidrawContents(pendingContents)
      return
    }

    // Check for a file path queued from an event that arrived before the API was ready
    if (pendingOpenFile.current) {
      const path = pendingOpenFile.current
      pendingOpenFile.current = null
      loadExcalidrawPath(path)
      return
    }

    // Check for a file path stored by the backend at startup (e.g. double-click in Finder)
    invoke<string | null>('take_pending_file').then((path) => {
      if (path) {
        console.log('[excalibur] take_pending_file returned:', path)
        loadExcalidrawPath(path)
      }
    })
  }, [applyExcalidrawContents, excalidrawApi, loadExcalidrawPath])

  const handleOpenMermaid = useCallback(async () => {
    if (!confirmMermaidAction('load another document')) {
      return
    }
    const response = await invoke<OpenFileResponse | null>('open_mermaid_file')
    if (!response) {
      return
    }
    const nextName = response.name?.replace(/\.[^/.]+$/, '') ?? ''
    setMermaidPath(response.path)
    setMermaidName(nextName)
    dispatchMermaid({ type: 'reset', text: response.contents })
    setMermaidPersistedState(response.contents, nextName, response.path)
    setMermaidMessage(`Loaded ${response.path}.`)
    setTab('mermaid')
    refreshRecents()
  }, [confirmMermaidAction, refreshRecents, setMermaidPersistedState])

  const handleSaveMermaid = useCallback(async () => {
    const nextName = mermaidName.trim()
    const response = await invoke<SaveFileResponse>('save_mermaid_file', {
      request: {
        path: mermaidPath,
        name: nextName || undefined,
        contents: mermaidText,
      },
    })
    setMermaidPath(response.path)
    setMermaidName(nextName)
    setMermaidPersistedState(mermaidText, nextName, response.path)
    setMermaidMessage(`Saved to ${response.path}.`)
    refreshRecents()
  }, [mermaidName, mermaidPath, mermaidText, refreshRecents, setMermaidPersistedState])

  const loadMermaidPath = useCallback(async (path: string) => {
    if (!confirmMermaidAction('load another document')) {
      return
    }
    const response = await invoke<OpenFileResponse>('load_mermaid_path', { path })
    const nextName = response.name?.replace(/\.[^/.]+$/, '') ?? ''
    setMermaidPath(response.path)
    setMermaidName(nextName)
    dispatchMermaid({ type: 'reset', text: response.contents })
    setMermaidPersistedState(response.contents, nextName, response.path)
    setMermaidMessage(`Loaded ${response.path}.`)
    setTab('mermaid')
    refreshRecents()
  }, [confirmMermaidAction, refreshRecents, setMermaidPersistedState])

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
      const { elements: skeletons, files = {} } = await parseMermaidToExcalidraw(cleanedText)
      const elements = convertToExcalidrawElements(skeletons, { regenerateIds: true })
      const nextName = mermaidName.trim()

      pendingExcalidrawContentsRef.current = {
        contents: serializeAsJSON(elements, {}, files, 'local'),
        path: null,
        name: nextName,
        message: nextName
          ? `Converted Mermaid diagram to Excalidraw as ${nextName}.`
          : 'Converted Mermaid diagram to Excalidraw.',
        markDocumentClean: false,
      }
      setTab('excalidraw')
    } catch (error) {
      console.error('[excalibur] handleConvertMermaidToExcalidraw: FAILED', error)
      pendingExcalidrawContentsRef.current = null
      setMermaidMessage('Unable to convert Mermaid to Excalidraw.')
    } finally {
      setIsConvertingMermaid(false)
    }
  }, [
    confirmExcalidrawAction,
    mermaidError,
    mermaidName,
    mermaidText,
    setRecoverableExcalidrawAutosave,
  ])

  const handleMermaidKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          const nextText = mermaidHistory.future[0]
          if (nextText !== undefined) {
            updateMermaidDirtyState(nextText, mermaidName, mermaidPath)
          }
          dispatchMermaid({ type: 'redo' })
        } else {
          const nextText = mermaidHistory.past[mermaidHistory.past.length - 1]
          if (nextText !== undefined) {
            updateMermaidDirtyState(nextText, mermaidName, mermaidPath)
          }
          dispatchMermaid({ type: 'undo' })
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const nextText = mermaidHistory.future[0]
        if (nextText !== undefined) {
          updateMermaidDirtyState(nextText, mermaidName, mermaidPath)
        }
        dispatchMermaid({ type: 'redo' })
      }
    },
    [mermaidHistory.future, mermaidHistory.past, mermaidName, mermaidPath, updateMermaidDirtyState],
  )

  const recentList = useMemo(() => {
    if (!recents.length) {
      return <div className="empty">No recent charts yet.</div>
    }
    return recents.map((item) => (
      <button
        key={`${item.kind}-${item.path}`}
        className="recent-item"
        onClick={() => {
          if (item.kind === 'excalidraw') {
            loadExcalidrawPath(item.path)
          } else {
            loadMermaidPath(item.path)
          }
        }}
      >
        <span className="recent-type">{item.kind}</span>
        <span className="recent-name">{item.name || item.path}</span>
        <span className="recent-path">{item.path}</span>
      </button>
    ))
  }, [recents, loadExcalidrawPath, loadMermaidPath])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Excalibur</div>
          <div className="brand-sub">Excalidraw + Mermaid workspace</div>
        </div>
        <div className="tab-buttons">
          <button
            className={`tab-button ${tab === 'excalidraw' ? 'active' : ''}`}
            onClick={() => setTab('excalidraw')}
          >
            Excalidraw
          </button>
          <button
            className={`tab-button ${tab === 'mermaid' ? 'active' : ''}`}
            onClick={() => setTab('mermaid')}
          >
            Mermaid
          </button>
        </div>
        <div className="recents">
          <div className="section-title">Recent (last 10)</div>
          <div className="recent-list">{recentList}</div>
        </div>
      </aside>

      <main className="workspace">
        {tab === 'excalidraw' ? (
          <section className="panel">
            <header className="panel-header">
              <div>
                <h1>Excalidraw editor</h1>
                <p>Open, edit, and save .excalidraw files.</p>
              </div>
              <div className="status">
                {excalidrawMessage}
                {recoverableAutosave ? <span className="status-note">Autosave backup available.</span> : null}
              </div>
            </header>
            <div className="control-row">
              <label>
                Name
                <input
                  value={excalidrawName}
                  onChange={(event) => {
                    const nextName = event.target.value
                    excalidrawNameRef.current = nextName
                    setExcalidrawName(nextName)
                    updateExcalidrawDirtyState(excalidrawSceneSnapshotRef.current, nextName)
                    if (autosaveSnapshotRef.current) {
                      setCurrentExcalidrawAutosave({
                        ...autosaveSnapshotRef.current,
                        name: nextName.trim(),
                        updatedAt: Date.now(),
                      })
                    }
                  }}
                  placeholder="Architecture brainstorm"
                />
              </label>
              <label>
                File
                <input
                  value={excalidrawPath ?? ''}
                  readOnly
                  placeholder="No file loaded"
                />
              </label>
              <div className="actions">
                <button className="primary" onClick={handleSaveExcalidraw}>
                  Save
                </button>
                <button onClick={handleOpenExcalidraw}>Open</button>
                <button onClick={handleNewExcalidraw}>New</button>
                {recoverableAutosave ? (
                  <button className="recover" onClick={handleRecoverExcalidraw}>
                    Recover backup
                  </button>
                ) : null}
              </div>
            </div>
            <div className="canvas-frame">
              <Excalidraw excalidrawAPI={setExcalidrawApi} onChange={handleExcalidrawChange} />
            </div>
          </section>
        ) : (
          <section className="panel">
            <header className="panel-header">
              <div>
                <h1>Mermaid editor</h1>
                <p>Write Mermaid syntax and render instantly.</p>
              </div>
              <div className="status">{mermaidMessage}</div>
            </header>
            <div className="control-row">
              <label>
                Name
                <input
                  value={mermaidName}
                  onChange={(event) => {
                    const nextName = event.target.value
                    setMermaidName(nextName)
                    updateMermaidDirtyState(mermaidText, nextName, mermaidPath)
                  }}
                  placeholder="Auth flow"
                />
              </label>
              <label>
                File
                <input value={mermaidPath ?? ''} readOnly placeholder="No file loaded" />
              </label>
              <div className="actions">
                <button className="primary" onClick={handleSaveMermaid}>
                  Save
                </button>
                <button onClick={handleOpenMermaid}>Open</button>
                <button onClick={handleConvertMermaidToExcalidraw} disabled={isConvertingMermaid}>
                  {isConvertingMermaid ? 'Converting...' : 'Convert to Excalidraw'}
                </button>
              </div>
            </div>
            <div className="mermaid-grid">
              <div className="mermaid-editor">
                <textarea
                  value={mermaidText}
                  onChange={(event) => {
                    const nextText = event.target.value
                    dispatchMermaid({ type: 'set', text: nextText })
                    updateMermaidDirtyState(nextText, mermaidName, mermaidPath)
                  }}
                  onKeyDown={handleMermaidKeyDown}
                />
              </div>
              <div className="mermaid-preview">
                {mermaidError ? (
                  <div className="error">{mermaidError}</div>
                ) : (
                  <div
                    className="diagram"
                    dangerouslySetInnerHTML={{ __html: mermaidSvg }}
                  />
                )}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App

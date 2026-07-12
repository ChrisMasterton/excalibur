import { type ComponentProps, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import type {
  AppState,
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

type LoadImageFileResponse = {
  path: string
  name?: string | null
  mime_type: string
  data_url: string
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

type ImageImportPayload = {
  name: string
  mimeType: string
  dataUrl: string
  sourcePath?: string | null
}

type CanvasClientPosition = {
  clientX: number
  clientY: number
}

type SaveButtonKind = 'excalidraw' | 'mermaid'

const EXCALIDRAW_AUTOSAVE_KEY = 'excalibur.excalidraw.autosave.current'
const EXCALIDRAW_RECOVERY_KEY = 'excalibur.excalidraw.autosave.recovery'
const INITIAL_MERMAID_TEXT = 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Refine]'
const SAVE_FEEDBACK_HOLD_MS = 100
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const IMAGE_IMPORT_MIME_BY_EXTENSION: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

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

function normalizeImageMimeType(mimeType: string) {
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
}

function getImageExtension(name: string) {
  const extension = name.split('.').pop()
  return extension ? extension.toLowerCase() : ''
}

function getSupportedImageMimeTypeFromName(name: string) {
  return IMAGE_IMPORT_MIME_BY_EXTENSION[getImageExtension(name)] ?? null
}

function getSupportedImageMimeTypeForFile(file: File) {
  const normalizedType = normalizeImageMimeType(file.type)
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalizedType)) {
    return normalizedType
  }
  return getSupportedImageMimeTypeFromName(file.name)
}

function isSupportedImagePath(path: string) {
  return getSupportedImageMimeTypeFromName(path) !== null
}

function getFirstSupportedImageFile(files: FileList | File[]) {
  return Array.from(files).find((file) => getSupportedImageMimeTypeForFile(file)) ?? null
}

function byteArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return window.btoa(binary)
}

async function fileToImageImportPayload(file: File): Promise<ImageImportPayload> {
  const mimeType = getSupportedImageMimeTypeForFile(file)
  if (!mimeType) {
    throw new Error('Unsupported image type.')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    name: file.name || 'image',
    mimeType,
    dataUrl: `data:${mimeType};base64,${byteArrayToBase64(bytes)}`,
  }
}

function loadImageDimensions(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      })
    }
    image.onerror = () => reject(new Error('Unable to read image dimensions.'))
    image.src = dataUrl
  })
}

function getImageDisplaySize(width: number, height: number, appState: AppState) {
  if (width <= 0 || height <= 0) {
    return { width: 240, height: 180 }
  }

  const zoom = appState.zoom.value || 1
  const maxHeight = Math.max(160, Math.min(appState.height - 120, appState.height * 0.5) / zoom)
  const maxWidth = Math.max(160, (appState.width * 0.7) / zoom)
  const scale = Math.min(1, maxWidth / width, maxHeight / height)

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function createImageFileId() {
  const id = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return id as BinaryFileData['id']
}

function App() {
  const [excalidrawApi, setExcalidrawApiInternal] = useState<ExcalidrawImperativeAPI | null>(null)
  const [tab, setTab] = useState<'excalidraw' | 'mermaid'>('excalidraw')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [saveButtonFeedback, setSaveButtonFeedback] = useState<Record<SaveButtonKind, boolean>>({
    excalidraw: false,
    mermaid: false,
  })
  const saveFeedbackTimersRef = useRef<Record<SaveButtonKind, number | null>>({
    excalidraw: null,
    mermaid: null,
  })

  const setExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI | null) => {
    console.log('[excalibur] setExcalidrawApi called:', api ? 'API instance received' : 'null')
    setExcalidrawApiInternal(api)
  }, [])

  const showSaveButtonFeedback = useCallback((kind: SaveButtonKind) => {
    const activeTimer = saveFeedbackTimersRef.current[kind]
    if (activeTimer !== null) {
      window.clearTimeout(activeTimer)
    }

    setSaveButtonFeedback((current) => ({
      ...current,
      [kind]: true,
    }))

    saveFeedbackTimersRef.current[kind] = window.setTimeout(() => {
      setSaveButtonFeedback((current) => ({
        ...current,
        [kind]: false,
      }))
      saveFeedbackTimersRef.current[kind] = null
    }, SAVE_FEEDBACK_HOLD_MS)
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
      console.log('[excalibur] App unmounted')
    }
  }, [])

  useEffect(() => {
    if (!excalidrawApi) {
      return
    }
    excalidrawApi.refresh()
  }, [excalidrawApi, isSidebarCollapsed])

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
  const canvasFrameRef = useRef<HTMLDivElement | null>(null)
  const excalidrawPathRef = useRef<string | null>(null)
  const excalidrawNameRef = useRef('')
  const excalidrawSceneSnapshotRef = useRef<ExcalidrawSceneSnapshot | null>(null)
  const excalidrawPersistedRef = useRef<ExcalidrawPersistedState | null>(null)
  const ignoreEmptyExcalidrawChangeUntilRef = useRef(0)
  const suppressEmptyChangeTimerRef = useRef<number | null>(null)
  const autosaveSnapshotRef = useRef<ExcalidrawAutosave | null>(
    readStoredExcalidrawAutosave(EXCALIDRAW_AUTOSAVE_KEY),
  )
  const mermaidPersistedRef = useRef<MermaidPersistedState>({
    path: null,
    name: '',
    text: INITIAL_MERMAID_TEXT,
  })
  const isQuittingRef = useRef(false)
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
          await invoke('exit_app')
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

  const applyExcalidrawContents = useCallback(
    (request: ApplyExcalidrawContentsRequest) => {
      const {
      contents,
      path,
      name,
      message,
      markDocumentClean,
      refreshRecentsOnSuccess,
      } = request
      console.log('[excalibur] applyExcalidrawFile: START', {
        path,
        name,
        contentLength: contents.length,
      })

      if (!excalidrawApi || tab !== 'excalidraw') {
        console.warn('[excalibur] applyExcalidrawFile: excalidrawApi unavailable, queueing request')
        pendingExcalidrawContentsRef.current = request
        if (tab !== 'excalidraw') {
          setExcalidrawApiInternal(null)
          setTab('excalidraw')
        }
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
        if (snapshot.hasContent) {
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
      tab,
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

  const flushPendingExcalidrawContents = useCallback(() => {
    if (!excalidrawApi || tab !== 'excalidraw' || !pendingExcalidrawContentsRef.current) {
      return false
    }

    const pendingContents = pendingExcalidrawContentsRef.current
    pendingExcalidrawContentsRef.current = null
    applyExcalidrawContents(pendingContents)
    return true
  }, [applyExcalidrawContents, excalidrawApi, tab])

  const handleExcalidrawChange = useCallback(
    (...[elements, appState, files]: Parameters<ExcalidrawChangeHandler>) => {
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
    showSaveButtonFeedback('excalidraw')
    refreshRecents()
  }, [
    excalidrawApi,
    excalidrawName,
    excalidrawPath,
    showSaveButtonFeedback,
    refreshRecents,
    setCurrentExcalidrawAutosave,
    setExcalidrawDocument,
    setExcalidrawPersistedState,
  ])

  const handleExportExcalidrawPng = useCallback(() => {
    if (!excalidrawApi) {
      return
    }

    setExcalidrawMessage('')
    excalidrawApi.updateScene({
      appState: {
        openDialog: { name: 'imageExport' },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
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
        appState: {
          selectedElementIds: { [imageElement.id]: true },
        },
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
      setTab('excalidraw')
      setExcalidrawMessage(`Imported ${payload.sourcePath ?? payload.name}.`)
      return true
    },
    [excalidrawApi],
  )

  const importNativeImagePath = useCallback(
    async (path: string, position: CanvasClientPosition | null) => {
      try {
        const response = await invoke<LoadImageFileResponse>('load_image_file', { path })
        return await importImagePayloadToCanvas(
          {
            name: response.name ?? response.path.split('/').pop() ?? 'image',
            mimeType: response.mime_type,
            dataUrl: response.data_url,
            sourcePath: response.path,
          },
          position,
        )
      } catch (error) {
        console.error('[excalibur] importNativeImagePath: FAILED', error)
        setExcalidrawMessage('Drop a PNG, JPEG, or WebP image to import it.')
        return false
      }
    },
    [importImagePayloadToCanvas],
  )

  const handleCanvasImageDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!getFirstSupportedImageFile(event.dataTransfer.files)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleCanvasImageDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
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
        console.error('[excalibur] handleCanvasImageDrop: FAILED', error)
        setExcalidrawMessage('Drop a PNG, JPEG, or WebP image to import it.')
      }
    },
    [importImagePayloadToCanvas],
  )

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null
    const currentWindow = getCurrentWindow()

    currentWindow
      .onDragDropEvent(async (event) => {
        if (!isActive || event.payload.type !== 'drop') {
          return
        }

        const imagePath = event.payload.paths.find(isSupportedImagePath)
        if (!imagePath) {
          return
        }

        const scaleFactor = await currentWindow.scaleFactor().catch(() => window.devicePixelRatio || 1)
        const logicalPosition = event.payload.position.toLogical(scaleFactor)
        const position = {
          clientX: logicalPosition.x,
          clientY: logicalPosition.y,
        }

        if (!isClientPointInCanvasFrame(position)) {
          return
        }

        await importNativeImagePath(imagePath, position)
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
  }, [importNativeImagePath, isClientPointInCanvasFrame])

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

    if (flushPendingExcalidrawContents()) {
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
  }, [excalidrawApi, flushPendingExcalidrawContents, loadExcalidrawPath])

  useEffect(() => {
    flushPendingExcalidrawContents()
  }, [flushPendingExcalidrawContents])

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
    showSaveButtonFeedback('mermaid')
    refreshRecents()
  }, [mermaidName, mermaidPath, mermaidText, refreshRecents, setMermaidPersistedState, showSaveButtonFeedback])

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
      const serialized = serializeAsJSON(elements, {}, files, 'local')
      const savedFile = await invoke<SaveFileResponse>('save_excalidraw_file', {
        request: {
          path: null,
          name: nextName || undefined,
          contents: serialized,
        },
      })
      const savedContents = await invoke<OpenFileResponse>('load_excalidraw_path', {
        path: savedFile.path,
      })

      applyExcalidrawFile(savedContents)
      setMermaidMessage(`Converted Mermaid and saved to ${savedFile.path}.`)
    } catch (error) {
      console.error('[excalibur] handleConvertMermaidToExcalidraw: FAILED', error)
      pendingExcalidrawContentsRef.current = null
      setMermaidMessage(error instanceof Error ? error.message : 'Unable to convert Mermaid to Excalidraw.')
    } finally {
      setIsConvertingMermaid(false)
    }
  }, [
    confirmExcalidrawAction,
    mermaidError,
    mermaidName,
    mermaidText,
    applyExcalidrawFile,
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
    <div className={`app-shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <button
        className="sidebar-return"
        type="button"
        aria-expanded={!isSidebarCollapsed}
        aria-label="Show sidebar"
        onClick={() => setIsSidebarCollapsed(false)}
      >
        Show sidebar
      </button>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <div className="brand-title">Excalibur</div>
            <div className="brand-sub">Excalidraw + Mermaid workspace</div>
          </div>
          <button
            className="sidebar-hide"
            type="button"
            aria-expanded={!isSidebarCollapsed}
            aria-label="Hide sidebar"
            onClick={() => setIsSidebarCollapsed(true)}
          >
            Hide
          </button>
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
              <div className="panel-title">
                <h1>Excalidraw editor</h1>
                <p>Open, edit, and save .excalidraw files.</p>
              </div>
              <div className="status" role="status" aria-live="polite">
                {excalidrawMessage ? (
                  <span key={excalidrawMessage} className="status-message">{excalidrawMessage}</span>
                ) : null}
                {recoverableAutosave ? <span className="status-note">Autosave backup available.</span> : null}
              </div>
            </header>
            <div className="control-row">
              <label className="field-control field-control-name">
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
              <label className="field-control field-control-file">
                File
                <input
                  value={excalidrawPath ?? ''}
                  readOnly
                  placeholder="No file loaded"
                />
              </label>
              <div className="actions">
                <button
                  className={`primary save-button${saveButtonFeedback.excalidraw ? ' save-feedback' : ''}`}
                  onClick={handleSaveExcalidraw}
                >
                  Save
                </button>
                <button onClick={handleOpenExcalidraw}>Open</button>
                <button onClick={handleNewExcalidraw}>New</button>
                <button onClick={handleExportExcalidrawPng} disabled={!excalidrawApi}>
                  Export PNG
                </button>
                <button
                  className={`recover${recoverableAutosave ? ' is-available' : ''}`}
                  onClick={handleRecoverExcalidraw}
                  disabled={!recoverableAutosave}
                  aria-hidden={!recoverableAutosave}
                  tabIndex={recoverableAutosave ? 0 : -1}
                >
                  Recover backup
                </button>
              </div>
            </div>
            <div
              ref={canvasFrameRef}
              className="canvas-frame"
              onDragOverCapture={handleCanvasImageDragOver}
              onDropCapture={handleCanvasImageDrop}
            >
              <Excalidraw excalidrawAPI={setExcalidrawApi} onChange={handleExcalidrawChange} />
            </div>
          </section>
        ) : (
          <section className="panel">
            <header className="panel-header">
              <div className="panel-title">
                <h1>Mermaid editor</h1>
                <p>Write Mermaid syntax and render instantly.</p>
              </div>
              <div className="status" role="status" aria-live="polite">
                {mermaidMessage ? (
                  <span key={mermaidMessage} className="status-message">{mermaidMessage}</span>
                ) : null}
              </div>
            </header>
            <div className="control-row">
              <label className="field-control field-control-name">
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
              <label className="field-control field-control-file">
                File
                <input value={mermaidPath ?? ''} readOnly placeholder="No file loaded" />
              </label>
              <div className="actions">
                <button
                  className={`primary save-button${saveButtonFeedback.mermaid ? ' save-feedback' : ''}`}
                  onClick={handleSaveMermaid}
                >
                  Save
                </button>
                <button onClick={handleOpenMermaid}>Open</button>
                <button onClick={handleConvertMermaidToExcalidraw} disabled={isConvertingMermaid}>
                  {isConvertingMermaid ? 'Saving...' : 'Convert & Save Excalidraw'}
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

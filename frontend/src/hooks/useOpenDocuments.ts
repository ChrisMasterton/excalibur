import { useCallback, useMemo, useRef, useState } from 'react'
import { parseExcalidrawContents } from '../lib/documents'
import type { ZoomPanTransform } from '../components/ZoomPanViewport'
import type { MermaidHistoryState } from '../lib/mermaidHistory'
import type {
  DiagramKind,
  DocumentMode,
  ExcalidrawSceneSnapshot,
  ExcalidrawViewport,
  OpenDocument,
} from '../types'

/** Editor state an Excalidraw tab carries while it is not the one on the canvas. */
export type ExcalidrawDocumentCache = {
  /** Latest serialized scene (`serializeAsJSON`); null for an untouched empty document. */
  scene: ExcalidrawSceneSnapshot | null
  /** The scene as it exists on disk; null when the document was never saved. */
  persistedScene: ExcalidrawSceneSnapshot | null
  /** Folder the next save should suggest (Mermaid conversions keep the source folder). */
  saveDirectory: string | null
  /** Scroll and zoom the canvas had; null until the tab has been looked at. */
  viewport: ExcalidrawViewport | null
}

/** Editor state a Mermaid tab carries while it is not the one in the editor. */
export type MermaidDocumentCache = {
  history: MermaidHistoryState
  persistedText: string
  /** Preview pan/zoom; null until the tab has been looked at (so it still auto-fits). */
  viewport: ZoomPanTransform | null
}

export type NewDocumentInput = {
  kind: DiagramKind
  path?: string | null
  name?: string
  displayName?: string | null
  title?: string | null
  diagramType?: string | null
  dirty?: boolean
  /** Defaults to `edit`; files read from disk ask for `view`. */
  mode?: DocumentMode
  excalidraw?: ExcalidrawDocumentCache
  mermaid?: MermaidDocumentCache
}

export type DocumentPatch = Partial<
  Pick<OpenDocument, 'path' | 'name' | 'displayName' | 'title' | 'diagramType' | 'dirty' | 'mode'>
>

export type StoredOpenDocument = { kind: DiagramKind; path: string }
export type StoredOpenDocuments = { documents: StoredOpenDocument[]; activeIndex: number }

export const RECOVERY_DOCUMENTS_KEY = 'excalibur.recoveryDocuments'

export function readRecoveryDocuments(): NewDocumentInput[] {
  const raw = window.localStorage.getItem(RECOVERY_DOCUMENTS_KEY)
  if (!raw) return []
  const entries = JSON.parse(raw) as NewDocumentInput[]
  if (!Array.isArray(entries) || entries.some(entry =>
    !entry || (entry.kind !== 'mermaid' && entry.kind !== 'excalidraw') ||
    (entry.kind === 'mermaid' ? typeof entry.mermaid?.history?.text !== 'string' : typeof entry.excalidraw?.scene?.contents !== 'string')
  )) throw new Error('Unable to read document recovery. Stored data has been retained.')
  for (const entry of entries) {
    if (entry.kind === 'excalidraw') parseExcalidrawContents(entry.excalidraw!.scene!.contents)
  }
  return entries
}

export const OPEN_DOCUMENTS_KEY = 'excalibur.openDocuments'

let nextDocumentId = 0

/** Tab label: the file's own title, else its stem, else a placeholder. */
export function documentDisplayName(document: OpenDocument) {
  return document.displayName?.trim() || document.title?.trim() || document.name.trim() || 'Untitled'
}

/** Paths of the previous session's tabs, restored on launch (contents are never stored). */
export function readStoredOpenDocuments(): StoredOpenDocuments {
  const empty: StoredOpenDocuments = { documents: [], activeIndex: 0 }
  try {
    const raw = window.localStorage.getItem(OPEN_DOCUMENTS_KEY)
    if (!raw) {
      return empty
    }
    const parsed = JSON.parse(raw) as Partial<StoredOpenDocuments>
    const documents = (parsed.documents ?? []).filter(
      (entry) =>
        Boolean(entry) &&
        typeof entry.path === 'string' &&
        (entry.kind === 'excalidraw' || entry.kind === 'mermaid'),
    )
    const activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0
    return { documents, activeIndex }
  } catch {
    window.localStorage.removeItem(OPEN_DOCUMENTS_KEY)
    return empty
  }
}

export function writeStoredOpenDocuments(documents: OpenDocument[], activeId: string | null) {
  const saved = documents.filter((document) => document.path)
  const stored: StoredOpenDocuments = {
    documents: saved.map((document) => ({ kind: document.kind, path: document.path as string })),
    activeIndex: Math.max(
      0,
      saved.findIndex((document) => document.id === activeId),
    ),
  }
  window.localStorage.setItem(OPEN_DOCUMENTS_KEY, JSON.stringify(stored))
}

/**
 * Ordered list of open documents plus the editor state each inactive tab holds.
 *
 * Only the identity of a document (path, name, title, dirty) lives in React state so
 * the tab strip re-renders; scenes, Mermaid text, and undo history sit in refs because
 * they change on every keystroke and nothing renders them until a tab is activated.
 */
export function useOpenDocuments() {
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const documentsRef = useRef<OpenDocument[]>([])
  const activeIdRef = useRef<string | null>(null)
  const excalidrawCacheRef = useRef(new Map<string, ExcalidrawDocumentCache>())
  const mermaidCacheRef = useRef(new Map<string, MermaidDocumentCache>())

  const [recoveryError, setRecoveryError] = useState('')
  const trackingRecoveryRef = useRef(false)
  const persistRecovery = useCallback(() => {
    if (!trackingRecoveryRef.current) return
    try {
      const entries: NewDocumentInput[] = []
      for (const document of documentsRef.current) {
        const excalidraw = excalidrawCacheRef.current.get(document.id)
        const mermaid = mermaidCacheRef.current.get(document.id)
        const dirty = document.kind === 'mermaid'
          ? mermaid && mermaid.history.text !== mermaid.persistedText
          : excalidraw && (excalidraw.persistedScene
            ? excalidraw.scene?.contents !== excalidraw.persistedScene.contents
            : excalidraw.scene?.hasContent)
        if (dirty) entries.push({ ...document, dirty: true, excalidraw, mermaid })
      }
      window.localStorage.setItem(RECOVERY_DOCUMENTS_KEY, JSON.stringify(entries))
      setRecoveryError('')
    } catch {
      setRecoveryError('Recovery could not be updated. Save your open documents to files before closing the app.')
    }
  }, [])
  const startRecoveryTracking = useCallback(() => {
    trackingRecoveryRef.current = true
    persistRecovery()
  }, [persistRecovery])

  const discardRecovery = useCallback(() => {
    try {
      window.localStorage.removeItem(RECOVERY_DOCUMENTS_KEY)
      trackingRecoveryRef.current = false
      return true
    } catch {
      setRecoveryError('Unable to discard stored recovery. Close the affected tabs or retry exiting.')
      return false
    }
  }, [])

  const commit = useCallback((next: OpenDocument[]) => {
    documentsRef.current = next
    setDocuments(next)
    persistRecovery()
  }, [persistRecovery])

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveIdState(id)
  }, [])

  const getActiveDocument = useCallback(() => documentsRef.current.find(document => document.id === activeIdRef.current) ?? null, [])

  const getDocuments = useCallback(() => documentsRef.current, [])

  const getDocument = useCallback(
    (id: string | null) => documentsRef.current.find((document) => document.id === id) ?? null,
    [],
  )

  const findByPath = useCallback(
    (path: string) => documentsRef.current.find((document) => document.path === path) ?? null,
    [],
  )

  /** Builds a document and stows its editor state, without listing it yet. */
  const instantiate = useCallback((input: NewDocumentInput) => {
    nextDocumentId += 1
    const document: OpenDocument = {
      id: `doc-${nextDocumentId}`,
      kind: input.kind,
      path: input.path ?? null,
      name: input.name ?? '',
      displayName: input.displayName ?? null,
      title: input.title ?? null,
      diagramType: input.diagramType ?? null,
      dirty: input.dirty ?? false,
      mode: input.mode ?? 'edit',
    }
    if (input.excalidraw) {
      excalidrawCacheRef.current.set(document.id, input.excalidraw)
    }
    if (input.mermaid) {
      mermaidCacheRef.current.set(document.id, input.mermaid)
    }
    return document
  }, [])

  const openDocument = useCallback(
    (input: NewDocumentInput) => {
      const document = instantiate(input)
      commit([...documentsRef.current, document])
      return document
    },
    [commit, instantiate],
  )

  /** Takes over a tab's slot with a new document; the old one and its cache are dropped. */
  const replaceDocument = useCallback(
    (id: string, input: NewDocumentInput) => {
      const current = documentsRef.current
      const index = current.findIndex((document) => document.id === id)
      const document = instantiate(input)
      if (index === -1) {
        commit([...current, document])
        return document
      }
      excalidrawCacheRef.current.delete(id)
      mermaidCacheRef.current.delete(id)
      const next = [...current]
      next[index] = document
      commit(next)
      if (activeIdRef.current === id) {
        setActiveId(document.id)
      }
      return document
    },
    [commit, instantiate, setActiveId],
  )

  /** A blank, never-edited, never-saved document — safe for a newly opened file to reuse. */
  const isPristineDocument = useCallback((document: OpenDocument | null) => {
    if (!document || document.path || document.dirty) {
      return false
    }
    if (document.kind === 'excalidraw') {
      const cache = excalidrawCacheRef.current.get(document.id)
      return !cache || (!cache.persistedScene && !cache.scene?.hasContent)
    }
    const cache = mermaidCacheRef.current.get(document.id)
    return !cache || (cache.history.past.length === 0 && cache.history.text === cache.persistedText)
  }, [])

  /**
   * The tab a newly opened document may take over: the active one when it is still
   * blank, or - when `kind` is given - any blank tab of that kind.
   */
  const findPristineDocument = useCallback(
    (kind?: DiagramKind) => {
      const active = documentsRef.current.find((document) => document.id === activeIdRef.current) ?? null
      if (active && isPristineDocument(active) && (!kind || active.kind === kind)) {
        return active
      }
      if (!kind) {
        return null
      }
      return (
        documentsRef.current.find((document) => document.kind === kind && isPristineDocument(document)) ?? null
      )
    },
    [isPristineDocument],
  )

  const patchDocument = useCallback(
    (id: string | null, patch: DocumentPatch) => {
      if (!id) {
        return
      }
      const current = documentsRef.current
      const index = current.findIndex((document) => document.id === id)
      if (index === -1) {
        return
      }
      const document = current[index]
      const keys = Object.keys(patch) as Array<keyof DocumentPatch>
      if (keys.every((key) => document[key] === patch[key])) {
        return
      }
      const next = [...current]
      next[index] = { ...document, ...patch }
      commit(next)
    },
    [commit],
  )

  /** Removes documents (and their caches) and returns the document that should take over. */
  const closeDocuments = useCallback(
    (ids: string[]) => {
      const current = documentsRef.current
      const closing = new Set(ids)
      const remaining = current.filter((document) => !closing.has(document.id))
      for (const id of ids) {
        excalidrawCacheRef.current.delete(id)
        mermaidCacheRef.current.delete(id)
      }

      const previousActiveId = activeIdRef.current
      let nextActive: OpenDocument | null = null
      if (previousActiveId && !closing.has(previousActiveId)) {
        nextActive = remaining.find((document) => document.id === previousActiveId) ?? null
      } else if (remaining.length) {
        const activeIndex = current.findIndex((document) => document.id === previousActiveId)
        const after = current.slice(activeIndex + 1).find((document) => !closing.has(document.id))
        nextActive = after ?? remaining[remaining.length - 1]
      }

      commit(remaining)
      setActiveId(nextActive?.id ?? null)
      return nextActive
    },
    [commit, setActiveId],
  )

  const readExcalidrawCache = useCallback((id: string) => excalidrawCacheRef.current.get(id) ?? null, [])
  const writeExcalidrawCache = useCallback((id: string, cache: ExcalidrawDocumentCache) => {
    if (!documentsRef.current.some(document => document.id === id)) return
    excalidrawCacheRef.current.set(id, cache)
    persistRecovery()
  }, [persistRecovery])
  const readMermaidCache = useCallback((id: string) => mermaidCacheRef.current.get(id) ?? null, [])
  const writeMermaidCache = useCallback((id: string, cache: MermaidDocumentCache) => {
    if (!documentsRef.current.some(document => document.id === id)) return
    mermaidCacheRef.current.set(id, cache)
    persistRecovery()
  }, [persistRecovery])

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeId) ?? null,
    [activeId, documents],
  )

  const openPaths = useMemo(
    () => new Set(documents.map((document) => document.path).filter((path): path is string => Boolean(path))),
    [documents],
  )

  return {
    recoveryError,
    reportRecoveryError: setRecoveryError,
    discardRecovery,
    startRecoveryTracking,
    documents,
    activeId,
    activeDocument,
    openPaths,
    getActiveDocument,
    getDocuments,
    getDocument,
    findByPath,
    openDocument,
    replaceDocument,
    findPristineDocument,
    patchDocument,
    closeDocuments,
    setActiveId,
    readExcalidrawCache,
    writeExcalidrawCache,
    readMermaidCache,
    writeMermaidCache,
  }
}

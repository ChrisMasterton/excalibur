import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import mermaid from 'mermaid'
import { INITIAL_MERMAID_TEXT, mermaidHistoryReducer } from '../lib/mermaidHistory'
import { parseMermaidTitle, titleToFileStem } from '../lib/mermaidTitle'
import { baseName, dirName, fileStem } from '../lib/paths'
import { api, errorMessage } from '../lib/tauri'
import type { DiagramKind, OpenDocument } from '../types'
import type { DocumentPatch, MermaidDocumentCache } from './useOpenDocuments'

type MermaidPersistedState = {
  path: string | null
  text: string
}

/** Everything the Excalidraw side needs to turn the live Mermaid source into a drawing. */
export type MermaidConversionRequest = {
  text: string
  /** Name the converted drawing should suggest when it is saved. */
  name: string
  /** Folder the conversion should be saved into (the source's folder). */
  saveDirectory: string | null
}

type UseMermaidDocumentOptions = {
  patchDocument: (id: string | null, patch: DocumentPatch) => void
  readCache: (id: string) => MermaidDocumentCache | null
  writeCache: (id: string, cache: MermaidDocumentCache) => void
  refreshRecents: () => void
  refreshProjectFiles: () => void
  showSaveFeedback: (kind: DiagramKind) => void
}

export type MermaidDocumentApi = ReturnType<typeof useMermaidDocument>

/**
 * The one live Mermaid editor: its text and undo history, the rendered preview,
 * whether it differs from disk, and the Mermaid toolbar's actions.
 */
export function useMermaidDocument({
  patchDocument,
  readCache,
  writeCache,
  refreshRecents,
  refreshProjectFiles,
  showSaveFeedback,
}: UseMermaidDocumentOptions) {
  const [path, setPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [history, dispatch] = useReducer(mermaidHistoryReducer, {
    text: INITIAL_MERMAID_TEXT,
    past: [],
    future: [],
  })
  const text = history.text
  const title = useMemo(() => parseMermaidTitle(text), [text])
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [isConverting, setIsConverting] = useState(false)

  const pathRef = useRef<string | null>(null)
  const persistedRef = useRef<MermaidPersistedState>({ path: null, text: INITIAL_MERMAID_TEXT })
  const historyRef = useRef(history)
  /** Which tab the editor is currently holding. */
  const liveIdRef = useRef<string | null>(null)

  useEffect(() => {
    historyRef.current = history
  }, [history])

  const setDocument = useCallback(
    (nextPath: string | null, nextName: string) => {
      pathRef.current = nextPath
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

  const setPersistedState = useCallback(
    (nextText: string, nextPath: string | null) => {
      persistedRef.current = { text: nextText, path: nextPath }
      markDirty(false)
    },
    [markDirty],
  )

  const updateDirtyState = useCallback(
    (nextText: string) => {
      markDirty(nextText !== persistedRef.current.text)
    },
    [markDirty],
  )

  // Keep the Mermaid tab labelled with the title from its frontmatter.
  useEffect(() => {
    patchDocument(liveIdRef.current, { title })
  }, [patchDocument, title])

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
        setError('')
        const cleanedText = text.replace(/^\uFEFF/, '').trim()
        if (!cleanedText) {
          setSvg('')
          return
        }
        const { svg: rendered } = await mermaid.render(`m-${Date.now()}`, cleanedText)
        if (isActive) {
          setSvg(rendered)
        }
      } catch {
        if (isActive) {
          setError('Unable to render diagram. Check syntax.')
        }
      }
    }
    void render()
    return () => {
      isActive = false
    }
  }, [text])

  /** Copies whatever the editor holds back into its tab, before another tab takes over. */
  const captureIntoCache = useCallback(() => {
    const liveId = liveIdRef.current
    if (liveId) {
      writeCache(liveId, {
        history: historyRef.current,
        persistedText: persistedRef.current.text,
      })
    }
  }, [writeCache])

  const loadDocument = useCallback(
    (document: OpenDocument, nextMessage: string) => {
      if (liveIdRef.current === document.id) {
        setMessage(nextMessage)
        return
      }
      const cache = readCache(document.id) ?? {
        history: { text: INITIAL_MERMAID_TEXT, past: [], future: [] },
        persistedText: INITIAL_MERMAID_TEXT,
      }
      liveIdRef.current = document.id
      historyRef.current = cache.history
      dispatch({ type: 'restore', state: cache.history })
      persistedRef.current = { path: document.path, text: cache.persistedText }
      setDocument(document.path, document.name)
      markDirty(cache.history.text !== cache.persistedText)
      setMessage(nextMessage)
    },
    [markDirty, readCache, setDocument],
  )

  /** Forgets that the editor holds this tab, so it is reloaded from its cache next time. */
  const releaseDocument = useCallback((id: string) => {
    if (liveIdRef.current === id) {
      liveIdRef.current = null
    }
  }, [])

  /** Clears the editor's live state because its tab is being closed. */
  const detachDocument = useCallback((document: OpenDocument) => {
    if (document.id === liveIdRef.current) {
      liveIdRef.current = null
    }
  }, [])

  /** Follows a live document whose file was renamed or moved underneath it. */
  const relocateDocument = useCallback(
    (id: string, nextPath: string) => {
      if (id !== liveIdRef.current) {
        return
      }
      setDocument(nextPath, fileStem(nextPath))
      persistedRef.current = { ...persistedRef.current, path: nextPath }
    },
    [setDocument],
  )

  const getLiveId = useCallback(() => liveIdRef.current, [])

  const handleTextChange = useCallback(
    (nextText: string) => {
      dispatch({ type: 'set', text: nextText })
      updateDirtyState(nextText)
    },
    [updateDirtyState],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const isModifier = event.metaKey || event.ctrlKey
      if (isModifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          const nextText = history.future[0]
          if (nextText !== undefined) {
            updateDirtyState(nextText)
          }
          dispatch({ type: 'redo' })
        } else {
          const nextText = history.past[history.past.length - 1]
          if (nextText !== undefined) {
            updateDirtyState(nextText)
          }
          dispatch({ type: 'undo' })
        }
        return
      }
      if (isModifier && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const nextText = history.future[0]
        if (nextText !== undefined) {
          updateDirtyState(nextText)
        }
        dispatch({ type: 'redo' })
        return
      }
      if (event.key === 'Tab' && !isModifier) {
        event.preventDefault()
        const target = event.currentTarget
        const { selectionStart, selectionEnd, value } = target
        const nextText = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
        handleTextChange(nextText)
        requestAnimationFrame(() => {
          target.selectionStart = target.selectionEnd = selectionStart + 2
        })
      }
    },
    [handleTextChange, history.future, history.past, updateDirtyState],
  )

  const handleSave = useCallback(async () => {
    const nextName = name.trim()
    try {
      const response = await api.saveMermaidFile({
        path,
        name: nextName || undefined,
        contents: text,
      })
      setDocument(response.path, fileStem(response.path))
      setPersistedState(text, response.path)
      setMessage(`Saved ${baseName(response.path)}.`)
      showSaveFeedback('mermaid')
      refreshRecents()
      refreshProjectFiles()
    } catch (error_) {
      if (errorMessage(error_, '') !== 'Save cancelled') {
        setMessage(errorMessage(error_, 'Unable to save Mermaid file.'))
      }
    }
  }, [name, path, refreshProjectFiles, refreshRecents, setDocument, setPersistedState, showSaveFeedback, text])

  const handleRename = useCallback(
    async (nextName: string) => {
      const currentPath = pathRef.current
      if (!currentPath) {
        setDocument(null, nextName)
        return
      }
      try {
        const nextPath = await api.renameFile(currentPath, nextName)
        setDocument(nextPath, fileStem(nextPath))
        persistedRef.current = { ...persistedRef.current, path: nextPath }
        setMessage(`Renamed to ${baseName(nextPath)}.`)
        refreshRecents()
        refreshProjectFiles()
      } catch (error_) {
        setMessage(errorMessage(error_, 'Unable to rename file.'))
        throw error_
      }
    },
    [refreshProjectFiles, refreshRecents, setDocument],
  )

  /**
   * Checks the source can be converted and works out how the resulting drawing
   * should be named and where it should be saved. Reports why not, and returns
   * null, when there is nothing to convert.
   */
  const prepareConversion = useCallback((): MermaidConversionRequest | null => {
    const cleanedText = text.replace(/^\uFEFF/, '').trim()
    if (!cleanedText) {
      setMessage('Nothing to convert yet.')
      return null
    }
    if (error) {
      setMessage('Fix Mermaid syntax before converting.')
      return null
    }
    return {
      text: cleanedText,
      name: name.trim() || (title ? titleToFileStem(title) : '') || 'diagram',
      saveDirectory: path ? dirName(path) : null,
    }
  }, [error, name, path, text, title])

  return {
    path,
    name,
    message,
    dirty,
    text,
    title,
    svg,
    error,
    isConverting,
    setMessage,
    setConverting: setIsConverting,
    getLiveId,
    captureIntoCache,
    loadDocument,
    releaseDocument,
    detachDocument,
    relocateDocument,
    prepareConversion,
    handleTextChange,
    handleKeyDown,
    handleSave,
    handleRename,
  }
}

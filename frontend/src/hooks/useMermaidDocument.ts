import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import mermaid from 'mermaid'
import type { ZoomPanHandle } from '../components/ZoomPanViewport'
import { INITIAL_MERMAID_TEXT, mermaidHistoryReducer } from '../lib/mermaidHistory'
import { applySymbolHighlight, clearSymbolHighlight } from '../lib/mermaidHighlight'
import { initializeMermaid } from '../lib/mermaidSymbols'
import type { SymbolLocator } from '../lib/symbols'
import {
  DIAGRAM_PAPER_BACKGROUND,
  EMPTY_DIAGRAM,
  pinSvgToNaturalSize,
  renderDiagramToPngBytes,
} from '../lib/mermaidSvg'
import { parseMermaidTitle, titleToFileStem } from '../lib/mermaidTitle'
import { baseName, dirName, fileStem } from '../lib/paths'
import { api, errorMessage } from '../lib/tauri'
import type { DiagramKind, OpenDocument } from '../types'
import type { DocumentPatch, MermaidDocumentCache } from './useOpenDocuments'

type MermaidPersistedState = {
  path: string | null
  text: string
}

/** Which nodes of which tab a search hit wants marked. */
export type MermaidHighlightRequest = {
  documentId: string
  locators: SymbolLocator[]
  display: string
  /** Bumped so asking for the same symbol twice still re-runs the pass. */
  token: number
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
  // The preview SVG at its natural pixel size: shared by the viewport and the PNG export.
  const diagram = useMemo(() => (svg ? pinSvgToNaturalSize(svg) : EMPTY_DIAGRAM), [svg])
  const diagramRef = useRef(diagram)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<ZoomPanHandle | null>(null)
  /** A "Find in project" hit waiting for its document's SVG to be on screen. */
  const [highlight, setHighlight] = useState<MermaidHighlightRequest | null>(null)

  useEffect(() => {
    diagramRef.current = diagram
  }, [diagram])

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
    // Shared with the symbol index so the preview and the parser agree on config.
    initializeMermaid()
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
      setHighlight(null)
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

  const highlightTokenRef = useRef(0)

  const highlightSymbol = useCallback((documentId: string, locators: SymbolLocator[], display: string) => {
    highlightTokenRef.current += 1
    setHighlight({ documentId, locators, display, token: highlightTokenRef.current })
  }, [])

  const clearHighlight = useCallback(() => setHighlight(null), [])

  // Re-runs whenever the preview is re-rendered, so the marks survive a re-parse.
  useEffect(() => {
    const container = previewRef.current
    if (!container) {
      return
    }
    clearSymbolHighlight(container)
    if (!highlight || highlight.documentId !== liveIdRef.current || !diagram.markup) {
      return
    }
    const targets = applySymbolHighlight(container, highlight.locators, highlight.display)
    if (targets.length) {
      viewportRef.current?.focusElement(targets)
    }
  }, [diagram, highlight])

  const handleExportPng = useCallback(async () => {
    const current = diagramRef.current
    if (!current.markup || error) {
      setMessage(error ? 'Fix Mermaid syntax before exporting.' : 'Nothing to export yet.')
      return
    }
    try {
      const contents = await renderDiagramToPngBytes(current, DIAGRAM_PAPER_BACKGROUND)
      const suggestedName = name.trim() || (title ? titleToFileStem(title) : '') || 'diagram'
      const response = await api.savePngFile({ name: suggestedName, contents })
      setMessage(`Exported ${baseName(response.path)}.`)
    } catch (error_) {
      if (errorMessage(error_, '') !== 'Save cancelled') {
        console.error('[excalibur] save_png_file failed', error_)
        setMessage(errorMessage(error_, 'Unable to export PNG.'))
      }
    }
  }, [error, name, title])

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
    diagram,
    error,
    isConverting,
    previewRef,
    viewportRef,
    highlightSymbol,
    clearHighlight,
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
    handleExportPng,
  }
}

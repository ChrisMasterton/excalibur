import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExcalidrawDocumentCache, MermaidDocumentCache } from './useOpenDocuments'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import type { PickedSymbol } from '../lib/symbolPick'
import type { SymbolEntry } from '../lib/symbols'
import { api } from '../lib/tauri'
import {
  renderExcalidrawThumbnail,
  renderMermaidThumbnail,
  type SymbolThumbnail,
} from '../lib/thumbnails'
import type { OpenDocument } from '../types'

/** What a card knows about its thumbnail while it is being made, and after. */
export type BoardThumbnail =
  | { status: 'loading' }
  | { status: 'ready'; thumbnail: SymbolThumbnail }
  | { status: 'failed' }

/** One document on the board. */
export type BoardCard = {
  hit: SymbolDocumentHit
  /** The document currently on screen, marked so the board says "you are here". */
  isActive: boolean
}

type UseSymbolBoardOptions = {
  /** The references panel's active symbol; the board only ever shows this one. */
  symbol: PickedSymbol | null
  /** Documents that mention it, already ordered by match count then title. */
  documents: readonly SymbolDocumentHit[]
  activePath: string | null
  /** Opens a document and reveals its match — the panel's own row handler. */
  select: (hit: SymbolDocumentHit) => void
  /** Escape once the board is out of the way (highlight, then panel). */
  onEscape: () => void
  /** Flushes the live editors into their tab caches, so unsaved work is thumbnailed. */
  snapshotLiveDocuments: () => void
  findByPath: (path: string) => OpenDocument | null
  readExcalidrawCache: (id: string) => ExcalidrawDocumentCache | null
  readMermaidCache: (id: string) => MermaidDocumentCache | null
}

/** Thumbnails held between openings; capped because a drawing's SVG is not small. */
const THUMBNAIL_CACHE_LIMIT = 60

/** Hands the event loop back between thumbnails so the board stays responsive. */
function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

/** Cheap FNV-1a over the source, so a document is re-rendered only when it changes. */
function contentsKey(contents: string) {
  let hash = 2166136261
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${contents.length}:${(hash >>> 0).toString(16)}`
}

function locatorsOf(entries: readonly SymbolEntry[]) {
  return entries.flatMap((entry) => entry.locators)
}

export type SymbolBoardApi = ReturnType<typeof useSymbolBoard>

/**
 * The board: every document that mentions the active symbol, side by side, each
 * showing its own diagram with the matches marked.
 *
 * It is a way of *looking* at what the references panel already found, so it owns
 * nothing but the overlay's open state and the thumbnails. Choosing a card goes
 * back through the panel's own `select`, so opening, activating, highlighting and
 * revealing stay in one place.
 *
 * Escape peels the board first, then hands over to the panel's own ordering
 * (highlight, then panel), so one press never takes two layers away.
 */
export function useSymbolBoard({
  symbol,
  documents,
  activePath,
  select,
  onEscape,
  snapshotLiveDocuments,
  findByPath,
  readExcalidrawCache,
  readMermaidCache,
}: UseSymbolBoardOptions) {
  const [isOpen, setIsOpen] = useState(false)
  const [thumbnails, setThumbnails] = useState<Record<string, BoardThumbnail>>({})
  /** `symbol|path|contents` → the render, kept so reopening the board is instant. */
  const cacheRef = useRef(new Map<string, SymbolThumbnail | null>())
  /** Cards whose thumbnail has been asked for since the board was last opened. */
  const requestedRef = useRef(new Set<string>())
  const queueRef = useRef<Array<{ key: string; symbolKey: string; hit: SymbolDocumentHit }>>([])
  const isRenderingRef = useRef(false)

  const symbolKey = symbol?.symbol ?? ''
  const canOpen = Boolean(symbol) && documents.length > 0

  const open = useCallback(() => {
    if (!canOpen) {
      return
    }
    // Unsaved tabs are thumbnailed from what the editor holds, not from disk.
    snapshotLiveDocuments()
    // Every card asks again, so an edited document is re-read; the cache below
    // still spares the render for everything that has not changed.
    requestedRef.current.clear()
    queueRef.current = []
    setThumbnails({})
    setIsOpen(true)
  }, [canOpen, snapshotLiveDocuments])

  const close = useCallback(() => setIsOpen(false), [])

  const handleEscape = useCallback(() => {
    if (isOpen) {
      close()
      return
    }
    onEscape()
  }, [close, isOpen, onEscape])

  // The board only ever reflects the active symbol: if the panel loses it (or the
  // symbol turns out to be mentioned nowhere), there is nothing left to show.
  useEffect(() => {
    if (isOpen && !canOpen) {
      setIsOpen(false)
    }
  }, [canOpen, isOpen])

  /** The source a document should be thumbnailed from: its open tab, else the file. */
  const readContents = useCallback(
    async (hit: SymbolDocumentHit): Promise<string | null> => {
      const open_ = findByPath(hit.doc.path)
      if (open_) {
        const contents =
          open_.kind === 'excalidraw'
            ? readExcalidrawCache(open_.id)?.scene?.contents
            : readMermaidCache(open_.id)?.history.text
        if (typeof contents === 'string') {
          return contents
        }
      }
      try {
        const response =
          hit.doc.kind === 'excalidraw'
            ? await api.loadExcalidrawPath(hit.doc.path, false)
            : await api.loadMermaidPath(hit.doc.path, false)
        return response.contents
      } catch (error) {
        console.warn('[excalibur] unable to read', hit.doc.path, error)
        return null
      }
    },
    [findByPath, readExcalidrawCache, readMermaidCache],
  )

  const remember = useCallback((key: string, thumbnail: SymbolThumbnail | null) => {
    const cache = cacheRef.current
    cache.delete(key)
    cache.set(key, thumbnail)
    while (cache.size > THUMBNAIL_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) {
        break
      }
      cache.delete(oldest)
    }
  }, [])

  const renderThumbnail = useCallback(
    (hit: SymbolDocumentHit, contents: string): Promise<SymbolThumbnail | null> => {
      const locators = locatorsOf(hit.entries)
      if (hit.doc.kind === 'excalidraw') {
        return renderExcalidrawThumbnail(
          contents,
          locators.flatMap((locator) => (locator.target === 'excalidraw' ? [locator.elementId] : [])),
        )
      }
      return renderMermaidThumbnail(
        contents,
        locators.filter((locator) => locator.target === 'mermaid'),
        hit.entries[0]?.display ?? '',
      )
    },
    [],
  )

  /** One thumbnail at a time, with a yield between, so tens of cards never block. */
  const drainQueue = useCallback(async () => {
    if (isRenderingRef.current) {
      return
    }
    isRenderingRef.current = true
    try {
      for (let next = queueRef.current.shift(); next; next = queueRef.current.shift()) {
        const contents = await readContents(next.hit)
        let thumbnail: SymbolThumbnail | null = null
        if (contents !== null) {
          const cacheKey = `${next.symbolKey}|${next.hit.doc.path}|${contentsKey(contents)}`
          const cached = cacheRef.current.get(cacheKey)
          if (cached !== undefined) {
            thumbnail = cached
          } else {
            thumbnail = await renderThumbnail(next.hit, contents)
            remember(cacheKey, thumbnail)
          }
        }
        const entry: BoardThumbnail = thumbnail ? { status: 'ready', thumbnail } : { status: 'failed' }
        setThumbnails((current) => ({ ...current, [next.key]: entry }))
        await yieldToBrowser()
      }
    } finally {
      isRenderingRef.current = false
    }
  }, [readContents, remember, renderThumbnail])

  /** A card asking for its thumbnail once it is on screen. Cheap to call again. */
  const requestThumbnail = useCallback(
    (hit: SymbolDocumentHit) => {
      const key = `${symbolKey}|${hit.doc.path}`
      if (requestedRef.current.has(key)) {
        return
      }
      requestedRef.current.add(key)
      queueRef.current.push({ key, symbolKey, hit })
      setThumbnails((current) => ({ ...current, [key]: { status: 'loading' } }))
      void drainQueue()
    },
    [drainQueue, symbolKey],
  )

  const thumbnailFor = useCallback(
    (hit: SymbolDocumentHit) => thumbnails[`${symbolKey}|${hit.doc.path}`] ?? null,
    [symbolKey, thumbnails],
  )

  const cards = useMemo<BoardCard[]>(
    () => documents.map((hit) => ({ hit, isActive: hit.doc.path === activePath })),
    [activePath, documents],
  )

  /** A card is a way into the document: the board steps aside and the panel takes over. */
  const selectCard = useCallback(
    (hit: SymbolDocumentHit) => {
      close()
      select(hit)
    },
    [close, select],
  )

  return {
    isOpen,
    canOpen,
    cards,
    open,
    close,
    handleEscape,
    selectCard,
    requestThumbnail,
    thumbnailFor,
  }
}

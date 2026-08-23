import { useCallback, useEffect, useRef, useState } from 'react'
import { indexFile, searchEntries, type SymbolSearchResult } from '../lib/symbolIndex'
import type { SymbolEntry } from '../lib/symbols'
import { api } from '../lib/tauri'
import type { ProjectFile, ProjectItem } from '../types'

export type SymbolIndexStatus = {
  isIndexing: boolean
  /** Files read so far, and how many there are in total. */
  indexed: number
  total: number
  ready: boolean
}

export type ProjectSearchGroup = {
  project: ProjectItem
  results: SymbolSearchResult[]
}

type UseSymbolIndexOptions = {
  projects: ProjectItem[]
  /** Bumps whenever project files may have changed on disk (a save, a move, a rescan). */
  refreshToken: number
}

export type SymbolIndexApi = ReturnType<typeof useSymbolIndex>

const IDLE_STATUS: SymbolIndexStatus = { isIndexing: false, indexed: 0, total: 0, ready: false }

/** Hands the event loop back so a large project cannot freeze the sidebar. */
function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

/**
 * The symbol index for every registered project, built lazily the first time
 * something asks for it and refreshed per file whenever its mtime moves.
 *
 * Files are read through the ordinary load commands with `trackRecent: false`,
 * one at a time with a yield between them, so indexing never blocks the UI.
 */
export function useSymbolIndex({ projects, refreshToken }: UseSymbolIndexOptions) {
  const [entriesByProject, setEntriesByProject] = useState<Record<string, SymbolEntry[]>>({})
  const [status, setStatus] = useState<SymbolIndexStatus>(IDLE_STATUS)
  const [isRequested, setIsRequested] = useState(false)
  /** path → the entries last extracted, tagged with the mtime they came from. */
  const cacheRef = useRef(new Map<string, { updatedAt: number; entries: SymbolEntry[] }>())
  const runIdRef = useRef(0)

  /** Starts (or refreshes) the index. Cheap to call repeatedly. */
  const ensureIndex = useCallback(() => setIsRequested(true), [])

  const readFile = useCallback(async (file: ProjectFile) => {
    const cached = cacheRef.current.get(file.path)
    if (cached && cached.updatedAt === file.updated_at) {
      return cached.entries
    }
    try {
      const response =
        file.kind === 'excalidraw'
          ? await api.loadExcalidrawPath(file.path, false)
          : await api.loadMermaidPath(file.path, false)
      const entries = await indexFile(file, response.contents)
      cacheRef.current.set(file.path, { updatedAt: file.updated_at, entries })
      return entries
    } catch (error) {
      console.warn('[excalibur] unable to index', file.path, error)
      cacheRef.current.set(file.path, { updatedAt: file.updated_at, entries: [] })
      return []
    }
  }, [])

  useEffect(() => {
    if (!isRequested) {
      return
    }
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    const isCurrent = () => runIdRef.current === runId

    const build = async () => {
      const listings = await Promise.all(
        projects.map(async (project) => ({
          project,
          files: await api.listProjectFiles(project.path).catch((error) => {
            console.warn('[excalibur] unable to list', project.path, error)
            return [] as ProjectFile[]
          }),
        })),
      )
      if (!isCurrent()) {
        return
      }
      const total = listings.reduce((sum, listing) => sum + listing.files.length, 0)
      setStatus({ isIndexing: true, indexed: 0, total, ready: false })

      let indexed = 0
      const next: Record<string, SymbolEntry[]> = {}
      for (const listing of listings) {
        const entries: SymbolEntry[] = []
        for (const file of listing.files) {
          entries.push(...(await readFile(file)))
          if (!isCurrent()) {
            return
          }
          indexed += 1
          setStatus({ isIndexing: true, indexed, total, ready: false })
          await yieldToBrowser()
          if (!isCurrent()) {
            return
          }
        }
        next[listing.project.path] = entries
        setEntriesByProject({ ...next })
      }
      setEntriesByProject(next)
      setStatus({ isIndexing: false, indexed: total, total, ready: true })
    }

    void build()
  }, [isRequested, projects, readFile, refreshToken])

  const search = useCallback(
    (query: string): ProjectSearchGroup[] =>
      projects
        .map((project) => ({
          project,
          results: searchEntries(entriesByProject[project.path] ?? [], query),
        }))
        .filter((group) => group.results.length > 0),
    [entriesByProject, projects],
  )

  return { status, ensureIndex, search }
}

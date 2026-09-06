import { useCallback, useEffect, useRef, useState } from 'react'
import {
  collectSymbolDocuments,
  indexFile,
  searchEntries,
  type SymbolSearchResult,
} from '../lib/symbolIndex'
import type { SymbolEntry } from '../lib/symbols'
import { api } from '../lib/tauri'
import type { ProjectFile, ProjectItem } from '../types'

export type SymbolIndexStatus = {
  isIndexing: boolean
  /** Files read so far, and how many there are in total. */
  indexed: number
  total: number
  errors: string[]
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

const IDLE_STATUS: SymbolIndexStatus = { isIndexing: false, indexed: 0, total: 0, ready: false, errors: [] }

/** Hands the event loop back so a large project cannot freeze the sidebar. */
function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

/**
 * The symbol index for every registered project, built lazily the first time
 * something asks for it and refreshed after writes or an explicit folder rescan.
 *
 * Files are read through the ordinary load commands with `trackRecent: false`,
 * one at a time with a yield between them, so indexing never blocks the UI.
 */
export function useSymbolIndex({ projects, refreshToken }: UseSymbolIndexOptions) {
  const [entriesByProject, setEntriesByProject] = useState<Record<string, SymbolEntry[]>>({})
  const [status, setStatus] = useState<SymbolIndexStatus>(IDLE_STATUS)
  const [isRequested, setIsRequested] = useState(false)
  const runIdRef = useRef(0)

  /** Starts (or refreshes) the index. Cheap to call repeatedly. */
  const ensureIndex = useCallback(() => setIsRequested(true), [])

  const readFile = useCallback(async (file: ProjectFile) => {
    try {
      const response =
        file.kind === 'excalidraw'
          ? await api.loadExcalidrawPath(file.path, false)
          : await api.loadMermaidPath(file.path, false)
      const entries = await indexFile(file, response.contents)
      return entries
    } catch (error) {
      console.warn('[excalibur] unable to index', file.path, error)
      throw error
    }
  }, [])

  useEffect(() => {
    if (!isRequested) {
      return
    }
    // An explicit refresh means disk contents may have changed even when timestamps match.
    const errors: string[] = []
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    const isCurrent = () => runIdRef.current === runId

    const build = async () => {
      const listings = await Promise.all(
        projects.map(async (project) => ({
          project,
          files: await api.listProjectFiles(project.path).catch((error) => {
            console.warn('[excalibur] unable to list', project.path, error)
            errors.push(project.path)
            return [] as ProjectFile[]
          }),
        })),
      )
      if (!isCurrent()) {
        return
      }
      const total = listings.reduce((sum, listing) => sum + listing.files.length, 0)
      setStatus({ isIndexing: true, indexed: 0, total, ready: false, errors: [] })

      let indexed = 0
      const next: Record<string, SymbolEntry[]> = {}
      for (const listing of listings) {
        const entries: SymbolEntry[] = []
        for (const file of listing.files) {
          try { entries.push(...(await readFile(file))) } catch { errors.push(file.path) }
          if (!isCurrent()) {
            return
          }
          indexed += 1
          setStatus({ isIndexing: true, indexed, total, ready: false, errors: [] })
          await yieldToBrowser()
          if (!isCurrent()) {
            return
          }
        }
        next[listing.project.path] = entries
        setEntriesByProject({ ...next })
      }
      setEntriesByProject(next)
      setStatus({ isIndexing: false, indexed: total, total, ready: true, errors })
    }

    void build()
    return () => { runIdRef.current += 1 }
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

  /** The registered project a path lives in (the deepest one, if they nest). */
  const findProject = useCallback(
    (path: string | null) => {
      if (!path) {
        return null
      }
      let match: ProjectItem | null = null
      for (const project of projects) {
        const inside = path === project.path || path.startsWith(`${project.path}/`) || path.startsWith(`${project.path}\\`)
        if (inside && (!match || project.path.length > match.path.length)) {
          match = project
        }
      }
      return match
    },
    [projects],
  )

  /** Every document in one project that mentions an exact symbol key. */
  const documentsForSymbol = useCallback(
    (projectPath: string | null, symbol: string) =>
      projectPath ? collectSymbolDocuments(entriesByProject[projectPath] ?? [], symbol) : [],
    [entriesByProject],
  )

  /** Every indexed entry in one project, for callers that want its whole vocabulary. */
  const entriesFor = useCallback(
    (projectPath: string | null): SymbolEntry[] =>
      projectPath ? (entriesByProject[projectPath] ?? []) : [],
    [entriesByProject],
  )

  return { status, ensureIndex, search, findProject, documentsForSymbol, entriesFor }
}

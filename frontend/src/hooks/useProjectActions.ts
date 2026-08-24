import { useCallback } from 'react'
import type { SidebarPanel } from '../components/Sidebar'
import type { DocumentTabsApi } from './useDocumentTabs'
import type { ExcalidrawDocumentApi } from './useExcalidrawDocument'
import type { MermaidDocumentApi } from './useMermaidDocument'
import type { DocumentPatch } from './useOpenDocuments'
import { baseName, fileStem } from '../lib/paths'
import { api, errorMessage } from '../lib/tauri'
import type { DiagramKind, OpenDocument, OpenFileResponse, ProjectItem } from '../types'

type UseProjectActionsOptions = {
  excalidraw: ExcalidrawDocumentApi
  mermaid: MermaidDocumentApi
  tabs: DocumentTabsApi
  notify: (message: string) => void
  setSidebarPanel: (panel: SidebarPanel) => void
  refreshRecents: () => void
  refreshProjects: () => Promise<void>
  refreshProjectFiles: () => void
  getDocuments: () => OpenDocument[]
  patchDocument: (id: string | null, patch: DocumentPatch) => void
  findByPath: (path: string) => OpenDocument | null
}

/** Adding, renaming, and filling projects, plus everything that moves a file on disk. */
export function useProjectActions({
  excalidraw,
  mermaid,
  tabs,
  notify,
  setSidebarPanel,
  refreshRecents,
  refreshProjects,
  refreshProjectFiles,
  getDocuments,
  patchDocument,
  findByPath,
}: UseProjectActionsOptions) {
  const { activateDocument, openLoadedFile } = tabs
  const { relocateDocument: relocateExcalidrawDocument } = excalidraw
  const { relocateDocument: relocateMermaidDocument } = mermaid

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
        relocateExcalidrawDocument(document.id, nextPath)
        relocateMermaidDocument(document.id, nextPath)
      }
    },
    [getDocuments, patchDocument, relocateExcalidrawDocument, relocateMermaidDocument],
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
  }, [notify, refreshProjects, setSidebarPanel])

  const handleRenameProject = useCallback(
    async (project: ProjectItem, name: string) => {
      await api.renameProject(project.path, name)
      await refreshProjects()
    },
    [refreshProjects],
  )

  const handleRenameProjectFileDisplayName = useCallback(
    async (project: ProjectItem, path: string, name: string) => {
      await api.renameProjectFileDisplayName(project.path, path, name)
      const openDocument = findByPath(path)
      if (openDocument) {
        patchDocument(openDocument.id, { title: name })
      }
      refreshRecents()
      refreshProjectFiles()
    },
    [findByPath, patchDocument, refreshProjectFiles, refreshRecents],
  )

  const moveFileToProject = useCallback(
    async (path: string, project: ProjectItem) => {
      try {
        const nextPath = await api.moveFileToProject(path, project.path)
        relocateOpenDocuments(path, nextPath)
        notify(`Moved ${baseName(nextPath)} to ${project.name}.`)
        refreshRecents()
        refreshProjectFiles()
      } catch (error) {
        notify(errorMessage(error, 'Unable to move file.'))
      }
    },
    [notify, refreshProjectFiles, refreshRecents, relocateOpenDocuments],
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

  return {
    handleOpenAllProjectFiles,
    handleAddProject,
    handleRenameProject,
    handleRenameProjectFileDisplayName,
    moveFileToProject,
    moveFileToNewProject,
  }
}

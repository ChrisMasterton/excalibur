import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/tauri'
import type { ProjectItem, RecentItem } from '../types'

/**
 * The lists the sidebar shows. `projectsRefreshToken` bumps whenever a project's
 * files may have changed on disk, so `ProjectsPanel` re-reads its file list.
 */
export function useSidebarData() {
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsRefreshToken, setProjectsRefreshToken] = useState(0)

  const refreshRecents = useCallback(
    () =>
      api
        .listRecents()
        .then(setRecents)
        .catch((error) => console.error('[excalibur] list_recents failed', error)),
    [],
  )

  const refreshProjects = useCallback(
    () =>
      api
        .listProjects()
        .then((items) => {
          setProjects(items)
          setProjectsRefreshToken((token) => token + 1)
        })
        .catch((error) => console.error('[excalibur] list_projects failed', error)),
    [],
  )

  /** Re-reads the files inside the known projects without re-reading the project list. */
  const refreshProjectFiles = useCallback(() => {
    setProjectsRefreshToken((token) => token + 1)
  }, [])

  useEffect(() => {
    void refreshRecents()
    void refreshProjects()
  }, [refreshProjects, refreshRecents])

  const removeRecent = useCallback(async (item: RecentItem) => {
    setRecents(await api.removeRecent(item.kind, item.path))
  }, [])

  const removeProject = useCallback(async (project: ProjectItem) => {
    setProjects(await api.removeProject(project.path))
  }, [])

  return {
    recents,
    projects,
    projectsRefreshToken,
    refreshRecents,
    refreshProjects,
    refreshProjectFiles,
    removeRecent,
    removeProject,
  }
}

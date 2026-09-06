import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/tauri'
import type { ProjectItem, RecentItem } from '../types'

/**
 * The lists the sidebar shows. `projectsRefreshToken` bumps whenever a project's
 * files may have changed on disk, so `ProjectsPanel` re-reads its file list.
 */
export function useSidebarData() {
  const [recentsError, setRecentsError] = useState('')
  const [projectsError, setProjectsError] = useState('')
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsRefreshToken, setProjectsRefreshToken] = useState(0)

  const refreshRecents = useCallback(
    () =>
      api
        .listRecents()
        .then(items => { setRecents(items); setRecentsError('') })
        .catch((error) => setRecentsError(errorMessage(error, 'Unable to load Recent.'))),
    [],
  )

  const refreshProjects = useCallback(
    () =>
      api
        .listProjects()
        .then((items) => {
          setProjects(items)
          setProjectsError('')
          setProjectsRefreshToken((token) => token + 1)
        })
        .catch((error) => setProjectsError(errorMessage(error, 'Unable to load projects.'))),
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
    try { setRecents(await api.removeRecent(item.kind, item.path)); setRecentsError('') }
    catch (error) { setRecentsError(errorMessage(error, 'Unable to remove Recent entry.')) }
  }, [])

  const removeProject = useCallback(async (project: ProjectItem) => {
    try { setProjects(await api.removeProject(project.path)); setProjectsError('') }
    catch (error) { setProjectsError(errorMessage(error, 'Unable to remove project.')) }
  }, [])

  return {
    error: [recentsError, projectsError].filter(Boolean).join(" "),
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

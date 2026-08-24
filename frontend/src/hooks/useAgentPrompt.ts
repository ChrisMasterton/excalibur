import { useCallback, useState } from 'react'
import type { ProjectItem } from '../types'

/**
 * Which project the "Coding agent prompt" dialog is open for, if any. A leaf
 * hook so the shell only carries one line for the whole feature.
 */
export function useAgentPrompt() {
  const [project, setProject] = useState<ProjectItem | null>(null)

  const open = useCallback((next: ProjectItem) => setProject(next), [])
  const close = useCallback(() => setProject(null), [])

  return { project, open, close }
}

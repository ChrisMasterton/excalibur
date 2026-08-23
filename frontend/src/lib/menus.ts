import type { MenuItem } from '../components/ContextMenu'
import type { DiagramKind, ProjectItem } from '../types'

export function kindIcon(kind: DiagramKind) {
  return kind === 'excalidraw' ? 'pen' : 'branch'
}

/** Builds the "Move to project" submenu shared by recents and project files. */
export function buildMoveToProjectItems(
  projects: ProjectItem[],
  currentProjectPath: string | null,
  onMove: (project: ProjectItem) => void,
  onMoveToNew: () => void,
): MenuItem[] {
  const items: MenuItem[] = projects
    .filter((project) => project.path !== currentProjectPath)
    .map((project) => ({
      label: project.name,
      icon: 'folder' as const,
      onSelect: () => onMove(project),
    }))
  if (items.length) {
    items.push({ separator: true })
  }
  items.push({ label: 'New project…', icon: 'folder-plus', onSelect: onMoveToNew })
  return items
}


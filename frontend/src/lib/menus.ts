import type { MenuItem } from '../components/ContextMenu'
import type { IconName } from '../components/Icon'
import type { DiagramKind, ProjectItem } from '../types'

const MERMAID_TYPE_ICONS: Partial<Record<string, IconName>> = {
  flowchart: 'flowchart',
  sequence: 'sequence',
  class: 'uml-class',
  er: 'database',
  state: 'state',
  gantt: 'gantt',
  pie: 'pie',
  mindmap: 'mindmap',
  journey: 'timeline',
  timeline: 'timeline',
  git: 'branch',
}

/** Icon for a diagram file; Mermaid files get a type-specific glyph when known. */
export function diagramIcon(kind: DiagramKind, diagramType?: string | null): IconName {
  if (kind === 'excalidraw') {
    return 'pen'
  }
  return (diagramType && MERMAID_TYPE_ICONS[diagramType]) || 'branch'
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


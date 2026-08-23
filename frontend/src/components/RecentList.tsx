import type { MouseEvent } from 'react'
import { useContextMenu } from '../hooks/useContextMenu'
import { buildMoveToProjectItems, kindIcon } from '../lib/menus'
import { baseName, dirName, shortDirName } from '../lib/paths'
import type { ProjectItem, RecentItem } from '../types'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

type RecentListProps = {
  recents: RecentItem[]
  projects: ProjectItem[]
  /** Paths with an open tab; the active one gets a stronger highlight. */
  openPaths: Set<string>
  activePath: string | null
  onOpen: (item: RecentItem) => void
  onMoveToProject: (item: RecentItem, project: ProjectItem) => void
  onMoveToNewProject: (item: RecentItem) => void
  onRemove: (item: RecentItem) => void
}

export function RecentList({
  recents,
  projects,
  openPaths,
  activePath,
  onOpen,
  onMoveToProject,
  onMoveToNewProject,
  onRemove,
}: RecentListProps) {
  const menu = useContextMenu()

  const openMenu = (event: MouseEvent, item: RecentItem) => {
    menu.open(event, [
      { label: 'Open', icon: kindIcon(item.kind), onSelect: () => onOpen(item) },
      {
        label: 'Move to project',
        icon: 'folder-input',
        children: buildMoveToProjectItems(
          projects,
          dirName(item.path),
          (project) => onMoveToProject(item, project),
          () => onMoveToNewProject(item),
        ),
      },
      { separator: true },
      { label: 'Remove from recents', icon: 'x', onSelect: () => onRemove(item) },
    ])
  }

  if (!recents.length) {
    return <div className="empty">No recent diagrams yet. Open or save a file and it will show up here.</div>
  }

  return (
    <div className="file-list">
      {recents.map((item) => {
        const open = openPaths.has(item.path)
        const active = activePath === item.path
        return (
          <div
            key={`${item.kind}-${item.path}`}
            className={`file-row${open ? ' is-open' : ''}${active ? ' is-active' : ''}`}
            onContextMenu={(event) => openMenu(event, item)}
          >
            <button
              type="button"
              className="file-row-main"
              onClick={() => onOpen(item)}
              title={item.path}
            >
              <Icon name={kindIcon(item.kind)} size={16} className="file-row-icon" />
              <span className="file-row-text">
                <span className="file-row-name">{item.title || item.name || item.path}</span>
                <span className="file-row-path">
                  {item.title ? `${item.name || baseName(item.path)} · ` : ''}
                  {shortDirName(item.path)}
                </span>
              </span>
            </button>
            <IconButton
              icon="more"
              label={`More actions for ${item.name || item.path}`}
              size="sm"
              className="file-row-more"
              onClick={(event) => openMenu(event, item)}
            />
          </div>
        )
      })}
      {menu.element}
    </div>
  )
}

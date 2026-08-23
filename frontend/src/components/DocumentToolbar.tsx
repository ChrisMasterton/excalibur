import type { ReactNode } from 'react'
import { dirName } from '../lib/paths'
import type { DiagramKind } from '../types'
import { EditableTitle } from './EditableTitle'
import { Icon } from './Icon'
import { kindIcon } from '../lib/menus'

type DocumentToolbarProps = {
  kind: DiagramKind
  /** File stem when a file is loaded, otherwise the name the next save will suggest. */
  title: string
  path: string | null
  dirty: boolean
  message: string
  /** Title carried inside the file itself (e.g. Mermaid frontmatter), shown beside the file name. */
  subtitle?: string | null
  note?: string | null
  /** View mode: the file name is read-only along with the document. */
  renameDisabled?: boolean
  onRename: (name: string) => void | Promise<void>
  children: ReactNode
}

/**
 * One toolbar for both workspaces: editable title (renames the file on disk),
 * folder hint, live status, and the icon actions passed as children.
 */
export function DocumentToolbar({
  kind,
  title,
  path,
  dirty,
  message,
  subtitle,
  note,
  renameDisabled = false,
  onRename,
  children,
}: DocumentToolbarProps) {
  const folder = path ? dirName(path) : ''
  return (
    <header className="toolbar">
      <div className="toolbar-document">
        <Icon name={kindIcon(kind)} size={18} className="toolbar-kind" />
        <div className="toolbar-titles">
          <div className="toolbar-title-row">
            <EditableTitle
              value={title}
              placeholder="Untitled"
              label={`${kind === 'excalidraw' ? 'Excalidraw' : 'Mermaid'} document name`}
              className="toolbar-title"
              disabled={renameDisabled}
              onCommit={onRename}
            />
            {subtitle ? (
              <span className="toolbar-subtitle" title="Title from the diagram source" data-testid={`${kind}-subtitle`}>
                {subtitle}
              </span>
            ) : null}
            {dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null}
          </div>
          <div className="toolbar-path" title={path ?? undefined} data-testid={`${kind}-path`} data-path={path ?? ''}>
            {path ? folder : 'Not saved yet'}
          </div>
        </div>
      </div>
      <div className="status" role="status" aria-live="polite">
        {message ? (
          <span key={message} className="status-message">
            {message}
          </span>
        ) : null}
        {note ? <span className="status-note">{note}</span> : null}
      </div>
      <div className="toolbar-actions">{children}</div>
    </header>
  )
}

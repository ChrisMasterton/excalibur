import { useEffect, useRef, type MouseEvent } from 'react'
import { useContextMenu } from '../hooks/useContextMenu'
import { documentDisplayName } from '../hooks/useOpenDocuments'
import { kindIcon } from '../lib/menus'
import type { OpenDocument } from '../types'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

type DocumentTabsProps = {
  documents: OpenDocument[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseAll: () => void
}

/**
 * Horizontal strip of open documents shared by both workspaces. Middle-click closes,
 * right-click opens the close menu, and overflow scrolls sideways instead of wrapping.
 */
export function DocumentTabs({
  documents,
  activeId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
}: DocumentTabsProps) {
  const menu = useContextMenu()
  const stripRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  // Keyboard switching can land on a tab that scrolled out of the strip.
  useEffect(() => {
    const strip = stripRef.current
    const tab = activeRef.current
    if (!strip || !tab) {
      return
    }
    const stripRect = strip.getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    if (tabRect.left < stripRect.left) {
      strip.scrollLeft -= stripRect.left - tabRect.left + 8
    } else if (tabRect.right > stripRect.right) {
      strip.scrollLeft += tabRect.right - stripRect.right + 8
    }
  }, [activeId, documents])

  const openMenu = (event: MouseEvent, doc: OpenDocument) => {
    menu.open(event, [
      { label: 'Close', icon: 'x', onSelect: () => onClose(doc.id) },
      { label: 'Close others', disabled: documents.length < 2, onSelect: () => onCloseOthers(doc.id) },
      { label: 'Close all', onSelect: onCloseAll },
    ])
  }

  if (!documents.length) {
    return null
  }

  return (
    <div className="document-tabs" role="tablist" aria-label="Open documents" ref={stripRef}>
      {documents.map((doc) => {
        const name = documentDisplayName(doc)
        const active = doc.id === activeId
        return (
          <div
            key={doc.id}
            ref={active ? activeRef : undefined}
            role="presentation"
            className={`document-tab${active ? ' is-active' : ''}`}
            onContextMenu={(event) => openMenu(event, doc)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(doc.id)
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="document-tab-main"
              title={doc.path ?? 'Not saved yet'}
              onClick={() => onActivate(doc.id)}
            >
              <Icon name={kindIcon(doc.kind)} size={14} className="document-tab-icon" />
              <span className="document-tab-name">{name}</span>
              {doc.dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null}
            </button>
            <IconButton
              icon="x"
              label={`Close ${name}`}
              size="sm"
              className="document-tab-close"
              onClick={() => onClose(doc.id)}
            />
          </div>
        )
      })}
      {menu.element}
    </div>
  )
}

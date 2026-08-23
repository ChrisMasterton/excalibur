import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export type MenuItem =
  | { separator: true }
  | {
      separator?: false
      label: string
      icon?: IconName
      disabled?: boolean
      danger?: boolean
      onSelect?: () => void
      children?: MenuItem[]
    }

export type MenuPosition = { x: number; y: number }

type ContextMenuProps = {
  position: MenuPosition
  items: MenuItem[]
  onClose: () => void
}

const EDGE_PADDING = 8

function MenuList({
  items,
  onClose,
  submenu = false,
}: {
  items: MenuItem[]
  onClose: () => void
  submenu?: boolean
}) {
  return (
    <ul className={submenu ? 'context-menu-list context-submenu' : 'context-menu-list'} role="menu">
      {items.map((item, index) => {
        if (item.separator) {
          return <li key={`separator-${index}`} className="context-menu-separator" role="separator" />
        }
        const hasChildren = Boolean(item.children?.length)
        return (
          <li
            key={`${item.label}-${index}`}
            className={`context-menu-item${hasChildren ? ' has-children' : ''}${item.danger ? ' is-danger' : ''}`}
            role="none"
          >
            <button
              type="button"
              role="menuitem"
              className="context-menu-button"
              disabled={item.disabled}
              aria-haspopup={hasChildren || undefined}
              onClick={() => {
                if (hasChildren) {
                  return
                }
                item.onSelect?.()
                onClose()
              }}
            >
              {item.icon ? <Icon name={item.icon} size={15} /> : <span className="context-menu-icon-gap" />}
              <span className="context-menu-label">{item.label}</span>
              {hasChildren ? <Icon name="chevron-right" size={14} className="context-menu-caret" /> : null}
            </button>
            {hasChildren ? <MenuList items={item.children!} onClose={onClose} submenu /> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Right-click menu rendered in a portal; closes on outside click, Escape, blur, or resize. */
export function ContextMenu({ position, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState(position)
  const [flipSubmenus, setFlipSubmenus] = useState(false)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) {
      return
    }
    const rect = menu.getBoundingClientRect()
    const x = Math.max(EDGE_PADDING, Math.min(position.x, window.innerWidth - rect.width - EDGE_PADDING))
    const y = Math.max(EDGE_PADDING, Math.min(position.y, window.innerHeight - rect.height - EDGE_PADDING))
    setPlacement({ x, y })
    setFlipSubmenus(x + rect.width * 2 > window.innerWidth)
  }, [position])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className={`context-menu${flipSubmenus ? ' flip-submenus' : ''}`}
      style={{ left: placement.x, top: placement.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>,
    document.body,
  )
}

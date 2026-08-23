import { useCallback, useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuItem, type MenuPosition } from '../components/ContextMenu'

type MenuState = { position: MenuPosition; items: MenuItem[] } | null

/** Tracks which menu is open; returns a handler factory for `onContextMenu`/"more" buttons. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState>(null)

  const open = useCallback((event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault()
    event.stopPropagation()
    // "More" buttons open below the button rather than under the cursor.
    const rect = event.type === 'click' ? (event.currentTarget as HTMLElement).getBoundingClientRect() : null
    setMenu({
      position: rect ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY },
      items,
    })
  }, [])

  const close = useCallback(() => setMenu(null), [])

  const element = menu ? <ContextMenu position={menu.position} items={menu.items} onClose={close} /> : null

  return { open, close, element }
}

import { useEffect } from 'react'
import type { DiagramKind } from '../types'

type UseKeyboardShortcutsOptions = {
  workspace: DiagramKind
  activateDocument: (id: string, message?: string) => void
  closeActiveDocument: () => void
  getCycleTargetId: (step: number) => string | null
  getDocumentIdAt: (index: number) => string | null
  openSettings: () => void
  onSaveExcalidraw: () => void
  onOpenExcalidraw: () => void
  onSaveMermaid: () => void
  onOpenMermaid: () => void
}

/** App-level shortcuts. Excalidraw's own open/save are disabled in favour of ours. */
export function useKeyboardShortcuts({
  workspace,
  activateDocument,
  closeActiveDocument,
  getCycleTargetId,
  getDocumentIdAt,
  openSettings,
  onSaveExcalidraw,
  onOpenExcalidraw,
  onSaveMermaid,
  onOpenMermaid,
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'tab') {
        // Cmd+Tab belongs to the OS; only Ctrl+Tab cycles documents.
        if (!event.ctrlKey) {
          return
        }
        const targetId = getCycleTargetId(event.shiftKey ? -1 : 1)
        if (!targetId) {
          return
        }
        event.preventDefault()
        activateDocument(targetId)
        return
      }
      if (key >= '1' && key <= '9') {
        const targetId = getDocumentIdAt(Number(key) - 1)
        if (targetId) {
          event.preventDefault()
          activateDocument(targetId)
        }
        return
      }
      if (key === ',') {
        event.preventDefault()
        openSettings()
        return
      }
      if (key === 'w') {
        event.preventDefault()
        closeActiveDocument()
        return
      }
      if (key === 's') {
        event.preventDefault()
        if (workspace === 'excalidraw') {
          onSaveExcalidraw()
        } else {
          onSaveMermaid()
        }
      } else if (key === 'o') {
        event.preventDefault()
        if (workspace === 'excalidraw') {
          onOpenExcalidraw()
        } else {
          onOpenMermaid()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    activateDocument,
    closeActiveDocument,
    getCycleTargetId,
    getDocumentIdAt,
    onOpenExcalidraw,
    onOpenMermaid,
    onSaveExcalidraw,
    onSaveMermaid,
    openSettings,
    workspace,
  ])
}

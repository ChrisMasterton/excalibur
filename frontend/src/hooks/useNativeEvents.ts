import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { SidebarPanel } from '../components/Sidebar'
import { api } from '../lib/tauri'
import type { CanvasClientPosition } from '../types'

type UseNativeEventsOptions = {
  onExitFailure: () => void
  onError: (message: string) => void
  hasUnsavedDocuments: boolean
  /** False means the user chose to stay in the app. */
  confirmExit: () => boolean
  openFileFromEvent: (path: string) => void
  importNativeImagePath: (path: string, position: CanvasClientPosition | null) => Promise<boolean>
  isClientPointInCanvasFrame: (position: CanvasClientPosition) => boolean
  refreshProjects: () => Promise<void>
  setSidebarPanel: (panel: SidebarPanel) => void
}

/**
 * The window's own events: files dropped onto it, files the OS asks it to open,
 * and the quit/close requests that have to check for unsaved work first.
 */
export function useNativeEvents({
  onError,
  onExitFailure,  hasUnsavedDocuments,
  confirmExit,
  openFileFromEvent,
  importNativeImagePath,
  isClientPointInCanvasFrame,
  refreshProjects,
  setSidebarPanel,
}: UseNativeEventsOptions) {
  const isQuittingRef = useRef(false)

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedDocuments) {
        return
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedDocuments])

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (isQuittingRef.current) {
          return
        }
        if (!confirmExit()) {
          return
        }
        isQuittingRef.current = true
        try {
          await api.exitApp()
        } catch (error) {
          isQuittingRef.current = false
          onExitFailure()
          onError(String(error))
          console.error('[excalibur] close request failed to exit app', error)
        }
      })
      .then((cleanup) => {
        if (!isActive) {
          cleanup()
          return
        }
        unlisten = cleanup
      })

    return () => {
      isActive = false
      unlisten?.()
    }
  }, [confirmExit, onError, onExitFailure])

  useEffect(() => {
    let isActive = true
    let unlisten: (() => void) | null = null
    const currentWindow = getCurrentWindow()

    currentWindow
      .onDragDropEvent(async (event) => {
        if (!isActive || event.payload.type !== 'drop') {
          return
        }
        const paths = event.payload.paths

        for (const path of paths) {
          try {
            const kind = await api.pathKind(path)
            if (kind === 'directory') {
              await api.addProjectPath(path)
              await refreshProjects()
              setSidebarPanel('projects')
            } else if (kind === 'excalidraw' || kind === 'mermaid') {
              openFileFromEvent(path)
            } else if (kind === 'image') {
              const scaleFactor = await currentWindow.scaleFactor()
              const logicalPosition = event.payload.position.toLogical(scaleFactor)
              const position = { clientX: logicalPosition.x, clientY: logicalPosition.y }
              if (isClientPointInCanvasFrame(position)) await importNativeImagePath(path, position)
            }
          } catch (error) {
            onError(String(error))
          }
        }
      })
      .then((cleanup) => {
        if (!isActive) {
          cleanup()
          return
        }
        unlisten = cleanup
      })

    return () => {
      isActive = false
      unlisten?.()
    }
  }, [importNativeImagePath, isClientPointInCanvasFrame, onError, openFileFromEvent, refreshProjects, setSidebarPanel])

  useEffect(() => {
    const warning = listen<string>('persistence-warning', event => onError(event.payload))
    const unlisten = listen<string>('open-file', (event) => {
      openFileFromEvent(event.payload)
    })
    return () => {
      unlisten.then((fn) => fn())
      warning.then((fn) => fn())
    }
  }, [onError, openFileFromEvent])
}

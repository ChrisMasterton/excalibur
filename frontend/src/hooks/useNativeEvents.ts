import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { SidebarPanel } from '../components/Sidebar'
import { isDiagramPath } from '../lib/documents'
import { isSupportedImagePath } from '../lib/images'
import { extension } from '../lib/paths'
import { api } from '../lib/tauri'
import type { CanvasClientPosition, DiagramKind } from '../types'

type UseNativeEventsOptions = {
  hasUnsavedDocuments: boolean
  /** False means the user chose to stay in the app. */
  confirmExit: () => boolean
  openDiagram: (kind: DiagramKind, path: string) => void
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
  hasUnsavedDocuments,
  confirmExit,
  openDiagram,
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
  }, [confirmExit])

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

        const imagePath = paths.find(isSupportedImagePath)
        if (imagePath) {
          const scaleFactor = await currentWindow.scaleFactor().catch(() => window.devicePixelRatio || 1)
          const logicalPosition = event.payload.position.toLogical(scaleFactor)
          const position = { clientX: logicalPosition.x, clientY: logicalPosition.y }
          if (isClientPointInCanvasFrame(position)) {
            await importNativeImagePath(imagePath, position)
          }
          return
        }

        const diagramPath = paths.find((path) => isDiagramPath(path))
        if (diagramPath) {
          openDiagram(isDiagramPath(diagramPath)!, diagramPath)
          return
        }

        // Anything else without an extension is probably a folder: offer it as a project.
        const folderPath = paths.find((path) => !extension(path))
        if (folderPath) {
          try {
            await api.addProjectPath(folderPath)
            await refreshProjects()
            setSidebarPanel('projects')
          } catch (error) {
            console.warn('[excalibur] dropped path is not a project folder', error)
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
  }, [importNativeImagePath, isClientPointInCanvasFrame, openDiagram, refreshProjects, setSidebarPanel])

  useEffect(() => {
    const unlisten = listen<string>('open-file', (event) => {
      openFileFromEvent(event.payload)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [openFileFromEvent])
}

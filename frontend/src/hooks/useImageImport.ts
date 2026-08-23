import { useCallback, useRef, type DragEvent } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  SUPPORTED_IMAGE_MIME_TYPES,
  createImageFileId,
  fileToImageImportPayload,
  getFirstSupportedImageFile,
  getImageDisplaySize,
  loadImageDimensions,
  normalizeImageMimeType,
} from '../lib/images'
import { baseName } from '../lib/paths'
import { api } from '../lib/tauri'
import type { CanvasClientPosition, DiagramKind, ImageImportPayload } from '../types'

type UseImageImportOptions = {
  excalidrawApi: ExcalidrawImperativeAPI | null
  setWorkspace: (kind: DiagramKind) => void
  setMessage: (message: string) => void
}

export type ImageImportApi = ReturnType<typeof useImageImport>

/** Dropping images (from the browser or from the OS) onto the Excalidraw canvas. */
export function useImageImport({ excalidrawApi, setWorkspace, setMessage }: UseImageImportOptions) {
  const canvasFrameRef = useRef<HTMLDivElement | null>(null)

  const isClientPointInCanvasFrame = useCallback((position: CanvasClientPosition) => {
    const frame = canvasFrameRef.current
    if (!frame) {
      return false
    }
    const rect = frame.getBoundingClientRect()
    return (
      position.clientX >= rect.left &&
      position.clientX <= rect.right &&
      position.clientY >= rect.top &&
      position.clientY <= rect.bottom
    )
  }, [])

  const importImagePayloadToCanvas = useCallback(
    async (payload: ImageImportPayload, position: CanvasClientPosition | null) => {
      if (!excalidrawApi) {
        setMessage('Canvas is still starting up. Try dropping the image again.')
        return false
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMimeType(payload.mimeType))) {
        setMessage('Drop a PNG, JPEG, or WebP image to import it.')
        return false
      }

      const appState = excalidrawApi.getAppState()
      const scenePosition = viewportCoordsToSceneCoords(
        position ?? {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        appState,
      )
      const imageDimensions = await loadImageDimensions(payload.dataUrl)
      const displaySize = getImageDisplaySize(imageDimensions.width, imageDimensions.height, appState)
      const fileId = createImageFileId()
      const [imageElement] = convertToExcalidrawElements(
        [
          {
            type: 'image',
            x: scenePosition.x - displaySize.width / 2,
            y: scenePosition.y - displaySize.height / 2,
            width: displaySize.width,
            height: displaySize.height,
            fileId,
            status: 'saved',
            scale: [1, 1],
          },
        ],
        { regenerateIds: true },
      )
      if (!imageElement) {
        setMessage('Unable to import image.')
        return false
      }

      excalidrawApi.updateScene({
        elements: [...excalidrawApi.getSceneElementsIncludingDeleted(), imageElement],
        appState: { selectedElementIds: { [imageElement.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      })
      excalidrawApi.addFiles([
        {
          id: fileId,
          mimeType: normalizeImageMimeType(payload.mimeType) as BinaryFileData['mimeType'],
          dataURL: payload.dataUrl as BinaryFileData['dataURL'],
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ])
      setWorkspace('excalidraw')
      setMessage(`Imported ${payload.sourcePath ? baseName(payload.sourcePath) : payload.name}.`)
      return true
    },
    [excalidrawApi, setMessage, setWorkspace],
  )

  const importNativeImagePath = useCallback(
    async (path: string, position: CanvasClientPosition | null) => {
      try {
        const response = await api.loadImageFile(path)
        return await importImagePayloadToCanvas(
          {
            name: response.name ?? baseName(response.path),
            mimeType: response.mime_type,
            dataUrl: response.data_url,
            sourcePath: response.path,
          },
          position,
        )
      } catch (error) {
        console.error('[excalibur] load_image_file failed', error)
        setMessage('Drop a PNG, JPEG, or WebP image to import it.')
        return false
      }
    },
    [importImagePayloadToCanvas, setMessage],
  )

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!getFirstSupportedImageFile(event.dataTransfer.files)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      const file = getFirstSupportedImageFile(event.dataTransfer.files)
      if (!file) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const position = { clientX: event.clientX, clientY: event.clientY }
      try {
        await importImagePayloadToCanvas(await fileToImageImportPayload(file), position)
      } catch (error) {
        console.error('[excalibur] image drop failed', error)
        setMessage('Drop a PNG, JPEG, or WebP image to import it.')
      }
    },
    [importImagePayloadToCanvas, setMessage],
  )

  return {
    canvasFrameRef,
    isClientPointInCanvasFrame,
    importNativeImagePath,
    handleDragOver,
    handleDrop,
  }
}

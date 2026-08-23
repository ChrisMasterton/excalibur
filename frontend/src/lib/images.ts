import type { AppState, BinaryFileData } from '@excalidraw/excalidraw/types'
import type { ImageImportPayload } from '../types'

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const IMAGE_IMPORT_MIME_BY_EXTENSION: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function normalizeImageMimeType(mimeType: string) {
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
}

function getImageExtension(name: string) {
  const extension = name.split('.').pop()
  return extension ? extension.toLowerCase() : ''
}

export function getSupportedImageMimeTypeFromName(name: string) {
  return IMAGE_IMPORT_MIME_BY_EXTENSION[getImageExtension(name)] ?? null
}

export function getSupportedImageMimeTypeForFile(file: File) {
  const normalizedType = normalizeImageMimeType(file.type)
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalizedType)) {
    return normalizedType
  }
  return getSupportedImageMimeTypeFromName(file.name)
}

export function isSupportedImagePath(path: string) {
  return getSupportedImageMimeTypeFromName(path) !== null
}

export function getFirstSupportedImageFile(files: FileList | File[]) {
  return Array.from(files).find((file) => getSupportedImageMimeTypeForFile(file)) ?? null
}

function byteArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return window.btoa(binary)
}

export async function fileToImageImportPayload(file: File): Promise<ImageImportPayload> {
  const mimeType = getSupportedImageMimeTypeForFile(file)
  if (!mimeType) {
    throw new Error('Unsupported image type.')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    name: file.name || 'image',
    mimeType,
    dataUrl: `data:${mimeType};base64,${byteArrayToBase64(bytes)}`,
  }
}

export function loadImageDimensions(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      })
    }
    image.onerror = () => reject(new Error('Unable to read image dimensions.'))
    image.src = dataUrl
  })
}

export function getImageDisplaySize(width: number, height: number, appState: AppState) {
  if (width <= 0 || height <= 0) {
    return { width: 240, height: 180 }
  }

  const zoom = appState.zoom.value || 1
  const maxHeight = Math.max(160, Math.min(appState.height - 120, appState.height * 0.5) / zoom)
  const maxWidth = Math.max(160, (appState.width * 0.7) / zoom)
  const scale = Math.min(1, maxWidth / width, maxHeight / height)

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function createImageFileId() {
  const id = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return id as BinaryFileData['id']
}

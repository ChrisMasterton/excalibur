import type { ExcalidrawAutosave } from '../types'

export const EXCALIDRAW_AUTOSAVE_KEY = 'excalibur.excalidraw.autosave.current'
export const EXCALIDRAW_RECOVERY_KEY = 'excalibur.excalidraw.autosave.recovery'

export function readStoredExcalidrawAutosave(storageKey: string): ExcalidrawAutosave | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as ExcalidrawAutosave
  } catch {
    window.localStorage.removeItem(storageKey)
    return null
  }
}

export function writeStoredExcalidrawAutosave(storageKey: string, autosave: ExcalidrawAutosave) {
  window.localStorage.setItem(storageKey, JSON.stringify(autosave))
}

export function clearStoredExcalidrawAutosave(storageKey: string) {
  window.localStorage.removeItem(storageKey)
}

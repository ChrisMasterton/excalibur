import { invoke } from '@tauri-apps/api/core'
import type {
  DiagramKind,
  LoadImageFileResponse,
  OpenFileResponse,
  ProjectFile,
  ProjectItem,
  RecentItem,
  SaveFileResponse,
} from '../types'

export type SaveFileRequest = {
  path: string | null
  name?: string
  directory?: string | null
  contents: string
}

export type SavePngFileRequest = {
  /** Suggested file name; the backend appends `.png` when it is missing. */
  name?: string
  contents: Uint8Array
}

/** Typed wrappers around the Tauri commands exposed by src-tauri/src/main.rs. */
export const api = {
  listRecents: () => invoke<RecentItem[]>('list_recents'),
  removeRecent: (kind: DiagramKind, path: string) =>
    invoke<RecentItem[]>('remove_recent', { kind, path }),

  listProjects: () => invoke<ProjectItem[]>('list_projects'),
  addProjectFolder: () => invoke<ProjectItem | null>('add_project_folder'),
  addProjectPath: (path: string) => invoke<ProjectItem>('add_project_path', { path }),
  removeProject: (path: string) => invoke<ProjectItem[]>('remove_project', { path }),
  renameProject: (path: string, name: string) =>
    invoke<ProjectItem>('rename_project', { path, name }),
  listProjectFiles: (path: string) => invoke<ProjectFile[]>('list_project_files', { path }),
  moveFileToProject: (path: string, projectPath: string) =>
    invoke<string>('move_file_to_project', { path, projectPath }),
  renameFile: (path: string, name: string) => invoke<string>('rename_file', { path, name }),

  openExcalidrawFile: () => invoke<OpenFileResponse | null>('open_excalidraw_file'),
  /** `trackRecent: false` loads without pushing the file into the Recent list. */
  loadExcalidrawPath: (path: string, trackRecent = true) =>
    invoke<OpenFileResponse>('load_excalidraw_path', { path, trackRecent }),
  saveExcalidrawFile: (request: SaveFileRequest) =>
    invoke<SaveFileResponse>('save_excalidraw_file', { request }),
  loadImageFile: (path: string) => invoke<LoadImageFileResponse>('load_image_file', { path }),

  openMermaidFile: () => invoke<OpenFileResponse | null>('open_mermaid_file'),
  loadMermaidPath: (path: string, trackRecent = true) =>
    invoke<OpenFileResponse>('load_mermaid_path', { path, trackRecent }),
  saveMermaidFile: (request: SaveFileRequest) =>
    invoke<SaveFileResponse>('save_mermaid_file', { request }),
  /** Opens a save dialog and writes PNG bytes; serde wants a plain number array. */
  savePngFile: (request: SavePngFileRequest) =>
    invoke<SaveFileResponse>('save_png_file', {
      request: { name: request.name, contents: Array.from(request.contents) },
    }),

  loadSettings: () => invoke<unknown>('load_settings'),
  saveSettings: (settings: Record<string, unknown>) => invoke<void>('save_settings', { settings }),

  takePendingFile: () => invoke<string | null>('take_pending_file'),
  exitApp: () => invoke('exit_app'),
}

export function errorMessage(error: unknown, fallback: string) {
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

import type { BinaryFileData } from '@excalidraw/excalidraw/types'

export type DiagramKind = 'excalidraw' | 'mermaid'

export type RecentItem = {
  kind: DiagramKind
  path: string
  name?: string | null
  updated_at: number
  /** Display title read from the file (Mermaid frontmatter `title:`). */
  title?: string | null
}

/** One open tab. Editor state lives in the caches held by `useOpenDocuments`. */
export type OpenDocument = {
  id: string
  kind: DiagramKind
  /** null until the document has been saved to disk. */
  path: string | null
  /** File stem, or the name the next save will suggest. */
  name: string
  /** Display title carried inside the file (Mermaid frontmatter `title:`). */
  title?: string | null
  dirty: boolean
}

export type ProjectItem = {
  path: string
  name: string
  added_at: number
}

export type ProjectFile = {
  kind: DiagramKind
  path: string
  name: string
  relative_path: string
  updated_at: number
  title?: string | null
}

export type OpenFileResponse = {
  path: string
  name?: string | null
  contents: string
}

export type SaveFileResponse = {
  path: string
}

export type LoadImageFileResponse = {
  path: string
  name?: string | null
  mime_type: string
  data_url: string
}

export type ExcalidrawData = {
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, BinaryFileData>
}

export type ExcalidrawAutosave = {
  contents: string
  path: string | null
  name: string
  updatedAt: number
}

export type ExcalidrawSceneSnapshot = {
  contents: string
  hasContent: boolean
}

export type ImageImportPayload = {
  name: string
  mimeType: string
  dataUrl: string
  sourcePath?: string | null
}

export type CanvasClientPosition = {
  clientX: number
  clientY: number
}

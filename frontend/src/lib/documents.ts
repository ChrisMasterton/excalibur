import type { NewDocumentInput } from '../hooks/useOpenDocuments'
import type { DiagramKind, ExcalidrawData, ExcalidrawSceneSnapshot, OpenFileResponse } from '../types'
import { parseMermaidDiagramType } from './mermaidDiagramType'
import { parseMermaidTitle } from './mermaidTitle'
import { extension, fileStem } from './paths'

/** A blank scene, used when a tab reaches the canvas without any contents of its own. */
export const EMPTY_EXCALIDRAW_CONTENTS = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'local',
  elements: [],
  appState: {},
  files: {},
})

export function getUnsavedChangesMessage(documentName: string, action: string) {
  return `You have unsaved ${documentName} changes. Save them before you ${action}. Select OK to continue without saving, or Cancel to go back.`
}

export function getExitUnsavedChangesMessage(hasExcalidrawChanges: boolean, hasMermaidChanges: boolean) {
  if (hasExcalidrawChanges && hasMermaidChanges) {
    return 'You have unsaved changes in Excalidraw and Mermaid. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  if (hasExcalidrawChanges) {
    return 'You have unsaved Excalidraw changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
  }
  return 'You have unsaved Mermaid changes. Save them before you exit. Select OK to exit without saving, or Cancel to go back.'
}

export function isDiagramPath(path: string): DiagramKind | null {
  const ext = extension(path)
  if (ext === 'excalidraw') return 'excalidraw'
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid'
  return null
}

export function kindLabel(kind: DiagramKind) {
  return kind === 'excalidraw' ? 'Excalidraw' : 'Mermaid'
}

/** Cheap scene summary for a tab that has not been put on the canvas yet. */
export function excalidrawSnapshotFromContents(contents: string): ExcalidrawSceneSnapshot {
  const raw = parseExcalidrawContents(contents)
  return { contents, hasContent: raw.elements.some(element => !(element as { isDeleted?: boolean }).isDeleted) }

}

export function parseExcalidrawContents(contents: string): ExcalidrawData {
  let parsed
  try { parsed = JSON.parse(contents) } catch { throw new Error('Invalid .excalidraw file: unable to parse JSON.') }
  const raw = parsed?.data ?? parsed
  if (!raw || !Array.isArray(raw.elements) || raw.elements.some((element: unknown) =>
    !element || typeof element !== 'object' || typeof (element as { type?: unknown }).type !== 'string'
  )) throw new Error('Invalid .excalidraw file: expected a scene with an elements array.')
  return raw as ExcalidrawData
}

/**
 * Tab contents for a file that was just read from disk. Existing files are for
 * reading first, so they open in view mode whichever route brought them in.
 */
export function documentInputForFile(kind: DiagramKind, file: OpenFileResponse): NewDocumentInput {
  if (kind === 'excalidraw') {
    const snapshot = excalidrawSnapshotFromContents(file.contents)
    return {
      kind,
      path: file.path,
      name: file.name ? fileStem(file.name) : fileStem(file.path),
      displayName: file.display_name,
      mode: 'view',
      excalidraw: { scene: snapshot, persistedScene: snapshot, saveDirectory: null, viewport: null },
    }
  }
  return {
    kind,
    path: file.path,
    name: fileStem(file.path),
    displayName: file.display_name,
    title: parseMermaidTitle(file.contents),
    diagramType: parseMermaidDiagramType(file.contents),
    mode: 'view',
    mermaid: {
      history: { text: file.contents, past: [], future: [] },
      persistedText: file.contents,
      viewport: null,
    },
  }
}

import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useRef, type ComponentProps, type DragEvent, type PointerEvent, type RefObject } from 'react'
import { isClickWithoutDrag } from '../lib/pointer'
import type { DocumentMode } from '../types'
import { DocumentToolbar } from './DocumentToolbar'
import { IconButton } from './IconButton'
import { ModeToggle } from './ModeToggle'

export type ExcalidrawChangeHandler = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>

type ExcalidrawWorkspaceProps = {
  hidden: boolean
  title: string
  path: string | null
  dirty: boolean
  message: string
  hasRecovery: boolean
  mode: DocumentMode
  saveFeedback: boolean
  isRefitting: boolean
  apiReady: boolean
  canvasFrameRef: RefObject<HTMLDivElement | null>
  onRename: (name: string) => Promise<void>
  onToggleMode: () => void
  /** A click (not a pan) on the canvas while viewing, for the references lookup. */
  onCanvasClick: (clientX: number, clientY: number) => void
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onExportPng: () => void
  onFitToWindow: () => void
  onRefitText: () => void
  onRecover: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onApi: (api: ExcalidrawImperativeAPI | null) => void
  onChange: ExcalidrawChangeHandler
}

// Our own toolbar handles open/save so the canvas stays a pure editor.
const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
  },
} as const

export function ExcalidrawWorkspace({
  hidden,
  title,
  path,
  dirty,
  message,
  hasRecovery,
  mode,
  saveFeedback,
  isRefitting,
  apiReady,
  canvasFrameRef,
  onRename,
  onToggleMode,
  onCanvasClick,
  onNew,
  onOpen,
  onSave,
  onExportPng,
  onFitToWindow,
  onRefitText,
  onRecover,
  onDragOver,
  onDrop,
  onApi,
  onChange,
}: ExcalidrawWorkspaceProps) {
  const isViewing = mode === 'view'
  const pressRef = useRef<{ clientX: number; clientY: number } | null>(null)

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressRef.current = event.button === 0 ? { clientX: event.clientX, clientY: event.clientY } : null
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    pressRef.current = null
    // Panning the canvas must not be mistaken for asking about a symbol.
    if (isViewing && press && isClickWithoutDrag(press, event)) {
      onCanvasClick(event.clientX, event.clientY)
    }
  }

  return (
    <section className="workspace-panel" hidden={hidden} aria-label="Excalidraw editor">
      <DocumentToolbar
        kind="excalidraw"
        title={title}
        path={path}
        dirty={dirty}
        message={message}
        note={hasRecovery ? 'Autosave backup available.' : null}
        renameDisabled={isViewing}
        onRename={onRename}
      >
        <ModeToggle mode={mode} onToggle={onToggleMode} />
        <span className="toolbar-divider" />
        {isViewing ? null : (
          <IconButton icon="file-plus" label="New drawing" onClick={onNew} disabled={!apiReady} />
        )}
        <IconButton icon="folder-open" label="Open drawing" onClick={onOpen} />
        {isViewing ? null : (
          <IconButton
            icon="save"
            label="Save"
            primary
            feedback={saveFeedback}
            onClick={onSave}
            disabled={!apiReady}
          />
        )}
        <span className="toolbar-divider" />
        <IconButton icon="fit" label="Fit to window" onClick={onFitToWindow} disabled={!apiReady} />
        {isViewing ? null : (
          <IconButton
            icon="text-refit"
            label="Refit text to containers"
            onClick={onRefitText}
            busy={isRefitting}
            disabled={!apiReady}
          />
        )}
        <IconButton icon="image" label="Export PNG" onClick={onExportPng} disabled={!apiReady} />
        {hasRecovery ? (
          <IconButton icon="history" label="Recover backup" className="recover" onClick={onRecover} />
        ) : null}
      </DocumentToolbar>
      <div
        ref={canvasFrameRef}
        className="canvas-frame"
        onDragOverCapture={onDragOver}
        onDropCapture={onDrop}
        onPointerDownCapture={handlePointerDown}
        onPointerUpCapture={handlePointerUp}
      >
        <Excalidraw
          excalidrawAPI={onApi}
          onChange={onChange}
          UIOptions={UI_OPTIONS}
          viewModeEnabled={isViewing}
          // Left undefined while editing so the user's own zen toggle still works.
          zenModeEnabled={isViewing ? true : undefined}
        />
      </div>
    </section>
  )
}

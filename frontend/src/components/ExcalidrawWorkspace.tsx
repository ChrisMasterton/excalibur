import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ComponentProps, DragEvent, RefObject } from 'react'
import { DocumentToolbar } from './DocumentToolbar'
import { IconButton } from './IconButton'

type ExcalidrawChangeHandler = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>

type ExcalidrawWorkspaceProps = {
  hidden: boolean
  title: string
  path: string | null
  dirty: boolean
  message: string
  hasRecovery: boolean
  saveFeedback: boolean
  isRefitting: boolean
  apiReady: boolean
  canvasFrameRef: RefObject<HTMLDivElement | null>
  onRename: (name: string) => Promise<void>
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
  saveFeedback,
  isRefitting,
  apiReady,
  canvasFrameRef,
  onRename,
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
  return (
    <section className="workspace-panel" hidden={hidden} aria-label="Excalidraw editor">
      <DocumentToolbar
        kind="excalidraw"
        title={title}
        path={path}
        dirty={dirty}
        message={message}
        note={hasRecovery ? 'Autosave backup available.' : null}
        onRename={onRename}
      >
        <IconButton icon="file-plus" label="New drawing" onClick={onNew} disabled={!apiReady} />
        <IconButton icon="folder-open" label="Open drawing" onClick={onOpen} />
        <IconButton
          icon="save"
          label="Save"
          primary
          feedback={saveFeedback}
          onClick={onSave}
          disabled={!apiReady}
        />
        <span className="toolbar-divider" />
        <IconButton icon="fit" label="Fit to window" onClick={onFitToWindow} disabled={!apiReady} />
        <IconButton
          icon="text-refit"
          label="Refit text to containers"
          onClick={onRefitText}
          busy={isRefitting}
          disabled={!apiReady}
        />
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
      >
        <Excalidraw excalidrawAPI={onApi} onChange={onChange} UIOptions={UI_OPTIONS} />
      </div>
    </section>
  )
}

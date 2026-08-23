import type { KeyboardEvent, RefObject } from 'react'
import type { PinnedDiagram } from '../lib/mermaidSvg'
import type { Settings } from '../lib/settings'
import { DocumentToolbar } from './DocumentToolbar'
import { IconButton } from './IconButton'
import { ZoomPanViewport, type ZoomPanHandle } from './ZoomPanViewport'

type MermaidWorkspaceProps = {
  hidden: boolean
  title: string
  path: string | null
  dirty: boolean
  message: string
  /** `title:` from the source's frontmatter, if any. */
  subtitle: string | null
  settings: Pick<Settings, 'previewZoomSpeed' | 'previewWheelAction' | 'previewFitUpscale' | 'mermaidEditorFontSize'>
  saveFeedback: boolean
  isConverting: boolean
  editorCollapsed: boolean
  text: string
  /** The rendered preview SVG, pinned to its natural size by `useMermaidDocument`. */
  diagram: PinnedDiagram
  error: string
  /** Wraps the rendered SVG so the highlight pass can query it. */
  previewRef: RefObject<HTMLDivElement | null>
  viewportRef: RefObject<ZoomPanHandle | null>
  onRename: (name: string) => Promise<void>
  onOpen: () => void
  onSave: () => void
  onConvert: () => void
  onExportPng: () => void
  onPreviewPointerDown: () => void
  onToggleEditor: () => void
  onTextChange: (text: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

export function MermaidWorkspace({
  hidden,
  title,
  path,
  dirty,
  message,
  subtitle,
  settings,
  saveFeedback,
  isConverting,
  editorCollapsed,
  text,
  diagram,
  error,
  previewRef,
  viewportRef,
  onRename,
  onOpen,
  onSave,
  onConvert,
  onExportPng,
  onPreviewPointerDown,
  onToggleEditor,
  onTextChange,
  onKeyDown,
}: MermaidWorkspaceProps) {
  // Re-fit only when the diagram's footprint changes, so typing doesn't reset the zoom.
  const contentKey = `${Math.round(diagram.width)}x${Math.round(diagram.height)}`

  return (
    <section className="workspace-panel" hidden={hidden} aria-label="Mermaid editor">
      <DocumentToolbar
        kind="mermaid"
        title={title}
        path={path}
        dirty={dirty}
        message={message}
        subtitle={subtitle}
        onRename={onRename}
      >
        <IconButton
          icon="code"
          label={editorCollapsed ? 'Show code' : 'Hide code'}
          active={!editorCollapsed}
          onClick={onToggleEditor}
        />
        <IconButton
          icon="fit"
          label="Fit to window"
          onClick={() => viewportRef.current?.fit()}
          disabled={!diagram.markup || Boolean(error)}
        />
        <span className="toolbar-divider" />
        <IconButton icon="folder-open" label="Open Mermaid file" onClick={onOpen} />
        <IconButton icon="save" label="Save" primary feedback={saveFeedback} onClick={onSave} />
        <IconButton
          icon="image"
          label="Export PNG"
          onClick={onExportPng}
          disabled={!diagram.markup || Boolean(error)}
        />
        <span className="toolbar-divider" />
        <IconButton
          icon="convert"
          label={isConverting ? 'Converting…' : 'Convert to Excalidraw'}
          showLabel
          busy={isConverting}
          onClick={onConvert}
        />
      </DocumentToolbar>
      <div className={`mermaid-grid${editorCollapsed ? ' editor-collapsed' : ''}`}>
        <div className="mermaid-editor" hidden={editorCollapsed}>
          <textarea
            style={{ fontSize: settings.mermaidEditorFontSize }}
            aria-label="Mermaid source"
            value={text}
            spellCheck={false}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="mermaid-preview" onPointerDownCapture={onPreviewPointerDown}>
          {error ? <div className="error">{error}</div> : null}
          <ZoomPanViewport
            ref={viewportRef}
            contentKey={contentKey}
            className="mermaid-viewport"
            zoomSpeed={settings.previewZoomSpeed}
            wheelAction={settings.previewWheelAction}
            maxFitScale={settings.previewFitUpscale ? 2 : 1}
          >
            <div ref={previewRef} className="diagram" dangerouslySetInnerHTML={{ __html: diagram.markup }} />
          </ZoomPanViewport>
        </div>
      </div>
    </section>
  )
}

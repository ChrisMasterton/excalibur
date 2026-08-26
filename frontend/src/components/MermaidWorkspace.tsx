import { memo, type KeyboardEvent, type RefObject } from 'react'
import type { PinnedDiagram } from '../lib/mermaidSvg'
import type { Settings } from '../lib/settings'
import type { DocumentMode } from '../types'
import { DocumentToolbar } from './DocumentToolbar'
import { IconButton } from './IconButton'
import { ModeToggle } from './ModeToggle'
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
  mode: DocumentMode
  /** Already resolved: view mode forces the code pane shut without losing the preference. */
  editorCollapsed: boolean
  /** Normalized Mermaid diagram type, tracked live from the source. */
  diagramType: string | null
  text: string
  /** The rendered preview SVG, pinned to its natural size by `useMermaidDocument`. */
  diagram: PinnedDiagram
  error: string
  /** Wraps the rendered SVG so the highlight pass can query it. */
  previewRef: RefObject<HTMLDivElement | null>
  viewportRef: RefObject<ZoomPanHandle | null>
  onRename: (name: string) => Promise<void>
  onToggleMode: () => void
  /** A click (not a pan) on a rendered node, for the references lookup. */
  onNodeClick: (target: Element) => void
  onOpen: () => void
  onSave: () => void
  onConvert: () => void
  onExportPng: () => void
  onPreviewPointerDown: () => void
  onToggleEditor: () => void
  onTextChange: (text: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * The rendered diagram itself, kept out of its parent's render pass.
 *
 * React re-applies `dangerouslySetInnerHTML` whenever the owning component
 * re-renders, which would wipe the symbol marks the highlight pass writes onto
 * these nodes. Memoising on the markup means an unrelated re-render leaves the
 * marked SVG exactly as it is.
 */
const MermaidDiagram = memo(function MermaidDiagram({
  markup,
  previewRef,
}: {
  markup: string
  previewRef: RefObject<HTMLDivElement | null>
}) {
  return <div ref={previewRef} className="diagram" dangerouslySetInnerHTML={{ __html: markup }} />
})

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
  mode,
  editorCollapsed,
  diagramType,
  text,
  diagram,
  error,
  previewRef,
  viewportRef,
  onRename,
  onToggleMode,
  onNodeClick,
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
  const isViewing = mode === 'view'

  return (
    <section className="workspace-panel" hidden={hidden} aria-label="Mermaid editor">
      <DocumentToolbar
        kind="mermaid"
        diagramType={diagramType}
        title={title}
        path={path}
        dirty={dirty}
        message={message}
        subtitle={subtitle}
        renameDisabled={isViewing}
        onRename={onRename}
      >
        <ModeToggle mode={mode} onToggle={onToggleMode} />
        <span className="toolbar-divider" />
        {isViewing ? null : (
          <IconButton
            icon="code"
            label={editorCollapsed ? 'Show code' : 'Hide code'}
            active={!editorCollapsed}
            onClick={onToggleEditor}
          />
        )}
        <IconButton
          icon="fit"
          label="Fit to window"
          onClick={() => viewportRef.current?.fit()}
          disabled={!diagram.markup || Boolean(error)}
        />
        <span className="toolbar-divider" />
        <IconButton icon="folder-open" label="Open Mermaid file" onClick={onOpen} />
        {isViewing ? null : (
          <IconButton icon="save" label="Save" primary feedback={saveFeedback} onClick={onSave} />
        )}
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
            onContentClick={onNodeClick}
          >
            <MermaidDiagram markup={diagram.markup} previewRef={previewRef} />
          </ZoomPanViewport>
        </div>
      </div>
    </section>
  )
}

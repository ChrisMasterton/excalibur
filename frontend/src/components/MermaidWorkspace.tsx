import { useMemo, useRef, type KeyboardEvent } from 'react'
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
  svg: string
  error: string
  onRename: (name: string) => Promise<void>
  onOpen: () => void
  onSave: () => void
  onConvert: () => void
  onToggleEditor: () => void
  onTextChange: (text: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * Mermaid emits `width="100%"` plus a `max-width` style, which fights a
 * zoomable viewport. Pin the SVG to its natural viewBox size instead.
 */
function pinSvgToNaturalSize(svg: string) {
  if (!svg || typeof DOMParser === 'undefined') {
    return { markup: svg, width: 0, height: 0 }
  }
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = document.documentElement
  if (!root || root.nodeName !== 'svg') {
    return { markup: svg, width: 0, height: 0 }
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : Number(root.getAttribute('width')) || 0
  const height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : Number(root.getAttribute('height')) || 0
  if (width && height) {
    root.setAttribute('width', String(Math.ceil(width)))
    root.setAttribute('height', String(Math.ceil(height)))
    root.style.maxWidth = 'none'
  }
  return { markup: new XMLSerializer().serializeToString(root), width, height }
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
  svg,
  error,
  onRename,
  onOpen,
  onSave,
  onConvert,
  onToggleEditor,
  onTextChange,
  onKeyDown,
}: MermaidWorkspaceProps) {
  const viewportRef = useRef<ZoomPanHandle | null>(null)
  const diagram = useMemo(() => pinSvgToNaturalSize(svg), [svg])
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
          disabled={!svg || Boolean(error)}
        />
        <span className="toolbar-divider" />
        <IconButton icon="folder-open" label="Open Mermaid file" onClick={onOpen} />
        <IconButton icon="save" label="Save" primary feedback={saveFeedback} onClick={onSave} />
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
        <div className="mermaid-preview">
          {error ? <div className="error">{error}</div> : null}
          <ZoomPanViewport
            ref={viewportRef}
            contentKey={contentKey}
            className="mermaid-viewport"
            zoomSpeed={settings.previewZoomSpeed}
            wheelAction={settings.previewWheelAction}
            maxFitScale={settings.previewFitUpscale ? 2 : 1}
          >
            <div className="diagram" dangerouslySetInnerHTML={{ __html: diagram.markup }} />
          </ZoomPanViewport>
        </div>
      </div>
    </section>
  )
}

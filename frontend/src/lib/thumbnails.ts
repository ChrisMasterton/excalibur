/**
 * Board thumbnails: one small SVG per document that mentions the active symbol,
 * with that symbol's matches marked on it.
 *
 * Both kinds come out as SVG markup meant to be inlined into the card's DOM, so
 * they stay crisp at any card size. The marks are written onto the markup as
 * presentation attributes rather than left to the app stylesheet: a thumbnail
 * has to carry its own highlight (the `.diagram` rules do not reach it), and
 * inline `<style>` inside an inlined SVG would leak into the whole page.
 *
 * Mermaid re-renders the source and reuses `findSymbolElements`, the same node
 * lookup the live preview highlights with. Excalidraw cannot highlight anything
 * during export, so the matched elements' bounds are drawn over the export using
 * its own coordinate mapping (scene coordinate + `-min + exportPadding`).
 */

import { exportToSvg, getCommonBounds, restore } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import mermaid from 'mermaid'
import { findSymbolElements, SYMBOL_HIGHLIGHT_CLASS } from './mermaidHighlight'
import { pinSvgToNaturalSize } from './mermaidSvg'
import { initializeMermaid } from './mermaidSymbols'
import type { SymbolLocator } from './symbols'

/** The amber the app marks matches with (`--highlight-stroke` / `--highlight-glow` in App.css). */
export const HIGHLIGHT_STROKE = '#b97b0e'
export const HIGHLIGHT_GLOW = 'rgba(247, 195, 111, 0.75)'
/** Fill for the Excalidraw overlay: the same amber, faint enough to read through. */
const HIGHLIGHT_FILL = 'rgba(247, 195, 111, 0.28)'

/** Excalidraw's own default, passed explicitly so the coordinate mapping is not a guess. */
const EXPORT_PADDING = 10
/** Breathing room around a matched element, in scene units. */
const OVERLAY_INSET = 6
const OVERLAY_RADIUS = 8

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** One rendered thumbnail, ready to be inlined into a card. */
export type SymbolThumbnail = {
  markup: string
  width: number
  height: number
  /** How many matches were marked; 0 means the symbol could not be located in the render. */
  marked: number
}

const SHAPE_SELECTOR = 'rect, circle, ellipse, polygon, path, line'
const TEXT_SELECTOR = 'text, tspan'

function appendStyle(element: Element, declarations: string) {
  const existing = element.getAttribute('style')
  element.setAttribute('style', existing ? `${existing};${declarations}` : declarations)
}

/** Writes the highlight look onto the nodes a symbol occupies, mirroring the app's CSS. */
function markSymbolElements(targets: readonly Element[]) {
  for (const target of targets) {
    target.classList.add(SYMBOL_HIGHLIGHT_CLASS)
    appendStyle(target, `filter:drop-shadow(0 0 4px ${HIGHLIGHT_GLOW})`)
    const shapes = [
      ...(target.matches(SHAPE_SELECTOR) ? [target] : []),
      ...target.querySelectorAll(SHAPE_SELECTOR),
    ]
    for (const shape of shapes) {
      appendStyle(shape, `stroke:${HIGHLIGHT_STROKE};stroke-width:2px`)
    }
    const labels = [
      ...(target.matches(TEXT_SELECTOR) ? [target] : []),
      ...target.querySelectorAll(TEXT_SELECTOR),
    ]
    for (const label of labels) {
      appendStyle(label, `fill:${HIGHLIGHT_STROKE};font-weight:700`)
    }
  }
}

let thumbnailSerial = 0

/**
 * Renders Mermaid source off-DOM, pins it to its natural size, and marks the
 * nodes the locators point at. Null when the source will not render.
 */
export async function renderMermaidThumbnail(
  source: string,
  locators: readonly SymbolLocator[],
  display: string,
): Promise<SymbolThumbnail | null> {
  const text = source.replace(/^\uFEFF/, '').trim()
  if (!text) {
    return null
  }
  initializeMermaid()
  let rendered: string
  try {
    thumbnailSerial += 1
    const result = await mermaid.render(`board-${thumbnailSerial}-${Date.now()}`, text)
    rendered = result.svg
  } catch {
    return null
  }

  const pinned = pinSvgToNaturalSize(rendered)
  const parsed = new DOMParser().parseFromString(pinned.markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.nodeName !== 'svg') {
    return null
  }
  const targets = findSymbolElements(root, locators, display)
  markSymbolElements(targets)
  return {
    markup: new XMLSerializer().serializeToString(root),
    width: pinned.width,
    height: pinned.height,
    marked: targets.length,
  }
}

type ExcalidrawSceneFile = {
  elements?: unknown
  appState?: unknown
  files?: unknown
}

type ParsedScene = {
  /** Non-deleted elements: what renders, and what the export is sized to. */
  elements: ExcalidrawElement[]
  files: BinaryFiles
  background: string | undefined
}

function parseScene(contents: string): ParsedScene | null {
  let parsed: ExcalidrawSceneFile
  try {
    parsed = JSON.parse(contents) as ExcalidrawSceneFile
  } catch {
    return null
  }
  if (!Array.isArray(parsed.elements)) {
    return null
  }
  const appState = (parsed.appState ?? {}) as Partial<AppState>
  const restored = restore(
    {
      elements: parsed.elements as unknown as ExcalidrawElement[],
      appState,
      files: (parsed.files ?? {}) as BinaryFiles,
    },
    null,
    null,
  )
  return {
    elements: restored.elements.filter((element) => !element.isDeleted),
    files: restored.files,
    background: typeof appState.viewBackgroundColor === 'string' ? appState.viewBackgroundColor : undefined,
  }
}

/** An amber box over one matched element, in the export's own coordinate space. */
function overlayRect(document_: Document, x: number, y: number, width: number, height: number) {
  const rect = document_.createElementNS(SVG_NAMESPACE, 'rect')
  rect.setAttribute('class', SYMBOL_HIGHLIGHT_CLASS)
  rect.setAttribute('x', String(x))
  rect.setAttribute('y', String(y))
  rect.setAttribute('width', String(width))
  rect.setAttribute('height', String(height))
  rect.setAttribute('rx', String(OVERLAY_RADIUS))
  rect.setAttribute('ry', String(OVERLAY_RADIUS))
  rect.setAttribute('fill', HIGHLIGHT_FILL)
  rect.setAttribute('stroke', HIGHLIGHT_STROKE)
  rect.setAttribute('stroke-width', '2')
  return rect
}

/**
 * Exports a drawing and draws the matched elements' bounding boxes over it.
 *
 * `exportToSvg` gives the scene a viewBox of `0 0 width height` and shifts every
 * element by `-min + exportPadding`, so a scene point maps into the export by the
 * same offset. The size that mapping implies is checked against the viewBox the
 * export actually carries; if a scene renders differently (frames, say) the
 * thumbnail is still returned, just without overlays rather than with wrong ones.
 */
export async function renderExcalidrawThumbnail(
  contents: string,
  elementIds: readonly string[],
): Promise<SymbolThumbnail | null> {
  const scene = parseScene(contents)
  if (!scene?.elements.length) {
    return null
  }
  const { elements } = scene

  let svg: SVGSVGElement
  try {
    svg = await exportToSvg({
      elements,
      // The drawing's own paper, so a card looks like the document it stands for.
      appState: { exportBackground: true, exportScale: 1, viewBackgroundColor: scene.background },
      files: scene.files,
      exportPadding: EXPORT_PADDING,
      // The page already has Excalidraw's fonts; inlining them would only slow this down.
      skipInliningFonts: true,
    })
  } catch {
    return null
  }

  const viewBox = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const width = viewBox.length === 4 ? viewBox[2] : 0
  const height = viewBox.length === 4 ? viewBox[3] : 0
  const [minX, minY, maxX, maxY] = getCommonBounds(elements)
  const fitsExport =
    width > 0 &&
    height > 0 &&
    Math.abs(maxX - minX + EXPORT_PADDING * 2 - width) < 0.5 &&
    Math.abs(maxY - minY + EXPORT_PADDING * 2 - height) < 0.5

  let marked = 0
  if (fitsExport) {
    const wanted = new Set(elementIds)
    const offsetX = -minX + EXPORT_PADDING
    const offsetY = -minY + EXPORT_PADDING
    for (const element of elements) {
      if (!wanted.has(element.id)) {
        continue
      }
      const [x1, y1, x2, y2] = getCommonBounds([element])
      svg.appendChild(
        overlayRect(
          svg.ownerDocument,
          x1 + offsetX - OVERLAY_INSET,
          y1 + offsetY - OVERLAY_INSET,
          x2 - x1 + OVERLAY_INSET * 2,
          y2 - y1 + OVERLAY_INSET * 2,
        ),
      )
      marked += 1
    }
  }

  return { markup: new XMLSerializer().serializeToString(svg), width, height, marked }
}

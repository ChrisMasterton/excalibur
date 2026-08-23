/**
 * Helpers for the rendered Mermaid SVG: pinning it to a real pixel size so a
 * zoomable viewport (and a canvas rasteriser) can work with it, and turning
 * that same markup into PNG bytes for `save_png_file`.
 */

export type PinnedDiagram = {
  /** SVG markup with concrete width/height and an `xmlns`, or the input when it could not be parsed. */
  markup: string
  width: number
  height: number
}

export const EMPTY_DIAGRAM: PinnedDiagram = { markup: '', width: 0, height: 0 }

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

/**
 * Mermaid emits `width="100%"` plus a `max-width` style, which fights a
 * zoomable viewport. Pin the SVG to its natural viewBox size instead.
 */
export function pinSvgToNaturalSize(svg: string): PinnedDiagram {
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
  // An SVG loaded through an <img> must carry its namespaces explicitly.
  if (!root.getAttribute('xmlns')) {
    root.setAttribute('xmlns', SVG_NAMESPACE)
  }
  if (!root.getAttribute('xmlns:xlink')) {
    root.setAttribute('xmlns:xlink', XLINK_NAMESPACE)
  }
  return { markup: new XMLSerializer().serializeToString(root), width, height }
}

function loadSvgImage(markup: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'sync'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to rasterise the diagram.'))
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  })
}

function canvasToPngBytes(canvas: HTMLCanvasElement) {
  return new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Unable to encode PNG.'))
        return
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(() => reject(new Error('Unable to encode PNG.')))
    }, 'image/png')
  })
}

/**
 * Rasterises a pinned diagram onto an opaque background at `scale` device
 * pixels per SVG unit and returns the encoded PNG bytes.
 */
export async function renderDiagramToPngBytes(
  diagram: PinnedDiagram,
  background: string,
  scale = 2,
): Promise<Uint8Array> {
  const width = Math.ceil(diagram.width)
  const height = Math.ceil(diagram.height)
  if (!diagram.markup || width <= 0 || height <= 0) {
    throw new Error('Nothing to export yet.')
  }
  const image = await loadSvgImage(diagram.markup)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to rasterise the diagram.')
  }
  context.fillStyle = background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await canvasToPngBytes(canvas)
}

/** The paper colour the preview sits on (`--paper` in App.css), used as the PNG background. */
export const DIAGRAM_PAPER_BACKGROUND = '#fffaf1'

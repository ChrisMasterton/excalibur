import { restoreElements } from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types'

/**
 * Re-measures text and grows/re-centres its containers, mirroring what Excalidraw
 * does internally (`redrawTextBoundingBox`) when a label is edited. This is the
 * fix for Mermaid conversions whose labels were sized with a fallback font.
 */

const BOUND_TEXT_PADDING = 5
const DEFAULT_FONT_SIZE = 20

// Mirrors Excalidraw's FONT_FAMILY map so we can preload the faces a scene needs.
const FONT_FAMILY_NAMES: Record<number, string> = {
  1: 'Virgil',
  2: 'Helvetica',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
  9: 'Liberation Sans',
}
const DEFAULT_FONT_FAMILY = 5

/** The subset of element geometry the container maths needs. */
type Box = { type: string; x: number; y: number; width: number; height: number }
type TextBox = Box & Pick<ExcalidrawTextElement, 'fontSize' | 'textAlign' | 'verticalAlign'>

type MutableElement = { -readonly [K in keyof ExcalidrawElement]: ExcalidrawElement[K] }
type MutableText = { -readonly [K in keyof ExcalidrawTextElement]: ExcalidrawTextElement[K] }

function isText(element: ExcalidrawElement): element is ExcalidrawTextElement {
  return element.type === 'text'
}

/**
 * Canvas text measurement silently falls back to a system font until the
 * Excalidraw faces are loaded, so every measurement pass waits for them first.
 */
export async function ensureExcalidrawFontsLoaded(elements?: readonly ExcalidrawElement[]) {
  if (typeof document === 'undefined' || !document.fonts?.load) {
    return
  }

  const families = new Set<number>([DEFAULT_FONT_FAMILY])
  for (const element of elements ?? []) {
    if (isText(element) && !element.isDeleted) {
      families.add(element.fontFamily)
    }
  }

  await Promise.all(
    Array.from(families)
      .map((family) => FONT_FAMILY_NAMES[family])
      .filter((name): name is string => Boolean(name))
      .map((name) => document.fonts.load(`16px "${name}"`).catch(() => [])),
  )
}

function getBoundTextMaxWidth(container: Box, text: TextBox) {
  const { width } = container
  if (container.type === 'arrow') {
    const minWidth = (text.fontSize ?? DEFAULT_FONT_SIZE) * 11
    return Math.max(0.7 * width, minWidth)
  }
  if (container.type === 'ellipse') {
    return Math.round((width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2
  }
  if (container.type === 'diamond') {
    return Math.round(width / 2) - BOUND_TEXT_PADDING * 2
  }
  return width - BOUND_TEXT_PADDING * 2
}

function getBoundTextMaxHeight(container: Box) {
  const { height } = container
  if (container.type === 'ellipse') {
    return Math.round((height / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2
  }
  if (container.type === 'diamond') {
    return Math.round(height / 2) - BOUND_TEXT_PADDING * 2
  }
  return height - BOUND_TEXT_PADDING * 2
}

function computeContainerDimensionForBoundText(dimension: number, containerType: string) {
  const rounded = Math.ceil(dimension)
  const padding = BOUND_TEXT_PADDING * 2
  if (containerType === 'ellipse') {
    return Math.round(((rounded + padding) / Math.SQRT2) * 2)
  }
  if (containerType === 'diamond') {
    return 2 * (rounded + padding)
  }
  return rounded + padding
}

function getContainerCoords(container: Box) {
  let offsetX = BOUND_TEXT_PADDING
  let offsetY = BOUND_TEXT_PADDING
  if (container.type === 'ellipse') {
    offsetX += (container.width / 2) * (1 - Math.SQRT2 / 2)
    offsetY += (container.height / 2) * (1 - Math.SQRT2 / 2)
  }
  if (container.type === 'diamond') {
    offsetX += container.width / 4
    offsetY += container.height / 4
  }
  return { x: container.x + offsetX, y: container.y + offsetY }
}

function computeBoundTextPosition(container: Box, text: TextBox) {
  const coords = getContainerCoords(container)
  const maxHeight = getBoundTextMaxHeight(container)
  const maxWidth = getBoundTextMaxWidth(container, text)

  let y: number
  if (text.verticalAlign === 'top') {
    y = coords.y
  } else if (text.verticalAlign === 'bottom') {
    y = coords.y + (maxHeight - text.height)
  } else {
    y = coords.y + (maxHeight / 2 - text.height / 2)
  }

  let x: number
  if (text.textAlign === 'left') {
    x = coords.x
  } else if (text.textAlign === 'right') {
    x = coords.x + (maxWidth - text.width)
  } else {
    x = coords.x + (maxWidth / 2 - text.width / 2)
  }

  return { x, y }
}

function roughlyEqual(a: number, b: number) {
  return Math.abs(a - b) < 0.5
}

export type RefitResult = {
  elements: ExcalidrawElement[]
  /** Number of text elements whose size or container changed. */
  changed: number
}

/** Call `ensureExcalidrawFontsLoaded` before this so measurements use the real fonts. */
export function refitBoundText(elements: readonly ExcalidrawElement[]): RefitResult {
  const originalById = new Map(elements.map((element) => [element.id, element]))
  const restored = restoreElements(elements as ExcalidrawElement[], null, {
    refreshDimensions: true,
    repairBindings: true,
  })

  const next: MutableElement[] = restored.map((element) => ({ ...element }))
  const nextById = new Map(next.map((element) => [element.id, element]))
  let changed = 0

  for (const element of next) {
    if (element.type !== 'text' || element.isDeleted) {
      continue
    }
    const text = element as unknown as MutableText
    const original = originalById.get(text.id)
    const container = text.containerId ? nextById.get(text.containerId) : null

    if (!container || container.isDeleted) {
      if (original && (!roughlyEqual(original.width, text.width) || !roughlyEqual(original.height, text.height))) {
        changed += 1
      }
      continue
    }

    if (container.type === 'arrow') {
      // Arrow labels float at the arrow midpoint; keep the label centred where it was.
      if (original) {
        text.x = original.x + (original.width - text.width) / 2
        text.y = original.y + (original.height - text.height) / 2
        if (!roughlyEqual(original.width, text.width) || !roughlyEqual(original.height, text.height)) {
          changed += 1
        }
      }
      continue
    }

    const maxHeight = getBoundTextMaxHeight(container)
    const maxWidth = getBoundTextMaxWidth(container, text)
    let containerChanged = false

    if (text.height > maxHeight) {
      container.height = computeContainerDimensionForBoundText(text.height, container.type)
      containerChanged = true
    }
    if (text.width > maxWidth) {
      container.width = computeContainerDimensionForBoundText(text.width, container.type)
      containerChanged = true
    }

    const position = computeBoundTextPosition(container, text)
    const moved = original ? !roughlyEqual(original.x, position.x) || !roughlyEqual(original.y, position.y) : false
    text.x = position.x
    text.y = position.y

    if (containerChanged) {
      container.version = (container.version ?? 0) + 1
      container.versionNonce = Math.floor(Math.random() * 0x7fffffff)
    }
    if (
      containerChanged ||
      moved ||
      (original && (!roughlyEqual(original.width, text.width) || !roughlyEqual(original.height, text.height)))
    ) {
      text.version = (text.version ?? 0) + 1
      text.versionNonce = Math.floor(Math.random() * 0x7fffffff)
      changed += 1
    }
  }

  return { elements: next as ExcalidrawElement[], changed }
}

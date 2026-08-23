import { convertToExcalidrawElements, serializeAsJSON } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { extractMermaidSymbols } from './mermaidSymbols'
import { EXCALIBUR_CUSTOM_DATA_KEY, type ExcaliburCustomData } from './symbolIndex'
import { normalizeSymbol } from './symbols'
import { ensureExcalidrawFontsLoaded, refitBoundText } from './textRefit'

const HTML_LINE_BREAK = /<br\s*\/?>/gi

/** Mermaid labels may carry `<br/>`; Excalidraw text wants real newlines. */
function replaceHtmlLineBreaks(elements: readonly ExcalidrawElement[]) {
  return elements.map((element) => {
    if (element.type !== 'text' || !HTML_LINE_BREAK.test(element.text)) {
      return element
    }
    return {
      ...element,
      text: element.text.replace(HTML_LINE_BREAK, '\n'),
      originalText: element.originalText.replace(HTML_LINE_BREAK, '\n'),
    }
  })
}

/** The parts of a skeleton this pass reads; the union type does not expose them directly. */
type LabelledSkeleton = {
  text?: unknown
  label?: { text?: unknown; customData?: Record<string, unknown> }
  customData?: Record<string, unknown>
}

function skeletonLabel(skeleton: LabelledSkeleton) {
  const label = skeleton.label?.text
  const text = typeof label === 'string' ? label : skeleton.text
  return typeof text === 'string' ? text.replace(HTML_LINE_BREAK, ' ') : ''
}

/**
 * Tags each converted shape with the symbol its label came from, so drawings
 * Excalibur produced are indexed exactly instead of by guesswork. Only the
 * named things a diagram declares (classes, entities, nodes, …) are stamped —
 * members live inside their class's box rather than in an element of their own.
 */
async function stampSymbols(skeletons: ExcalidrawElementSkeleton[], mermaidText: string) {
  const extraction = await extractMermaidSymbols(mermaidText)
  if (!extraction) {
    return skeletons
  }
  const stampByLabel = new Map<string, ExcaliburCustomData>()
  for (const symbol of extraction.symbols) {
    if (symbol.owner) {
      continue
    }
    const key = normalizeSymbol(symbol.display)
    if (!key || stampByLabel.has(key)) {
      continue
    }
    stampByLabel.set(key, { symbol: key, display: symbol.display, kind: symbol.kind })
  }

  return skeletons.map((skeleton) => {
    const carrier = skeleton as unknown as LabelledSkeleton
    const stamp = stampByLabel.get(normalizeSymbol(skeletonLabel(carrier)))
    if (!stamp) {
      return skeleton
    }
    const customData = { ...carrier.customData, [EXCALIBUR_CUSTOM_DATA_KEY]: stamp }
    // The bound label is built from `label`, so it needs its own copy of the stamp.
    const label = carrier.label
      ? { label: { ...carrier.label, customData: { ...carrier.label.customData, [EXCALIBUR_CUSTOM_DATA_KEY]: stamp } } }
      : null
    return { ...skeleton, customData, ...label } as ExcalidrawElementSkeleton
  })
}

/**
 * Parses Mermaid source into a serialized Excalidraw scene whose labels are
 * measured with the real Excalidraw fonts and refit to their containers.
 */
export async function convertMermaidToExcalidrawScene(mermaidText: string) {
  // Measure with the real fonts, otherwise labels come out too small for their boxes.
  await ensureExcalidrawFontsLoaded()
  const { elements: skeletons, files = {} } = await parseMermaidToExcalidraw(mermaidText)
  const stamped = await stampSymbols(skeletons, mermaidText)
  const converted = convertToExcalidrawElements(stamped, { regenerateIds: true })
  const { elements } = refitBoundText(replaceHtmlLineBreaks(converted))
  return serializeAsJSON(elements, {}, files, 'local')
}

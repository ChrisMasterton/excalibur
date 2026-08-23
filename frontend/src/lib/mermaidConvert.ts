import { convertToExcalidrawElements, serializeAsJSON } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
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

/**
 * Parses Mermaid source into a serialized Excalidraw scene whose labels are
 * measured with the real Excalidraw fonts and refit to their containers.
 */
export async function convertMermaidToExcalidrawScene(mermaidText: string) {
  // Measure with the real fonts, otherwise labels come out too small for their boxes.
  await ensureExcalidrawFontsLoaded()
  const { elements: skeletons, files = {} } = await parseMermaidToExcalidraw(mermaidText)
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: true })
  const { elements } = refitBoundText(replaceHtmlLineBreaks(converted))
  return serializeAsJSON(elements, {}, files, 'local')
}

/**
 * Marks the rendered Mermaid nodes a "Find in project" hit points at.
 *
 * The locators recorded by the index hold the ids Mermaid's own parser used, so
 * the selectors normally hit straight away; the text fallback covers diagram
 * types whose renderer does not label its nodes (and anything Mermaid changes).
 */

import type { SymbolLocator } from './symbols'

export const SYMBOL_HIGHLIGHT_CLASS = 'symbol-highlight'

const TEXT_SELECTOR = '.nodeLabel, .label text, .label tspan, text, tspan'

export function clearSymbolHighlight(container: ParentNode) {
  for (const element of container.querySelectorAll(`.${SYMBOL_HIGHLIGHT_CLASS}`)) {
    element.classList.remove(SYMBOL_HIGHLIGHT_CLASS)
  }
}

/** The node a label belongs to, so a whole box lights up rather than a word. */
function highlightTarget(element: Element) {
  return element.closest('g.node, g.root > g, g.actor, .actor') ?? element
}

/**
 * Adds the highlight class to everything matching `locators`, falling back to
 * elements whose rendered text is `display`. Returns what was marked.
 */
export function applySymbolHighlight(
  container: ParentNode,
  locators: readonly SymbolLocator[],
  display: string,
): Element[] {
  const matched = new Set<Element>()

  for (const locator of locators) {
    if (locator.target !== 'mermaid') {
      continue
    }
    for (const selector of locator.selectors) {
      let found: NodeListOf<Element>
      try {
        found = container.querySelectorAll(selector)
      } catch {
        continue
      }
      for (const element of found) {
        matched.add(element)
      }
    }
  }

  if (!matched.size) {
    const wanted = display.trim().toLowerCase()
    for (const element of container.querySelectorAll(TEXT_SELECTOR)) {
      if ((element.textContent ?? '').trim().toLowerCase() === wanted) {
        matched.add(highlightTarget(element))
      }
    }
  }

  const targets = [...matched]
  for (const element of targets) {
    element.classList.add(SYMBOL_HIGHLIGHT_CLASS)
  }
  return targets
}

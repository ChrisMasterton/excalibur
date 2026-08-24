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
export function symbolHighlightTarget(element: Element) {
  return element.closest('g.node, g.root > g, g.actor, .actor') ?? element
}

/**
 * The nodes one symbol occupies inside a rendered Mermaid SVG: everything the
 * `locators` select, falling back to elements whose rendered text is `display`.
 *
 * `root` is any `ParentNode`, so this works on the live preview and equally on a
 * detached SVG parsed off-DOM for a board thumbnail.
 */
export function findSymbolElements(
  root: ParentNode,
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
        found = root.querySelectorAll(selector)
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
    for (const element of root.querySelectorAll(TEXT_SELECTOR)) {
      if ((element.textContent ?? '').trim().toLowerCase() === wanted) {
        matched.add(symbolHighlightTarget(element))
      }
    }
  }

  return [...matched]
}

/**
 * Adds the highlight class to everything `findSymbolElements` located, so the
 * app stylesheet lights it up. Returns what was marked.
 */
export function applySymbolHighlight(
  container: ParentNode,
  locators: readonly SymbolLocator[],
  display: string,
): Element[] {
  const targets = findSymbolElements(container, locators, display)
  for (const element of targets) {
    element.classList.add(SYMBOL_HIGHLIGHT_CLASS)
  }
  return targets
}

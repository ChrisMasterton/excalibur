import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { enterEditMode, getMockState, installTauriMock, seedBackend, type MockSeed } from './support'

const PROJECT = { path: '/mock/walk', name: 'Walk', added_at: 1 }

const CLASSES = `---
title: Domain classes
---
classDiagram
    class User {
      +String email
    }
    class Order
    User "1" --> "*" Order : places
`

const FLOW = `sequenceDiagram
    participant User
    participant Order
    User->>Order: place(order)
`

/** Mentions nothing the walk is looking for. */
const OTHER = `flowchart TD
    P[Payment] --> I[Invoice]
`

/**
 * One stamped element for `User`, plus an unrelated one, so a hit is a real subset.
 * The fixture is exactly what `serializeAsJSON` writes back (element `index` and
 * all), so loading it leaves the tab clean and a stray dirty dot means something.
 */
const SKETCH = readFileSync(new URL('./fixtures/symbol-walk-sketch.excalidraw', import.meta.url), 'utf8')

const SEED: MockSeed = {
  files: {
    '/mock/walk/classes.mmd': CLASSES,
    '/mock/walk/flow.mmd': FLOW,
    '/mock/walk/other.mmd': OTHER,
    '/mock/walk/sketch.excalidraw': SKETCH,
  },
  projects: [PROJECT],
  projectFiles: {
    '/mock/walk': [
      {
        kind: 'mermaid',
        path: '/mock/walk/classes.mmd',
        name: 'classes.mmd',
        relative_path: 'classes.mmd',
        updated_at: 1,
        title: 'Domain classes',
      },
      { kind: 'mermaid', path: '/mock/walk/flow.mmd', name: 'flow.mmd', relative_path: 'flow.mmd', updated_at: 2 },
      { kind: 'mermaid', path: '/mock/walk/other.mmd', name: 'other.mmd', relative_path: 'other.mmd', updated_at: 3 },
      {
        kind: 'excalidraw',
        path: '/mock/walk/sketch.excalidraw',
        name: 'sketch.excalidraw',
        relative_path: 'sketch.excalidraw',
        updated_at: 4,
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

async function openProjectFile(page: Page, path: string) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  const expand = page.getByRole('button', { name: `Expand ${PROJECT.name}` })
  if (await expand.count()) {
    await expand.click()
  }
  await expect(page.locator(`.file-row-main[title="${path}"]`)).toBeVisible()
  await page.locator(`.file-row-main[title="${path}"]`).click()
}

/** Whichever workspace is on screen. */
const panel = (page: Page) => page.locator('.workspace-panel:not([hidden])')

/** The preview's pan/zoom as the DOM has it, so a tab switch can be shown not to move it. */
function viewport(page: Page) {
  return page.locator('.mermaid-preview .zoom-pan-content')
}

/** Whether the Excalidraw interactive layer has anything painted on it (a selection border). */
function hasCanvasSelection(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-frame canvas.interactive')
    const context = canvas?.getContext('2d')
    // A hidden workspace measures 0x0 until the canvas has re-measured itself.
    if (!canvas || !context || !canvas.width || !canvas.height) {
      return false
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) {
        return true
      }
    }
    return false
  })
}

test('the picked symbol follows every tab switch until the panel closes', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  await openProjectFile(page, '/mock/walk/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await openProjectFile(page, '/mock/walk/flow.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await openProjectFile(page, '/mock/walk/other.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await openProjectFile(page, '/mock/walk/sketch.excalidraw')
  await expect(page.getByRole('tab', { name: 'sketch' })).toHaveAttribute('aria-selected', 'true')

  // Pick `User` in the class diagram: it is marked where it was picked, in place.
  await page.getByRole('tab', { name: 'Domain classes' }).click()
  await page.locator('.diagram [id^="classId-User-"]').first().click()
  const references = page.getByRole('complementary', { name: 'References' })
  await expect(references.locator('.references-name')).toHaveText('User')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  // Ctrl+Tab to the sequence diagram: the mark is already there, panel untouched.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'flow' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()
  await expect(references).toBeVisible()
  // The panel marks where the walk has got to.
  await expect(references.locator('.symbol-hit.is-active')).toHaveText(/flow/)

  // Pin this tab's viewport by hand, so a stray pan would be plain to see.
  const zoom = page.locator('.zoom-pan-percent')
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  const pinnedTransform = await viewport(page).getAttribute('style')
  const pinnedZoom = await zoom.textContent()

  // A diagram that never mentions `User` simply shows nothing, and says nothing.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)
  await expect(page.locator('.mermaid-preview .error')).toHaveCount(0)
  await expect(references.locator('.symbol-hit.is-active')).toHaveCount(0)

  // The drawing in the walk gets its stamped element selected, and stays clean.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'sketch' })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => hasCanvasSelection(page)).toBe(true)
  await expect(page.locator('.dirty-dot')).toHaveCount(0)

  // Round the tabs again: the class diagram is still marked, and the sequence
  // diagram comes back to exactly the viewport it was left at - the highlight
  // rides along, it does not steer.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'Domain classes' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'flow' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()
  await expect(viewport(page)).toHaveAttribute('style', pinnedTransform ?? '')
  await expect(zoom).toHaveText(pinnedZoom ?? '')

  // Choosing a document in the panel is still the deliberate act that reveals it.
  await references.getByRole('button', { name: /flow/ }).click()
  await expect(viewport(page)).not.toHaveAttribute('style', pinnedTransform ?? '')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  // Closing the panel ends the walk everywhere, including the tabs already visited.
  await references.getByRole('button', { name: 'Close references' }).click()
  await expect(references).toHaveCount(0)
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)
  await page.getByRole('tab', { name: 'sketch' }).click()
  await expect.poll(() => hasCanvasSelection(page)).toBe(false)
  await page.getByRole('tab', { name: 'Domain classes' }).click()
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)
})

test('editing a highlighted Mermaid diagram re-marks the re-rendered SVG', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  await openProjectFile(page, '/mock/walk/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await page.locator('.diagram [id^="classId-User-"]').first().click()
  await expect(page.getByRole('complementary', { name: 'References' })).toBeVisible()
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  await enterEditMode(page)
  const source = page.locator('.mermaid-editor textarea')
  await source.fill(`${CLASSES}    class Payment\n`)

  // The fresh SVG is marked again, without the panel being touched.
  await expect(page.locator('.diagram [id^="classId-Payment-"]')).toBeVisible()
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  // A symbol the source no longer declares drops its marks silently.
  await source.fill('classDiagram\n    class Payment\n')
  await expect(page.locator('.diagram [id^="classId-Payment-"]')).toBeVisible()
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)
  await expect(page.locator('.mermaid-preview .error')).toHaveCount(0)
})

test('a highlighted diagram exports the same PNG as an unhighlighted one', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  await openProjectFile(page, '/mock/walk/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  const exportPng = () => panel(page).getByRole('button', { name: 'Export PNG' }).click()

  await exportPng()
  await expect(page.getByText('Exported classes.png.')).toBeVisible()

  // The marks live on the preview's DOM; the export rasterises the SVG Mermaid
  // rendered, so the same diagram must come out byte for byte.
  await page.locator('.diagram [id^="classId-User-"]').first().click()
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()
  await exportPng()
  await expect.poll(async () => (await getMockState(page)).savedPngs.length).toBe(2)

  const { savedPngs } = await getMockState(page)
  expect(savedPngs[1].digest).toBe(savedPngs[0].digest)
})
